#!/bin/sh
# Git credential setup for the remote-cli container.
#
# Two auth modes:
#   1. GitHub App (preferred): config.json has github_app.installations.
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

git config --global user.name "${GIT_USER_NAME:-thor}"
git config --global user.email "${GIT_USER_EMAIL:-thor@localhost}"

exec "$@"
