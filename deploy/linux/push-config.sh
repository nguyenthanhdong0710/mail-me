#!/usr/bin/env bash
# Upload config.json, .env and OAuth sign-ins to a mail-me server, check them there, then
# (re)start the service. Run from your mail-me folder, after deploy/linux/install.sh.
#
# Exit codes: 0 ok, 1 usage or SSH error, 2 local file missing, 3 server not installed yet,
# 4 the configuration did not pass check-config (the running service is left untouched).
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=deploy/linux/lib.sh
. "$here/lib.sh"

usage() {
  cat <<'EOF'
Usage: deploy/linux/push-config.sh [options] <user@host>

Options:
  -i <key>          SSH identity file
  -p <port>         SSH port (default: 22)
  -o <option>       Extra ssh option, e.g. -o ProxyJump=bastion
  --config <path>   Local config file (default: config.json)
  --env <path>      Local env file (default: .env)
  --grants <dir>    Local sign-ins folder (default: data/grants; skipped if missing)
  --no-grants       Do not upload sign-ins; keep the ones on the server
  --dir <path>      Install folder on the server (default: /opt/mail-me)
  -h, --help        Show this help
EOF
}

config=config.json
env_file=.env
grants=data/grants
with_grants=1
dir=/opt/mail-me

while [ $# -gt 0 ]; do
  case "$1" in
    -i) ssh_args+=(-i "${2:?-i needs a file}"); shift 2 ;;
    -p) ssh_args+=(-p "${2:?-p needs a port}"); shift 2 ;;
    -o) ssh_args+=(-o "${2:?-o needs an ssh option}"); shift 2 ;;
    --config) config=${2:?--config needs a path}; shift 2 ;;
    --env) env_file=${2:?--env needs a path}; shift 2 ;;
    --grants) grants=${2:?--grants needs a folder}; shift 2 ;;
    --no-grants) with_grants=0; shift ;;
    --dir) dir=${2:?--dir needs a path}; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    -*) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
    *)
      [ -z "$HOST" ] || { echo "Only one host, please." >&2; exit 1; }
      HOST=$1; shift ;;
  esac
done
[ -n "$HOST" ] || { usage >&2; exit 1; }

for f in "$config" "$env_file"; do
  [ -f "$f" ] || { echo "Missing $f. Prepare it as described in the README setup guide first." >&2; exit 2; }
done
if [ "$with_grants" = 1 ] && [ ! -d "$grants" ]; then
  echo "No $grants folder found; uploading without sign-ins (fine for password-only accounts)."
  with_grants=0
fi

ssh_setup
detect_root
qdir=$(q "$dir")

if ! remote "test -f $qdir/docker-compose.yml && command -v docker >/dev/null"; then
  echo "mail-me is not installed on $HOST yet. Run: deploy/linux/install.sh $HOST" >&2
  exit 3
fi

echo "→ Uploading settings (contents are never printed)…"
(
  umask 077
  mkdir "$WORK/bundle"
  cp "$config" "$WORK/bundle/config.json"
  cp "$env_file" "$WORK/bundle/.env"
  if [ "$with_grants" = 1 ]; then
    mkdir "$WORK/bundle/grants"
    find "$grants" -maxdepth 1 -type f -name '*.json' -exec cp {} "$WORK/bundle/grants/" \;
  fi
)
COPYFILE_DISABLE=1 tar -C "$WORK/bundle" -czf - . |
  remote "$AS_ROOT bash -c $(q "umask 077 && rm -rf $qdir/.staging && mkdir -p $qdir/.staging && tar -xzf - --no-same-owner --warning=no-unknown-keyword -C $qdir/.staging")"

echo "→ Checking the configuration on the server…"
remote "$AS_ROOT bash -s -- $qdir $with_grants" <<'REMOTE'
set -euo pipefail
dir=$1
with_grants=$2
st=$dir/.staging
cd "$dir"
trap 'rm -rf "$st"' EXIT

if ! docker image inspect mail-me:latest >/dev/null 2>&1; then
  echo "  building the image (first time only)…"
  docker build -q -t mail-me:latest . >/dev/null </dev/null
fi

# The container runs as uid 1000; sign-ins must be owner-only or mail-me refuses them.
mkdir -p data/grants
chown 1000:1000 data data/grants
chmod 700 data data/grants
chown 1000:1000 "$st/config.json"
chmod 600 "$st/config.json" "$st/.env"
grant_mount=""
if [ "$with_grants" = 1 ]; then
  chown -R 1000:1000 "$st/grants"
  chmod 700 "$st/grants"
  find "$st/grants" -type f -exec chmod 600 {} +
  grant_mount="      - ./grants:/app/data/grants:ro"
fi

# Check with the same env-file parsing as the real service, without touching it.
cat >"$st/check.yml" <<EOF
services:
  check:
    image: mail-me:latest
    env_file: .env
    volumes:
      - ./config.json:/app/config.json:ro
      - $dir/data:/app/data
$grant_mount
EOF
if ! docker compose -f "$st/check.yml" -p mail-me-check run --rm -T check check-config </dev/null; then
  echo "✗ check-config failed. Nothing was changed on the server; fix the problem and run this again." >&2
  exit 4
fi

install -m 600 -o 1000 -g 1000 "$st/config.json" config.json
install -m 600 -o root -g root "$st/.env" .env
if [ "$with_grants" = 1 ]; then
  find "$st/grants" -type f -name '*.json' -exec cp -p {} data/grants/ \;
fi

echo "→ Starting mail-me…"
# </dev/null: this script arrives on stdin, so no command may read it.
docker compose up -d --force-recreate mail-me </dev/null
docker compose ps mail-me </dev/null
REMOTE

echo "✓ Done. Follow the logs with: ssh $HOST 'cd $dir && ${AS_ROOT:+$AS_ROOT }docker compose logs -f mail-me'"
