# Daytona sandbox base snapshot for Thor.
#
# Polyglot image with version managers: nvm (Node), SDKMAN (Java), pyenv (Python).
# Based on Ubuntu 24.04 for broad Debian/Ubuntu package compatibility.
#
# Build:
#   docker build -t thor-sandbox-base docker/sandbox
#
# Register with Daytona, then set DAYTONA_SNAPSHOT to the snapshot ID.

FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV LANG=C.UTF-8

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

# ── nvm + Node versions ────────────────────────────────────────────────────

ENV NVM_DIR=/home/thor/.nvm

RUN mkdir -p "$NVM_DIR" && chown thor:thor "$NVM_DIR"

USER thor
RUN curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash

# Preinstall common Node versions (22 = default, 20 = LTS, 24 = emerging)
RUN bash -c '. "$NVM_DIR/nvm.sh" \
    && nvm install 22 && nvm install 20 && nvm install 24 \
    && nvm alias default 22 && nvm use default \
    && corepack enable && corepack prepare pnpm@latest --activate'

# ── SDKMAN + Java/Maven/Gradle ─────────────────────────────────────────────

ENV SDKMAN_DIR=/home/thor/.sdkman

RUN curl -fsSL https://get.sdkman.io?rcupdate=false | bash

# Preinstall common JDK versions (21 = default, 17 = still active)
RUN bash -c '. "$SDKMAN_DIR/bin/sdkman-init.sh" \
    && sdk install java 21.0.7-tem && sdk install java 17.0.15-tem \
    && sdk default java 21.0.7-tem \
    && sdk install maven && sdk install gradle'

# ── pyenv + Python versions ────────────────────────────────────────────────

ENV PYENV_ROOT=/home/thor/.pyenv
ENV PATH="$PYENV_ROOT/bin:$PYENV_ROOT/shims:$PATH"

RUN curl -fsSL https://pyenv.run | PYENV_GIT_TAG=v2.5.4 bash

# Preinstall common Python versions (3.12 = default, 3.11 = active, 3.13 = emerging)
RUN bash -c 'export PATH="$PYENV_ROOT/bin:$PATH" && eval "$(pyenv init -)" \
    && pyenv install 3.12 && pyenv install 3.11 && pyenv install 3.13 \
    && pyenv global 3.12'

# uv (fast Python package manager)
RUN curl -LsSf https://astral.sh/uv/0.7.2/install.sh | sh

# ── Shell profile (activate version managers in login shells) ──────────────
# Write to .profile so `bash -lc` (non-interactive login shell) loads them.
# Ubuntu's .bashrc exits early for non-interactive shells, so appending there
# alone is not enough. .profile is always read by login shells.

RUN { \
      echo ''; \
      echo '# nvm'; \
      echo 'export NVM_DIR="$HOME/.nvm"'; \
      echo '[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"'; \
      echo ''; \
      echo '# SDKMAN'; \
      echo 'export SDKMAN_DIR="$HOME/.sdkman"'; \
      echo '[ -s "$SDKMAN_DIR/bin/sdkman-init.sh" ] && . "$SDKMAN_DIR/bin/sdkman-init.sh"'; \
      echo ''; \
      echo '# pyenv'; \
      echo 'export PYENV_ROOT="$HOME/.pyenv"'; \
      echo 'export PATH="$PYENV_ROOT/bin:$PYENV_ROOT/shims:$PATH"'; \
      echo 'eval "$(pyenv init -)"'; \
      echo ''; \
      echo '# uv'; \
      echo '[ -s "$HOME/.local/bin/env" ] && . "$HOME/.local/bin/env"'; \
    } >> /home/thor/.profile

# ── Workspace setup ────────────────────────────────────────────────────────

USER root
RUN mkdir -p /workspace/repo && chown -R thor:thor /workspace
RUN git config --system init.defaultBranch main

USER thor
WORKDIR /workspace/repo
