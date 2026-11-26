#!/usr/bin/env bash
# Install or update mail-me on any Linux server you can SSH into (Ubuntu 22.04/24.04,
# Debian 12/13). Run from your mail-me folder. It copies the code from THIS computer (no git
# clone on the server, so private repositories and local changes work), never your secrets.
#
# Exit codes: 0 ok, 1 usage/SSH/build error, 5 unsupported server system.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
# shellcheck source=deploy/linux/lib.sh
. "$here/lib.sh"

usage() {
  cat <<'EOF'
Usage: deploy/linux/install.sh [options] <user@host>

Installs Docker on the server if needed, uploads the mail-me code from this computer, builds it
and starts mail-me if settings were already uploaded. Run it again to update.

Options:
  -i <key>      SSH identity file
  -p <port>     SSH port (default: 22)
  -o <option>   Extra ssh option, e.g. -o ProxyJump=bastion
  --dir <path>  Install folder on the server (default: /opt/mail-me)
  --dry-run     List the files that would be uploaded, then exit (no SSH)
  -h, --help    Show this help
EOF
}

dir=/opt/mail-me
dry_run=0
while [ $# -gt 0 ]; do
  case "$1" in
    -i) ssh_args+=(-i "${2:?-i needs a file}"); shift 2 ;;
    -p) ssh_args+=(-p "${2:?-p needs a port}"); shift 2 ;;
    -o) ssh_args+=(-o "${2:?-o needs an ssh option}"); shift 2 ;;
    --dir) dir=${2:?--dir needs a path}; shift 2 ;;
    --dry-run) dry_run=1; shift ;;
    -h | --help) usage; exit 0 ;;
    -*) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
    *)
      [ -z "$HOST" ] || { echo "Only one host, please." >&2; exit 1; }
      HOST=$1; shift ;;
  esac
done

# Files to upload, one per line, relative to the repository root. Secrets, local data and build
# output are never included, even if someone forgets to git-ignore them.
bundle_files() {
  (
    cd "$repo"
    if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
      git ls-files -z --cached --others --exclude-standard | tr '\0' '\n'
    else
      find . \( -name .git -o -name node_modules -o -name dist -o -name coverage -o -name .terraform -o -path ./data \) -prune \
        -o -type f -print | sed 's#^\./##'
    fi | while IFS= read -r f; do if [ -f "$f" ]; then printf '%s\n' "$f"; fi; done
  ) | awk '
    /(^|\/)\.env(\.[^\/]*)?$/ && !/(^|\/)\.env\.example$/ { next }
    /^config\.json$/ { next }
    /^data\// { next }
    /(^|\/)(node_modules|dist|coverage|\.terraform)\// { next }
    /^(\.claude|\.specify|\.github|specs)\// { next }  # developer-only, not needed on a server
    /\.db(-[^\/]*)?$/ { next }
    /\.tfstate/ { next }
    /\.tfvars$/ { next }
    { print }
  '
}

if [ "$dry_run" = 1 ]; then
  bundle_files
  exit 0
fi
[ -n "$HOST" ] || { usage >&2; exit 1; }

ssh_setup
detect_root
qdir=$(q "$dir")

echo "→ Preparing the server (Docker, swap, folders)…"
set +e
remote "$AS_ROOT bash -s -- system --dir $qdir" <"$here/server-setup.sh"
status=$?
set -e
[ "$status" = 0 ] || exit "$status"

echo "→ Uploading the code from this computer (no secrets)…"
bundle_files >"$WORK/files"
# COPYFILE_DISABLE stops macOS tar from adding ._ metadata files.
COPYFILE_DISABLE=1 tar -C "$repo" -czf - -T "$WORK/files" |
  remote "$AS_ROOT bash -c $(q "rm -rf $qdir/.code-new && mkdir -p $qdir/.code-new && tar -xzf - --no-same-owner --warning=no-unknown-keyword -C $qdir/.code-new")"

# Swap the new code in. Settings, sign-ins and the database stay where they are.
remote "$AS_ROOT bash -s -- $qdir" <<'REMOTE'
set -euo pipefail
cd "$1"
find . -mindepth 1 -maxdepth 1 ! -name data ! -name config.json ! -name .env ! -name .staging ! -name .code-new \
  -exec rm -rf {} +
(cd .code-new && find . -mindepth 1 -maxdepth 1 -exec mv {} .. \;)
rmdir .code-new
REMOTE

echo "→ Building mail-me on the server…"
remote "$AS_ROOT bash -s -- app --dir $qdir" <"$here/server-setup.sh" | tee "$WORK/app.log"

if grep -q '^MAIL_ME_STATUS=running' "$WORK/app.log"; then
  echo "✓ mail-me is running the new version. Logs: ssh $HOST 'cd $dir && ${AS_ROOT:+$AS_ROOT }docker compose logs -f mail-me'"
else
  echo "✓ Installed. Next, upload your settings and start it:"
  echo "    deploy/linux/push-config.sh $HOST"
fi
