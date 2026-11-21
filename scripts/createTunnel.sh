#!/bin/bash
# Opens (or closes) an SSH tunnel to the production AMS360 Postgres, so a local checkout — whose .env
# points at PGHOST=localhost PGPORT=5433 — reads the live database. Runs in the background; safe to
# run again (does nothing if the tunnel is already up). Uses the `boxwood-mcp` host from ~/.ssh/config
# (the `boxwood` shell alias). Production Postgres listens on the server's 5432; the containers reach
# it over host networking.
#
# Usage: scripts/createTunnel.sh           open the tunnel
#        scripts/createTunnel.sh status    show whether it's up
#        scripts/createTunnel.sh stop      close it
set -euo pipefail

HOST=boxwood-mcp
LOCAL_PORT=5433
REMOTE_PORT=5432
FORWARD="${LOCAL_PORT}:localhost:${REMOTE_PORT}"

is_up() {
  ss -ltn 2>/dev/null | grep -qE "127\.0\.0\.1:${LOCAL_PORT}\b"
}

case "${1:-start}" in
  start)
    if is_up; then
      echo "Tunnel already up on localhost:${LOCAL_PORT}."
      exit 0
    fi
    # ExitOnForwardFailure: fail loudly instead of leaving a background ssh with no forward.
    ssh -f -N -o ExitOnForwardFailure=yes -L "$FORWARD" "$HOST"
    echo "Tunnel up: localhost:${LOCAL_PORT} → ${HOST}:${REMOTE_PORT}."
    ;;
  status)
    if is_up; then echo "Tunnel up on localhost:${LOCAL_PORT}."; else echo "Tunnel down."; exit 1; fi
    ;;
  stop)
    if pkill -f "ssh -f -N .*-L ${FORWARD} ${HOST}"; then echo "Tunnel closed."; else echo "No tunnel found."; fi
    ;;
  *)
    echo "Usage: $0 [start|status|stop]" >&2
    exit 2
    ;;
esac
