# Data Model: Google Cloud Free Tier and Any-VPS Hosting

## GCP deployment inputs (non-secret)

| Field | Type | Default | Validation |
| --- | --- | --- | --- |
| `project_id` | string | — (required) | 6–30 chars `^[a-z][a-z0-9-]{4,28}[a-z0-9]$` |
| `region` | string | `us-central1` | one of `us-west1`, `us-central1`, `us-east1` ("free tier") |
| `zone` | string | `""` → `us-west1-b` / `us-central1-a` / `us-east1-b` | empty or starts with `<region>-` |
| `ssh_user` | string | `ubuntu` | `^[a-z_][a-z0-9_-]{0,31}$` |
| `ssh_public_key` | string | — (required) | starts with `ssh-` or `ecdsa-` |
| `ssh_source_cidr` | string | `0.0.0.0/0` | valid IPv4 CIDR |
| `disk_size_gb` | number | `30` | 10–30 ("free tier: 30 GB standard disk") |
| `display_name` | string | `mail-me` | `^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$` (GCE names) |

Fixed (not variables): machine type `e2-micro`, disk type `pd-standard`, image
`ubuntu-os-cloud/ubuntu-2404-lts-amd64`.

## GCP resources (labels `app = mail-me`)

```text
google_project_service.compute
google_compute_network ── google_compute_subnetwork (10.10.0.0/24)
                      └─ google_compute_firewall (allow tcp:22 from ssh_source_cidr → tag mail-me)
google_compute_instance (e2-micro, pd-standard, ephemeral external IP, tag mail-me)
```

`lifecycle.ignore_changes = [boot_disk[0].initialize_params[0].image]` so a newer Ubuntu image
never replaces the server (and its data). SSH key changes are applied in place.

## Server layout (all targets)

| Path | Owner | Mode | Written by |
| --- | --- | --- | --- |
| `/opt/mail-me/` (code) | root | 755 | install.sh (replaced on update) |
| `/opt/mail-me/config.json` | 1000:1000 | 600 | push-config.sh (kept on update) |
| `/opt/mail-me/.env` | root | 600 | push-config.sh (kept on update) |
| `/opt/mail-me/data/` | 1000:1000 | 700 | server-setup.sh; contents by mail-me (kept) |
| `/swapfile` | root | 600 | server-setup.sh, only if < 2 GB memory and no swap |

## Code bundle

Included: git-tracked files + untracked files not ignored by `.gitignore`.
Always excluded: `config.json`, `.env`, `.env.*` (but `.env.example` kept), `data/`, `*.db`,
`*.db-*`, `*.tfstate*`, `*.tfvars`, `.terraform/`.

## Server states

```text
fresh → install (system) → prepared → install (upload+app) → installed, waiting for settings
installed → push-config → running
running → install (update) → running (new image, same settings/data)
```
