# Contract: Terraform module `deploy/gcp`

Inputs: see [data-model.md](../data-model.md#gcp-deployment-inputs-non-secret). Required:
`project_id`, `ssh_public_key`.

## Outputs

| Output | Example |
| --- | --- |
| `public_ip` | `34.123.45.67` |
| `ssh_command` | `ssh ubuntu@34.123.45.67` |
| `install_command` | `deploy/linux/install.sh ubuntu@34.123.45.67` |
| `push_config_command` | `deploy/linux/push-config.sh ubuntu@34.123.45.67` |

## Guarantees (verified by `deploy/gcp/tests/free_tier.tftest.hcl`)

1. Defaults plan: machine `e2-micro`, disk `pd-standard` 30 GB, zone `us-central1-a`, image
   family Ubuntu 24.04.
2. `region = "asia-southeast1"`, `disk_size_gb = 31` or `9` fail before apply; messages mention
   "free tier".
3. Zone defaults per region (`us-west1-b`, `us-east1-b`); a zone outside the region fails.
4. Firewall allows only `tcp` port `22`, from `ssh_source_cidr`, to tag `mail-me`.
5. Instance metadata carries `ubuntu:<key>`, blocks project keys, and has no startup script.
6. Compute API service has `disable_on_destroy = false`.
