#!/usr/bin/env bash
# Prepares a Linux server for mail-me. Runs ON the server as root; install.sh streams it over SSH,
# so you normally never run it yourself. Every phase is safe to run again.
#
#   server-setup.sh check  [--dir DIR]  supported OS and CPU? (changes nothing)
#   server-setup.sh system [--dir DIR]  Docker + Compose, swap on small machines, the data folder
#   server-setup.sh app    [--dir DIR]  build the image; start mail-me if settings are present
#
# Exit codes: 0 ok, 1 error, 5 unsupported system.
set -euo pipefail

phase=${1:-}
[ $# -gt 0 ] && shift
dir=/opt/mail-me
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) dir=${2:?--dir needs a path}; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

say() { echo "  [server] $*"; }

check_os() {
  if [ ! -r /etc/os-release ]; then
    echo "Unsupported system (no /etc/os-release). Supported: Ubuntu 22.04/24.04, Debian 12/13." >&2
    exit 5
  fi
  # shellcheck disable=SC1091
  . /etc/os-release
  case "${ID:-}:${VERSION_ID:-}" in
    ubuntu:22.04 | ubuntu:24.04 | debian:12 | debian:13) ;;
    *)
      echo "Unsupported system: ${PRETTY_NAME:-unknown}. Supported: Ubuntu 22.04/24.04, Debian 12/13." >&2
      exit 5
      ;;
  esac
  case "$(uname -m)" in
    x86_64 | aarch64) ;;
    *)
      echo "Unsupported CPU: $(uname -m). Supported: x86_64 and aarch64 (arm64)." >&2
      exit 5
      ;;
  esac
  OS_ID=$ID
  OS_CODENAME=${VERSION_CODENAME:-}
}

need_root() {
  [ "$(id -u)" = 0 ] || { echo "server-setup.sh $phase must run as root." >&2; exit 1; }
}

apt_get() { apt-get -o DPkg::Lock::Timeout=600 -y -qq "$@" >/dev/null; }

install_docker() {
  if docker compose version >/dev/null 2>&1 && docker buildx version >/dev/null 2>&1; then
    say "Docker and Compose already installed"
    return
  fi
  say "installing Docker Engine and Compose from Docker's repository…"
  export DEBIAN_FRONTEND=noninteractive
  apt_get update
  apt_get install ca-certificates curl
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/$OS_ID/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/$OS_ID $OS_CODENAME stable" \
    >/etc/apt/sources.list.d/docker.list
  apt_get update
  apt_get install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
}

add_swap() {
  local mem_kb
  mem_kb=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)
  if [ "$mem_kb" -ge 2000000 ] || [ -n "$(swapon --show --noheadings 2>/dev/null)" ]; then
    return
  fi
  say "less than 2 GB of memory and no swap: adding a 2 GB swap file so the build fits…"
  fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
}

# Oracle Cloud's Ubuntu images end the FORWARD chain with a REJECT rule, which can cut containers
# off from the internet. Inbound access is still limited by the INPUT chain and the cloud firewall.
fix_oracle_forward_rule() {
  if [ -f /etc/iptables/rules.v4 ] && grep -q '^-A FORWARD -j REJECT' /etc/iptables/rules.v4; then
    say "removing Oracle's FORWARD REJECT rule so containers can reach the internet"
    sed -i '/^-A FORWARD -j REJECT/d' /etc/iptables/rules.v4
    iptables -D FORWARD -j REJECT --reject-with icmp-host-prohibited 2>/dev/null || true
  fi
}

phase_system() {
  need_root
  if command -v cloud-init >/dev/null 2>&1; then
    say "waiting for first-boot setup (cloud-init) to finish…"
    cloud-init status --wait >/dev/null 2>&1 || true
  fi
  install_docker
  if command -v systemctl >/dev/null 2>&1; then systemctl enable --now docker >/dev/null 2>&1 || true; fi
  add_swap
  fix_oracle_forward_rule
  # The container runs as uid 1000 (node) and keeps its database and sign-ins here.
  mkdir -p "$dir/data"
  chown 1000:1000 "$dir/data"
  chmod 700 "$dir/data"
  say "system ready"
}

phase_app() {
  need_root
  [ -f "$dir/Dockerfile" ] || { echo "No mail-me code in $dir. Run deploy/linux/install.sh first." >&2; exit 1; }
  cd "$dir"
  say "building the mail-me image (a few minutes; longer on small servers)…"
  docker build -q -t mail-me:latest . >/dev/null </dev/null
  docker image prune -f >/dev/null 2>&1 || true
  if [ -f config.json ] && [ -f .env ]; then
    say "settings found: (re)starting mail-me"
    docker compose up -d --force-recreate mail-me </dev/null
    echo "MAIL_ME_STATUS=running"
  else
    echo "MAIL_ME_STATUS=waiting-for-settings"
  fi
}

case "$phase" in
  check) check_os; echo "OK: ${PRETTY_NAME:-} on $(uname -m)" ;;
  system) check_os; phase_system ;;
  app) phase_app ;;
  *) echo "Usage: server-setup.sh <check|system|app> [--dir DIR]" >&2; exit 1 ;;
esac
