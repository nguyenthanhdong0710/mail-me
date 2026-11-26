# Contract: Terraform module `deploy/oci`

## Inputs

See [data-model.md](../data-model.md#deployment-inputs-terraform-variables-non-secret). Required:
`tenancy_ocid`, `region`, `ssh_public_key`. Everything else has a free-tier-safe default.

## Outputs

| Output | Example | Purpose |
| --- | --- | --- |
| `public_ip` | `141.147.1.2` | Server address |
| `ssh_command` | `ssh ubuntu@141.147.1.2` | Ready-to-use SSH command (FR-008) |
| `push_config_command` | `deploy/linux/push-config.sh ubuntu@141.147.1.2` | Next step |
| `instance_ocid` | `ocid1.instance.oc1...` | For console / CLI lookups |

## Guarantees (verified by `tests/free_tier.tftest.hcl`)

1. A plan with defaults creates exactly: 1 VCN, 1 internet gateway, 1 route table, 1 security list,
   1 subnet, 1 instance.
2. Instance shape is `VM.Standard.A1.Flex` with the requested OCPU/memory.
3. `ocpus > 4`, `memory_in_gbs > 24`, `boot_volume_size_in_gbs > 200` or `< 50` fail the plan
   with a message containing "Always Free".
4. Security list has exactly one ingress TCP rule, on port 22 only.
5. Rendered `user_data` contains the repo URL and ref and no secret placeholders.
6. Variables contain no secret-typed input; no output is sensitive because none carries a secret.

## Failure behavior

- Invalid sizes: plan fails before any API call.
- "Out of host capacity": `apply` fails at the instance; network resources remain and a re-run
  of `apply` (optionally with another `availability_domain_index`) only retries the instance.
