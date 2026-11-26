# Feature Specification: Free Cloud Hosting on Oracle Cloud Always Free

**Feature Branch**: `003-oci-free-deploy`

**Created**: 2026-11-26

**Status**: Draft

**Input**: User description: "Deploy mail-me to an Oracle Cloud Infrastructure (OCI) Always Free VM using infrastructure as code. Provide Terraform (oracle/oci provider, also usable via OCI Resource Manager) under deploy/oci/ that creates: a VCN, public subnet, internet gateway, route table, and a security list allowing only inbound SSH (mail-me needs no inbound ports); one VM.Standard.A1.Flex (ARM, Ubuntu) instance sized within Always Free limits (default 1 OCPU / 6 GB, configurable, validated to stay within 4 OCPU / 24 GB and 200 GB boot volume); cloud-init user_data that installs Docker + Compose plugin, clones the repo, prepares data/ owned by uid 1000, and starts the service with docker compose once config is present. Secrets (.env, config.json, data/grants/) are never put into Terraform variables or state; they are copied with scp, with a helper script to upload them and restart. Document the known gotchas: 'Out of host capacity' for ARM (retry / other availability domain), idle reclamation of Always Free instances (upgrade to Pay As You Go to avoid, still free within limits), home region is fixed. Update README: replace/add a hosting section recommending Oracle Always Free VM, explain why Vercel/serverless is not suitable (long-running poller, local SQLite and grant files need persistent writable disk, Hobby cron once per day), and link to deploy/oci/README.md."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Create a free, always-on server from code (Priority: P1)

A self-hoster with an Oracle Cloud account runs one provisioning command (or uploads the same
definition to Oracle's hosted runner) and gets a server that stays within the Always Free
allowance, is reachable only over SSH, and already has the container runtime and the mail-me
source installed and ready.

**Why this priority**: Without a server nothing else in this feature matters, and doing it by
hand in the cloud console is the slowest and most error-prone part of hosting.

**Independent Test**: Apply the definition to an empty Oracle Cloud tenancy, then SSH to the
printed address and confirm the container runtime and the mail-me checkout are present, that no
port other than SSH is open, and that the billing page shows no charges.

**Acceptance Scenarios**:

1. **Given** an Oracle Cloud account and an SSH public key, **When** the user provisions with the
   default settings, **Then** one ARM server with 1 OCPU and 6 GB memory is created and its
   public address and an SSH command are printed.
2. **Given** a size above the free allowance (e.g. 5 OCPU, 32 GB memory or a 250 GB disk),
   **When** the user provisions, **Then** provisioning stops before creating anything, with a
   message naming the limit.
3. **Given** a provisioned server, **When** an outside host scans it, **Then** only SSH answers.
4. **Given** the server has booted, **When** the user connects, **Then** the container runtime and
   the mail-me source are installed and the service waits for its configuration instead of
   crash-looping.

---

### User Story 2 - Upload private settings and start the service (Priority: P1)

The user prepares `config.json`, `.env` and their OAuth sign-ins on their own computer (as the
main setup guide already describes), then runs one helper command that copies them to the server
with private permissions and starts or restarts mail-me.

**Why this priority**: This is what turns an empty server into a working assistant, and it is the
step where secrets could leak if done carelessly.

**Independent Test**: With a provisioned server and a valid local configuration, run the helper,
then send a test email and receive its report; confirm the secret files are readable only by
their owner on the server and that none of them appear in the provisioning state or variables.

**Acceptance Scenarios**:

1. **Given** a provisioned server and valid local settings, **When** the user runs the helper with
   the server address, **Then** the settings are copied, owner-only permissions are applied, the
   configuration is validated on the server, and the service is (re)started.
2. **Given** the configuration fails validation on the server, **When** the helper runs, **Then**
   it shows the validation errors and does not leave a crash-looping service.
3. **Given** the helper has been run, **When** the user inspects the provisioning state and
   variables, **Then** no mail password, API key, OAuth client secret or sign-in is present.
4. **Given** a running service, **When** the user edits a setting locally and re-runs the helper,
   **Then** the new setting is in effect after the restart, and the existing database is kept.

---

### User Story 3 - Know where to host and avoid the free-tier traps (Priority: P2)

A reader of the main README wants to know where to run mail-me for free. The README recommends the
Oracle Always Free server, explains briefly why serverless platforms such as Vercel are not
suitable, and links to the deployment guide, which explains the known traps and how to get past
them.

**Why this priority**: Users keep asking whether serverless free tiers work; a clear answer saves
them a failed attempt, but the deployment itself works without it.

**Independent Test**: A reader who has never used Oracle Cloud follows only the README and the
deployment guide and reaches a working service, and can answer "why not Vercel?" from the README.

**Acceptance Scenarios**:

1. **Given** the README hosting section, **When** a reader looks for free hosting, **Then** they
   find the Oracle Always Free recommendation, the reasons serverless does not fit, and a link to
   the deployment guide.
2. **Given** provisioning fails with "Out of host capacity", **When** the user reads the guide,
   **Then** they find how to retry and how to try another availability domain.
3. **Given** the guide, **When** the user reads about idle reclamation and the home region, **Then**
   they understand the risk and how to avoid it while staying free.

---

### User Story 4 - Update, back up and remove (Priority: P3)

The user can update the running service to the latest version, back up the database and
sign-ins, and tear down every cloud resource the feature created with one command.

**Why this priority**: Day-two operations matter for a long-running service but are not needed
to get the first report.

**Independent Test**: Run the documented update, back-up and tear-down commands against a
provisioned server and confirm the outcome of each.

**Acceptance Scenarios**:

1. **Given** a running service, **When** the user runs the documented update, **Then** the newest
   source is built and running and no email is reported twice.
2. **Given** a running service, **When** the user runs the documented back-up, **Then** a copy of
   the database and sign-ins is saved on their computer with private permissions.
3. **Given** provisioned resources, **When** the user tears them down, **Then** every resource
   the feature created is removed and nothing else in the account is touched.

---

### Edge Cases

- The chosen availability domain has no free ARM capacity: provisioning fails with Oracle's
  "Out of host capacity" message; the guide explains retrying and choosing another domain.
- The account already uses part of the free allowance (another free VM): the documented limits
  are per account, so the guide tells the user to subtract existing usage.
- The user's account is not in a region that offers free ARM servers: covered by the home-region
  note.
- The server reboots: the service comes back on its own.
- Settings are uploaded before the first-boot setup finishes: the helper waits for setup to
  finish or reports clearly that it has not finished yet.
- The repository is private or forked: the source location is configurable.
- The user's local sign-in files have loose permissions: the server copies are still made
  owner-only.
- Gmail sign-ins need a browser callback: the guide explains signing in locally and uploading,
  or forwarding the sign-in port over SSH.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The repository MUST provide an infrastructure-as-code definition that creates a
  private network, a public subnet with internet access, and one ARM server on Oracle Cloud,
  usable both from the user's computer and from Oracle's hosted runner.
- **FR-002**: The only inbound traffic allowed MUST be SSH, and the allowed SSH source MUST be
  configurable (default: anywhere, with a documented recommendation to restrict it).
- **FR-003**: Server size MUST default to 1 OCPU, 6 GB memory and a 50 GB disk, MUST be
  configurable, and MUST be rejected before any resource is created when it exceeds 4 OCPU, 24 GB
  memory or a 200 GB disk.
- **FR-004**: On first boot the server MUST install the container runtime, get the mail-me source
  from a configurable location, create a data folder writable by the service user, and start the
  service automatically once settings are present.
- **FR-005**: The service MUST restart on its own after a crash or reboot.
- **FR-006**: Secrets (`.env`, `config.json`, sign-ins under `data/grants/`) MUST NOT be accepted
  as provisioning inputs and MUST NOT appear in provisioning state.
- **FR-007**: A helper command MUST upload the settings and sign-ins over SSH, apply owner-only
  permissions, validate the configuration on the server, and (re)start the service, stopping with
  the validation output if the configuration is invalid.
- **FR-008**: Provisioning MUST print the server's public address and a ready-to-use SSH command.
- **FR-009**: A deployment guide MUST cover prerequisites, provisioning from the user's computer
  and from the hosted runner, uploading settings, signing in, checking logs, updating, backing up,
  tearing down, and the known traps (no ARM capacity, idle reclamation, fixed home region).
- **FR-010**: The main README MUST recommend this hosting option, explain why serverless
  platforms (e.g. Vercel) are not suitable, and link to the deployment guide.
- **FR-011**: Every cloud resource created MUST be removable with a single tear-down command
  that leaves other resources in the account untouched.
- **FR-012**: The definition MUST be checked automatically (format and validation) so mistakes
  are caught before users run it.

### Key Entities

- **Deployment inputs**: Non-secret settings the user provides: account and compartment
  identifiers, region, SSH public key, server size, allowed SSH source, source location.
- **Cloud resources**: Network, subnet, gateway, route table, firewall rules and the server,
  all tagged as belonging to mail-me.
- **Private settings bundle**: `config.json`, `.env` and `data/grants/`, which stay outside the
  definition and its state and are copied by the helper.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A user with an Oracle Cloud account and a prepared configuration goes from nothing to
  a first delivered report in under 30 minutes, not counting waits for free ARM capacity.
- **SC-002**: Running the deployment with default settings costs $0 per month.
- **SC-003**: A network scan of the server shows exactly one open port (SSH).
- **SC-004**: Searching the provisioning state and variables for any secret value from the user's
  settings finds 0 matches.
- **SC-005**: After a server reboot the service is running again within 5 minutes with no manual
  step, and no email is reported twice.
- **SC-006**: Tear-down removes 100% of the resources the feature created.

## Assumptions

- The user already has an Oracle Cloud account (sign-up needs a payment card for verification)
  and its API signing key or uses the hosted runner in the console.
- The user prepares `config.json`, `.env` and sign-ins locally by following the existing setup
  guide; this feature only moves them to the server.
- The existing container image builds on ARM (it already falls back to a source build for the
  SQLite module).
- Ubuntu is the server OS; the latest free-eligible Ubuntu ARM image is looked up automatically.
- The default source location is the public project repository; forks and private copies set
  their own.
- Monitoring, alerts and automatic backups to object storage are out of scope.
- Making the Oracle account Pay As You Go is the user's decision; the guide explains it but the
  definition does not change account settings.
