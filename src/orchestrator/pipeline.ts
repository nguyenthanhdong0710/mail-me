import { analyze } from "../agents/analyst.js";
import { classify, type GatekeeperVerdict } from "../agents/gatekeeper.js";
import type { AccountConfig, AppConfig } from "../config/load.js";
import { dispatch } from "../courier/dispatcher.js";
import { buildReport } from "../courier/report.js";
import type {
  Clock,
  LlmClient,
  MailSource,
  MailSourceFactory,
  RawMessage,
  ReportChannel,
  Store,
} from "../domain/ports.js";
import type {
  AnalysisResult,
  ChannelName,
  DraftRecord,
  IncomingEmail,
  LlmUsage,
} from "../domain/types.js";
import { parseAndClean } from "../fetcher/clean.js";
import type { Logger } from "../lib/logger.js";
import type { RetryOptions } from "../lib/retry.js";
import { evaluateRules } from "../rules/engine.js";

export interface PipelineDeps {
  config: AppConfig;
  store: Store;
  llm: LlmClient;
  channels: Map<ChannelName, ReportChannel>;
  sources: MailSourceFactory;
  clock: Clock;
  logger: Logger;
  /** Backoff settings for LLM and channel calls; tests pass a no-sleep variant. */
  retry?: RetryOptions;
}

/** What happened to one message; `settled` means its state is persisted (recorded or pending). */
type MessageResult = { settled: boolean };

export class Pipeline {
  private readonly installId: string;

  constructor(private readonly deps: PipelineDeps) {
    this.installId = deps.store.getInstallId();
  }

  /** One poll of one account: retry pending reports, then process new mail. */
  async pollAccount(account: AccountConfig): Promise<void> {
    await this.drainPending(account.id);
    // A broken mailbox does not stop the account's other mailboxes; the error is still
    // raised afterwards so the scheduler can back off.
    let failure: unknown = null;
    for (const mailbox of account.mailboxes) {
      const source = this.deps.sources(account.id);
      try {
        await this.pollMailbox(account, mailbox, source);
      } catch (err) {
        this.deps.logger.error(
          { account: account.id, mailbox, err: (err as Error).message },
          "mailbox poll failed",
        );
        failure ??= err;
      } finally {
        await source.close().catch(() => {});
      }
    }
    if (failure) throw failure;
  }

  async drainPending(accountId: string): Promise<void> {
    for (const pending of this.deps.store.listPendingReports(accountId)) {
      await dispatch(pending, this.dispatchDeps());
    }
  }

  private async pollMailbox(
    account: AccountConfig,
    mailbox: string,
    source: MailSource,
  ): Promise<void> {
    const { store, logger, config } = this.deps;
    const { uidValidity, uidNext } = await source.open(mailbox);
    let state = store.getMailboxState(account.id, mailbox);

    if (!state || state.uidValidity !== uidValidity) {
      // First run, or the server reset UIDs: start from "now" (or the look-back window)
      // instead of replaying the whole mailbox (FR-019, research R2).
      let baseline = uidNext - 1;
      if (!state && account.lookbackHours > 0) {
        const since = new Date(this.deps.clock.now().getTime() - account.lookbackHours * 3_600_000);
        const first = await source.firstUidSince(since);
        if (first !== null) baseline = first - 1;
      }
      if (state) {
        logger.warn(
          { account: account.id, mailbox, old: state.uidValidity, new: uidValidity },
          "UIDVALIDITY changed, re-baselining",
        );
      }
      state = { accountId: account.id, mailbox, uidValidity, lastSeenUid: baseline };
      store.setMailboxState(state);
    }

    let lastSeen = state.lastSeenUid;
    let contiguous = true;
    for await (const raw of source.fetchSince(state.lastSeenUid, config.limits.fetch_batch)) {
      let result: MessageResult;
      try {
        result = await this.processMessage(account, mailbox, uidValidity, raw);
      } catch (err) {
        logger.error(
          { account: account.id, mailbox, uid: raw.uid, err },
          "message processing failed, will retry",
        );
        result = { settled: false };
      }
      // Only advance over a contiguous prefix of settled UIDs, so failures are retried.
      if (!result.settled) contiguous = false;
      if (contiguous) lastSeen = raw.uid;
    }
    if (lastSeen !== state.lastSeenUid) store.setMailboxState({ ...state, lastSeenUid: lastSeen });
  }

  async processMessage(
    account: AccountConfig,
    mailbox: string,
    uidValidity: number,
    raw: RawMessage,
  ): Promise<MessageResult> {
    const { store, llm, logger, config, clock } = this.deps;
    const started = Date.now();
    const key = { accountId: account.id, mailbox, uidValidity, uid: raw.uid };
    if (store.hasPendingReport(key)) return { settled: true };

    const cleaned = await parseAndClean(raw.source, {
      maxBodyChars: config.limits.max_body_chars,
      fallbackDate: raw.internalDate,
    });
    const email: IncomingEmail = { ...key, ...cleaned };
    const log = logger.child({ account: account.id, mailbox, uid: raw.uid });

    const decision = evaluateRules(email, {
      installId: this.installId,
      isProcessed: (e) => store.isProcessed(e, e.messageId),
      rules: {
        whitelistDomains: config.rules.whitelist_domains,
        dropKeywords: config.rules.drop_keywords,
      },
    });
    if (decision.kind === "ALREADY_PROCESSED") return { settled: true };

    const draft: DraftRecord = {
      key,
      messageId: email.messageId,
      sender: email.from.address,
      subject: email.subject,
      decision: "LLM",
      category: null,
      confidence: null,
      tokensIn: null,
      tokensOut: null,
    };
    const usage: LlmUsage = { input: 0, output: 0 };
    const addUsage = (u: LlmUsage | null) => {
      if (!u) return;
      usage.input += u.input;
      usage.output += u.output;
    };

    if (decision.kind === "SELF_SENT") {
      store.recordProcessed({
        ...draft,
        decision: "SELF_SENT",
        outcome: "SKIPPED",
        processedAt: clock.now().toISOString(),
      });
      log.info({ decision: "SELF_SENT", outcome: "SKIPPED" }, "skipped our own report");
      return { settled: true };
    }

    if (decision.kind === "DROP_KEYWORD") {
      store.recordProcessed({
        ...draft,
        decision: "DROP_KEYWORD",
        category: "PROMOTION",
        outcome: "SKIPPED",
        processedAt: clock.now().toISOString(),
      });
      log.info(
        {
          decision: "DROP_KEYWORD",
          keyword: decision.keyword,
          category: "PROMOTION",
          outcome: "SKIPPED",
          ms: Date.now() - started,
        },
        "email skipped",
      );
      return { settled: true };
    }

    let verdict: GatekeeperVerdict | null = null;
    if (decision.kind === "WHITELIST") {
      draft.decision = "WHITELIST";
      draft.category = "IMPORTANT";
    } else {
      verdict = await classify(llm, email, {
        threshold: config.rules.confidence_threshold,
        retry: this.deps.retry,
      });
      addUsage(verdict.usage);
      draft.category = verdict.effective;
      draft.confidence = verdict.result?.confidence_score ?? null;

      if (verdict.effective !== "IMPORTANT") {
        store.recordProcessed({
          ...draft,
          tokensIn: usage.input,
          tokensOut: usage.output,
          outcome: "SKIPPED",
          processedAt: clock.now().toISOString(),
        });
        log.info(
          {
            decision: "LLM",
            category: verdict.effective,
            confidence: draft.confidence,
            reasoning: verdict.result?.reasoning,
            outcome: "SKIPPED",
            tokens: usage,
            ms: Date.now() - started,
          },
          "email skipped",
        );
        return { settled: true };
      }
    }

    let analysis: AnalysisResult | null = null;
    try {
      const res = await analyze(llm, email, {
        targetLanguage: config.ai.targetLanguage,
        retry: this.deps.retry,
      });
      analysis = res.value;
      addUsage(res.usage);
    } catch (err) {
      log.error({ err: (err as Error).message }, "analysis failed, sending fallback report");
    }

    const report = buildReport(
      email,
      { accountId: account.id, label: account.label },
      analysis,
      config.limits.excerpt_chars,
    );
    const finalDraft = { ...draft, tokensIn: usage.input, tokensOut: usage.output };
    store.savePendingReport(report, finalDraft, [...this.deps.channels.keys()]);

    const [pending] = store
      .listPendingReports(account.id)
      .filter(
        (p) =>
          p.report.key.mailbox === mailbox &&
          p.report.key.uidValidity === uidValidity &&
          p.report.key.uid === raw.uid,
      );
    const result = pending
      ? await dispatch(pending, this.dispatchDeps())
      : { done: false as const };

    log.info(
      {
        decision: draft.decision,
        ...(decision.kind === "WHITELIST" && { domain: decision.domain }),
        category: "IMPORTANT",
        confidence: draft.confidence,
        gatekeeperFailed: verdict?.failed,
        lowConfidence: verdict?.lowConfidence,
        analysisFailed: analysis === null,
        outcome: result.done ? result.outcome : "DELIVERY_PENDING",
        tokens: usage,
        ms: Date.now() - started,
      },
      "email reported",
    );
    return { settled: true };
  }

  private dispatchDeps() {
    return {
      store: this.deps.store,
      channels: this.deps.channels,
      clock: this.deps.clock,
      logger: this.deps.logger,
      maxAttempts: this.deps.config.delivery.maxAttempts,
      retry: this.deps.retry,
    };
  }
}
