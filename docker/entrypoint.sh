#!/bin/bash
# OpenAlice container entrypoint.
#
# Handles PUID/PGID remapping so files written to the mounted volume are owned
# by the host user rather than root. Compatible with Unraid's standard
# appdata ownership model.
#
# Environment variables (all optional):
#   PUID   — UID to run as (default: 1000)
#   PGID   — GID to run as (default: 1000)
#   TZ     — Timezone (default: UTC)
#
# If PUID/PGID match root (0) the process runs as root — same as the original
# behaviour before this script was introduced.

set -euo pipefail

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
TZ="${TZ:-UTC}"

# ── Timezone ──────────────────────────────────────────────────────────────────
if [ -f "/usr/share/zoneinfo/${TZ}" ]; then
  ln -snf "/usr/share/zoneinfo/${TZ}" /etc/localtime
  echo "${TZ}" > /etc/timezone
fi

# ── Root shortcut ─────────────────────────────────────────────────────────────
if [ "${PUID}" = "0" ] && [ "${PGID}" = "0" ]; then
  echo "[entrypoint] running as root"
  exec "$@"
fi

# ── User / group creation ─────────────────────────────────────────────────────
# Create the group if the GID doesn't already exist.
if ! getent group "${PGID}" &>/dev/null; then
  groupadd --gid "${PGID}" openalice
fi
GROUP_NAME=$(getent group "${PGID}" | cut -d: -f1)

# Create the user if the UID doesn't already exist.
if ! getent passwd "${PUID}" &>/dev/null; then
  useradd \
    --uid "${PUID}" \
    --gid "${PGID}" \
    --no-create-home \
    --shell /bin/false \
    openalice
fi

# ── Volume ownership ──────────────────────────────────────────────────────────
# Ensure the data volume and log directory are writable by the target user.
# Only chown the top-level dirs — avoid traversing large subtrees on every boot.
for dir in /data /app/logs; do
  if [ -d "${dir}" ]; then
    # Only fix if the owner doesn't already match (perf: skip on subsequent boots).
    owner_uid=$(stat -c '%u' "${dir}" 2>/dev/null || echo "0")
    if [ "${owner_uid}" != "${PUID}" ]; then
      chown "${PUID}:${PGID}" "${dir}" || true
    fi
  fi
done

echo "[entrypoint] running as ${PUID}:${PGID} (${GROUP_NAME})"
exec gosu "${PUID}:${PGID}" "$@"
