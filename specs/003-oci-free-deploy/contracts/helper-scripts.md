# Contract: helper scripts

Both run from the repository root on the user's computer and need `ssh` and `tar`.

## `deploy/linux/push-config.sh [options] <user@host>`

| Option | Default | Meaning |
| --- | --- | --- |
| `-i <key>` | ssh default | SSH identity file |
| `--config <path>` | `config.json` | Local config file |
| `--env <path>` | `.env` | Local env file |
| `--grants <dir>` | `data/grants` | Local grants folder (skipped if missing) |
| `--no-grants` | off | Do not upload grants (keep the server's) |
| `--dir <path>` | `/opt/mail-me` | Install folder on the server |
| `-h, --help` | | Usage |

Steps and exit codes:

1. Check local files exist → else exit 2 with the missing path.
2. Wait for first-boot setup (`cloud-init status --wait`) → exit 3 if it failed.
3. Stream files into `<dir>/.staging` (0700, root) in one SSH session.
4. Build the image if missing; run `check-config` with staging files mounted → on failure print
   its output, delete staging, leave the running service untouched, exit 4.
5. Install files with owners/modes from data-model; `docker compose up -d`; print
   `docker compose ps` and the log command → exit 0.

Never prints file contents. Never writes secrets to the server outside `<dir>`.

## `deploy/linux/backup.sh [-i <key>] [--dir <path>] [--out <dir>] <user@host>`

Stops the container, streams `tar.gz` of `<dir>/data` to
`<out>/mail-me-backup-<YYYYMMDDTHHMMSSZ>.tar.gz` (created under `umask 077`), starts the
container again (also on failure, via trap). Exit 0 on success, non-zero otherwise.
