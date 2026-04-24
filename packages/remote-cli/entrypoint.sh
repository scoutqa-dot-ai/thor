#!/bin/sh
# Git credential setup for the remote-cli container.
#
# Two auth modes:
#   1. GitHub App (preferred): config.json has orgs.<org>.github_app_installation_id.
#      Thor git/gh wrappers handle per-invocation token minting.
#      PAT env vars below act as fallback if the wrapper fails.
#   2. PAT (legacy): GITHUB_PAT env var configures GIT_ASKPASS + GH_TOKEN.

set -e

if [ -n "$GITHUB_PAT" ]; then
  ASKPASS_SCRIPT="/tmp/git-askpass.sh"
  printf '#!/bin/sh\necho "%s"\n' "$GITHUB_PAT" > "$ASKPASS_SCRIPT"
  chmod 700 "$ASKPASS_SCRIPT"

  export GIT_ASKPASS="$ASKPASS_SCRIPT"
  export GH_TOKEN="$GITHUB_PAT"
  export GIT_TERMINAL_PROMPT=0
  export GIT_CONFIG_COUNT=1
  export GIT_CONFIG_KEY_0="credential.username"
  export GIT_CONFIG_VALUE_0="x-access-token"
fi

# Ensure cache directory exists with correct permissions
mkdir -p /var/lib/remote-cli/github-app/cache
chmod 700 /var/lib/remote-cli/github-app/cache 2>/dev/null || true

: "${GITHUB_APP_SLUG:?GITHUB_APP_SLUG is required}"
: "${GITHUB_APP_BOT_ID:?GITHUB_APP_BOT_ID is required}"

git config --global user.name "${GITHUB_APP_SLUG}[bot]"
git config --global user.email "${GITHUB_APP_BOT_ID}+${GITHUB_APP_SLUG}[bot]@users.noreply.github.com"

exec "$@"
