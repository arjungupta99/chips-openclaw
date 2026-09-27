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
  # The host's approvals: ask always, deny what nobody answers.
  oc_run exec-policy set --host gateway --security allowlist --ask always --ask-fallback deny
  # A ChatGPT sign-in runs turns on OpenClaw's Codex runtime, where an allowlist exec policy blocks
  # every command outright. Mode `ask` with Codex's own reviewer set to the user sends each command
  # to the operator's approval route instead, which is what the bridge turns into Chips cards.
  oc_run config unset tools.exec.security
  oc_run config unset tools.exec.ask
  oc_run config set tools.exec.mode ask
  oc_run config set plugins.entries.codex.enabled true
  # Codex's own sandbox (bubblewrap) cannot start in an unprivileged container, so every command
  # failed after its yes. The container is the sandbox instead (Arjun's call, 27 September 2026):
  # full access inside it, and `untrusted` asks for everything beyond Codex's read-only safe list.
  oc_run config set plugins.entries.codex.config.appServer.approvalPolicy untrusted
  oc_run config set plugins.entries.codex.config.appServer.approvalsReviewer user
  oc_run config set plugins.entries.codex.config.appServer.sandbox danger-full-access
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
