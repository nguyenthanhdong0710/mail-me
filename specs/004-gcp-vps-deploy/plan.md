# Implementation Plan: Google Cloud Free Tier and Any-VPS Hosting

**Branch**: `004-gcp-vps-deploy` | **Date**: 2026-11-26 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/004-gcp-vps-deploy/spec.md`

## Summary

Introduce `deploy/linux/` as the single install path for every target:

- `server-setup.sh` runs **on** the server as root in two phases: `system` (OS/arch check,
  Docker Engine + Compose plugin from Docker's apt repo, swap on < 2 GB machines, Oracle FORWARD
  fix, `/opt/mail-me/data` for uid 1000) and `app` (build image, start if settings exist).
- `install.sh` runs on the user's computer: one SSH connection, runs `system`, streams the code
  bundle (git-tracked + untracked-not-ignored files, secrets filtered out) into `/opt/mail-me`
  replacing old code but keeping `config.json`, `.env`, `data/`, then runs `app`. Re-running = update.
- `push-config.sh` and `backup.sh` move here from `deploy/oci/`, work as root or sudo user, and
  `push-config.sh` checks for an installed server instead of waiting for cloud-init.
- `lib.sh` holds shared SSH and root/sudo helpers.

Add `deploy/gcp/` (Terraform, `hashicorp/google ~> 8.0`): Compute API enablement, dedicated
VPC + subnet, SSH-only firewall, one `e2-micro` Ubuntu 24.04 instance with a `pd-standard` disk
≤ 30 GB in us-west1/us-central1/us-east1, SSH key in metadata. Remove cloud-init/repo variables
from `deploy/oci/`. Rewrite the README hosting section as a "Where to host" comparison with
links to `deploy/linux`, `deploy/gcp`, `deploy/oci` guides.

## Technical Context

**Language/Version**: Bash (scripts, must also run on macOS bash 3.2 locally), HCL (Terraform ≥ 1.7).

**Primary Dependencies**: `hashicorp/google ~> 8.0` (8.12.0 locked), `oracle/oci ~> 7.0`;
Docker Engine, `docker-compose-plugin`, `docker-buildx-plugin` from download.docker.com.

**Storage**: Server disk (`/opt/mail-me/data`); Terraform state local, no secrets.

**Testing**: `terraform fmt/validate/test` (mocked providers) for oci and gcp; `shellcheck`;
`server-setup.sh check` run in `ubuntu:22.04`, `ubuntu:24.04`, `debian:12`, `debian:13` (pass) and
`fedora`/`alpine` (refuse); `install.sh --dry-run` bundle listing asserts no secrets. Manual E2E
per quickstart.

**Target Platform**: Ubuntu 22.04/24.04, Debian 12/13, x86-64 or arm64. Client: Linux/macOS/WSL.

**Project Type**: Deployment tooling (scripts + IaC + docs) for the existing single-process service.

**Constraints**: GCP free tier (1 e2-micro, 30 GB pd-standard, us-west1/us-central1/us-east1);
private repository (no clone on server); secrets never in bundles or state; idempotent re-runs.

**Scale/Scope**: 5 scripts, 1 new Terraform module (~6 files + tests), OCI module trimmed, 4 docs.

## Constitution Check

| Principle / Rule | Status | Notes |
| --- | --- | --- |
| I. Self-Hosted & Privacy-First | ✅ | Every target is a machine the user controls; code comes from the user's own checkout. |
| II. Deterministic First | ✅ | N/A (no LLM). |
| III. Never Lose Mail | ✅ | Update keeps `data/`; `ignore_changes` on boot images; settings validated before replacement (unchanged). |
| IV. Untrusted Input | ✅ | Scripts quote inputs; Terraform inputs validated. |
| V. Modular, Testable | ✅ | Mocked Terraform tests, shellcheck, OS-check container tests, bundle dry-run test in CI. |
| VI. Config as Contract | ✅ | Typed/validated Terraform variables; `check-config` gate kept. |
| VII. Simplicity | ✅ (justified) | One shared path replaces cloud-init clone logic; see Complexity Tracking. |
| Security: secrets | ✅ | Bundle excludes ignored files + explicit secret filter; SSH-only ingress. |
| Security: pinned deps | ✅ | Provider lock files committed; Docker from its signed apt repo. |

Post-design re-check: passing.

## Project Structure

### Documentation (this feature)

```text
specs/004-gcp-vps-deploy/
├── plan.md, research.md, data-model.md, quickstart.md, tasks.md
└── contracts/
    ├── linux-scripts.md
    └── gcp-terraform.md
```

### Source Code (repository root)

```text
deploy/linux/
├── README.md          # any Linux server / VPS guide (also used by the cloud guides)
├── lib.sh             # shared ssh + root/sudo helpers
├── server-setup.sh    # runs on the server: check | system | app
├── install.sh         # install or update from this computer
├── push-config.sh     # moved from deploy/oci/
├── backup.sh          # moved from deploy/oci/
└── tests/
    └── test-scripts.sh  # OS-check matrix + bundle dry-run assertions
deploy/gcp/
├── README.md, versions.tf, providers.tf, variables.tf, network.tf, compute.tf, outputs.tf
├── terraform.tfvars.example, .terraform.lock.hcl
└── tests/free_tier.tftest.hcl
deploy/oci/             # cloud-init.yaml.tftpl, repo_url/repo_ref, push-config.sh, backup.sh removed
README.md               # "Where to host" section
.github/workflows/ci.yml  # infra job covers gcp + linux script tests
```

**Structure Decision**: `deploy/linux` is the shared layer; cloud folders only create a server.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
| --- | --- | --- |
| Second Terraform module (GCP) | User cannot sign up for Oracle; GCP is the remaining free VM | Manual console steps are error-prone and hard to tear down |
