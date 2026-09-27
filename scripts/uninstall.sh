#!/usr/bin/env bash
# Take OpenClaw away entirely (Phase 8 of docs/proposals/openclaw-test-plan.md), then prove it
# against the baseline taken before it was installed. Asks once before it starts.
#
# The Chips side on the live server is not done here: `chips remove OpenClaw` removes the harness
# there, and is run first, by hand, while its name still means something (the plan's step 2).
set -euo pipefail
. "$(dirname "$0")/lib.sh"

cat <<EOF
  This will:
    · stop the bridge, the scratch Chips server and its web app, by the PIDs in $DIR
    · remove the container, the project's volumes and the image $IMAGE
    · delete $DIR: OpenClaw's state, its ChatGPT sign-in, logs, the scratch Chips database
    · check every place OpenClaw could have left something, against $BASELINE
    · delete the baseline, once the check is clean
EOF
if [ "${1:-}" != "--yes" ]; then
  read -r -p "  Go ahead? [y/N] " answer
  [ "$answer" = "y" ] || { say "nothing was changed"; exit 1; }
fi

for pidfile in "$DIR/bridge/bridge.pid" "$DIR/chips/chipsd.pid" "$DIR/chips/web.pid"; do
  if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    kill "$(cat "$pidfile")" && say "stopped $(basename "$pidfile" .pid) ($(cat "$pidfile"))"
  fi
done

compose --profile cli down --volumes --rmi all --remove-orphans
docker image rm "$IMAGE" >/dev/null 2>&1 || true
say "container, volumes and image removed"

rm -rf "$DIR"
say "deleted $DIR"

say "checking against the baseline:"
if "$HERE/check.sh" --gone; then
  rm -f "$BASELINE"
  say "clean. The baseline is deleted. On OpenAI's side, the ChatGPT sign-in ends when it expires,"
  say "or now, if ChatGPT's security settings list it."
else
  say "something is left (above); the baseline is kept to check again"
  exit 1
fi
