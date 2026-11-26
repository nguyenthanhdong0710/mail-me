# Feature Specification: Google Cloud Free Tier and Any-VPS Hosting

**Feature Branch**: `004-gcp-vps-deploy`

**Created**: 2026-11-26

**Status**: Draft

**Input**: User description: "Add two more hosting targets for mail-me and unify deployment around one generic Linux path. (1) Any Linux VPS (Ubuntu 22.04/24.04 or Debian 12/13, anywhere, e.g. a Singapore or Vietnamese provider, or a home machine reachable by SSH): a laptop-side install script that prepares the server over SSH (Docker Engine + Compose from Docker's official apt repo, swap on small-memory machines, data/ for uid 1000), uploads the source from the local checkout (the GitHub repo is private, so no git clone on the server), builds the image, and starts the service if settings are present; re-running it updates. push-config.sh and backup.sh move to deploy/linux/ and work with root or a sudo user on any such server. (2) Google Cloud free tier: Terraform under deploy/gcp/ creating one e2-micro VM in us-west1/us-central1/us-east1 with a standard persistent disk ≤30 GB, Ubuntu 24.04, a dedicated network with SSH-only firewall, and the SSH key in metadata; sizes/regions outside the free tier are rejected; then the same install + push-config flow. Oracle (deploy/oci) switches to the same flow (no repo clone in cloud-init). Update the main README with a 'where to host' recommendation covering home machine, Oracle Always Free, Google Cloud free tier and any VPS, keeping the 'why not Vercel' note, with links to each guide."

## Context

Feature 003 added Oracle Cloud Always Free hosting, but Oracle sign-up is often rejected (the
user hit this three times), and the server-side `git clone` cannot work because the repository
is private. This feature adds Google Cloud's free tier and "any Linux server" as targets, and
makes all targets share one install path that does not depend on the repository being public.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Install on any Linux server I can SSH into (Priority: P1)

A self-hoster has a Linux server: a cheap VPS in Singapore or Vietnam, a home mini PC, or a cloud
VM. From their own computer, in the mail-me folder, they run one install command with the server
address. It prepares the server, copies the code from their computer, builds mail-me there, and
leaves it ready for their settings. They then upload their settings with the existing helper
and mail-me starts.

**Why this priority**: It works with every provider, including the free and cheap ones the user is
now choosing between, and it is the path every other target uses.

**Independent Test**: Take a fresh Ubuntu 24.04 or Debian 12 server with only SSH access, run the
install command and then the settings upload, send a test email, and receive its report.

**Acceptance Scenarios**:

1. **Given** a fresh supported server reachable as root or as a user with sudo, **When** the user
   runs the install command, **Then** the container runtime is installed, the code from the
   user's computer is on the server, the image is built, and the command says the next step is
   uploading settings.
2. **Given** a server with less than 2 GB of memory, **When** the install runs, **Then** swap
   space is added so the build does not run out of memory.
3. **Given** an installed server with settings, **When** the user runs the install command again
   after pulling new code, **Then** the new version is built and running, settings and the
   database are kept, and no email is reported twice.
4. **Given** an unsupported system (not Ubuntu 22.04/24.04 or Debian 12/13), **When** the install
   runs, **Then** it stops before changing anything and names the supported systems.
5. **Given** the user's local folder has secrets (`config.json`, `.env`, `data/`), **When** the
   code is uploaded, **Then** none of those files are part of the code upload.

---

### User Story 2 - Free server on Google Cloud (Priority: P1)

A user without an Oracle account creates a Google Cloud free-tier server with one provisioning
command, then uses the same install and settings commands as any other server.

**Why this priority**: It is the free option the user can actually sign up for.

**Independent Test**: Apply the definition to a Google Cloud project with billing enabled, run
install and settings upload against the printed address, receive a report, and confirm in the
billing report that compute charges are zero.

**Acceptance Scenarios**:

1. **Given** a Google Cloud project and an SSH public key, **When** the user provisions with
   defaults, **Then** one free-tier-eligible server is created in a free-tier region with a
   free-tier disk, and its address and the next commands are printed.
2. **Given** a region outside the free tier or a disk larger than 30 GB, **When** the user
   provisions, **Then** it stops before creating anything, with a message naming the free-tier
   limit.
3. **Given** the provisioned server, **When** it is scanned from outside, **Then** only SSH
   answers.
4. **Given** provisioned resources, **When** the user tears down, **Then** all of them are removed.

---

### User Story 3 - Oracle uses the same path (Priority: P2)

Oracle users follow the same install and settings steps as everyone else, so the private
repository no longer breaks the Oracle setup.

**Why this priority**: It fixes a real defect in feature 003 but only matters to users who could
sign up with Oracle.

**Independent Test**: Provision on Oracle, run install and settings upload, receive a report.

**Acceptance Scenarios**:

1. **Given** a newly provisioned Oracle server, **When** it boots, **Then** it does not try to
   clone the repository.
2. **Given** that server, **When** the user runs install and settings upload, **Then** mail-me runs.

---

### User Story 4 - Know where to host (Priority: P2)

A reader of the main README sees a short recommendation of where to run mail-me (own machine,
Oracle Always Free, Google Cloud free tier, any VPS), with the trade-offs and a link to each
guide, plus why serverless platforms such as Vercel do not fit.

**Why this priority**: Helps users choose, but the deployments work without it.

**Independent Test**: A reader can pick an option and reach its guide in one click, and can
answer "why not Vercel?" from the README.

**Acceptance Scenarios**:

1. **Given** the README hosting section, **When** a reader compares options, **Then** each option
   shows cost, sign-up difficulty and main limitation, and links to its guide.

---

### Edge Cases

- The server user has no sudo or a sudo password: install says so and stops.
- Logging in as root on a minimal system without `sudo`: everything works without it.
- The local folder is not a git checkout (e.g. a downloaded zip): the upload falls back to
  copying the folder minus secrets and build output.
- Docker is already installed on the server (e.g. a home machine): it is reused, not reinstalled.
- The server already has swap: no extra swap is added.
- Settings are uploaded before install: the settings helper says to run install first.
- The Google Cloud project already uses its one free e2-micro: documented as the user's
  responsibility (the limit is per billing account).
- Google Cloud's outbound data allowance (1 GB/month): mail-me's traffic is small; documented.
- Install is interrupted halfway: running it again completes it.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: A single install command MUST prepare a supported server over SSH, upload the code
  from the user's computer, build mail-me, and start it if settings are already present.
- **FR-002**: Supported systems MUST be Ubuntu 22.04, Ubuntu 24.04, Debian 12 and Debian 13 on
  x86-64 or Arm64; others MUST be refused before any change.
- **FR-003**: Install MUST work when logged in as root, or as a user with password-less sudo.
- **FR-004**: Install MUST add swap on servers with less than 2 GB of memory and no swap.
- **FR-005**: Re-running install MUST update the code and rebuild while keeping settings, the
  database and sign-ins.
- **FR-006**: The code upload MUST NOT include `config.json`, `.env`, `data/` or any file the
  repository ignores.
- **FR-007**: The settings and backup helpers MUST work on any server prepared by install, as root
  or a sudo user, and the settings helper MUST tell the user to run install first if needed.
- **FR-008**: The repository MUST provide an infrastructure-as-code definition for Google Cloud
  that creates one e2-micro server with Ubuntu 24.04 in us-west1, us-central1 or us-east1, a
  standard disk of at most 30 GB, a dedicated network, and a firewall allowing only SSH from a
  configurable source.
- **FR-009**: The Google Cloud definition MUST reject non-free-tier regions and disks over 30 GB
  before creating anything, MUST print the server address and next commands, and MUST be fully
  removable with one tear-down command.
- **FR-010**: No secret MAY be a provisioning input or appear in provisioning state, on any target.
- **FR-011**: The Oracle definition MUST no longer clone the repository on first boot; its guide
  MUST use the shared install path.
- **FR-012**: Each target MUST have a guide: any Linux server, Google Cloud, Oracle; the main
  README MUST recommend where to host, compare the options and link to each guide, and keep the
  "why not serverless" explanation.
- **FR-013**: All definitions and scripts MUST be checked automatically (format, validation, tests,
  shell lint).

### Key Entities

- **Server**: any supported Linux machine reachable over SSH; may come from Oracle, Google Cloud,
  a VPS provider or the user's home.
- **Code bundle**: the mail-me source from the user's computer, minus secrets and ignored files.
- **Private settings bundle**: `config.json`, `.env`, `data/grants/` (unchanged from 003).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: From a fresh server with SSH access and prepared settings, a user receives the first
  report in under 20 minutes using two commands (install, settings upload).
- **SC-002**: Install succeeds on all four supported systems.
- **SC-003**: Google Cloud deployment with defaults costs $0 in compute and disk per month.
- **SC-004**: An update (re-run install) causes 0 duplicate reports and keeps 100% of settings and
  sign-ins.
- **SC-005**: 0 secret files are present in the code upload or in any provisioning state.
- **SC-006**: A network scan of a Google Cloud server shows exactly one open port (SSH).

## Assumptions

- The user runs the commands from a Linux, macOS or WSL computer with `ssh`, `tar` and (for
  cloud targets) Terraform; Google Cloud users have a project with billing enabled and are signed
  in with `gcloud auth application-default login`.
- Google Cloud's free tier covers one e2-micro, 30 GB standard disk and its external IP in the
  three US regions; the guide recommends a budget alert in case terms change.
- The server-side layout (`/opt/mail-me`, data owned by uid 1000) and the settings upload behavior
  from feature 003 are kept.
- Choosing and paying a VPS provider is the user's business; the guide names examples only.
- Automatic OS security updates are the provider image's default and are not managed here.
