# ---------------------------------------------------------------------------
# Stage 1: build opencode from source
# ---------------------------------------------------------------------------
FROM oven/bun:1.3 AS builder

RUN apt-get update && apt-get install -y git python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /src

# https://github.com/scoutqa-dot-ai/thor-opencode/tree/thor/v1.3.9
RUN git clone --depth 1 --single-branch --branch thor/v1.3.9 https://github.com/scoutqa-dot-ai/thor-opencode.git . \
    && git checkout d087608

RUN bun install
RUN cd packages/opencode && bun run build --single
RUN cp packages/opencode/dist/opencode-*/bin/opencode /tmp/opencode

# ---------------------------------------------------------------------------
# Stage 2: runtime image
# ---------------------------------------------------------------------------
FROM node:22-slim

RUN groupadd --gid 1001 thor && useradd --uid 1001 --gid thor --create-home thor

# Install the built binary
COPY --from=builder /tmp/opencode /usr/local/bin/opencode

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
