FROM node:22-slim

RUN groupadd --gid 1001 thor && useradd --uid 1001 --gid thor --create-home thor
RUN npm i -g opencode-ai@1.2.27

# git/gh wrapper scripts — forward to remote-cli service over HTTP
COPY bin/remote-cli.mjs /usr/local/bin/remote-cli.mjs
COPY bin/git /usr/local/bin/git
COPY bin/gh /usr/local/bin/gh
COPY bin/scoutqa /usr/local/bin/scoutqa

USER thor
RUN mkdir -p /home/thor/.local/share/opencode /home/thor/.local/state

ENV THOR_REMOTE_CLI_URL=http://remote-cli:3004

COPY --chown=thor:thor opencode.json /home/thor/.config/opencode/opencode.json
COPY --chown=thor:thor agents/ /home/thor/.config/opencode/agents/
ENTRYPOINT ["opencode"]
