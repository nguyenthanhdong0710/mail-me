# Feature Specification: Read-Only OAuth, More Mail Providers, Meeting Suggestions, Shorter Reports and AI Cost Logs

**Feature Branch**: `002-oauth-providers-calendar`

**Created**: 2026-10-29

**Status**: Draft (clarified)

**Input**: User description: "1. I dont want to using google app password. To risky. I want to using OAuth2 and grant the READ permission only (Please remember to update readme and config example too) 2. I want to support MS Outlook beside gmail too. Actually I want support many kind of mail as possible 3. I want in docker logs, when ever AI triggered, we also log the cost (but if you cant do that, ignore this requirement) 4. I want 1 more agent to Schedule the meeting or any kind of "meet" I can get via the email. So the feature is read the email, if the email contain something like the "plan", suggest me add to google calendar or MS calendar (outlook calendar or team calendar). 5. The Analytic agent seem like write to long. I want shorter message"

Follow-up (2026-10-30): "1. I don't want SMPT is required and Telegrams is Optional, I want both is optional but must at least 1 channel enabled. So user can enable mail or tele or both. 2. In the email message, I want to know which this email sent to. Current the brief only sender, summary message and the original message. 3. Optional. I want to url to open original email if possible."

Builds on `specs/001-ai-email-assistant/spec.md`. Requirements there still apply unless this spec changes them.

## Clarifications

### Session 2026-10-29

- Q: How does the assistant "suggest adding to calendar"? → A: The report shows the detected event with one-click "Add to Google Calendar" and "Add to Outlook calendar" links, and the email report attaches a calendar file (.ics). The user adds the event themselves. The assistant gets no calendar permission and never writes to a calendar.
- Q: The mailbox grant is read-only, so how does the email report channel send? → A: The sending account grants a separate send-only permission through the same OAuth sign-in. That grant cannot read mail. No passwords are used.
- Q: How are providers without read-only OAuth supported (Yahoo, iCloud, Fastmail, Zoho, school or company servers)? → A: Password-based mailbox access stays available as a fallback for any standard mail server. It is documented as less safe than OAuth.
- Q: Which emails does the meeting agent look at? → A: Only emails that end up IMPORTANT (including whitelisted ones). Spam and promotions are never checked for events.
- Q: Is AI cost logging feasible? → A: Yes, as an estimate: token usage times a price per model. Prices come built in for common models and can be overridden in config.

### Session 2026-10-30

- Q: Are email and Telegram delivery both optional? → A: Yes. Each is opt-in on its own, and at least one must be enabled. A Telegram-only setup needs no sending account at all: no outgoing mail settings, no password and no send-only grant. Docs and the example config present both as equal choices.
- Q: What does "who the email was sent to" show? → A: The To and Cc recipients (first 5, then "and N more"), plus the monitored address that actually received it. When the user got it through Bcc, an alias or a forward, the report says "received at <monitored address>".
- Q: Can the report link to the original email? → A: Yes, where the provider offers a web link to a single message (Gmail and Microsoft). For other providers the link is left out rather than shown broken.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Gmail sign-in with read-only OAuth, no app password (Priority: P1)

A self-hoster no longer creates a Google app password. They register their own OAuth app once,
following the README, then run a one-time sign-in command. A consent screen asks only for
permission to **read** mail. After they approve, the assistant monitors the mailbox with that
grant and refreshes access on its own. No mailbox password is stored anywhere.

**Why this priority**: An app password gives full access to the mailbox, including sending and
deleting. Replacing it with a read-only grant is the user's main safety concern.

**Independent Test**: Follow the README on a fresh install with one Gmail account. Confirm that the
consent screen lists read-only mail access only, that no password is in `.env`, and that an
important email still produces a report.

**Acceptance Scenarios**:

1. **Given** a Gmail account set to OAuth in config and no sign-in done yet, **When** the assistant starts, **Then** startup fails with a message naming the account and the sign-in command to run.
2. **Given** the user runs the sign-in command for that account, **When** they approve the consent screen, **Then** the grant is stored locally and the command confirms which account and which permission were granted.
3. **Given** a signed-in Gmail account, **When** an important email arrives, **Then** a report is delivered exactly as in feature 001.
4. **Given** a signed-in account, **When** the short-lived access expires, **Then** the assistant renews it without user action and without missing mail.
5. **Given** the user revokes the grant in their Google account, **When** the assistant polls, **Then** that account logs a clear "sign-in revoked, run the sign-in command again" error, other accounts keep working, and no mail is skipped once the user signs in again.
6. **Given** the README, `config.example.json` and `.env.example`, **When** a user reads them, **Then** they describe OAuth setup as the default for Gmail and show no app-password step for it.

---

### User Story 2 - Outlook and many other mail providers (Priority: P1)

The user can monitor Outlook.com, Hotmail and Microsoft 365 work or school mailboxes using the same
kind of read-only OAuth sign-in. Any other provider with standard mail access (Yahoo, iCloud,
Fastmail, Zoho, GMX, a university or company server) works with a password fallback. For common
providers, the user picks a provider name and doesn't have to type server settings.

**Why this priority**: The user's school and work mail is often on Microsoft 365. Supporting
"as many providers as possible" makes the tool useful beyond Gmail.

**Independent Test**: Configure one Outlook.com account (OAuth) and one password-based account on
another provider at the same time. Send an important email to each and confirm that each produces a
report labeled with its account.

**Acceptance Scenarios**:

1. **Given** a Microsoft account set to OAuth, **When** the user signs in, **Then** the consent screen asks only for read-only mail access, and monitoring works like Gmail.
2. **Given** a Microsoft 365 organization that requires admin approval for third-party apps, **When** the user tries to sign in, **Then** the sign-in command explains that an administrator must approve the app, and the README documents this.
3. **Given** an account configured with a known provider name (e.g. "yahoo", "icloud", "fastmail"), **When** the config is loaded, **Then** server settings are filled in from the provider preset, and anything the user sets explicitly wins.
4. **Given** an account on an unknown server, **When** the user gives the server settings and a password reference, **Then** it is monitored over an encrypted connection as in feature 001.
5. **Given** a password-based account, **When** the assistant starts, **Then** it logs a one-time notice that the account uses a password, which is less safe than OAuth.

---

### User Story 3 - Shorter reports (Priority: P2)

Reports are short enough to read at a glance on a phone: a one- or two-sentence TL;DR, at most three
one-line key points, action items only when there are any, and a short excerpt. Users who want more
detail can choose a "detailed" style in config.

**Why this priority**: Current reports are too long, so they defeat the purpose of a summary.

**Independent Test**: Run a fixed set of 20 important test emails through both styles. Check that
every "brief" report meets the length limits below and that "detailed" is about as long as today's
reports.

**Acceptance Scenarios**:

1. **Given** the default style, **When** a long email is analyzed, **Then** the TL;DR is at most 2 sentences (about 40 words), there are at most 3 key points of at most about 15 words each, and the excerpt is at most about 300 characters.
2. **Given** an email with no required action, **When** it is reported, **Then** the report has no action-items section and shows "Action needed: No" on one line.
3. **Given** the default style, **When** the report goes to Telegram, **Then** a typical report fits in one message without splitting.
4. **Given** the style set to "detailed", **When** an email is analyzed, **Then** the report uses today's longer format.

---

### User Story 4 - Meeting and plan suggestions with one-click "add to calendar" (Priority: P2)

When an important email mentions a meeting, call, interview, class, appointment, event or another
plan with a date and time, the report includes an **Event** section: title, date and time with time
zone, duration or end time, and the location or online meeting link. It also offers "Add to Google
Calendar" and "Add to Outlook calendar" links, and the email report attaches a calendar file that
any calendar app (including Teams and Apple Calendar) can open. A new **Scheduler** agent does the
detection, with its own configurable AI model, and it can be turned off.

**Why this priority**: Turning an email into a calendar entry is a common manual step after reading
a summary, and missing a meeting is costly.

**Independent Test**: Send an important email such as "Project sync on Thursday 6 Nov at 14:00 for
45 minutes, Teams link: …". Confirm the report shows the event, and that opening either link creates
a prefilled event with the right time, duration and link.

**Acceptance Scenarios**:

1. **Given** an important email with a clear date, time and online link, **When** it is reported, **Then** the Event section shows them, and both calendar links open a prefilled event with the correct start, end and location or link.
2. **Given** an email that already contains a calendar invitation, **When** it is processed, **Then** the event comes from the invitation itself, with no AI call for detection.
3. **Given** an email that says "next Tuesday at 3pm" with no year or time zone, **When** it is processed, **Then** the date is worked out from the email's sent date, and the time uses the configured time zone unless the email states one.
4. **Given** an email that mentions a meeting but no usable time ("let's meet sometime next week"), **When** it is reported, **Then** the Event section shows "time not set" with no calendar links.
5. **Given** an email with several events (e.g. an exam schedule), **When** it is reported, **Then** up to 3 events are listed, each with its own links, and the report says when more were left out.
6. **Given** an email cancelling or moving a meeting, **When** it is reported, **Then** the event is marked "Cancelled" or "Rescheduled", and the assistant changes nothing in any calendar.
7. **Given** the Scheduler fails or returns invalid output, **When** the email is reported, **Then** the report is still delivered without an Event section, and the failure is logged.
8. **Given** the Scheduler is disabled in config, **When** emails are processed, **Then** no event detection AI calls are made.
9. **Given** an event whose time has already passed when the email is processed, **When** it is reported, **Then** no calendar links are offered.

---

### User Story 5 - AI cost in the logs (Priority: P3)

Every time an AI model is called, the log shows the role, the model, token counts and the estimated
cost. The per-email log line shows the total for that email. The user can see in `docker compose
logs` what the assistant costs.

**Why this priority**: Useful for keeping costs in check, but the assistant works without it. The
user said to drop it if it isn't feasible. It is feasible as an estimate.

**Independent Test**: Process one important email with all three agents enabled. Confirm three
AI-call log lines with role, model, tokens and cost, and a per-email line whose cost equals their
sum.

**Acceptance Scenarios**:

1. **Given** a model with a known price, **When** it is called, **Then** the log line includes input tokens, output tokens and estimated cost in USD.
2. **Given** a model with no known price, **When** it is called, **Then** tokens are logged, cost is shown as unknown, and one warning per model explains how to set its price in config.
3. **Given** a price override in config, **When** that model is called, **Then** the override is used.
4. **Given** an email handled by rules only (whitelist hit with Scheduler disabled, drop keyword, self-sent), **When** it is logged, **Then** its cost is 0.

---

### User Story 6 - Choose delivery channels freely (Priority: P2)

The user picks how reports arrive: by email only, by Telegram only, or both. Neither channel is
required. Someone who only wants phone notifications sets up Telegram and never configures a
sending mail account.

**Why this priority**: The current docs make outgoing mail look mandatory, which pushes users into
creating sending credentials they don't need. That is exactly the risk this feature removes.

**Independent Test**: Start three installs: email only, Telegram only, and both. Each delivers
reports to exactly its enabled channels. An install with neither enabled refuses to start.

**Acceptance Scenarios**:

1. **Given** only Telegram is enabled and no sending account is configured, **When** the assistant starts and an important email arrives, **Then** it starts cleanly and the report arrives on Telegram.
2. **Given** only email is enabled, **When** an important email arrives, **Then** the report arrives by email and no Telegram settings are needed.
3. **Given** both are enabled, **When** an important email arrives, **Then** one report arrives on each channel, as in feature 001.
4. **Given** neither channel is enabled, **When** the assistant starts, **Then** startup fails with a message naming the delivery settings and saying at least one channel must be enabled.
5. **Given** a channel is disabled, **When** its settings are missing or incomplete, **Then** config validation does not complain about them.
6. **Given** the README and the example config, **When** a user reads them, **Then** both channels are presented as optional choices, and the steps for each are labeled "only if you use email reports" or "only if you use Telegram".

---

### User Story 7 - See who the email was sent to and open the original (Priority: P2)

Each report shows who the email was addressed to, and which of the user's monitored addresses
received it. When the provider supports it, the report also has an "Open original" link that
opens the message in the user's webmail.

**Why this priority**: With several mailboxes and aliases, knowing whether a message went to "me",
"me and the whole class" or "a mailing list" changes how urgent it is. Opening the original is the
usual next step after reading a summary.

**Independent Test**: Send one email to a monitored Gmail account with two To and one Cc recipient,
and one to a monitored address through Bcc. Confirm both reports show the right recipients and the
receiving address, and that "Open original" opens the right message.

**Acceptance Scenarios**:

1. **Given** an email with To and Cc recipients, **When** it is reported, **Then** the report shows the To and Cc lists and marks which monitored address received it.
2. **Given** an email with more than 5 recipients in a list, **When** it is reported, **Then** the first 5 are shown, followed by "and N more".
3. **Given** the user received the email through Bcc, an alias or a forward, so their address is not in To or Cc, **When** it is reported, **Then** the report says "received at <monitored address>".
4. **Given** a Gmail or Microsoft account, **When** an email is reported, **Then** the report has an "Open original" link that opens that message in webmail.
5. **Given** an account on a provider with no per-message web link, **When** an email is reported, **Then** there is no "Open original" link and nothing broken in its place.
6. **Given** an email whose recipient names contain markup or instructions, **When** it is reported, **Then** they are shown as plain text and do not change behavior.

### Edge Cases

- OAuth grant expires because the user's OAuth app is in Google's "testing" mode, where grants last only 7 days → the README explains how to avoid this, and expiry is reported the same way as a revoked grant.
- The sign-in machine has a browser but the server is headless (Docker on a VPS) → sign-in works from any machine, and the stored grant can be placed where the server reads it.
- The stored grant file is missing, corrupt or for a different account → startup fails with a message naming the account.
- Mail provider is temporarily down during an access renewal → treated like any mail-server error: logged and retried on the next poll.
- Send-only grant revoked for the email channel → handled like a delivery failure, retried per feature 001, and the log says to sign in again.
- An email states a time in a different time zone from the user's → the event keeps the stated zone, and the report shows the time in the user's zone.
- All-day events and multi-day events (conferences, trips) → shown and linked as all-day or multi-day.
- An event text contains instructions ("ignore previous instructions…") → treated as data, with no change to behavior.
- A meeting link in an email is a phishing link → the assistant shows the link as written and does not vouch for it. Links are never opened by the assistant.
- Event section plus a long report pushes Telegram over its limit → the excerpt is shortened first, as in feature 001.
- Prices change → the built-in price list can be out of date. Costs are labeled as estimates.
- "Undisclosed recipients" or an empty To field → the report shows "undisclosed recipients" and the receiving monitored address.
- Very long recipient lists (mailing lists, all-staff mail) → capped as in FR-128.
- The user later deletes or moves the original message → the "Open original" link may no longer open it. This is acceptable and documented.
- Opening "Open original" while signed in to a different account in the browser → the provider may show the wrong mailbox or ask to switch accounts. The link names the account where the provider allows it.

## Requirements *(mandatory)*

### Functional Requirements

**Sign-in and mail access**

- **FR-101**: System MUST support OAuth sign-in for Google mailboxes (Gmail and Google Workspace) and Microsoft mailboxes (Outlook.com, Hotmail, Live and Microsoft 365), requesting **read-only** mail permission only.
- **FR-102**: When the email channel is enabled, it MUST be able to send using a separate OAuth grant that has **send-only** permission. Read and send permissions MUST be granted separately, so a monitored account never gets send permission and the sending account never needs read permission.
- **FR-103**: System MUST provide a one-time sign-in command per account. It MUST show the user which permissions are requested, store the resulting grant locally, and confirm the account address and the granted permission.
- **FR-104**: System MUST renew access automatically while the grant is valid. A revoked or expired grant MUST be logged with the account name and the command to fix it, MUST NOT stop other accounts, and MUST NOT cause mail to be skipped once the user signs in again.
- **FR-105**: Stored grants are secrets. They MUST be kept in a configurable location outside committed files, readable only by the assistant's user, kept across container restarts, and never written to logs.
- **FR-106**: Password-based mailbox access MUST remain available for any standard mail server. Each password-based account MUST log a one-time notice that OAuth is safer where available.
- **FR-107**: System MUST provide presets for common providers (at least Gmail, Microsoft, Yahoo, iCloud, Fastmail, Zoho, GMX and AOL) that fill in server settings and the default sign-in method. Settings the user sets explicitly MUST override the preset.
- **FR-108**: Config validation MUST reject an account whose sign-in method doesn't match what its provider supports, and an OAuth account without a stored grant, with a message naming the account and the next step.
- **FR-109**: The system MUST still never modify, move, delete or flag messages in monitored mailboxes (feature 001 FR-013). The read-only grant enforces this at the provider.
- **FR-110**: README, `config.example.json` and `.env.example` MUST document OAuth as the default for Gmail and Microsoft, with step-by-step registration of the user's own OAuth app, the sign-in command, how to avoid 7-day expiry, and the password fallback for other providers.

**Shorter reports**

- **FR-111**: The Analyst MUST support a report style, "brief" (default) or "detailed". In "brief": TL;DR of at most 2 sentences, at most 3 key points of one line each, action items only when present, and an excerpt of at most about 300 characters. "Detailed" keeps feature 001 behavior.
- **FR-112**: A report with no action items MUST show a single "Action needed: No" line instead of an empty section.

**Scheduler agent (meeting and plan suggestions)**

- **FR-113**: System MUST add a Scheduler role that finds events (meetings, calls, interviews, classes, appointments, deadlines with a time, trips and other plans) in IMPORTANT emails. It MUST have its own configurable provider and model, and it MUST be possible to disable it.
- **FR-114**: When an email contains a calendar invitation, the event MUST be taken from the invitation without an AI call.
- **FR-115**: Each detected event MUST have a title, start, end or duration (default 60 minutes when not stated), all-day flag, time zone, location and/or online meeting link, and a status (new, rescheduled or cancelled). At most 3 events per email are reported, and the report notes any left out.
- **FR-116**: Relative or incomplete dates MUST be worked out from the email's sent date. Times without a stated zone MUST use the configured time zone. An event without a usable date and time MUST be shown as "time not set" with no calendar links.
- **FR-117**: For each event with a usable time that has not already passed, the report MUST offer an "Add to Google Calendar" link and an "Add to Outlook calendar" link prefilled with the event details, and the email report MUST attach a standard calendar file. These MUST be built by plain code, not by the AI.
- **FR-118**: System MUST NOT write to, change or delete anything in any calendar, and MUST NOT request calendar permissions.
- **FR-119**: Scheduler output MUST be validated against a strict schema. On failure, the report MUST still be delivered without an Event section and the failure MUST be logged. The email MUST NOT be held back.
- **FR-120**: Email content passed to the Scheduler MUST be treated as data, as in feature 001 FR-016. All event fields shown in reports and links MUST be escaped or encoded for their destination.

**AI cost logging**

- **FR-121**: Every AI call MUST log the role, provider, model, input tokens, output tokens, latency and estimated cost in USD.
- **FR-122**: The per-email log line MUST include the total tokens and total estimated cost across all AI calls for that email.
- **FR-123**: System MUST ship a price list for common models, and the user MUST be able to set or override a model's price in config. A model without a price MUST be logged with an unknown cost and one warning per model.

**Configuration**

- **FR-124**: Config MUST gain: per-account provider and sign-in method; the grant storage location; the send-only sign-in for the email channel (only when that channel is enabled); the Scheduler role (provider, model, enabled); the user's time zone; report style; and optional model prices. All of it is validated at startup, as in feature 001 FR-014.

**Delivery channels**

- **FR-125**: Email and Telegram delivery MUST each be optional and independently enabled, in any combination, with at least one enabled. Settings of a disabled channel MUST NOT be required or validated.
- **FR-126**: A sending account (outgoing mail settings, password or send-only grant) MUST be required only when the email channel is enabled. A Telegram-only installation MUST store no sending credential.
- **FR-127**: README and `config.example.json` MUST present both channels as optional choices. The example MUST show both channel blocks, and README setup steps for each channel MUST be marked as needed only for that channel.

**Recipients and original link**

- **FR-128**: Every report MUST show the To and Cc recipients (at most 5 per list, then "and N more"; "undisclosed recipients" when empty) and the monitored address that received the message. When that address is not in To or Cc, the report MUST say "received at <monitored address>". All of it MUST be escaped per channel.
- **FR-129**: When the account's provider offers a web link to a single message, every report MUST include an "Open original" link to it. Otherwise the link MUST be left out. The link MUST be built by plain code from data the provider or the message supplies, never by the AI.

### Key Entities

- **Mail Provider Preset**: A named provider (e.g. Gmail, Microsoft, Yahoo) with default server settings and the sign-in methods it supports.
- **OAuth Grant**: The stored permission for one account: account address, provider, permission level (read-only or send-only), when it was granted, and its renewal state. Secret.
- **Monitored Account** (changed): gains a provider and a sign-in method (OAuth or password).
- **Incoming Email** (changed): gains To and Cc recipients, the monitored address that received it, and an optional web link to the original message.
- **Detected Event**: title, start, end or duration, all-day flag, time zone, location, meeting link, status (new, rescheduled or cancelled), and source (invitation or AI).
- **Report** (changed): gains a style, zero or more Detected Events with their calendar links, the recipients and receiving address, and an optional "Open original" link.
- **AI Usage Record**: per call: role, provider, model, tokens, latency and estimated cost.
- **Model Price**: per model: input and output price per million tokens, built in or set by the user.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-101**: A Gmail account and an Outlook account can be monitored with no mailbox password stored anywhere on the host.
- **SC-102**: The consent screen for a monitored account lists read-only mail access and no other mail permission, for both Google and Microsoft.
- **SC-103**: A new user with an existing Google or Microsoft account can go from the README to their first report using OAuth in under 30 minutes.
- **SC-104**: At least 8 named providers work out of the box with a preset. Any standard mail server works with manual settings.
- **SC-105**: In "brief" style, 100% of reports in the test set meet the length limits, and at least 90% of Telegram reports fit in one message.
- **SC-106**: On a labeled test set of at least 30 emails with events, at least 90% of events with a clear date and time produce links that create the correct event (start, end, title) when opened, and 0 events are suggested for emails with no event.
- **SC-107**: 0 calendar changes are ever made by the assistant.
- **SC-108**: 100% of AI calls in logs show tokens and either an estimated cost or "unknown", and per-email totals equal the sum of their calls.
- **SC-109**: A Scheduler failure never prevents or delays a report beyond the normal retry window.
- **SC-110**: A Telegram-only installation works end to end with no sending account or sending credential configured.
- **SC-111**: 100% of reports in the test set show the recipients and the receiving monitored address, including Bcc and alias cases.
- **SC-112**: For Gmail and Microsoft accounts, at least 95% of "Open original" links open the correct message for a user signed in to that account.

## Assumptions

- The user registers their own OAuth app with Google (Cloud project) and/or Microsoft (Entra app registration). The project does not run a shared OAuth app.
- The sign-in command is run once per account from a machine with a web browser. The grant can then be used by a headless server.
- Microsoft 365 organizations may block user-approved third-party apps. Getting admin approval is up to the user.
- Teams meetings live in the Outlook calendar, so "Add to Outlook calendar" covers Teams. The calendar file works with any calendar app.
- Calendar links need no permission; the user adds the event in their own browser session.
- Costs are estimates from public list prices. Discounts, caching and taxes are not included.
- One time zone per installation, set in config.
- "Open original" needs the user to be signed in to that webmail account in their browser or mail app. It needs no extra permission for the assistant.
- The constitution will need a minor amendment during planning: Principle II lists only Gatekeeper and Analyst as AI roles (add Scheduler), and the Security section mentions app passwords (add OAuth grants as secrets).
- Out of scope: writing to calendars, replying to invites, interactive Telegram buttons, mailbox actions, a shared hosted OAuth app, and providers with no standard mail access and no supported OAuth (e.g. Proton Mail without its bridge).
