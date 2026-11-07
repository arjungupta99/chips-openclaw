#!/usr/bin/env bash
# Stop OpenClaw, keeping everything: `up.sh` starts it again as it was.
set -euo pipefail
. "$(dirname "$0")/lib.sh"
compose stop
say "stopped; ~/Chips/.bridges/openclaw-rig is kept"
