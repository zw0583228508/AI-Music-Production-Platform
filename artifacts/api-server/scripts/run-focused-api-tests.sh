#!/bin/sh
set -eu

tmpdir=$(mktemp -d /tmp/music-studio-api-tests.XXXXXX)
trap 'rm -rf -- "$tmpdir"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

node ./scripts/run-focused-api-tests.mjs "$1" "$tmpdir"