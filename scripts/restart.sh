#!/usr/bin/env bash
# Restart OpenClaw: what Chips's Restart runs through the bridge (Chips ADR 0094), and what you can
# run by hand. The bridge stays connected to Chips through all of it; this restarts what is behind
# it, and exits 0 once the gateway is healthy again.
#
# Colima's VM first, only when it is dead: it died three times in a week (28 and 30 September,
# 2 October), and then `colima list` can still say Running while `colima status` and every docker
# command fail. A force stop and a start bring it back with the containers it had; a VM that
# answers is left alone, since other projects' containers live on it too. Then the gateway's
# container is restarted (or started, by up.sh, when it is not there), and waited on.
set -euo pipefail
. "$(dirname "$0")/lib.sh"

# The bridge may have been started from a shell with a short PATH; colima and docker are Homebrew's.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

if ! colima status >/dev/null 2>&1; then
  say "Colima's VM is not answering; stopping it by force and starting it again"
  colima stop --force >/dev/null 2>&1 || true
  colima start
fi

if running; then
  say "restarting the gateway's container"
  compose restart gateway
fi
exec "$HERE/up.sh"
