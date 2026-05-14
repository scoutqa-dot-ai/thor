FROM nginx:alpine
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY 10-thor-admin-emails.envsh /docker-entrypoint.d/10-thor-admin-emails.envsh
COPY static/ /usr/share/nginx/thor-brand/
