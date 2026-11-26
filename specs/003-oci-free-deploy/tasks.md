---
description: "Task list for 003 Free Cloud Hosting on Oracle Cloud Always Free"
---

# Tasks: Free Cloud Hosting on Oracle Cloud Always Free

**Input**: Design documents from `/specs/003-oci-free-deploy/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: Required by constitution V (new behavior needs automated tests): Terraform tests with a
mocked provider and shellcheck.

## Format: `[ID] [P?] [Story] Description`

## Phase 1: Setup

- [X] T001 Create `deploy/oci/` and `deploy/oci/tests/`; add Terraform ignores (`.terraform/`, `*.tfstate*`, `*.tfvars` except `*.tfvars.example`, `*.tfplan`) to `.gitignore`
- [X] T002 [P] Add `deploy/` to `.dockerignore` so the image build ignores deployment files
- [X] T003 [P] Create `deploy/oci/versions.tf` (`required_version >= 1.7`, `oracle/oci ~> 7.0`) and `deploy/oci/providers.tf` (`provider "oci" { region = var.region }`)

## Phase 2: Foundational

- [X] T004 Create `deploy/oci/variables.tf` with every input from data-model.md, quoting the rules: `tenancy_ocid` "starts with `ocid1.tenancy.`"; `compartment_ocid` default `""` → tenancy, "empty or starts with `ocid1.`"; `ssh_public_key` "starts with `ssh-` or `ecdsa-`"; `ssh_source_cidr` default `0.0.0.0/0`, "valid IPv4 CIDR"; `ocpus` default 1, "1–4 (Always Free A1 total)"; `memory_in_gbs` default 6, "1–24"; `boot_volume_size_in_gbs` default 50, "50–200"; `availability_domain_index` default 0, "≥ 0"; `image_ocid` default `""`, "empty or starts with `ocid1.image.`"; `repo_url` default project HTTPS URL, "starts with `https://` or `git@`"; `repo_ref` default `main`; `display_name` default `mail-me`, "1–63 chars `[a-zA-Z0-9-]`". Size error messages must contain "Always Free".
- [X] T005 Run `terraform init -backend=false` in `deploy/oci/` and commit `deploy/oci/.terraform.lock.hcl` (with `linux_amd64`, `linux_arm64`, `darwin_arm64` hashes)

## Phase 3: User Story 1 - Create a free, always-on server from code (P1) 🎯 MVP

**Goal**: One apply creates an SSH-only network and an Always Free A1 Ubuntu VM with Docker and the source ready.

**Independent Test**: `terraform test` passes; on a real tenancy, SSH in and see Docker and `/opt/mail-me`; nmap shows only 22.

- [X] T006 [P] [US1] Write `deploy/oci/tests/free_tier.tftest.hcl` with `mock_provider "oci"` and `override_data` for images and availability domains, covering contract guarantees 1–6 in `contracts/terraform-interface.md` (resource counts, shape/size, `expect_failures` for ocpus=5, memory=32, boot=250, boot=40, one ingress TCP rule on port 22, user_data contains repo URL/ref)
- [X] T007 [P] [US1] Create `deploy/oci/network.tf`: VCN `10.0.0.0/16`, internet gateway, route table `0.0.0.0/0` → IGW, security list (egress all; ingress TCP 22 from `var.ssh_source_cidr`; ICMP type 3 code 4), public subnet `10.0.0.0/24`; all with `freeform_tags = { app = "mail-me" }`
- [X] T008 [P] [US1] Create `deploy/oci/cloud-init.yaml.tftpl`: install `docker.io`, `docker-compose-v2`, `git`; enable Docker; add `ubuntu` to `docker` group; clone `repo_url`@`repo_ref` to `/opt/mail-me`; `data/` owned 1000:1000 mode 700; `docker compose build`; `docker compose up -d` only if `config.json` and `.env` exist
- [X] T009 [US1] Create `deploy/oci/compute.tf`: availability domains data source, Ubuntu 24.04 A1 image lookup (newest first, `image_ocid` override), `oci_core_instance` with `shape_config`, boot volume size, `ssh_authorized_keys`, base64 `templatefile` user_data, `preserve_boot_volume = false`, `lifecycle.ignore_changes = [source_details[0].source_id, metadata["user_data"]]`, preconditions for memory ≤ 64 × ocpus, AD index in range, image found
- [X] T010 [P] [US1] Create `deploy/oci/outputs.tf` with `public_ip`, `ssh_command`, `push_config_command`, `instance_ocid`
- [X] T011 [P] [US1] Create `deploy/oci/terraform.tfvars.example` with non-secret placeholders and comments
- [X] T012 [US1] Run `terraform fmt -check`, `terraform validate`, `terraform test` in `deploy/oci/` and fix failures

## Phase 4: User Story 2 - Upload private settings and start the service (P1)

**Goal**: One helper uploads secrets with private permissions, validates, and starts the service.

**Independent Test**: shellcheck passes; on a real VM, valid config → running; broken config → exit 4, previous service untouched.

- [X] T013 [US2] Create `deploy/linux/push-config.sh` per `contracts/helper-scripts.md` (options, exit codes 2/3/4, staging under `<dir>/.staging` mode 700, `check-config` with staging mounts, install modes: `config.json` 1000:1000 600, `.env` root 600, grants 1000:1000 600 in 700 dir; `docker compose up -d`); make it executable
- [X] T014 [US2] Run `shellcheck deploy/linux/push-config.sh` and fix findings

## Phase 5: User Story 3 - Know where to host and avoid the traps (P2)

**Goal**: README recommends OCI, explains why not serverless; guide documents everything.

**Independent Test**: Reader can answer "why not Vercel?" from README and reach a running service via the guide alone.

- [X] T015 [P] [US3] Write `deploy/oci/README.md`: prerequisites (account, home region, API key or Resource Manager), provision locally and via Resource Manager (zip folder), outputs, `push-config.sh`, signing in (local then upload; SSH port forward for Gmail; device code for Microsoft), logs, update, backup, teardown, gotchas (Out of host capacity, idle reclamation + Pay As You Go + budget alert, fixed home region, per-account limits), security notes
- [X] T016 [P] [US3] Update `README.md` Step 7: add "Free hosting: Oracle Cloud Always Free" option linking to `deploy/oci/README.md`, and a short "Why not Vercel or other serverless?" note (long-running poller, persistent writable disk for SQLite and grants, Hobby cron once a day)

## Phase 6: User Story 4 - Update, back up and remove (P3)

**Goal**: Day-two operations.

**Independent Test**: backup produces a private archive; update keeps data; destroy removes all resources.

- [X] T017 [US4] Create `deploy/linux/backup.sh` per `contracts/helper-scripts.md` (stop, stream tar.gz, `umask 077`, restart via trap); make it executable; shellcheck it
- [X] T018 [US4] Document update (`ssh … 'cd /opt/mail-me && git pull && sudo docker compose up -d --build'`), backup and `terraform destroy` in `deploy/oci/README.md`

## Phase 7: Polish & Cross-Cutting

- [X] T019 Add an `infra` job to `.github/workflows/ci.yml`: `hashicorp/setup-terraform`, `fmt -check -recursive`, `init -backend=false`, `validate`, `test`, and `shellcheck deploy/oci/*.sh`
- [X] T020 Run `npx prettier --check .` (format new markdown/yaml), `npm run lint`, and `npm test` to make sure nothing else regressed
- [X] T021 Walk through `specs/003-oci-free-deploy/quickstart.md` offline checks and mark the manual end-to-end steps as pending user verification (offline checks pass; real-tenancy steps 1–10 pending)

## Dependencies

- Setup (T001–T003) → Foundational (T004–T005) → US1 (T006–T012) → US2 (T013–T014)
- US3 (T015–T016) can start after US1 design is fixed; US4 (T017–T018) after US2
- Polish after all stories

## Parallel Examples

- US1: T006, T007, T008, T010, T011 in parallel; then T009; then T012
- US3: T015 and T016 in parallel

## Implementation Strategy

MVP = US1 + US2 (a running service on a free VM). Then US3 docs, US4 operations, then CI polish.
