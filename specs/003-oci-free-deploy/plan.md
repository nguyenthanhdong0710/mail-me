# Implementation Plan: Free Cloud Hosting on Oracle Cloud Always Free

**Branch**: `003-oci-free-deploy` | **Date**: 2026-11-26 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/003-oci-free-deploy/spec.md`

## Summary

Add an optional, self-contained deployment under `deploy/oci/`: a Terraform root module (OCI
provider) that creates a VCN, public subnet, internet gateway, route table, an SSH-only security
list and one `VM.Standard.A1.Flex` Ubuntu 24.04 instance kept inside the Always Free limits by
variable validation. Cloud-init installs Docker and the Compose plugin from Ubuntu's archive,
clones the repository into `/opt/mail-me`, prepares `data/` for uid 1000, and builds the image.
Secrets never enter Terraform: a shell helper (`push-config.sh`) streams `config.json`, `.env`
and `data/grants/` over SSH into a staging folder, validates them with `check-config` inside the
container, then moves them into place and runs `docker compose up -d`. A second helper
(`backup.sh`) pulls a consistent copy of `data/`. The README gets a "Free hosting" section that
recommends this path, explains why Vercel/serverless does not fit, and links to
`deploy/oci/README.md`. CI gains an `infra` job: `terraform fmt -check`, `validate`,
`terraform test` (mocked provider) and `shellcheck`.

## Technical Context

**Language/Version**: HCL for Terraform ≥ 1.7 (needs `mock_provider` in `terraform test`); POSIX
`bash` for helpers; cloud-init `#cloud-config` YAML. No TypeScript changes.

**Primary Dependencies**: `oracle/oci` Terraform provider (pinned `~> 7.0`, lock file committed);
Ubuntu 24.04 packages `docker.io` and `docker-compose-v2`; the project's existing `Dockerfile`
and `docker-compose.yml`.

**Storage**: The instance boot volume holds `/opt/mail-me/data` (SQLite + grants). Terraform state
is local (or managed by OCI Resource Manager) and contains no secrets.

**Testing**: `terraform fmt -check -recursive`, `terraform validate`, `terraform test` with a
mocked `oci` provider (variable validation, security list, outputs, user_data contents),
`shellcheck` for helpers, manual end-to-end per [quickstart.md](quickstart.md).

**Target Platform**: Oracle Cloud Infrastructure, Always Free tier, Ampere A1 (arm64), Ubuntu
24.04. Helpers run on Linux/macOS/WSL with `ssh` and `tar`.

**Project Type**: Deployment tooling (infrastructure as code + scripts + docs) for the existing
single-process service.

**Performance Goals**: Provision and first boot in ≤ 10 minutes; service back within 5 minutes of
a reboot (SC-005).

**Constraints**: Stay inside Always Free (≤ 4 OCPU, ≤ 24 GB memory, ≤ 200 GB block storage); only
TCP 22 inbound; no secret in variables or state; changing the image or cloud-init must not
replace the instance (it would destroy `data/`).

**Scale/Scope**: One instance per stack; ~6 Terraform files, 2 scripts, 1 cloud-init template,
2 docs, 1 CI job.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle / Rule | Status | Notes |
| --- | --- | --- |
| I. Self-Hosted & Privacy-First | ✅ | The VM is in the user's own tenancy; still one process + local SQLite; no new data flows. |
| II. Deterministic First | ✅ | No LLM involvement. |
| III. Never Lose Mail | ✅ | Restart policy and helper keep the existing DB; `ignore_changes` prevents instance replacement; invalid config is rejected before it replaces the running one. |
| IV. Untrusted Input | ✅ | N/A to email handling; scripts quote all inputs. |
| V. Modular, Testable | ✅ | Terraform tests with mocked provider + shellcheck in CI. No app modules touched. |
| VI. Type Safety & Config as Contract | ✅ | Terraform variables are typed and validated; `check-config` gates every upload. |
| VII. Simplicity & Observability | ✅ (justified) | New infra is opt-in deployment tooling only; see Complexity Tracking. Logs via `docker compose logs`. |
| Security: secrets outside git/state | ✅ | Secrets streamed over SSH; owner-only perms; grants 0600 in 0700 dir. |
| Security: pinned deps | ✅ | Provider version constraint + committed `.terraform.lock.hcl`. |
| Workflow: Conventional Commits, CI gates | ✅ | New CI job. |

Post-design re-check: no change, still passing.

## Project Structure

### Documentation (this feature)

```text
specs/003-oci-free-deploy/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── terraform-interface.md
│   └── helper-scripts.md
└── tasks.md
```

### Source Code (repository root)

```text
deploy/oci/
├── README.md                 # deployment guide (prereqs, provision, upload, sign-in, ops, gotchas)
├── versions.tf               # terraform + provider constraints
├── providers.tf              # provider "oci" { region }
├── variables.tf              # typed, validated inputs (Always Free limits)
├── network.tf                # VCN, IGW, route table, security list, subnet
├── compute.tf                # image lookup, availability domain, instance
├── outputs.tf                # public_ip, ssh_command, next_steps
├── cloud-init.yaml.tftpl     # first-boot setup (Docker, clone, data/)
├── terraform.tfvars.example  # non-secret example inputs
├── .terraform.lock.hcl       # provider lock
├── tests/
│   └── free_tier.tftest.hcl  # mocked-provider tests
├── push-config.sh            # upload + validate + (re)start
└── backup.sh                 # pull a consistent copy of data/

README.md                     # new "Free hosting (Oracle Cloud)" section + why not serverless
.github/workflows/ci.yml      # new `infra` job
.gitignore                    # terraform state, .terraform/, *.tfvars (keep example)
.dockerignore                 # exclude deploy/
```

**Structure Decision**: Everything lives under `deploy/oci/` so the Terraform folder can be zipped
and uploaded to OCI Resource Manager as-is and so the app build ignores it. Scripts sit next to
the Terraform they complement.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
| --- | --- | --- |
| New infrastructure (Terraform, cloud VM) | Users need an always-on free host; the app itself is unchanged and the folder is optional | Manual console steps are slow and error-prone; serverless (Vercel) cannot run a long-lived poller with a persistent local DB |

> **Superseded in part by [004](../004-gcp-vps-deploy/plan.md):** the helpers moved to
> `deploy/linux/`, and the server is set up by `deploy/linux/install.sh` over SSH instead of
> cloud-init cloning the (private) repository.
