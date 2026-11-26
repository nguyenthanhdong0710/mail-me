# Deploy mail-me on Oracle Cloud Always Free

This folder creates a free, always-on server for mail-me on Oracle Cloud Infrastructure (OCI)
with Terraform. You then install mail-me on it with the same two commands as on any Linux server
([deploy/linux](../linux/README.md)).

> Oracle's sign-up is strict and often rejects people ("We're unable to complete your sign up").
> If that happens to you, use [Google Cloud's free tier](../gcp/README.md) or
> [any Linux server](../linux/README.md) instead.

What gets created (all tagged `app = mail-me`, all removed by `terraform destroy`):

- A network (VCN), a public subnet, an internet gateway and a route table.
- A firewall (security list) that only lets **SSH (port 22)** in. mail-me only makes outbound
  connections, so it needs no open ports.
- One **Ampere A1** Arm server (`VM.Standard.A1.Flex`) running Ubuntu 24.04: 1 CPU, 6 GB memory and
  a 50 GB disk by default. Sizes above the Always Free limits are rejected before anything is
  created.

Nothing is installed on first boot. `deploy/linux/install.sh` installs Docker and copies the
mail-me code from your computer over SSH, so this also works with a private copy of the
repository. Your secrets (`config.json`, `.env`, `data/grants/`) never go into Terraform
variables or state; `deploy/linux/push-config.sh` copies them over SSH.

Plan for about 30 minutes, plus any wait for free Arm capacity (see [Known traps](#known-traps)).

## Before you start

1. **Finish the main setup guide on your own computer first**, up to Step 6: you need a working
   `config.json`, `.env` and, for Gmail/Outlook, your sign-ins in `data/grants/`. Run
   `npm run check-config` (or the Docker equivalent) and make sure it passes. Signing in locally is
   easiest; see [Signing in on the server](../linux/README.md#signing-in-on-the-server) for the
   alternative.
2. **An Oracle Cloud account.** Sign up at [oracle.com/cloud/free](https://www.oracle.com/cloud/free/).
   A card is needed to verify your identity; Always Free resources are not charged.
   **Pick your home region carefully**: Always Free servers can only be created there, and it
   cannot be changed later. Choose one close to you, ideally one with more than one availability
   domain (it makes finding free Arm capacity easier).
3. **An SSH key pair.** If you have none: `ssh-keygen -t ed25519`.
4. Choose how to run Terraform:
   - **On your computer**: install [Terraform](https://developer.hashicorp.com/terraform/install)
     1.7 or newer and set up an OCI API key (below).
   - **In Oracle's Resource Manager** (no install, runs in the browser): skip to
     [Option 2](#option-2-oci-resource-manager-no-install).

## Option 1: Terraform on your computer

### Set up an OCI API key

In the OCI console: **Profile menu (top right) → My profile → API keys → Add API key →
Generate API key pair**. Download the private key, click **Add**, and copy the configuration
preview it shows into `~/.oci/config`:

```ini
[DEFAULT]
user=ocid1.user.oc1..aaaa...
fingerprint=12:34:...
tenancy=ocid1.tenancy.oc1..aaaa...
region=eu-frankfurt-1
key_file=~/.oci/oci_api_key.pem
```

```bash
chmod 600 ~/.oci/config ~/.oci/oci_api_key.pem
```

Terraform reads this file automatically. To use another profile, set `OCI_CLI_PROFILE`.

### Create the server

```bash
cd deploy/oci
cp terraform.tfvars.example terraform.tfvars
```

Edit `terraform.tfvars` (it is git-ignored and holds nothing secret):

| Variable                                            | Value                                                                   |
| --------------------------------------------------- | ----------------------------------------------------------------------- |
| `tenancy_ocid`                                      | **Profile menu → Tenancy** → OCID                                       |
| `region`                                            | Your home region, e.g. `eu-frankfurt-1`                                 |
| `ssh_public_key`                                    | Contents of `~/.ssh/id_ed25519.pub`                                     |
| `ssh_source_cidr`                                   | Optional. Your own IP, e.g. `203.0.113.7/32`, so only you can reach SSH |
| `compartment_ocid`                                  | Optional. Defaults to the root compartment                              |
| `ocpus`, `memory_in_gbs`, `boot_volume_size_in_gbs` | Optional. Defaults 1 / 6 / 50. Free totals per account: 4 / 24 / 200    |
| `availability_domain_index`                         | Optional. `0`, `1` or `2`; change it on "Out of host capacity"          |

```bash
terraform init
terraform apply
```

Terraform shows what it will create and asks for `yes`. When it finishes it prints:

```text
public_ip           = "141.147.x.x"
ssh_command         = "ssh ubuntu@141.147.x.x"
install_command     = "deploy/linux/install.sh ubuntu@141.147.x.x"
push_config_command = "deploy/linux/push-config.sh ubuntu@141.147.x.x"
```

Keep `terraform.tfstate` (it is git-ignored). Terraform needs it to update or remove the server.
It contains no secrets.

## Option 2: OCI Resource Manager (no install)

1. Make a zip of this folder's Terraform files:
   ```bash
   cd deploy/oci && zip mail-me-oci.zip *.tf .terraform.lock.hcl
   ```
2. In the OCI console: **Developer Services → Resource Manager → Stacks → Create stack**, choose
   **My configuration → .Zip file**, and upload `mail-me-oci.zip`.
3. On the variables page, `tenancy_ocid`, `region` and `compartment_ocid` are filled in for you.
   Paste your SSH public key into `ssh_public_key`. Change the optional ones if you like.
4. Create the stack, then click **Apply**. The outputs (`public_ip`, `ssh_command`, …) appear in the
   job's **Outputs** tab.

## Install mail-me and upload your settings

From your **mail-me folder**, on your computer:

```bash
deploy/linux/install.sh ubuntu@<public_ip>       # Docker + the code from this computer, then build
deploy/linux/push-config.sh ubuntu@<public_ip>   # config.json, .env, sign-ins; check; start
```

The first `install.sh` takes about 5–10 minutes on 1 CPU. Everything else (checking logs,
updating, changing settings, signing in on the server, backups) is the same as on any Linux
server: see the [Linux server guide](../linux/README.md#day-to-day).

Set `timezone` in `config.json`: the server and the container run in UTC.

To remove everything: `cd deploy/oci && terraform destroy` (or **Destroy** in Resource Manager).
**This deletes the disk**, with the database and sign-ins: back up first
(`deploy/linux/backup.sh ubuntu@<ip>`). Later `terraform apply` runs never replace the server just
because Oracle published a newer Ubuntu image.

## Known traps

### "Out of host capacity"

Free Arm servers are popular, and `terraform apply` often fails at the server with
`Out of host capacity`. The network is already created; only the server needs another try.

- Run `terraform apply` again later. Early morning or late night in your region often works.
- Try another availability domain: `terraform apply -var availability_domain_index=1` (or `2`),
  if your region has more than one.
- Try a smaller size (1 CPU / 6 GB is the default and is easiest to get).
- Upgrading to Pay As You Go (below) makes capacity much easier to get.

### Idle servers can be reclaimed

Oracle may stop Always Free servers that look idle: over 7 days, CPU use (95th percentile),
network use and memory use (Arm servers) all below 20%. mail-me spends most of its time waiting,
so this can happen to it. Oracle emails you first.

The reliable fix is to **upgrade the account to Pay As You Go** (**Billing → Upgrade and Manage
Payment**). Always Free resources stay free, and idle reclamation no longer applies. Set a
**budget alert** (**Billing → Budgets**, e.g. $1) so you hear about any charge.

### The home region is fixed

Always Free servers can only be created in your home region, chosen at sign-up. If your home
region has no free Arm capacity for a long time, the only options are waiting or Pay As You Go.

### The limits are per account

4 Arm CPUs, 24 GB memory and 200 GB of disk are the **account** totals. If you already run other
free servers, choose a size that fits in what is left, or `apply` fails with a limit error.

## Security notes

- Only SSH is open. Set `ssh_source_cidr` to your own IP to narrow it further. Password login is
  off; only your key works.
- On the server, `config.json` and `data/grants/` are owned by the container user (uid 1000) with
  mode 600 (folders 700); `.env` is owned by root with mode 600.
- Anyone with SSH access to the server, and the account's administrators, can read your
  settings. Keep your SSH key and Oracle account safe (enable MFA).
- Oracle's Ubuntu images block forwarded traffic, which can cut containers off from the internet.
  `install.sh` removes that single `FORWARD … REJECT` rule; inbound access is still limited to SSH
  by the host firewall and the security list.

## Troubleshooting

| Problem                                      | Fix                                                                                                                           |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `Permission denied (publickey)`              | Use the key whose public half you gave Terraform: `install.sh -i ~/.ssh/your_key …`                                           |
| `404-NotAuthorizedOrNotFound` from Terraform | Wrong `tenancy_ocid` / `compartment_ocid`, or your user lacks permissions there                                               |
| `LimitExceeded`                              | You are over the free totals; see [The limits are per account](#the-limits-are-per-account)                                   |
| Reports stop after weeks                     | Check whether Oracle reclaimed the server (console → Compute → Instances); see [Idle servers](#idle-servers-can-be-reclaimed) |
