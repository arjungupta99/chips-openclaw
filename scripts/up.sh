#!/usr/bin/env bash
# Start OpenClaw for testing Chips. The first run makes ~/chips-openclaw, a gateway token, and
# OpenClaw's config: local mode, token auth, no model yet (`login.sh`), no channels, no service,
# and every command the agent runs asked about first. Later runs only start the container.
set -euo pipefail
. "$(dirname "$0")/lib.sh"

mkdir -p "$DIR/state" "$DIR/secrets"
chmod 700 "$DIR" "$DIR/state" "$DIR/secrets"

if [ ! -f "$DIR/.env" ]; then
  (umask 077 && printf 'OPENCLAW_GATEWAY_TOKEN=%s\n' "$(openssl rand -hex 32)" >"$DIR/.env")
  say "made a gateway token in $DIR/.env"
fi

if [ ! -f "$DIR/state/openclaw.json" ]; then
  say "first run: OpenClaw's setup, without a model, channels or a service"
  oc_run onboard --non-interactive --accept-risk --mode local \
    --auth-choice skip \
    --gateway-auth token --gateway-token-ref-env OPENCLAW_GATEWAY_TOKEN --gateway-bind lan \
    --skip-channels --skip-daemon --no-install-daemon --skip-health --skip-hooks \
    --skip-search --skip-skills --skip-ui
  say "every command the agent runs asks first; unanswered is denied"
  oc_run exec-policy set --host gateway --security allowlist --ask always --ask-fallback deny
fi

compose up -d gateway
say "waiting for the gateway to be healthy"
for _ in $(seq 1 60); do
  state="$(docker inspect -f '{{.State.Health.Status}}' "$(compose ps -q gateway)" 2>/dev/null || true)"
  if [ "$state" = "healthy" ]; then
    say "OpenClaw is up on http://127.0.0.1:$PORT/ (token in $DIR/.env)"
    exit 0
  fi
  sleep 2
done
say "the gateway did not become healthy; its log:"
compose logs --tail 40 gateway
exit 1
