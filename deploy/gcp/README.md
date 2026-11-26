# Deploy mail-me on Google Cloud's free tier

This folder creates one free, always-on server for mail-me on Google Cloud with Terraform. You
then install mail-me on it with the same two commands as on any Linux server
([deploy/linux](../linux/README.md)).

What gets created (all labelled `app = mail-me`, all removed by `terraform destroy`):

- A dedicated network and subnet, and a firewall rule that only lets **SSH (port 22)** in.
  mail-me only makes outbound connections, so it needs no open ports.
- One **e2-micro** server (2 shared vCPUs, 1 GB memory) running Ubuntu 24.04 with a **30 GB
  standard** disk and a public IP, in a free-tier US region. Anything outside the free tier
  (other regions, bigger disks) is rejected before anything is created.
- The Compute Engine API is turned on for the project (and left on when you destroy).

Your secrets (`config.json`, `.env`, `data/grants/`) never go into Terraform variables or state.

## What is free

Google's [free tier](https://cloud.google.com/free/docs/free-cloud-features#compute) includes,
every month, per billing account:

- **one** non-preemptible e2-micro server in `us-west1` (Oregon), `us-central1` (Iowa) or
  `us-east1` (South Carolina),
- 30 GB of **standard** persistent disk (the console's default "balanced" disk is **not** free),
- 1 GB of outbound traffic from North America (mail-me sends little: AI requests and reports),
- no charge for the server's external IP.

The limits are per **billing account**: a second e2-micro, in any project, is billed. Google can
change these terms, so set a budget alert (below). The servers are in the US; from Vietnam,
`us-west1` is the closest. Latency does not matter for mail-me.

## Before you start

1. **Finish the main setup guide on your own computer first**, up to Step 6: a working
   `config.json`, `.env` and, for Gmail/Outlook, your sign-ins in `data/grants/`. Run
   `npm run check-config` (or the Docker equivalent) and make sure it passes.
2. **A Google Cloud account with billing.** Go to [console.cloud.google.com](https://console.cloud.google.com),
   accept the terms, and create a billing account (a card is needed; new accounts also get trial
   credit). The free tier keeps applying after the trial ends.
3. **A project.** Project picker → **New project**. Note its **project ID** (e.g. `mail-me-123456`),
   and make sure the project is linked to your billing account (**Billing → Account management**).
4. **A budget alert**: **Billing → Budgets & alerts → Create budget**, amount e.g. $1, alerts at
   50% and 100%. You get an email if anything starts costing money.
5. **Tools on your computer**: [Terraform](https://developer.hashicorp.com/terraform/install) 1.7
   or newer and the [gcloud CLI](https://cloud.google.com/sdk/docs/install). Sign in once:
   ```bash
   gcloud auth application-default login
   ```
6. **An SSH key pair.** If you have none: `ssh-keygen -t ed25519`.

## Create the server

```bash
cd deploy/gcp
cp terraform.tfvars.example terraform.tfvars
```

Edit `terraform.tfvars` (git-ignored, nothing secret):

| Variable          | Value                                                                   |
| ----------------- | ----------------------------------------------------------------------- |
| `project_id`      | Your project ID                                                         |
| `ssh_public_key`  | Contents of `~/.ssh/id_ed25519.pub`                                     |
| `region`          | Optional. `us-west1`, `us-central1` (default) or `us-east1`             |
| `ssh_source_cidr` | Optional. Your own IP, e.g. `203.0.113.7/32`, so only you can reach SSH |
| `ssh_user`        | Optional. User name created for your key (default `ubuntu`)             |
| `disk_size_gb`    | Optional. 10–30 (default 30, the free amount)                           |

```bash
terraform init
terraform apply
```

Terraform shows what it will create and asks for `yes`. When it finishes it prints:

```text
public_ip           = "34.x.x.x"
ssh_command         = "ssh ubuntu@34.x.x.x"
install_command     = "deploy/linux/install.sh ubuntu@34.x.x.x"
push_config_command = "deploy/linux/push-config.sh ubuntu@34.x.x.x"
```

Keep `terraform.tfstate` (git-ignored). Terraform needs it to update or remove the server. It
contains no secrets.

## Install mail-me and upload your settings

From your **mail-me folder**:

```bash
deploy/linux/install.sh ubuntu@<public_ip>
deploy/linux/push-config.sh ubuntu@<public_ip>
```

The first `install.sh` takes roughly 10–15 minutes: the e2-micro is small, so it adds 2 GB of
swap and builds slowly. Updates afterwards are much quicker. Logs, updates, settings changes,
signing in on the server and backups work as on any Linux server: see the
[Linux server guide](../linux/README.md#day-to-day).

## Remove everything

```bash
deploy/linux/backup.sh ubuntu@<public_ip>   # optional: keep the database and sign-ins
cd deploy/gcp && terraform destroy
```

This deletes the server **and its disk**. The Compute Engine API stays enabled. Later
`terraform apply` runs never replace the server just because Google published a newer Ubuntu
image.

## Check that it stays free

After a day, open **Billing → Reports**, filter to your project and group by SKU. Compute Engine
lines should show $0 (the free-tier credit cancels the e2-micro, disk and IP). If something is
charged, check that:

- the region is `us-west1`, `us-central1` or `us-east1`,
- the disk type is "Standard persistent disk",
- you have no other e2-micro running in any project on the same billing account,
- outbound traffic is under 1 GB a month.

## Troubleshooting

| Problem                                                   | Fix                                                                                             |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `could not find default credentials`                      | Run `gcloud auth application-default login`                                                     |
| `Billing account for project … is not found` / API errors | Link the project to a billing account, wait a minute, `terraform apply` again                   |
| `Compute Engine API has not been used in project …`       | Wait a minute after the first apply (enabling the API takes time) and apply again               |
| `Permission denied (publickey)`                           | Use the key whose public half you gave Terraform: `install.sh -i ~/.ssh/your_key …`             |
| `ZONE_RESOURCE_POOL_EXHAUSTED`                            | Rare for e2-micro. Try `-var zone=us-central1-b` (or another zone in your region)               |
| Build is very slow or killed                              | Normal on e2-micro the first time; make sure swap exists (`free -h`) and run `install.sh` again |
