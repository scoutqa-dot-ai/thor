FROM alpine:3.23

ENV SUPERCRONIC_VERSION=v0.2.44

RUN apk add --no-cache curl jq \
 && adduser -D -u 1001 thor \
 && case "$(uname -m)" in \
      x86_64)  ARCH=amd64 ;; \
      aarch64) ARCH=arm64 ;; \
      *) echo "unsupported arch $(uname -m)"; exit 1 ;; \
    esac \
 && SUPERCRONIC_BIN="supercronic-linux-${ARCH}" \
 && curl -fsSLO "https://github.com/aptible/supercronic/releases/download/${SUPERCRONIC_VERSION}/${SUPERCRONIC_BIN}" \
 && chmod +x "${SUPERCRONIC_BIN}" \
 && mv "${SUPERCRONIC_BIN}" /usr/local/bin/supercronic

COPY hey-thor /usr/local/bin/hey-thor
RUN chmod +x /usr/local/bin/hey-thor

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

USER thor
ENTRYPOINT ["/entrypoint.sh"]
