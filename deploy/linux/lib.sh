# shellcheck shell=bash
# Shared helpers for the deploy/linux scripts. Sourced, not run. Works with macOS bash 3.2.
#
# The calling script sets HOST (user@host) and may add to ssh_args (e.g. -i key), then calls
# ssh_setup and detect_root. After that:
#   remote <command...>  runs a command on the server over one shared SSH connection
#   $AS_ROOT             is "" when logged in as root, "sudo" for a user with password-less sudo
#   $WORK                is a private temporary folder, removed on exit

# shellcheck disable=SC2034 # used by the scripts that source this file
HOST=""
# shellcheck disable=SC2034
AS_ROOT=""
WORK=""
ssh_args=()

ssh_setup() {
  WORK=$(mktemp -d)
  trap ssh_cleanup EXIT
  # One connection for every step, so a key passphrase is asked for once.
  ssh_args+=(-o ControlMaster=auto -o "ControlPath=$WORK/ssh" -o ControlPersist=120)
}

ssh_cleanup() {
  ssh -o "ControlPath=$WORK/ssh" -O exit "$HOST" 2>/dev/null || true
  rm -rf "$WORK"
}

# shellcheck disable=SC2029 # remote commands are built and quoted on purpose
remote() { ssh "${ssh_args[@]}" "$HOST" "$@"; }

detect_root() {
  local uid
  if ! uid=$(remote 'id -u'); then
    echo "Could not connect to $HOST over SSH." >&2
    exit 1
  fi
  if [ "$uid" = 0 ]; then
    AS_ROOT=""
  elif remote 'sudo -n true' 2>/dev/null; then
    # shellcheck disable=SC2034
    AS_ROOT="sudo"
  else
    echo "$HOST: log in as root, or as a user that can run sudo without a password." >&2
    exit 1
  fi
}

# Quote one value for the remote shell.
q() { printf %q "$1"; }
