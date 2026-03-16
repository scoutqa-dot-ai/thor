#!/bin/sh
# Git credential setup for the git-mcp container.
# Configures GIT_ASKPASS so any process (Node.js or interactive shell)
# can authenticate to GitHub over HTTPS using the PAT.

set -e

if [ -n "$GITHUB_PAT" ]; then
  ASKPASS_SCRIPT="/tmp/git-askpass.sh"
  printf '#!/bin/sh\necho "%s"\n' "$GITHUB_PAT" > "$ASKPASS_SCRIPT"
  chmod 700 "$ASKPASS_SCRIPT"

  export GIT_ASKPASS="$ASKPASS_SCRIPT"
  export GIT_TERMINAL_PROMPT=0
  export GIT_CONFIG_COUNT=1
  export GIT_CONFIG_KEY_0="credential.username"
  export GIT_CONFIG_VALUE_0="x-access-token"
fi

git config --global user.name "${GIT_USER_NAME:-thor}"
git config --global user.email "${GIT_USER_EMAIL:-thor@localhost}"

exec "$@"
