# Research: Google Cloud Free Tier and Any-VPS Hosting

## R1. Getting the code onto the server

- **Decision**: Upload from the user's checkout over SSH. File list = `git ls-files -z --cached
  --others --exclude-standard` (tracked + new non-ignored files, so local edits ship too), then an
  explicit filter dropping `config.json`, `.env*` (except `.env.example`), `data/`, `*.db*`,
  `*.tfstate*`, `*.tfvars`. Outside a git checkout: `tar` with the same excludes plus
  `node_modules/`, `dist/`, `coverage/`, `.git/`, `.terraform/`.
- **Rationale**: The GitHub repository is private (anonymous request → 404), so cloning on the
  server would need credentials on the server. Uploading needs none and works for forks.
- **Alternatives**: Deploy key / token on server (secret management burden); building the image
  locally and `docker save | ssh docker load` (cross-arch builds for arm servers, large transfer);
  registry push (needs an account).

## R2. Replacing old code safely

- **Decision**: Stream the bundle into `<dir>/.code-new`, then delete top-level entries in `<dir>`
  except `config.json`, `.env`, `data`, `.staging`, `.code-new`, then move the new entries in.
- **Rationale**: Removes files deleted upstream; never touches settings or data; an interrupted
  upload leaves the old code in place until the swap.

## R3. Docker installation

- **Decision**: If `docker compose version` already works, keep it. Otherwise add Docker's apt
  repository (`https://download.docker.com/linux/{ubuntu|debian}`, signed key in
  `/etc/apt/keyrings/docker.asc`) and install `docker-ce docker-ce-cli containerd.io
  docker-buildx-plugin docker-compose-plugin`.
- **Rationale**: One method for all four OSes; Debian's own `docker-compose` is the old v1;
  buildx is needed for the Dockerfile's `# syntax=` line. This is Docker's documented method.
- **Alternatives**: Distro packages (differ per OS, no compose v2 on Debian 12); `get.docker.com`
  (`curl | sh`, Docker advises against it for production).
- First-boot races: cloud images run cloud-init and unattended-upgrades on boot, so the script
  runs `cloud-init status --wait` when present and passes `-o DPkg::Lock::Timeout=600` to apt.

## R4. Swap

- **Decision**: If `MemTotal` < 2 GB and `swapon --show` is empty, create a 2 GB `/swapfile`
  (`fallocate`, fallback `dd`), `chmod 600`, `mkswap`, `swapon`, add to `/etc/fstab`.
- **Rationale**: e2-micro has 1 GB; `npm ci` + `tsc` during the image build can exceed it.

## R5. Root vs sudo

- **Decision**: `lib.sh` asks the server `id -u`; if 0, run as is; else require `sudo -n true`
  (password-less) and prefix `sudo`. Otherwise exit with a message.
- **Rationale**: VPS providers often give root; cloud images give a sudo user.

## R6. Google Cloud free tier

- **Decision**: One `e2-micro`, `pd-standard` boot disk 10–30 GB (default 30), regions `us-west1`,
  `us-central1`, `us-east1` only, image family `ubuntu-os-cloud/ubuntu-2404-lts-amd64`, ephemeral
  external IP, dedicated VPC `10.10.0.0/24`, firewall `tcp:22` from `ssh_source_cidr` to tag
  `mail-me`. Default zones: `us-west1-b`, `us-central1-a`, `us-east1-b` (us-east1 has no `-a`).
- **Rationale**: Google's free tier docs: 1 non-preemptible e2-micro per month in those regions,
  30 GB-months standard persistent disk, 1 GB egress from North America, and no charge for the
  external IP. A balanced disk (the console default) is **not** free, so the disk type is fixed.
  Users report surprise charges anyway, so the guide requires a budget alert.
- **Alternatives**: IAP-only SSH without external IP (needs Cloud NAT for outbound, which costs).

## R7. GCP SSH access

- **Decision**: `metadata.ssh-keys = "<ssh_user>:<key>"`, `block-project-ssh-keys = true`,
  `enable-oslogin = "FALSE"`; default `ssh_user = "ubuntu"`.
- **Rationale**: Works with plain `ssh` (no gcloud needed after provisioning), same user name as
  the Oracle guide.

## R8. GCP provider auth and API

- **Decision**: `provider "google" { project, region }` with Application Default Credentials
  (`gcloud auth application-default login`). `google_project_service.compute` with
  `disable_on_destroy = false`.
- **Rationale**: New projects have the Compute API off; disabling it on destroy could break other
  things in the project.

## R9. Oracle changes

- **Decision**: Drop `cloud-init.yaml.tftpl`, `user_data`, `repo_url`, `repo_ref`. The Oracle
  FORWARD-chain fix moves into `server-setup.sh system` (applied only when the rule exists).
  Outputs gain `install_command`.

## R10. Testing the scripts

- **Decision**: `server-setup.sh check` validates OS/arch only, without changes; CI runs it in
  `ubuntu:22.04`, `ubuntu:24.04`, `debian:12`, `debian:13` (expect 0) and `fedora:41`,
  `alpine:3` (expect non-zero). `install.sh --dry-run` prints the bundle file list; the test
  creates fake `config.json`, `.env`, `data/x.db` in a temp copy and asserts none is listed.
