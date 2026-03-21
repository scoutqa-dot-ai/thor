FROM node:22-slim

RUN groupadd --gid 1001 thor && useradd --uid 1001 --gid thor --create-home thor
RUN corepack enable
RUN npm i -g opencode-ai@1.2.27

# git/gh/scoutqa wrapper scripts — forward to remote services over HTTP
COPY bin/remote-cli.mjs /usr/local/bin/remote-cli.mjs
COPY bin/git /usr/local/bin/git
COPY bin/gh /usr/local/bin/gh
COPY bin/scoutqa /usr/local/bin/scoutqa
COPY bin/coder.mjs /usr/local/bin/coder.mjs
COPY bin/coder /usr/local/bin/coder

USER thor
RUN mkdir -p /home/thor/.local/share/opencode /home/thor/.local/state

ENV THOR_REMOTE_CLI_URL=http://remote-cli:3004
ENV THOR_SANDBOXD_URL=http://sandboxd:3005

COPY --chown=thor:thor opencode.json /home/thor/.config/opencode/opencode.json
COPY --chown=thor:thor agents/ /home/thor/.config/opencode/agents/
ENTRYPOINT ["opencode"]
