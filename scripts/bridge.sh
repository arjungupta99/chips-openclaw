#!/usr/bin/env bash
# The bridge: the live one kept running by launchd, the scratch one run by hand.
#   bridge.sh start live | start scratch | stop | status    (`run live` is the launch agent's)
#
# live:    Chips on 4431, kept by launchd as chat.chips.openclaw, as Hermes's and OpenCode's bridges
#          are: `start live` writes ~/Library/LaunchAgents/chat.chips.openclaw.plist, which runs
#          `bridge.sh run live` at login and again whenever the bridge stops, so a closed terminal
#          or a killed task no longer takes OpenClaw offline in Chips (it did on 24 October 2026).
#          The harness's address is in $DIR/bridge/live.env (CHIPS_URL, CHIPS_HARNESS_ID,
#          CHIPS_SPACE_ID) and its token stays in the login keychain, where `chips connect` put it.
#          `run live` reads the token into the bridge's environment at each start; it is never
#          written to a file, the launch agent's included.
# scratch: the scratch Chips on 4436, run by hand and stopped by its PID, never kept. Its four
#          CHIPS_ lines are in $DIR/bridge/chips.env, as `chips connect custom` printed them there.
# stop:    either one, and returns once it has exited. The live one leaves launchd and its file is
#          removed, so it stays stopped, at login too, until `start live`.
set -euo pipefail
. "$(dirname "$0")/lib.sh"

STATE="$DIR/bridge"
PIDFILE="$STATE/bridge.pid"
LOG="$STATE/bridge.log"
LABEL="chat.chips.openclaw"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
JOB="gui/$(id -u)/$LABEL"
# In the launch agent's file, so `stop` removes only a file `start live` wrote.
MARK="Written by chips-openclaw's scripts/bridge.sh"

alive() { [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; }
kept() { launchctl print "$JOB" >/dev/null 2>&1; }

# The live harness's address and token, into this shell's environment.
live_env() {
  if [ ! -f "$STATE/live.env" ]; then
    say "no $STATE/live.env: connect OpenClaw to 4431 first (the plan's Phase 6)"; exit 1
  fi
  set -a; . "$STATE/live.env"; set +a
  # `chips connect` keeps a custom harness's token under service "chips", account custom:<id>.
  CHIPS_HARNESS_TOKEN="$(security find-generic-password -s chips -a "custom:$CHIPS_HARNESS_ID" -w)"
  export CHIPS_HARNESS_TOKEN
}

# `run live` at login and again whenever it stops, ten seconds apart at most; what it says goes
# to the bridge's log, as a bridge started by hand's does.
write_plist() {
  mkdir -p "$(dirname "$PLIST")"
  cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- $MARK start live. \`bridge.sh stop\` stops it and removes this file. -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$HERE/bridge.sh</string>
    <string>run</string>
    <string>live</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$ROOT/bridge</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>CHIPS_OPENCLAW_DIR</key>
    <string>$DIR</string>
    <key>BRIDGE_TRACE</key>
    <string>${BRIDGE_TRACE:-1}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>$LOG</string>
  <key>StandardErrorPath</key>
  <string>$LOG</string>
</dict>
</plist>
EOF
}

case "${1:-status}" in
  start)
    if alive; then say "the bridge is already running (pid $(cat "$PIDFILE"))"; exit 1; fi
    rm -f "$PIDFILE"
    case "${2:-}" in
      scratch)
        (cd "$ROOT/bridge" && BRIDGE_TRACE="${BRIDGE_TRACE:-1}" nohup node --import tsx src/main.ts >>"$LOG" 2>&1 &)
        how="by hand"
        ;;
      live)
        # Said here, where a person reads it, rather than again every ten seconds in the log.
        (live_env)
        if [ -f "$PLIST" ] && ! grep -q "$MARK" "$PLIST"; then
          say "$PLIST is there already and wasn't written by bridge.sh: it was left as it is, and nothing was started"
          exit 1
        fi
        write_plist
        # A job launchd still holds, one that kept failing say, is let go and loaded from the new file.
        launchctl bootout "$JOB" 2>/dev/null || true
        launchctl bootstrap "gui/$(id -u)" "$PLIST"
        how="kept by launchd as $LABEL"
        ;;
      *) say "start which? scratch or live"; exit 1 ;;
    esac
    for _ in $(seq 1 30); do
      if alive; then say "bridge running against ${2} (pid $(cat "$PIDFILE")), $how, log $LOG"; exit 0; fi
      sleep 1
    done
    say "the bridge did not start; its log:"; tail -20 "$LOG"; exit 1
    ;;
  run)
    # The launch agent's: the live bridge in the foreground, as launchd's own process.
    [ "${2:-}" = "live" ] || { say "run which? live"; exit 1; }
    if alive; then say "the bridge is already running (pid $(cat "$PIDFILE"))"; exit 1; fi
    live_env
    cd "$ROOT/bridge"
    BRIDGE_TRACE="${BRIDGE_TRACE:-1}" exec node --import tsx src/main.ts
    ;;
  stop)
    pid="$(cat "$PIDFILE" 2>/dev/null || true)"
    was=""
    # Out of launchd first, which would start it again, and its file gone, so login doesn't either.
    if kept; then launchctl bootout "$JOB" 2>/dev/null || true; was=yes; fi
    if [ -f "$PLIST" ] && grep -q "$MARK" "$PLIST"; then rm -f "$PLIST"; fi
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      was=yes
      # Back only once it has exited: a `start` straight after found it alive and refused (BR-2).
      for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
      if kill -0 "$pid" 2>/dev/null; then say "the bridge (pid $pid) is still running 20 s after it was asked to stop"; exit 1; fi
    fi
    if [ -n "$was" ]; then say "stopped the bridge"; else say "the bridge was not running"; fi
    ;;
  status)
    if alive && kept; then say "running (pid $(cat "$PIDFILE")), kept by launchd as $LABEL"
    elif alive; then say "running (pid $(cat "$PIDFILE")), by hand"
    elif kept; then say "not running, though launchd holds $LABEL: see $LOG"
    else say "not running"; fi
    ;;
esac
