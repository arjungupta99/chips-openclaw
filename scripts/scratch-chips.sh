#!/usr/bin/env bash
# A scratch Chips server for the test (Phase 3), apart from the live one on 4431: port 4436, dev mode
# on loopback, its database in ~/chips-openclaw/chips. Runs the Chips checkout's own server code.
#   scratch-chips.sh start | stop | status
set -euo pipefail
. "$(dirname "$0")/lib.sh"

CHIPS_REPO="${CHIPS_REPO:-$HOME/Work/Chips/chips-main}"
DATA="$DIR/chips"
PIDFILE="$DATA/chipsd.pid"
SCRATCH_PORT=4436

alive() { [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; }

case "${1:-status}" in
  start)
    if alive; then say "scratch Chips already running ($(cat "$PIDFILE"))"; exit 0; fi
    if lsof -nP -iTCP:"$SCRATCH_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
      say "port $SCRATCH_PORT is taken by something else"; exit 1
    fi
    mkdir -p "$DATA" && chmod 700 "$DATA"
    (
      cd "$CHIPS_REPO/server"
      CHIPS_HOST=127.0.0.1 CHIPS_PORT="$SCRATCH_PORT" CHIPS_DEV_MODE=true \
        CHIPS_DATA_DIR="$DATA" CHIPS_DATABASE_URL="sqlite:$DATA/chips.db" \
        nohup node --import tsx bin/chipsd.ts serve >"$DATA/chipsd.log" 2>&1 &
      echo $! >"$PIDFILE"
    )
    for _ in $(seq 1 60); do
      if curl -sf "http://127.0.0.1:$SCRATCH_PORT/v1/health" >/dev/null; then
        say "scratch Chips on http://127.0.0.1:$SCRATCH_PORT (pid $(cat "$PIDFILE")), log $DATA/chipsd.log"
        exit 0
      fi
      sleep 1
    done
    say "scratch Chips did not answer; its log:"; tail -20 "$DATA/chipsd.log"; exit 1
    ;;
  stop)
    if alive; then
      # One node process (tsx as a loader, not a launcher), stopped by its own PID.
      kill "$(cat "$PIDFILE")" 2>/dev/null || true
      say "stopped scratch Chips"
    fi
    rm -f "$PIDFILE"
    ;;
  status)
    if alive; then say "running (pid $(cat "$PIDFILE"))"; else say "not running"; fi
    ;;
esac
