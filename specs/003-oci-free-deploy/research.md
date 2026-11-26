# Research: Free Cloud Hosting on Oracle Cloud Always Free

## R1. Why not Vercel / serverless

- **Decision**: Do not support Vercel or other serverless platforms; document why in the README.
- **Rationale**: mail-me is a long-running poller (`start`) with one loop per account. Serverless
  functions only run per request with a time limit. State (`data/mail-me.db`, `data/grants/`)
  needs a persistent, writable disk; Vercel's filesystem is read-only apart from an ephemeral
  `/tmp`. Hobby cron jobs run at most once a day, too slow for `run-once`. Hobby is also
  non-commercial only.
- **Alternatives considered**: Refactor to an external DB + KV for grants + external cron hitting
  an API route — rejected: violates constitution I/VII (single process, local SQLite) for no gain.

## R2. Host choice

- **Decision**: OCI Always Free Ampere A1 (`VM.Standard.A1.Flex`).
- **Rationale**: Up to 4 OCPU / 24 GB / 200 GB block storage free, persistent disk, runs the
  existing Docker Compose setup unchanged. Default 1 OCPU / 6 GB leaves room for other free VMs.
- **Alternatives considered**: GCP e2-micro (1 GB RAM, tight for `npm ci` build); Fly.io/Render
  (no free persistent disk for new users); GitHub Actions cron (state persistence, unreliable
  schedule, minutes quota).

## R3. IaC tool and runner

- **Decision**: Terraform root module with `oracle/oci ~> 7.0`, Terraform ≥ 1.7, usable locally and
  by OCI Resource Manager (managed Terraform, free).
- **Rationale**: First-party provider; Resource Manager auto-fills `tenancy_ocid`,
  `compartment_ocid` and `region`, so naming variables that way makes the same folder work in both.
  Provider block sets only `region`; locally the provider falls back to `~/.oci/config`
  (`DEFAULT` profile, or `OCI_CLI_PROFILE`/`TF_VAR_*`), and in Resource Manager it uses the
  service's own auth. ≥ 1.7 is required for `mock_provider` in tests.
- **Alternatives considered**: Pulumi (extra runtime), Ansible (better for config than
  provisioning), OCI CLI scripts (no state/teardown).

## R4. Image selection and instance stability

- **Decision**: `data "oci_core_images"` filtered to `Canonical Ubuntu` `24.04`, shape
  `VM.Standard.A1.Flex`, newest first; optional `image_ocid` override. `lifecycle.ignore_changes`
  on `source_details[0].source_id` and `metadata["user_data"]`.
- **Rationale**: New images are published often; without `ignore_changes` a later `apply` would
  replace the instance and delete `data/`. Ubuntu has `docker.io` and `docker-compose-v2` in its
  archive (no third-party repo needed), and the README already documents these packages.
- **Alternatives considered**: Oracle Linux (Docker needs extra repo; podman default); pinning an
  image OCID (region-specific, goes stale).

## R5. Network exposure

- **Decision**: Dedicated VCN `10.0.0.0/16`, public subnet `10.0.0.0/24`, internet gateway,
  default route, security list with egress all and ingress TCP 22 from `ssh_source_cidr`
  (default `0.0.0.0/0`) plus ICMP type 3 code 4 (path-MTU discovery, as OCI's default list does).
- **Rationale**: mail-me only makes outbound connections (IMAP/HTTPS/SMTP/Telegram). Ubuntu images on
  OCI also ship host iptables rules that allow only SSH inbound, which matches.
- **Alternatives considered**: Private subnet + bastion (extra moving parts; Bastion session
  limits); reusing the default VCN (not created by Terraform, harder teardown).

## R6. First boot (cloud-init)

- **Decision**: `#cloud-config` rendered with `templatefile`: `package_update`, install `docker.io`,
  `docker-compose-v2`, `git`; add the default user to `docker`; clone `repo_url` at `repo_ref` into
  `/opt/mail-me`; `mkdir data && chown 1000:1000 data && chmod 700 data`; `docker compose build`
  in the background-safe `runcmd`; enable `docker`. If `config.json` and `.env` already exist,
  `docker compose up -d`.
- **Rationale**: Pre-building on first boot makes the first `push-config.sh` fast. Starting only when
  settings exist avoids a crash loop. `restart: unless-stopped` + enabled Docker handles reboots.
- **Alternatives considered**: systemd unit wrapping compose (redundant with restart policy);
  `get.docker.com` script (curl | sh, unpinned).

## R7. Moving secrets

- **Decision**: `push-config.sh` streams a tar of `config.json`, `.env` and (unless
  `--no-grants`) `data/grants/` over one SSH connection into `/opt/mail-me/.staging` (mode 700),
  waits for `cloud-init status --wait`, builds if needed, validates with
  `docker compose run --rm` + staging mounts running `check-config`, and only then moves files into
  place (`config.json` → uid 1000 mode 600, `.env` → root mode 600, grants → uid 1000, 0600 files
  in a 0700 dir) and runs `docker compose up -d`.
- **Rationale**: Nothing touches Terraform; a bad config never replaces a working one; grant
  permissions satisfy `FileGrantStore`'s owner-only check (uid 1000 = `node` in the container).
  `.env` is read by the Compose CLI (run with sudo), so root ownership is fine.
- **Alternatives considered**: `scp` + separate `chmod` (multiple round trips; window with loose
  perms); passing secrets as `user_data` (would land in state and instance metadata).

## R8. Sign-in on the server

- **Decision**: Recommend signing in locally then uploading grants. Alternative documented: SSH
  local forward `-L 53682:127.0.0.1:53682` and run `auth <id> --listen 0.0.0.0` in the container
  bound to `127.0.0.1:53682` on the VM; Microsoft uses device code, no forward needed.
- **Rationale**: Matches the existing README flow; no inbound port opened.

## R9. Backups

- **Decision**: `backup.sh` stops the container, tars `/opt/mail-me/data` to stdout over SSH into
  a local `mail-me-backup-<UTC timestamp>.tar.gz` created with `umask 077`, then starts it again.
- **Rationale**: Stopping avoids a torn SQLite WAL copy; downtime is seconds and the exactly-once
  store makes it safe.

## R10. Free-tier gotchas (documented)

- **Out of host capacity**: A1 capacity is often exhausted. Retry later, try another
  `availability_domain_index`, or use a smaller shape; Pay As You Go accounts get capacity more
  reliably.
- **Idle reclamation**: Oracle may reclaim Always Free instances whose 95th-percentile CPU,
  network and (for A1) memory use stay below 20% over 7 days. mail-me is mostly idle. Upgrading the
  account to Pay As You Go removes reclamation; Always Free resources stay free. Recommend a budget
  alert at $1.
- **Home region**: Always Free compute can only be created in the tenancy's home region, chosen at
  sign-up and not changeable.

## R11. Validation of limits

- **Decision**: Variable validations: `ocpus` 1–4, `memory_in_gbs` 1–24 and ≤ 64 × ocpus,
  `boot_volume_size_in_gbs` 50–200, `ssh_source_cidr` valid CIDR, `ssh_public_key` starts with
  `ssh-`/`ecdsa-`. The memory-per-OCPU check (A1 allows 1–64 GB per OCPU) spans two variables, so
  it is a `precondition` on the instance rather than a cross-variable validation (which needs
  Terraform ≥ 1.9 and may be newer than Resource Manager offers).
- **Rationale**: Fail before anything is created, with a message naming the free limit. The
  limits are per tenancy, so docs tell users to subtract existing usage.
