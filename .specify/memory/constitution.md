<!--
Sync Impact Report
- Version change: 1.0.0 → 1.1.0 (MINOR: expanded guidance)
- Modified principles: I. Self-Hosted & Privacy-First (report delivery channels the user opted into
  are an allowed destination for email-derived content)
- Added sections: none
- Removed sections: none
- Templates: plan/spec/tasks templates read the constitution at runtime; no edits required
- Follow-up TODOs: none
-->

# Mail-Me (Open-Source AI Email Assistant) Constitution

## Core Principles

### I. Self-Hosted & Privacy-First

- The system MUST run fully on infrastructure the user controls, as a single process with no
  required external services other than the user's mail servers and the chosen LLM provider.
- Email content MUST only leave the host when sent to the LLM provider the user configured, or to
  report delivery channels the user explicitly enabled (e.g. email, Telegram). There is no
  telemetry, analytics or other third-party upload.
- Report delivery channels MUST be opt-in, and their privacy implications MUST be documented
  (e.g. Telegram bot chats are not end-to-end encrypted).
- Persisted email data MUST be limited to what processing needs (identifiers, classification,
  summaries, and short excerpts), and the user MUST be able to configure retention.

**Rationale**: Users trust the tool with school, work and personal mailboxes.

### II. Deterministic First, LLM Where It Adds Value

- Cheap deterministic rules (whitelist, drop keywords, already-processed checks) MUST run before
  any LLM call.
- Formatting and dispatch (the Courier) MUST be plain code with no LLM call.
- Each LLM role (Gatekeeper, Analyst) MUST have its own configurable provider and model, so a
  cheap model can classify and a stronger model can analyze.

**Rationale**: This controls cost and latency and cuts down on hallucination.

### III. Never Lose Mail (NON-NEGOTIABLE)

- The system MUST NOT delete, move or mutate messages in a monitored mailbox unless the user
  explicitly enables it in config. The default is read-only.
- Any failure (LLM error, timeout, invalid output, low confidence) MUST fail open. The email is
  treated as important and forwarded, with an indication that AI processing failed. It is never
  silently dropped.
- Each message MUST be processed at most once and MUST NOT be skipped, including across restarts.

**Rationale**: A missed bill or deadline costs more than an extra summary email.

### IV. Untrusted Input & Validated Output

- All email content MUST be treated as untrusted. Prompts MUST clearly separate instructions from
  email data, and instructions found inside an email MUST NOT change agent behavior.
- Every LLM response MUST be parsed against a strict schema. If validation fails, the failure path
  in Principle III applies.
- Rendered HTML MUST escape all values that come from email or the LLM.

**Rationale**: Inboxes are an adversarial environment (phishing, prompt injection).

### V. Modular, Testable Pipeline

- The pipeline MUST be made of independent modules (fetcher, rules, gatekeeper, analyst, courier,
  store, config) that communicate through typed contracts.
- IMAP, SMTP, LLM, clock and storage MUST sit behind interfaces so that every module can be tested
  with fakes, without network access.
- New behavior MUST come with automated tests. Contract tests MUST cover the agent input/output
  schemas and the config schema.

**Rationale**: Mail servers and LLMs are slow, flaky and expensive to use in tests.

### VI. Type Safety & Configuration as Contract

- The code MUST be TypeScript in strict mode on a maintained Node.js LTS. Using `any` requires a
  written justification.
- User configuration MUST be validated at startup with clear, actionable error messages. An invalid
  config MUST stop startup and MUST NOT run with partial settings.

**Rationale**: Self-hosters are often non-developers, so misconfiguration has to be caught early and explained.

### VII. Simplicity & Observability

- Start simple (YAGNI): single process, embedded local storage, file-based config. Any added
  infrastructure MUST be justified in the plan's Complexity Tracking table.
- Logs MUST be structured and MUST record each email's pipeline decisions (rule hit, category,
  confidence, forwarded or skipped) along with LLM cost and latency.
- Logs MUST NOT contain credentials, and by default MUST NOT contain full email bodies.

**Rationale**: Users need to see why an email was or was not forwarded.

## Security & Privacy Constraints

- Secrets (mail passwords or app passwords, API keys) MUST come from environment variables or a
  secrets file excluded from git, never from committed config. Config refers to them by name.
- IMAP and SMTP connections MUST use TLS by default.
- The repository MUST ship an example config with no real credentials.
- Dependencies MUST be pinned using a lockfile.

## Development Workflow & Quality Gates

- Spec-driven: each feature goes from spec to plan to tasks before implementation, using Spec Kit.
- Before merging: type-check, lint and all tests MUST pass. The plan's Constitution Check MUST
  have no unjustified violations.
- Prompts are versioned source files and changes to them are reviewed like code.
- Commits follow Conventional Commits.

## Governance

- This constitution supersedes other practices. Plans and reviews MUST check compliance with it.
- Amendments require a documented rationale, a version bump, and an update to dependent artifacts
  if they are affected.
- Versioning: MAJOR for removing or redefining a principle, MINOR for a new principle or section,
  PATCH for clarifications.

**Version**: 1.1.0 | **Ratified**: 2026-10-29 | **Last Amended**: 2026-10-29
