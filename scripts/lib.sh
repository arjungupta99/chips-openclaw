# Shared by the OpenClaw scripts (the plan is Chips's docs/proposals/openclaw-test-plan.md). Sourced,
# never run.
#
# Everything OpenClaw keeps is under $CHIPS_OPENCLAW_DIR, and every Docker command is scoped to the
# compose project `chips-openclaw`, so nothing here can reach the other containers on this Colima.

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
export CHIPS_OPENCLAW_DIR="${CHIPS_OPENCLAW_DIR:-$HOME/Chips/.bridges/openclaw-rig}"
DIR="$CHIPS_OPENCLAW_DIR"
PROJECT="chips-openclaw"
IMAGE="ghcr.io/openclaw/openclaw:2026.9.6"
BASELINE="$HOME/Chips/.bridges/openclaw-rig-baseline.txt"
PORT=18789

say() { printf '  %s\n' "$*"; }

compose() { docker compose -p "$PROJECT" -f "$ROOT/compose.yaml" "$@"; }

# OpenClaw's CLI in a throwaway container of the gateway's image, before the gateway runs.
oc_run() { compose run --rm --no-deps -T --entrypoint node gateway dist/index.js "$@"; }

# OpenClaw's CLI inside the running gateway.
oc() { compose exec -T gateway node dist/index.js "$@"; }

# The same, attached to this terminal, for a prompt a person answers.
oc_tty() { compose exec gateway node dist/index.js "$@"; }

running() { [ -n "$(compose ps -q --status running gateway 2>/dev/null)" ]; }

token() { sed -n 's/^OPENCLAW_GATEWAY_TOKEN=//p' "$DIR/.env"; }
