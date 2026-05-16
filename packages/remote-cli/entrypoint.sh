#!/bin/sh
# Git credential setup for the remote-cli container.
# Thor git/gh wrappers handle per-invocation GitHub App token minting.

set -e

# Ensure cache directory exists with correct permissions
mkdir -p /var/lib/remote-cli/github-app/cache
chmod 700 /var/lib/remote-cli/github-app/cache 2>/dev/null || true

: "${GITHUB_APP_SLUG:?GITHUB_APP_SLUG is required}"
: "${GITHUB_APP_BOT_ID:?GITHUB_APP_BOT_ID is required}"

git config --global user.name "${GITHUB_APP_SLUG}[bot]"
git config --global user.email "${GITHUB_APP_BOT_ID}+${GITHUB_APP_SLUG}[bot]@users.noreply.github.com"

exec "$@"
