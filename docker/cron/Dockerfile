FROM alpine:3.21

RUN apk add --no-cache curl jq

COPY hey-thor /usr/local/bin/hey-thor
RUN chmod +x /usr/local/bin/hey-thor

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
