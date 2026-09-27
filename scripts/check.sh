#!/usr/bin/env bash
# What OpenClaw is doing on this Mac. `check.sh` says what is running; `check.sh --gone` proves it
# has all gone, against the baseline taken before it was installed. Exit 1 when a check fails.
set -uo pipefail
. "$(dirname "$0")/lib.sh"

failed=0
ok() { printf '  ✓ %s\n' "$*"; }
bad() {
  printf '  ✗ %s\n' "$*"
  failed=1
}

# The lines of one section of the baseline.
section() { awk -v want="## $1" '$0 == want { on = 1; next } /^## / { on = 0 } on' "$BASELINE"; }

running_now() {
  if running; then
    ok "container: $(compose ps --format '{{.Name}} {{.Status}}' gateway)"
  else
    bad "container: not running (scripts/up.sh)"
  fi
  if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    ok "gateway: listening on 127.0.0.1:$PORT"
  else
    bad "gateway: nothing on $PORT"
  fi
  if [ -d "$DIR" ]; then ok "folder: $DIR, $(du -sh "$DIR" 2>/dev/null | cut -f1)"; else bad "folder: $DIR missing"; fi
  if [ -f "$BASELINE" ]; then ok "baseline: $BASELINE"; else bad "baseline: missing"; fi
}

gone() {
  [ -f "$BASELINE" ] || { bad "no baseline at $BASELINE to compare against"; return; }
  [ -z "$(docker ps -a --filter "label=com.docker.compose.project=$PROJECT" -q)" ] &&
    ok "no container of $PROJECT" || bad "containers of $PROJECT remain"
  [ -z "$(docker ps -a --format '{{.Image}} {{.Names}}' | grep -i openclaw)" ] &&
    ok "no container named or made from openclaw" || bad "an openclaw container remains"
  [ -z "$(docker images --format '{{.Repository}}' | grep -i openclaw)" ] &&
    ok "no openclaw image" || bad "an openclaw image remains"
  [ -z "$(docker volume ls -q | grep -iE "openclaw|$PROJECT")" ] &&
    ok "no openclaw volume" || bad "an openclaw volume remains"
  for path in "$DIR" "$HOME/.openclaw" "$HOME/.openclaw-auth-profile-secrets" /tmp/openclaw \
    /Applications/OpenClaw.app; do
    [ ! -e "$path" ] && ok "absent: $path" || bad "present: $path"
  done
  [ -z "$(ls "$HOME/Library/LaunchAgents" | grep -i openclaw)" ] &&
    ok "no OpenClaw launch agent" || bad "an OpenClaw launch agent remains"
  [ -z "$(launchctl list | grep -i openclaw)" ] && ok "nothing OpenClaw in launchctl" ||
    bad "OpenClaw is loaded in launchctl"
  [ -z "$(npm ls -g --depth=0 2>/dev/null | grep -i openclaw)" ] &&
    ok "no global openclaw npm package" || bad "a global openclaw npm package remains"
  [ -z "$(security dump-keychain 2>/dev/null | grep -i openclaw)" ] &&
    ok "nothing OpenClaw in the keychain" || bad "the keychain holds an OpenClaw item"
  for port in 18789 1455 4436; do
    lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 && bad "port $port in use" ||
      ok "port $port free"
  done
  if diff <(section "~ top level") <(ls -A "$HOME") >/dev/null; then
    ok "the top of ~ is as the baseline found it"
  else
    bad "the top of ~ differs from the baseline:"
    diff <(section "~ top level") <(ls -A "$HOME") | sed 's/^/      /'
  fi
  if diff <(section "~/Library/LaunchAgents") <(ls -A "$HOME/Library/LaunchAgents") >/dev/null; then
    ok "LaunchAgents as the baseline found them"
  else
    bad "LaunchAgents differ from the baseline"
  fi
  before="$(section "docker ps -a" | awk '{ print $1 }' | sort)"
  now="$(docker ps -a --format '{{.Names}}' | sort)"
  [ "$before" = "$now" ] && ok "the other containers are the baseline's, untouched" ||
    bad "the containers differ from the baseline"
}

if [ "${1:-}" = "--gone" ]; then gone; else running_now; fi
exit "$failed"
