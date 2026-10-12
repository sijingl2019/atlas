#!/bin/sh
# Starts as root, hands each volume mount point to the host user, then drops
# to that user, so nothing written into the bind-mounted checkout ends up
# owned by root on a Linux host. ci-local passes ATLAS_UID/ATLAS_GID, and 0
# for rootless Docker and Podman, where root in here already is the host user.
set -eu

uid="${ATLAS_UID:-0}"
gid="${ATLAS_GID:-0}"
export HOME=/cache/home CARGO_HOME=/cache/cargo CARGO_TARGET_DIR=/cache/target

mkdir -p "$HOME" "$CARGO_HOME" "$CARGO_TARGET_DIR"
# A fresh volume is root-owned and empty; only its top level needs handing over.
for d in /cache "$HOME" "$CARGO_HOME" "$CARGO_TARGET_DIR" ${ATLAS_OWNED:-}; do
  [ "$(stat -c %u:%g "$d")" = "$uid:$gid" ] || chown "$uid:$gid" "$d"
done

[ "$uid" = 0 ] && exec "$@"
exec setpriv --reuid="$uid" --regid="$gid" --clear-groups "$@"
