FROM node:22-slim

RUN npm i -g opencode-ai@1.2.24

COPY opencode.json /root/.config/opencode/opencode.json
COPY agents/ /root/.config/opencode/agents/

ENTRYPOINT ["opencode"]
