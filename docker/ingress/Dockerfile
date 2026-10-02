FROM nginx:alpine
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY 10-thor-admin-emails.envsh /docker-entrypoint.d/10-thor-admin-emails.envsh
COPY --chmod=755 10-thor-runtime.envsh /docker-entrypoint.d/10-thor-runtime.envsh
COPY static/ /usr/share/nginx/thor-brand/
