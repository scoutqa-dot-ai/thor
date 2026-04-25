# Daytona sandbox image for Thor.
#
# Polyglot image with version managers: nvm (Node), SDKMAN (Java), pyenv (Python),
# plus Docker CE for running containers (docker compose, testcontainers, etc.).
#
# Published to ghcr.io/scoutqa-dot-ai/thor-sandbox via .github/workflows/sandbox-e2e.yml.
# An admin then creates a Daytona snapshot from the published image and sets
# DAYTONA_SNAPSHOT to the snapshot name.
#
# Local build:
#   docker build -t thor-sandbox docker/sandbox

FROM ubuntu:24.04

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ARG DOCKER_VERSION=28.5.1
ARG NVM_INSTALL_TAG=v0.40.4
ARG NODE_22_VERSION=22.22.2
ARG NODE_20_VERSION=20.20.2
ARG JAVA_21_VERSION=21.0.10-tem
ARG JAVA_17_VERSION=17.0.18-tem
ARG PYENV_INSTALL_TAG=v2.6.27
ARG PYTHON_3_12_VERSION=3.12.13
ARG UV_VERSION=0.11.7

ENV DEBIAN_FRONTEND=noninteractive
ENV LANG=C.UTF-8
ENV PATH=/home/thor/.local/bin:$PATH

# ── thor user (matches main Dockerfile: UID 1001, GID thor) ────────────────

RUN groupadd --gid 1001 thor \
    && useradd --uid 1001 --gid thor --create-home --shell /bin/bash thor

# ── Core OS / dev tools ─────────────────────────────────────────────────────

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    openssh-client \
    curl \
    wget \
    ca-certificates \
    gnupg \
    jq \
    zip \
    unzip \
    xz-utils \
    build-essential \
    pkg-config \
    less \
    procps \
    lsof \
    netcat-openbsd \
    postgresql-client \
    redis-tools \
    ripgrep \
    fd-find \
    # pyenv build dependencies
    libssl-dev \
    zlib1g-dev \
    libbz2-dev \
    libreadline-dev \
    libsqlite3-dev \
    libncursesw5-dev \
    libxml2-dev \
    libxmlsec1-dev \
    libffi-dev \
    liblzma-dev \
    tk-dev \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf /usr/bin/fdfind /usr/local/bin/fd

# ── Docker CE ──────────────────────────────────────────────────────────────

RUN apt-get update && apt-get install -y --no-install-recommends sudo \
    && rm -rf /var/lib/apt/lists/* \
    && curl --retry 5 --retry-all-errors --retry-delay 2 -fsSL https://get.docker.com | VERSION="$DOCKER_VERSION" sh - \
    && usermod -aG docker thor \
    && echo "thor ALL=(ALL) NOPASSWD: ALL" > /etc/sudoers.d/thor \
    && command -v docker >/dev/null \
    && docker --version | grep -F "$DOCKER_VERSION" >/dev/null

# ── nvm + Node versions ────────────────────────────────────────────────────

ENV NVM_DIR=/home/thor/.nvm

RUN mkdir -p "$NVM_DIR" && chown thor:thor "$NVM_DIR"

USER thor
RUN curl --retry 5 --retry-all-errors --retry-delay 2 -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_INSTALL_TAG}/install.sh" | bash \
    && test -s "$NVM_DIR/nvm.sh"

# Preinstall Node versions (22 = default, 20 = LTS)
RUN bash -c '. "$NVM_DIR/nvm.sh" \
    && nvm install "$NODE_22_VERSION" \
    && nvm install "$NODE_20_VERSION" \
    && nvm alias default "$NODE_22_VERSION" \
    && nvm use default \
    && corepack enable && corepack prepare pnpm@latest --activate \
    && nvm exec 22 node --version | grep -Fx "v$NODE_22_VERSION" >/dev/null \
    && nvm exec 20 node --version | grep -Fx "v$NODE_20_VERSION" >/dev/null \
    && nvm current | grep -Fx "v$NODE_22_VERSION" >/dev/null \
    && node --version | grep -Fx "v$NODE_22_VERSION" >/dev/null \
    && pnpm --version'

# ── SDKMAN + Java/Maven/Gradle ─────────────────────────────────────────────

ENV SDKMAN_DIR=/home/thor/.sdkman

RUN curl --retry 5 --retry-all-errors --retry-delay 2 -fsSL https://get.sdkman.io?rcupdate=false | bash \
    && test -s "$SDKMAN_DIR/bin/sdkman-init.sh"

# Preinstall common JDK versions (21 = default, 17 = still active)
RUN bash -c '. "$SDKMAN_DIR/bin/sdkman-init.sh" \
    && sdk_install_retry() { \
    local attempt; \
    for attempt in 1 2 3 4 5; do \
    if sdk install "$@"; then \
    return 0; \
    fi; \
    echo "sdk install failed for: $* (attempt ${attempt}/5)" >&2; \
    sleep 2; \
    done; \
    return 1; \
    } \
    && sdk_install_retry java "$JAVA_21_VERSION" \
    && sdk_install_retry java "$JAVA_17_VERSION" \
    && sdk default java "$JAVA_21_VERSION" \
    && sdk_install_retry maven \
    && sdk_install_retry gradle \
    && java -version \
    && mvn -v \
    && gradle -v >/dev/null \
    && sdk current java | grep -F "$JAVA_21_VERSION" >/dev/null \
    && test -d "$SDKMAN_DIR/candidates/java/$JAVA_17_VERSION"'

# ── pyenv + Python versions ────────────────────────────────────────────────

ENV PYENV_ROOT=/home/thor/.pyenv
ENV PATH="$PYENV_ROOT/bin:$PYENV_ROOT/shims:$PATH"

RUN curl --retry 5 --retry-all-errors --retry-delay 2 -fsSL https://pyenv.run | PYENV_GIT_TAG="$PYENV_INSTALL_TAG" bash \
    && command -v pyenv >/dev/null

# Preinstall Python default runtime (3.12)
RUN bash -c 'export PATH="$PYENV_ROOT/bin:$PATH" && eval "$(pyenv init -)" \
    && pyenv install "$PYTHON_3_12_VERSION" \
    && pyenv global "$PYTHON_3_12_VERSION" \
    && PYENV_VERSION=3.12 pyenv exec python --version 2>&1 | grep -Fx "Python $PYTHON_3_12_VERSION" >/dev/null \
    && [[ "$(pyenv global)" == "$PYTHON_3_12_VERSION" ]] \
    && [[ "$(pyenv which python)" == "$PYENV_ROOT/versions/$PYTHON_3_12_VERSION/bin/python" ]] \
    && python --version 2>&1 | grep -Fx "Python $PYTHON_3_12_VERSION" >/dev/null'

# uv (fast Python package manager)
RUN curl --retry 5 --retry-all-errors --retry-delay 2 -fsSL "https://astral.sh/uv/${UV_VERSION}/install.sh" | sh \
    && command -v uv >/dev/null \
    && command -v uvx >/dev/null \
    && uv --version | grep -F "uv ${UV_VERSION}" >/dev/null

# ── Shell profile (activate version managers in login shells) ──────────────
# Write to .profile so `bash -lc` (non-interactive login shell) loads them.
# Ubuntu's .bashrc exits early for non-interactive shells, so appending there
# alone is not enough. .profile is always read by login shells.
#
# nvm, SDKMAN, and pyenv init scripts use bash-specific syntax (source, [[,
# arrays). Guard them with a BASH_VERSION check so `sh -lc` (dash) skips
# them instead of failing with syntax errors.

RUN { \
    echo ''; \
    echo '# nvm (bash-only: nvm.sh uses bash syntax)'; \
    echo 'if [ -n "$BASH_VERSION" ]; then'; \
    echo '  export NVM_DIR="$HOME/.nvm"'; \
    echo '  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"'; \
    echo 'fi'; \
    echo ''; \
    echo '# SDKMAN (bash-only: sdkman-init.sh uses bash syntax)'; \
    echo 'if [ -n "$BASH_VERSION" ]; then'; \
    echo '  export SDKMAN_DIR="$HOME/.sdkman"'; \
    echo '  [ -s "$SDKMAN_DIR/bin/sdkman-init.sh" ] && . "$SDKMAN_DIR/bin/sdkman-init.sh"'; \
    echo 'fi'; \
    echo ''; \
    echo '# pyenv (bash-only: pyenv init outputs bash syntax)'; \
    echo 'if [ -n "$BASH_VERSION" ]; then'; \
    echo '  export PYENV_ROOT="$HOME/.pyenv"'; \
    echo '  export PATH="$PYENV_ROOT/bin:$PYENV_ROOT/shims:$PATH"'; \
    echo '  eval "$(pyenv init -)"'; \
    echo 'fi'; \
    echo ''; \
    echo '# uv (POSIX-compatible)'; \
    echo '[ -s "$HOME/.local/bin/env" ] && . "$HOME/.local/bin/env"'; \
    } >> /home/thor/.profile

# ── Workspace setup ────────────────────────────────────────────────────────

USER root
RUN mkdir -p /workspace/sandbox && chown -R thor:thor /workspace
RUN git config --system init.defaultBranch main

USER thor
WORKDIR /workspace/sandbox
