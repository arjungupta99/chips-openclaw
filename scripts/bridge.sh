#!/usr/bin/env bash
# The bridge, run by hand and stopped by its PID, never as a launch agent (the plan's Phases 4 and 6).
#   bridge.sh start scratch | start live | stop | status
#
# scratch: the scratch Chips on 4436. Its four CHIPS_ lines are in $DIR/bridge/chips.env, as
#          `chips connect custom` printed them there.
# live:    Chips on 4431. The harness's address is in $DIR/bridge/live.env (CHIPS_URL,
#          CHIPS_HARNESS_ID, CHIPS_SPACE_ID) and its token stays in the login keychain, where
#          `chips connect` put it. The token is read into the bridge's environment at start and is
#          never written to a file.
set -euo pipefail
. "$(dirname "$0")/lib.sh"

STATE="$DIR/bridge"
PIDFILE="$STATE/bridge.pid"
LOG="$STATE/bridge.log"

alive() { [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; }

case "${1:-status}" in
  start)
    if alive; then say "the bridge is already running (pid $(cat "$PIDFILE"))"; exit 1; fi
    case "${2:-}" in
      scratch) ;;
      live)
        if [ ! -f "$STATE/live.env" ]; then
          say "no $STATE/live.env: connect OpenClaw to 4431 first (the plan's Phase 6)"; exit 1
        fi
        set -a; . "$STATE/live.env"; set +a
        # `chips connect` keeps a custom harness's token under service "chips", account custom:<id>.
        CHIPS_HARNESS_TOKEN="$(security find-generic-password -s chips -a "custom:$CHIPS_HARNESS_ID" -w)"
        export CHIPS_HARNESS_TOKEN
        ;;
      *) say "start which? scratch or live"; exit 1 ;;
    esac
    rm -f "$PIDFILE"
    (cd "$ROOT/bridge" && BRIDGE_TRACE="${BRIDGE_TRACE:-1}" nohup node --import tsx src/main.ts >>"$LOG" 2>&1 &)
    for _ in $(seq 1 30); do
      if alive; then say "bridge running against ${2} (pid $(cat "$PIDFILE")), log $LOG"; exit 0; fi
      sleep 1
    done
    say "the bridge did not start; its log:"; tail -20 "$LOG"; exit 1
    ;;
  stop)
    if alive; then
      kill "$(cat "$PIDFILE")" 2>/dev/null || true
      say "stopped the bridge"
    fi
    ;;
  status)
    if alive; then say "running (pid $(cat "$PIDFILE"))"; else say "not running"; fi
    ;;
esac
