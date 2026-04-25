FROM alpine:3.23

ARG TARGETARCH=amd64
ENV SUPERCRONIC_VERSION=v0.2.44

RUN apk add --no-cache curl jq \
 && adduser -D -u 1001 thor \
 && SUPERCRONIC_BIN="supercronic-linux-${TARGETARCH}" \
 && curl -fsSLO "https://github.com/aptible/supercronic/releases/download/${SUPERCRONIC_VERSION}/${SUPERCRONIC_BIN}" \
 && chmod +x "${SUPERCRONIC_BIN}" \
 && mv "${SUPERCRONIC_BIN}" /usr/local/bin/supercronic

COPY hey-thor /usr/local/bin/hey-thor
RUN chmod +x /usr/local/bin/hey-thor

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

USER thor
ENTRYPOINT ["/entrypoint.sh"]
