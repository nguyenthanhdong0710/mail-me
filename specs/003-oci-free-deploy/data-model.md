# Data Model: Free Cloud Hosting on Oracle Cloud Always Free

No application data model changes. The "entities" are deployment inputs, cloud resources and the
private settings bundle.

## Deployment inputs (Terraform variables, non-secret)

| Field | Type | Default | Validation |
| --- | --- | --- | --- |
| `tenancy_ocid` | string | — (required; auto-filled by Resource Manager) | starts with `ocid1.tenancy.` |
| `compartment_ocid` | string | `""` → tenancy | empty or starts with `ocid1.` |
| `region` | string | — (required) | non-empty |
| `ssh_public_key` | string | — (required) | starts with `ssh-` or `ecdsa-` |
| `ssh_source_cidr` | string | `0.0.0.0/0` | valid IPv4 CIDR |
| `ocpus` | number | `1` | 1–4 (Always Free A1 total) |
| `memory_in_gbs` | number | `6` | 1–24; with `ocpus`: ≤ 64 × ocpus (precondition) |
| `boot_volume_size_in_gbs` | number | `50` | 50–200 |
| `availability_domain_index` | number | `0` | ≥ 0; precondition: < number of ADs |
| `image_ocid` | string | `""` → newest Ubuntu 24.04 aarch64 | empty or starts with `ocid1.image.` |
| `repo_url` | string | project's public GitHub HTTPS URL | starts with `https://` or `git@` |
| `repo_ref` | string | `main` | non-empty |
| `display_name` | string | `mail-me` | 1–63 chars `[a-zA-Z0-9-]` |

No variable accepts a password, API key, OAuth client secret or grant (FR-006).

## Cloud resources (all tagged `freeform_tags = { app = "mail-me" }`)

```text
oci_core_vcn ─┬─ oci_core_internet_gateway
              ├─ oci_core_route_table (0.0.0.0/0 → IGW)
              ├─ oci_core_security_list (egress all; ingress TCP 22 from ssh_source_cidr; ICMP 3/4)
              └─ oci_core_subnet (public, route table + security list)
                    └─ oci_core_instance (A1.Flex, Ubuntu 24.04, cloud-init user_data)
```

Instance lifecycle: `ignore_changes = [source_details[0].source_id, metadata["user_data"]]`,
`preserve_boot_volume = false` (teardown removes everything, SC-006).

## Private settings bundle (never in Terraform)

| Local path | Server path | Owner | Mode |
| --- | --- | --- | --- |
| `config.json` | `/opt/mail-me/config.json` | 1000:1000 | 600 |
| `.env` | `/opt/mail-me/.env` | root:root | 600 |
| `data/grants/*.json` | `/opt/mail-me/data/grants/*.json` | 1000:1000 | 600 (dir 700) |
| — | `/opt/mail-me/data/mail-me.db*` | 1000:1000 | created by app |

## Server states

```text
booting → cloud-init done (Docker, source, image built; waiting for settings)
        → push-config ok → running (restart: unless-stopped)
running → push-config with invalid config → still running on previous settings (upload rejected)
running → reboot → running (Docker restarts container)
```
