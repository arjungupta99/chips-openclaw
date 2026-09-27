#!/usr/bin/env bash
# Sign OpenClaw in to ChatGPT (OpenAI's OAuth), by device code: OpenClaw prints a link and a short
# code; open the link on any device, sign in, enter the code. The tokens stay in ~/chips-openclaw
# and go with it at the uninstall. A person runs this; nothing else types the sign-in.
set -euo pipefail
. "$(dirname "$0")/lib.sh"
running || { say "OpenClaw is not running: scripts/up.sh"; exit 1; }
oc_tty models auth login --provider openai --device-code --set-default
say "signed in; the profiles OpenClaw holds:"
oc models auth list --provider openai
