FROM quay.io/vouch/vouch-proxy AS vouch

FROM alpine:3
RUN apk add --no-cache gettext
COPY --from=vouch /vouch-proxy /vouch-proxy
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 9090
ENTRYPOINT ["/bin/sh", "/entrypoint.sh"]
