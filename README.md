# chips-openclaw

OpenClaw, run to test [Chips](../Chips) as a second harness beside Jacobian, and taken away after.
The plan, the phases and the tests are in Chips's `docs/proposals/openclaw-test-plan.md`.

**Chips depends on nothing here.** Chips's own guard fails if anything of OpenClaw appears in Chips.
This repository depends on Chips through its public wire and, since 14 October 2026, its SDK:
`@chipschat/harness` and `@chipschat/protocol` (and `@chipschat/conformance` for the tests), packed from a Chips
checkout into `bridge/vendor/` by `scripts/vendor.sh`, since nothing of Chips is published yet. Until
then the bridge was written from Chips's docs alone, which proved the docs; now it is what another
harness's bridge would be (Chips's `docs/proposals/open-source-harnesses-plan.md`, Phase 2).

## What is here

| Path | What it is |
|---|---|
| `compose.yaml` | OpenClaw 2026.9.6 in one container, compose project `chips-openclaw`, on `127.0.0.1:18789` only, never a service |
| `scripts/up.sh` | start it; the first run makes `~/chips-openclaw`, a gateway token, and OpenClaw's config (no model, no channels, ask before every command) |
| `scripts/login.sh` | sign OpenClaw in to ChatGPT by device code; the sign-in stays in `~/chips-openclaw` |
| `scripts/cli.sh` | OpenClaw's own CLI inside the container, e.g. `scripts/cli.sh doctor` |
| `scripts/scratch-chips.sh` | a scratch Chips on 4436, apart from the live one (Phase 3) |
| `scripts/bridge.sh` | start the bridge against the scratch Chips or the live one on 4431, stop it by its PID |
| `scripts/restart.sh` | restart it: Colima's VM started again when it is dead, then the gateway's container, waited on. What Restart on OpenClaw's page in Chips runs, through the bridge (Chips ADR 0094) |
| `scripts/vendor.sh` | the Chips SDK, packed from a Chips checkout into `bridge/vendor/` and installed; run it when the SDK changes |
| `scripts/check.sh` | what is running; `--gone` proves it has all gone, against the baseline taken before the install |
| `scripts/down.sh` | stop it, keeping everything |
| `scripts/uninstall.sh` | take it all away and prove it |
| `bridge/` | the bridge between OpenClaw and Chips (Phase 4 of the plan) |

## Joining a Chips from a link

Chips's gallery has an OpenClaw card (Chips ADR 0171). Its link, made in Chips under **Agents → Add
an agent → OpenClaw**, is all the bridge needs: with OpenClaw up (`scripts/up.sh`),

```sh
cd bridge && npm run connect -- 'http://192.168.1.20:4431/j/chips_j_…'
```

or `CHIPS_JOIN_LINK='…' npm start`; the card gives the first, from `~/Work/chips-openclaw/bridge`.
Before it takes the link up, which works once, it checks OpenClaw's side: the gateway's token (in
`~/chips-openclaw/.env`, made by `scripts/up.sh`) and the gateway answering. Anything missing stops
it with what to do, and the link is still good. Then it takes the link up through the SDK's
`join()` (Chips ADR 0122), keeps the key the SDK is handed, writes the address to
`bridge/joined.env`, starts, and says hello in its room once, which the card waits for. After that,
`npm start` comes back to the same Chips with the same key, and a new link from Chips replaces it; a
token in the environment (`scripts/bridge.sh start live`) still wins, and says no hello. A package
an agent could fetch (`@chipschat/openclaw`) waits for publishing, which nothing here is yet.

`npm run e2e` in `bridge/` runs the card that way against a scratch Chips from a Chips checkout
(`CHIPS_REPO`, `~/Work/Chips` unless set; skipped without one) and a fake gateway
(`bridge/test/fake-gateway.ts`): each thing not set up stops it with the link still good; then it
joins with what the card grants, says hello once, says nothing more started again, and takes up a
new link in place of the key it kept. The scratch Chips, the link and the run come from Chips's
`tools/connect-kit`; `npm test` there runs the bridge's own tests.

## Where things are kept

Everything OpenClaw and the bridge keep is under `~/chips-openclaw/`:
- `state/`: OpenClaw's config, sessions, workspace and logs; `state/chips/<agent>/` is the folder of
  each OpenClaw agent the bridge made for an agent in Chips (`bridge/src/own-agents.ts`)
- `secrets/`: its sign-in
- `.env`: the gateway token
- `bridge/`: the bridge's device key, one cursor per Chips harness, its log, `chips.env` (the scratch
  harness), `live.env` (4431's harness address; its token stays in the login keychain), `joined.env`
  (the address of a Chips it joined from a link; the key is the SDK's, in the login keychain), and
  `automations.json`: who each automation an agent scheduled from a room is for (Chips ADR 0157)
- `chips/`: the scratch Chips server's database

The uninstall deletes that folder, the container and the image. This repository stays. On 4431,
`chips remove OpenClaw` takes the harness away first (the plan's Phase 8).
