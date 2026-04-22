#!/usr/bin/env sh

set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

exec mitmdump \
  --mode regular@8080 \
  --set block_global=false \
  --set connection_strategy=lazy \
  -s "$SCRIPT_DIR/addon.py"
