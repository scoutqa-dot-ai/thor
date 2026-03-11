#!/bin/sh
mkdir -p /config
envsubst < /template/config.yml > /config/config.yml
exec /vouch-proxy
