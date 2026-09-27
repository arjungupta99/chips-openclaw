#!/usr/bin/env bash
# OpenClaw's own CLI, inside the running container: `scripts/cli.sh doctor`.
set -euo pipefail
. "$(dirname "$0")/lib.sh"
running || { say "OpenClaw is not running: scripts/up.sh"; exit 1; }
if [ -t 0 ]; then oc_tty "$@"; else oc "$@"; fi
