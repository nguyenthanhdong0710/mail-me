# Contract: `deploy/linux` scripts

All laptop-side scripts run from the repository root, take `<user@host>`, accept `-i <key>` and
`--dir <path>` (default `/opt/mail-me`), and use one shared SSH connection. The remote user must
be root or have password-less sudo (else exit 1 with a message).

## `server-setup.sh <check|system|app> [--dir <path>]` (on the server, as root)

| Phase | Does | Exit |
| --- | --- | --- |
| `check` | OS in {ubuntu 22.04, 24.04, debian 12, 13} and arch in {x86_64, aarch64}; no changes | 0 ok, 5 unsupported |
| `system` | `check`; wait for cloud-init/apt; Docker + Compose (if missing); swap (< 2 GB, none); FORWARD fix (if present); `<dir>` and `<dir>/data` (1000:1000, 700) | 0 / 5 / 1 |
| `app` | `docker build -t mail-me:latest <dir>`; if `config.json` and `.env` exist: `docker compose up -d --force-recreate mail-me` | 0 / 1 |

Idempotent: running any phase twice is safe.

## `install.sh [options] <user@host>`

| Option | Meaning |
| --- | --- |
| `-i <key>` | SSH identity |
| `--dir <path>` | Install folder |
| `--dry-run` | Print the files that would be uploaded and exit 0; no SSH |
| `-h` | Help |

Flow: check root/sudo → `server-setup.sh system` (streamed) → upload bundle into `<dir>/.code-new`
and swap it in, keeping `config.json`, `.env`, `data/` → `server-setup.sh app` → print next step
(`push-config.sh` if no settings, else logs command). Exit codes: 0, 1 (ssh/sudo/build), 5
(unsupported OS).

## `push-config.sh` (moved, behavior from 003 except)

- Step 2 is now: verify `<dir>/docker-compose.yml` and `docker` exist, else exit 3 with
  "Run deploy/linux/install.sh <host> first".
- Works as root (no `sudo`) or sudo user.

## `backup.sh` (moved) — works as root or sudo user; otherwise unchanged.
