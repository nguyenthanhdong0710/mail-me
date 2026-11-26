#!/usr/bin/env bash
# Copy the server's data/ folder (database and OAuth sign-ins) to this computer.
# mail-me is stopped for a few seconds so the SQLite files are consistent, then started again.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=deploy/linux/lib.sh
. "$here/lib.sh"

usage() {
  cat <<'EOF'
Usage: deploy/linux/backup.sh [options] <user@host>

Options:
  -i <key>      SSH identity file
  -p <port>     SSH port (default: 22)
  -o <option>   Extra ssh option, e.g. -o ProxyJump=bastion
  --dir <path>  Install folder on the server (default: /opt/mail-me)
  --out <dir>   Where to save the backup (default: current folder)
  -h, --help    Show this help

The backup contains your sign-ins (secrets): keep it private.
EOF
}

dir=/opt/mail-me
out=.

while [ $# -gt 0 ]; do
  case "$1" in
    -i) ssh_args+=(-i "${2:?-i needs a file}"); shift 2 ;;
    -p) ssh_args+=(-p "${2:?-p needs a port}"); shift 2 ;;
    -o) ssh_args+=(-o "${2:?-o needs an ssh option}"); shift 2 ;;
    --dir) dir=${2:?--dir needs a path}; shift 2 ;;
    --out) out=${2:?--out needs a folder}; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    -*) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
    *)
      [ -z "$HOST" ] || { echo "Only one host, please." >&2; exit 1; }
      HOST=$1; shift ;;
  esac
done
[ -n "$HOST" ] || { usage >&2; exit 1; }

ssh_setup
detect_root

umask 077
mkdir -p "$out"
file="$out/mail-me-backup-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"

# The server restarts mail-me even if tar fails.
if ! remote "$AS_ROOT bash -s -- $(q "$dir")" >"$file.part" <<'REMOTE'; then
set -euo pipefail
cd "$1"
docker compose stop mail-me >&2 </dev/null
trap 'docker compose start mail-me >&2 </dev/null' EXIT
tar -czf - data
REMOTE
  rm -f "$file.part"
  echo "Backup failed; nothing saved." >&2
  exit 1
fi

[ -s "$file.part" ] || { rm -f "$file.part"; echo "Backup is empty; nothing saved." >&2; exit 1; }
mv "$file.part" "$file"
echo "✓ Saved $file (private: contains your sign-ins)."
