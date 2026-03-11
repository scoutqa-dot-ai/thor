FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
RUN npm i -g opencode-ai@1.2.24

COPY opencode.json /root/.config/opencode/opencode.json
COPY agents/ /root/.config/opencode/agents/

ENTRYPOINT ["opencode"]
