#!/usr/bin/env bash
# Offline tests for deploy/linux (no server needed):
#   1. server-setup.sh check accepts the supported systems and refuses others (needs Docker).
#   2. install.sh --dry-run never lists secrets, local data or Terraform state, with and without git.
set -euo pipefail

root=$(cd "$(dirname "$0")/../../.." && pwd)
setup="$root/deploy/linux/server-setup.sh"
failures=0
pass() { echo "  ok   $*"; }
fail() { echo "  FAIL $*"; failures=$((failures + 1)); }

echo "server-setup.sh check:"
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  for img in ubuntu:22.04 ubuntu:24.04 debian:12 debian:13; do
    if docker run --rm -v "$setup:/s.sh:ro" "$img" bash /s.sh check >/dev/null 2>&1; then
      pass "$img accepted"
    else
      fail "$img should be accepted"
    fi
  done
  for img in ubuntu:20.04 fedora:41; do
    set +e
    docker run --rm -v "$setup:/s.sh:ro" "$img" bash /s.sh check >/dev/null 2>&1
    status=$?
    set -e
    if [ "$status" = 5 ]; then pass "$img refused"; else fail "$img should be refused with exit 5 (got $status)"; fi
  done
else
  echo "  skip (Docker not available)"
fi

echo "install.sh --dry-run:"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
# A copy of the repository as git sees it, plus secrets and local state that must never ship.
(cd "$root" && git ls-files -z --cached --others --exclude-standard | tr '\0' '\n' |
  while IFS= read -r f; do if [ -f "$f" ]; then printf '%s\n' "$f"; fi; done |
  tar -cf - -T -) | tar -xf - -C "$tmp"
secrets="config.json .env .env.local data/mail-me.db data/grants/school.read.json deploy/gcp/terraform.tfstate deploy/gcp/terraform.tfstate.backup deploy/oci/terraform.tfvars deploy/gcp/.terraform/providers/x mail-me.db-wal"
for f in $secrets; do
  mkdir -p "$tmp/$(dirname "$f")"
  echo secret >"$tmp/$f"
done

check_bundle() {
  local label=$1 list
  list=$("$tmp/deploy/linux/install.sh" --dry-run)
  for f in $secrets; do
    if printf '%s\n' "$list" | grep -qxF "$f"; then fail "$label: $f must not be uploaded"; else pass "$label: $f excluded"; fi
  done
  for f in .env.example Dockerfile docker-compose.yml package.json deploy/linux/install.sh; do
    if printf '%s\n' "$list" | grep -qxF "$f"; then pass "$label: $f included"; else fail "$label: $f must be uploaded"; fi
  done
}

git -C "$tmp" init -q
git -C "$tmp" add -A
git -C "$tmp" add -f config.json .env # even files someone force-added to git
check_bundle "git checkout"
rm -rf "$tmp/.git"
check_bundle "plain folder"

if [ "$failures" -gt 0 ]; then
  echo "$failures failure(s)"
  exit 1
fi
echo "all passed"
