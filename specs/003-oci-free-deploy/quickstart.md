# Quickstart / Validation: Free Cloud Hosting on Oracle Cloud Always Free

## Offline checks (CI and local)

```bash
cd deploy/oci
terraform fmt -check -recursive
terraform init -backend=false
terraform validate
terraform test                       # mocked provider; contract guarantees 1–6
shellcheck push-config.sh backup.sh
```

Expected: all pass.

## End-to-end (real tenancy, manual)

Prerequisites: OCI account, API key in `~/.oci/config`, local `config.json`, `.env`,
`data/grants/` that pass `npm run check-config`.

1. `cp terraform.tfvars.example terraform.tfvars`, fill `tenancy_ocid`, `region`,
   `ssh_public_key`. `terraform apply` → outputs `public_ip`, `ssh_command`.
2. `terraform apply -var ocpus=5` → fails before creating anything, message mentions Always Free.
3. `nmap -Pn <public_ip>` → only `22/tcp open` (SC-003).
4. `deploy/linux/push-config.sh ubuntu@<ip>` → `check-config` output, then service running.
5. Break `config.json` locally (e.g. invalid JSON), re-run → exit 4, service still running with
   the previous settings.
6. Send a test email → report arrives (SC-001).
7. `grep -F -f <(secret values) terraform.tfstate` → no matches (SC-004).
8. `ssh ubuntu@<ip> sudo reboot`; within 5 minutes `docker compose ps` shows running, no duplicate
   reports (SC-005).
9. `deploy/linux/backup.sh ubuntu@<ip>` → private `.tar.gz` locally containing `data/mail-me.db`.
10. `terraform destroy` → all 6 resources removed (SC-006).
