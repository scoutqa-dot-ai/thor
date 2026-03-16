FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
RUN groupadd --gid 1001 thor && useradd --uid 1001 --gid thor --create-home thor
RUN npm i -g opencode-ai@1.2.24

# git/gh wrapper scripts — forward to git-wrappers service over HTTP
COPY bin/remote-cli.mjs /usr/local/bin/remote-cli.mjs
COPY bin/git /usr/local/bin/git
COPY bin/gh /usr/local/bin/gh

USER thor
RUN mkdir -p /home/thor/.local/share/opencode /home/thor/.local/state

ENV THOR_GIT_EXEC_URL=http://git-wrappers:3004

COPY --chown=thor:thor opencode.json /home/thor/.config/opencode/opencode.json
COPY --chown=thor:thor agents/ /home/thor/.config/opencode/agents/
ENTRYPOINT ["opencode"]
