# Quickstart / Validation: Google Cloud Free Tier and Any-VPS Hosting

## Offline (CI and local)

```bash
for m in deploy/oci deploy/gcp; do
  (cd $m && terraform fmt -check -recursive && terraform init -backend=false && terraform validate && terraform test)
done
shellcheck deploy/linux/*.sh deploy/linux/tests/*.sh
deploy/linux/tests/test-scripts.sh      # OS matrix in containers + bundle has no secrets
```

## Any Linux server (manual)

1. Fresh Ubuntu 24.04 VPS, SSH as root: `deploy/linux/install.sh root@<ip>` → Docker installed,
   image built, "next: push-config" printed.
2. `deploy/linux/push-config.sh root@<ip>` → running; test email → report.
3. Change code locally, `deploy/linux/install.sh root@<ip>` → new image running, no duplicate
   reports, settings kept.
4. Repeat 1 on Debian 12 with a sudo user.
5. 1 GB server: `swapon --show` lists `/swapfile` after install.

## Google Cloud (manual)

1. `cd deploy/gcp && cp terraform.tfvars.example terraform.tfvars` (project, key);
   `terraform apply` → outputs.
2. `terraform apply -var region=asia-southeast1` → fails, mentions free tier.
3. `nmap -Pn <ip>` → only 22 open.
4. Install + push-config as above → report arrives.
5. After a day: Billing → Reports filtered by project shows $0 for Compute Engine.
6. `terraform destroy` → all removed.

## Oracle (manual)

Provision, then `deploy/linux/install.sh ubuntu@<ip>` and `push-config.sh` → report.
