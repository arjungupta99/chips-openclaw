# chips-openclaw

OpenClaw, run to test [Chips](../Chips) as a second harness beside Jacobian, and taken away after.
The plan, the phases and the tests are in Chips's `docs/proposals/openclaw-test-plan.md`.

**Chips depends on nothing here.** This repository depends on Chips only through Chips's public
wire (WebSocket and HTTP, as Chips's `connect/` docs describe). It imports none of Chips's packages,
and Chips's own guard fails if anything of OpenClaw appears in Chips.

## What is here

| Path | What it is |
|---|---|
| `compose.yaml` | OpenClaw 2026.9.6 in one container, compose project `chips-openclaw`, on `127.0.0.1:18789` only, never a service |
| `scripts/up.sh` | start it; the first run makes `~/chips-openclaw`, a gateway token, and OpenClaw's config (no model, no channels, ask before every command) |
| `scripts/login.sh` | sign OpenClaw in to ChatGPT by device code; the sign-in stays in `~/chips-openclaw` |
| `scripts/cli.sh` | OpenClaw's own CLI inside the container, e.g. `scripts/cli.sh doctor` |
| `scripts/check.sh` | what is running; `--gone` proves it has all gone, against the baseline taken before the install |
| `scripts/down.sh` | stop it, keeping everything |
| `scripts/uninstall.sh` | take it all away and prove it |
| `bridge/` | the bridge between OpenClaw and Chips (Phase 4 of the plan) |

## Where things are kept

Everything OpenClaw and the bridge keep is under `~/chips-openclaw/`:
- `state/`: OpenClaw's config, sessions, workspace and logs
- `secrets/`: its sign-in
- `.env`: the gateway token
- `bridge/`: the bridge's device key and cursor
- `chips/`: the scratch Chips server's database

The uninstall deletes that folder, the container and the image. This repository stays.
