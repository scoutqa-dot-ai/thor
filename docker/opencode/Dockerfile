FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
RUN groupadd --gid 1001 thor && useradd --uid 1001 --gid thor --create-home thor
RUN npm i -g opencode-ai@1.2.24

COPY opencode.json /home/thor/.config/opencode/opencode.json
COPY agents/ /home/thor/.config/opencode/agents/
RUN chown -R thor:thor /home/thor/.config

USER thor
ENTRYPOINT ["opencode"]
