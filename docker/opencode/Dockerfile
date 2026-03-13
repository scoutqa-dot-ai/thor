FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
RUN groupadd --gid 1001 thor && useradd --uid 1001 --gid thor --create-home thor
RUN npm i -g opencode-ai@1.2.24

USER thor
RUN mkdir -p /home/thor/.local/share/opencode /home/thor/.local/state

COPY --chown=thor:thor opencode.json /home/thor/.config/opencode/opencode.json
COPY --chown=thor:thor agents/ /home/thor/.config/opencode/agents/
ENTRYPOINT ["opencode"]
