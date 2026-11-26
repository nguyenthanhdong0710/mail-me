# Deploy mail-me on any Linux server

Two commands, run on **your computer** from your mail-me folder, turn any Linux server you can SSH
into into a running mail-me:

```bash
deploy/linux/install.sh    root@203.0.113.7   # Docker + the code from this computer, then build
deploy/linux/push-config.sh root@203.0.113.7  # config.json, .env, sign-ins; check; start
```

This works for a VPS from any provider, a cloud VM (the [Google Cloud](../gcp/README.md) and
[Oracle Cloud](../oci/README.md) guides create one and then use these same commands), or a
machine at home that you can reach over SSH.

## What you need

**A server** running one of these systems, on x86-64 or Arm64:

| System                 | Supported |
| ---------------------- | --------- |
| Ubuntu 22.04 and 24.04 | ✅        |
| Debian 12 and 13       | ✅        |

- At least **1 GB of memory** (on less than 2 GB, `install.sh` adds 2 GB of swap so the build
  fits) and **10 GB of disk**.
- Login as **root**, or as a user that can run `sudo` **without a password** (the default on most
  cloud images).
- Your **SSH key** on it. Most providers ask for your public key (`~/.ssh/id_ed25519.pub`; create
  one with `ssh-keygen -t ed25519`) when you create the server. If you only got a password, run
  `ssh-copy-id root@<ip>` once.
- No open ports other than SSH. mail-me only makes outbound connections.

**On your computer** (Linux, macOS or WSL): `ssh`, `tar`, and a finished setup from the main
guide up to Step 6 — a working `config.json`, `.env`, and for Gmail/Outlook your sign-ins in
`data/grants/`. Run `npm run check-config` (or the Docker equivalent) and make sure it passes.

### Where to get a server

| Option                                       | Cost                | Notes                                                                                                                                       |
| -------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| A computer you already have                  | Free (electricity)  | Mini PC, old laptop, Raspberry Pi 4/5 with a 64-bit OS. Most private: mail stays at home. It must stay on; mail-me catches up after outages |
| [Google Cloud free tier](../gcp/README.md)   | Free                | 1 small server (1 GB) in the US. Needs a card and billing account                                                                           |
| [Oracle Cloud Always Free](../oci/README.md) | Free                | Bigger free server, but sign-up often fails and free capacity is scarce                                                                     |
| A small VPS                                  | Around $4–6/month   | Vultr, DigitalOcean, Hetzner, Linode/Akamai and others have Singapore data centers. Pick Ubuntu 24.04, 1 GB memory                          |
| A VPS from a local provider                  | Varies, often cheap | E.g. in Vietnam: Viettel IDC, VNPT, BizFly Cloud. Data stays in the country; pay in local currency                                          |

Prices change; check the provider's page.

## Install

From your mail-me folder:

```bash
deploy/linux/install.sh root@<server-ip>
```

It:

1. checks the system is supported (and stops before changing anything if not),
2. installs Docker Engine and the Compose plugin from Docker's official repository (kept if
   already installed), adds swap on small machines, and creates `/opt/mail-me/data`,
3. uploads the mail-me code **from this computer** — your current files, including local changes.
   `config.json`, `.env`, `data/`, Terraform state and anything git ignores are never uploaded.
   No `git clone` happens on the server, so a private repository is fine,
4. builds the image on the server, and starts mail-me if settings were already uploaded.

The first run takes a few minutes (longer on a 1 GB server). Options: `-i <key>` for a specific
SSH key, `-p <port>` for a non-standard SSH port, `-o <ssh option>` for anything else,
`--dir <path>` for another install folder, `--dry-run` to list the files it would upload.

## Upload your settings and start

```bash
deploy/linux/push-config.sh root@<server-ip>
```

It uploads `config.json`, `.env` and `data/grants/*.json` (contents are never printed), runs
`check-config` on the server **before** replacing anything, installs them with owner-only
permissions, and (re)starts mail-me. If the check fails, it prints the error, changes nothing and
exits with code 4; a running mail-me keeps its previous settings. `--no-grants` keeps the
sign-ins already on the server. See `--help` for the rest.

Set `timezone` in `config.json`: servers and containers usually run in UTC.

Then check it, as in Step 8 of the main guide:

```bash
ssh root@<server-ip> 'cd /opt/mail-me && docker compose logs -f mail-me'
```

(As a non-root user, put `sudo` before `docker` in the commands on this page.)

## Signing in on the server

Signing in on your computer and letting `push-config.sh` upload `data/grants/` is easiest. To sign
in on the server instead, upload your settings first with `push-config.sh --no-grants`
(`check-config` tells you which accounts still need a sign-in), then:

- **Gmail** needs a browser callback. Forward the port over SSH and run the sign-in there:
  ```bash
  ssh -L 53682:127.0.0.1:53682 root@<server-ip>
  cd /opt/mail-me
  docker compose run --rm -p 127.0.0.1:53682:53682 mail-me auth <account-id> --listen 0.0.0.0
  ```
  Open the printed link in your local browser; the callback reaches the server through the tunnel.
- **Microsoft** uses a device code and needs no port:
  ```bash
  ssh -t root@<server-ip> 'cd /opt/mail-me && docker compose run --rm mail-me auth <account-id>'
  ```

Then restart: `ssh root@<server-ip> 'cd /opt/mail-me && docker compose restart mail-me'`.

## Day-to-day

| Task                              | Command (from your mail-me folder)                                       |
| --------------------------------- | ------------------------------------------------------------------------ |
| Logs                              | `ssh <user@ip> 'cd /opt/mail-me && sudo docker compose logs -f mail-me'` |
| Status                            | `ssh <user@ip> 'cd /opt/mail-me && sudo docker compose ps'`              |
| Update to a new version           | `git pull`, then `deploy/linux/install.sh <user@ip>`                     |
| Change settings                   | Edit locally, then `deploy/linux/push-config.sh <user@ip>`               |
| Back up the database and sign-ins | `deploy/linux/backup.sh <user@ip>`                                       |

- **Updates** keep `config.json`, `.env` and `data/` (database and sign-ins), remove files that
  no longer exist in the code, rebuild, and restart mail-me. No email is reported twice.
- **Reboots**: Docker starts at boot and brings mail-me back (`restart: unless-stopped`).
- **Backups**: `backup.sh` stops mail-me for a few seconds so the database copy is consistent,
  saves `mail-me-backup-<time>.tar.gz` (private: it contains your sign-ins) and starts it again.
  `--out <dir>` chooses where. To restore: copy the archive to the server, then
  `cd /opt/mail-me && docker compose stop mail-me && tar -xzf <archive> && docker compose start mail-me`.
- **System updates**: Ubuntu and Debian cloud images install security updates automatically.
  Otherwise run `apt update && apt upgrade` now and then.

## Security

- Only SSH needs to be reachable. If your provider has a firewall panel, allow only port 22
  (ideally only from your IP). On the server itself you can use
  `ufw allow OpenSSH && ufw enable` (Ubuntu) — allow SSH **before** enabling, or you lock
  yourself out.
- Use SSH keys and turn off password login (`PasswordAuthentication no` in
  `/etc/ssh/sshd_config`) once your key works.
- On the server, `config.json` and `data/grants/` are owned by the container user (uid 1000)
  with mode 600 (folders 700); `.env` is owned by root with mode 600. Anyone with root on the
  server, including the provider, can read them. Choose a provider you trust.

## Troubleshooting

| Problem                                                             | Fix                                                                                             |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `Unsupported system` (exit 5)                                       | Reinstall the server with Ubuntu 24.04 or Debian 12                                             |
| `log in as root, or as a user that can run sudo without a password` | Use `root@…`, or add `youruser ALL=(ALL) NOPASSWD:ALL` with `visudo`                            |
| `Permission denied (publickey)`                                     | Pass the right key: `install.sh -i ~/.ssh/your_key …`                                           |
| `push-config.sh` exits 3                                            | Run `install.sh` first                                                                          |
| `push-config.sh` exits 4                                            | `check-config` failed; its message says what to fix. Fix it locally and run again               |
| Build killed / out of memory                                        | Check `free -h` shows swap; on very small servers stop other services. 1 GB + swap is enough    |
| `failed to solve` / network errors during build                     | The server cannot reach npm or Docker Hub; check its internet access and run `install.sh` again |
