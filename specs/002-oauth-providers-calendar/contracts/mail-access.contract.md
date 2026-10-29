# Contract: Mail Access and Sending Ports (002)

Replaces the `MailSource` section of [001 ports.contract](../../001-ai-email-assistant/contracts/ports.contract.md).
All adapters are testable with fakes: IMAP via a fake `MailSource`, Gmail/Graph/OAuth via the
existing `HttpFetch` seam.

## MailSource (changed)

```ts
interface RawMessage {
  id: string;            // IMAP UID, Gmail message ID, or Graph immutable ID
  cursor: string;        // persist once this and all earlier messages are settled
  source: Buffer;        // full RFC 822 message
  internalDate: Date;
  webLink?: string;      // provider-supplied (Graph); validated by the fetcher
}

interface MailSource {
  /** Never changes anything in the mailbox (FR-109). */
  open(mailbox: string): Promise<{ generation: string; head: string }>;
  /** Messages after `cursor`, oldest first, at most `limit`. */
  fetchSince(cursor: string, limit: number): AsyncIterable<RawMessage>;
  /** Cursor that makes fetchSince start at mail received on/after `since`; null if none. */
  cursorSince(since: Date): Promise<string | null>;
  close(): Promise<void>;
}
```

Pipeline rules (unchanged in spirit from 001):
- No stored state, or stored `generation` ≠ opened `generation` → baseline at `head` (or
  `cursorSince(now - lookback)` on first run); dedup by Message-ID protects against replays.
- Persist the `cursor` of the last message in the contiguous settled prefix.
- A `GrantRevokedError` from `open`/`fetchSince` fails that account's poll only, cursor untouched.

### Adapters

| Adapter | Used for | API calls (read-only) |
|---|---|---|
| `ImapMailSource` | `auth: password` | EXAMINE, UID FETCH BODY.PEEK[], UID SEARCH SINCE (001) |
| `GmailApiSource` | `provider: gmail, auth: oauth` | `users.getProfile`, `users.labels.list`, `users.history.list`, `users.messages.list`, `users.messages.get?format=raw` |
| `GraphMailSource` | `provider: microsoft` | `GET /me/mailFolders/{id}`, `GET /me/mailFolders/{id}/messages?$select=id,receivedDateTime,webLink&$filter&$orderby&$top`, `GET /me/messages/{id}/$value` |

Errors: HTTP 401 after one refresh → `GrantRevokedError`; 403 with an admin-consent code →
`GrantRevokedError` with the admin message; 429/5xx → transient error honoring `Retry-After`;
Gmail history 404 → internal switch to `t:` mode (not an error).

## TokenProvider (new)

```ts
interface TokenProvider {
  /** Valid access token; refreshes and persists rotated refresh tokens. */
  accessToken(): Promise<string>;
  /** Drop the cached access token after a 401. */
  invalidate(): void;
}
class GrantRevokedError extends Error { readonly grantName: string; readonly fixCommand: string }
```

One `TokenProvider` per grant file. Concurrency: concurrent callers share one in-flight refresh.
New token values are registered with the logger's secret scrubber before use.

## GrantStore (new)

```ts
interface GrantStore {
  read(name: string): Grant | null;          // throws GrantFileError on bad JSON/permissions
  write(name: string, grant: Grant): void;   // atomic, mode 0600
}
```

## OAuthClient (new, used by the `auth` command and TokenProvider)

```ts
interface OAuthClient {
  provider: "google" | "microsoft";
  /** Interactive sign-in; resolves with the confirmed address and granted scopes. */
  signIn(purpose: "read" | "send", io: SignInIO): Promise<Grant>;
  refresh(grant: Grant): Promise<{ accessToken: string; expiresAt: Date; refreshToken?: string }>;
}
```

Scopes requested (exactly; FR-101, FR-102, SC-102). A grant is accepted when it includes the
required scope and none of the blocked scopes (any Gmail scope other than `gmail.readonly`/`gmail.send`,
`Mail.ReadWrite`, `Mail.Send` on a read grant, `Mail.Read` on a send grant, any `Calendars.*`/calendar scope):

| Provider | read | send |
|---|---|---|
| google | `https://www.googleapis.com/auth/gmail.readonly` | `https://www.googleapis.com/auth/gmail.send` + `openid email` (`gmail.send` cannot read the profile, so the address comes from the ID token) |
| microsoft | `offline_access User.Read Mail.Read` | `offline_access User.Read Mail.Send` |

Google: authorization code + PKCE (S256), loopback redirect `http://127.0.0.1:<port>/`,
`state` checked, `access_type=offline`, `prompt=consent`. Microsoft: device code flow on
`https://login.microsoftonline.com/<tenant>/oauth2/v2.0/{devicecode,token}`.

## MailSender (new, used by the email channel)

```ts
interface MailSender {
  /** Sends a complete MIME message. Throws ChannelError (retryable or not). */
  send(mime: Buffer, envelope: { from: string; to: string }): Promise<{ externalId: string }>;
  verify(): Promise<void>;
}
```

| Adapter | Call | Notes |
|---|---|---|
| `SmtpSender` | nodemailer SMTP (001) | password |
| `GmailApiSender` | `POST users/me/messages/send` `{ raw: base64url(mime) }` | `gmail.send` |
| `GraphSender` | `POST /me/sendMail`, `Content-Type: text/plain`, body base64(mime) | `Mail.Send`; 202 has no ID → externalId = our Message-ID |

`EmailChannel` builds the MIME with `MailComposer` (headers from 001 `reportHeaders`, plus the
`.ics` attachment) and calls `MailSender.send`. Revoked send grant → `ChannelError(retryable: true)`
with "run `mail-me auth --email-channel`" so delivery retries per 001 after the user signs in.
`verify()` for OAuth senders checks the grant refreshes; it sends nothing.
