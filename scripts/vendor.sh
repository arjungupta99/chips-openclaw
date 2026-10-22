#!/usr/bin/env bash
# The Chips SDK the bridge is built on, packed from a Chips checkout and installed:
#   vendor.sh [path to Chips]        (~/Work/Chips/chips-main unless given)
#
# Chips's `pnpm release:sdk` builds @chipschat/protocol, @chipschat/harness and @chipschat/conformance and packs
# them into bridge/vendor/, which package.json names as file: dependencies. npm keeps a tarball it
# installed before while the lockfile's hash for it holds, so those entries are dropped first and
# the new tarballs installed in their place. Nothing is published (Chips's ruling of 5 October 2026).
set -euo pipefail

CHIPS="${1:-$HOME/Work/Chips/chips-main}"
BRIDGE="$(cd "$(dirname "$0")/../bridge" && pwd)"

(cd "$CHIPS" && pnpm release:sdk "$BRIDGE/vendor")
cd "$BRIDGE"
node -e '
const fs = require("fs");
const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
for (const key of Object.keys(lock.packages)) if (key.startsWith("node_modules/@chipschat/")) delete lock.packages[key];
fs.writeFileSync("package-lock.json", `${JSON.stringify(lock, null, 2)}\n`);'
rm -rf node_modules/@chipschat
npm install --prefer-offline --no-audit --no-fund
echo "bridge: the SDK from $CHIPS is installed"
