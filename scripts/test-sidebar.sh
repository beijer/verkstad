#!/bin/sh
# The Gate's `sidebar` step: the sidebar's tests (hooks/sidebar/*.test.ts), run by `claude plugin test`
# against the plugin's manifest, hooks and state contract alone, since that runner takes every *.test.ts under
# the folder it is given and verkstad's own tests are node's (test/). Skipped where claude is not installed.
set -eu
command -v claude >/dev/null || { echo "claude is not installed: the sidebar's tests are skipped"; exit 0; }
root=$(cd "$(dirname "$0")/.." && pwd)
dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT
mkdir -p "$dir/.claude-plugin"
cp "$root/.claude-plugin/plugin.json" "$dir/.claude-plugin/"
cp -R "$root/hooks" "$root/types" "$dir/"
claude plugin test "$dir"
