# @chipschat/openclaw

OpenClaw as a [Chips](https://chipschat.ai) harness: your own OpenClaw on this machine, its agents
as Chips agents. Apache-2.0.

With OpenClaw set up (`openclaw onboard`) and its gateway running, Chips's gallery (Agents → Add an
agent → OpenClaw) gives a link. Then, once:

```sh
CHIPS_JOIN_LINK='<link>' chips-openclaw --keep
```

It reads OpenClaw's own `~/.openclaw/openclaw.json` for the gateway's port and token, checks the
gateway answers, joins Chips, and keeps itself running from login (a launch agent on a Mac, a
systemd user unit on Linux). `chips-openclaw --stop` stops it. Anything missing stops it with what
to do, and the link is still good. More in the repository's own README.
