# Contract: `mail-me auth` Command (002, FR-103)

```text
mail-me auth <account-id>        Sign in a monitored account (read-only)
mail-me auth --email-channel     Sign in the email channel's sending account (send-only)
mail-me auth --status            List every OAuth grant: account, address, permission, last renewed
  [--config path] [--port 53682] [--listen 127.0.0.1]
```

The command loads the config with grant checks turned off, since a missing grant is what it
fixes. Any other config error still stops it.

## Flow: Google (`provider: gmail`)

```text
Signing in "school" (student@university.edu) with Google.
Permission requested: Read your email (gmail.readonly). Mail-Me cannot send, change or delete mail.

Open this link in a browser where you can sign in to student@university.edu:
  https://accounts.google.com/o/oauth2/v2/auth?…

Waiting for the browser on http://127.0.0.1:53682 …
If the browser is on another machine, it will end on a page that does not load.
Copy that page's full address and paste it here:
> _
```

- The listener and the paste prompt race; whichever delivers a valid `code` with the right
  `state` wins.
- `--port` is fixed so it can be published from Docker. Inside a container the listener must bind
  the container interface, so Docker users run
  `docker compose run --rm -p 127.0.0.1:53682:53682 mail-me auth school --listen 0.0.0.0`
  (the redirect URI stays `http://127.0.0.1:53682/`; the host-side `127.0.0.1` keeps the port off
  the network).

## Flow: Microsoft (`provider: microsoft`)

```text
Signing in "work" (me@company.com) with Microsoft.
Permission requested: Read your mail (Mail.Read). Mail-Me cannot send, change or delete mail.

On any device, open https://microsoft.com/devicelogin and enter the code: ABCD-EFGH
Waiting … (expires in 15 minutes)
```

## Outcomes

| Case | Output | Exit |
|---|---|---|
| Success | `✓ Signed in student@university.edu with read-only mail access. Saved to data/grants/school.read.json` | 0 |
| Signed in as a different address | `✗ You signed in as other@gmail.com, but account "school" is student@university.edu. Nothing was saved.` | 1 |
| Fewer scopes granted (user unticked a box) | `✗ Read access was not granted. Run the command again and allow "Read your email".` | 1 |
| Admin consent required (AADSTS65001/90094) | `✗ Your organization requires an administrator to approve this app. Send them the app (client) ID <id>; see README "Microsoft 365 admin approval".` | 1 |
| User cancels / code expires | `✗ Sign-in was cancelled or timed out.` | 1 |
| Unknown account / account is `password` | `✗ Account "x" not found` / `✗ Account "yahoo" uses a password; OAuth is only for gmail and microsoft accounts.` | 2 |

Nothing is written unless sign-in fully succeeds. The refresh token is never printed.
Re-running replaces the old grant (same file, atomic).
