#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
node_bin=''

if command -v node >/dev/null 2>&1; then
  node_bin=$(command -v node)
elif [ -x /Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node ]; then
  node_bin=/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node
elif [ -x "${HOME:?}/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node" ]; then
  node_bin="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
else
  echo 'Menoteam setup needs Node.js 20 or newer.' >&2
  exit 1
fi

if ! "$node_bin" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)'; then
  echo 'Menoteam setup needs Node.js 20 or newer.' >&2
  exit 1
fi

exec "$node_bin" "$script_dir/setup.mjs" "$@"
