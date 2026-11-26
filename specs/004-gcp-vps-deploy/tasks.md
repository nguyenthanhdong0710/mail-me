---
description: "Task list for 004 Google Cloud Free Tier and Any-VPS Hosting"
---

# Tasks: Google Cloud Free Tier and Any-VPS Hosting

**Input**: Design documents from `/specs/004-gcp-vps-deploy/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: Required by constitution V: mocked Terraform tests, shellcheck, script tests.

## Phase 1: Setup

- [X] T001 Create `deploy/linux/`, `deploy/linux/tests/`, `deploy/gcp/`, `deploy/gcp/tests/`; `git mv`-equivalent move of `deploy/oci/push-config.sh` and `deploy/oci/backup.sh` to `deploy/linux/`

## Phase 2: Foundational

- [X] T002 Create `deploy/linux/lib.sh`: `ssh_setup` (ControlMaster in a temp dir, cleanup trap), `remote`, `detect_root` (sets `AS_ROOT` to "" for uid 0, "sudo" when `sudo -n true` works, else exit 1 "needs root or password-less sudo"), shared option parsing for `-i` and `--dir`; bash 3.2 safe
- [X] T003 Create `deploy/linux/server-setup.sh` with phases `check|system|app` per `contracts/linux-scripts.md`: OS "ubuntu 22.04, 24.04, debian 12, 13" and arch "x86_64, aarch64" (exit 5 otherwise); cloud-init wait; apt `DPkg::Lock::Timeout=600`; Docker repo install if `docker compose version` fails; swap 2 GB "if MemTotal < 2 GB and no swap"; FORWARD REJECT removal only if present; `<dir>/data` "1000:1000, 700"; `app` builds `mail-me:latest` and runs `docker compose up -d --force-recreate mail-me` only if `config.json` and `.env` exist

## Phase 3: User Story 1 - Install on any Linux server (P1) 🎯 MVP

**Independent Test**: fresh VPS → install → push-config → report.

- [X] T004 [P] [US1] Write `deploy/linux/tests/test-scripts.sh`: run `server-setup.sh check` in `ubuntu:22.04`, `ubuntu:24.04`, `debian:12`, `debian:13` (expect 0) and `fedora:41`, `alpine:3` (expect 5); copy repo to temp, add fake `config.json`, `.env`, `.env.local`, `data/mail-me.db`, `deploy/gcp/terraform.tfstate`, run `install.sh --dry-run`, assert none listed and `.env.example`, `Dockerfile` listed; also test a non-git copy
- [X] T005 [US1] Create `deploy/linux/install.sh` per contract (bundle from `git ls-files -z --cached --others --exclude-standard` + explicit secret filter, non-git fallback with excludes; stream to `<dir>/.code-new`; swap in keeping `config.json`, `.env`, `data`, `.staging`; run `system` then `app`; next-step message; `--dry-run`)
- [X] T006 [US1] Update `deploy/linux/push-config.sh`: source `lib.sh`, use `AS_ROOT`, replace cloud-init wait with installed check (exit 3 "Run deploy/linux/install.sh <host> first"), update help paths
- [X] T007 [US1] Update `deploy/linux/backup.sh`: source `lib.sh`, use `AS_ROOT`
- [X] T008 [US1] Run shellcheck on `deploy/linux/*.sh deploy/linux/tests/*.sh` and `deploy/linux/tests/test-scripts.sh`; fix failures
- [X] T009 [US1] Write `deploy/linux/README.md`: requirements (OS list, ≥ 1 GB RAM, 10 GB disk, SSH key, root or sudo), provider examples (Singapore VPS, Vietnamese providers, home machine), install, push-config, sign-in on server, logs, update (re-run install), backup/restore, firewall advice (ufw allow OpenSSH), troubleshooting

## Phase 4: User Story 2 - Google Cloud free tier (P1)

**Independent Test**: `terraform test` passes; real project → install → report; $0 billing.

- [X] T010 [P] [US2] Create `deploy/gcp/versions.tf` (`>= 1.7`, `hashicorp/google ~> 8.0`) and `providers.tf` (`project`, `region`)
- [X] T011 [P] [US2] Create `deploy/gcp/variables.tf` per data-model: `project_id` "^[a-z][a-z0-9-]{4,28}[a-z0-9]$"; `region` "one of us-west1, us-central1, us-east1" default `us-central1`; `zone` "empty or starts with <region>-"; `ssh_user` default `ubuntu` "^[a-z_][a-z0-9_-]{0,31}$"; `ssh_public_key`; `ssh_source_cidr` default `0.0.0.0/0`; `disk_size_gb` default 30 "10–30"; `display_name` default `mail-me`
- [X] T012 [P] [US2] Write `deploy/gcp/tests/free_tier.tftest.hcl` covering guarantees 1–6 in `contracts/gcp-terraform.md`
- [X] T013 [US2] Create `deploy/gcp/network.tf` (compute API service, VPC, subnet `10.10.0.0/24`, firewall tcp:22) and `deploy/gcp/compute.tf` (e2-micro, pd-standard, Ubuntu 24.04 family, ephemeral IP, metadata ssh-keys/block-project-ssh-keys/enable-oslogin FALSE, labels, ignore image changes, zone precondition)
- [X] T014 [P] [US2] Create `deploy/gcp/outputs.tf` and `deploy/gcp/terraform.tfvars.example`
- [X] T015 [US2] `terraform init` + lock (linux/darwin amd64/arm64), fmt, validate, test in `deploy/gcp/`
- [X] T016 [US2] Write `deploy/gcp/README.md`: account + billing + project, gcloud ADC login, apply, install + push-config via `deploy/linux`, free-tier rules (one e2-micro per billing account, pd-standard only, US regions, 1 GB egress), budget alert, teardown, troubleshooting

## Phase 5: User Story 3 - Oracle uses the shared path (P2)

- [X] T017 [US3] Remove `deploy/oci/cloud-init.yaml.tftpl`, `user_data`, `repo_url`, `repo_ref` and the user_data ignore; add `install_command` output; point `push_config_command` to `deploy/linux/`
- [X] T018 [US3] Update `deploy/oci/tests/free_tier.tftest.hcl` (drop user_data/repo tests; assert no `user_data`) and run fmt/validate/test
- [X] T019 [US3] Update `deploy/oci/README.md` and `deploy/oci/.terraformignore` to the shared flow; update 003 spec docs' script paths

## Phase 6: User Story 4 - Where to host (P2)

- [X] T020 [US4] Rewrite README Step 7 intro + Option D into a "Where to host" comparison (home machine, Oracle Always Free, Google Cloud free tier, any VPS: cost, sign-up, limitation, guide link) keeping "Why not Vercel"

## Phase 7: Polish

- [X] T021 Update `.github/workflows/ci.yml` `infra` job: oci + gcp Terraform checks, shellcheck `deploy/linux`, run `deploy/linux/tests/test-scripts.sh`
- [X] T022 Run prettier check, lint, unit tests; mark quickstart manual steps as pending user verification (all pass; container E2E on Ubuntu 24.04 sudo user and Debian 12 root passed; real GCP/VPS runs pending)

## Dependencies

Setup → Foundational (T002–T003) → US1 (T004–T009) → US2 (T010–T016, parallel with US1 after T003) → US3 → US4 → Polish.

## Implementation Strategy

MVP = US1 (works on any server, including the GCP one created by hand). Then US2 Terraform, US3, docs.
