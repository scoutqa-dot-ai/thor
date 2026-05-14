FROM nginx:alpine
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY 40-thor-admin-emails.sh /docker-entrypoint.d/40-thor-admin-emails.sh
COPY static/ /usr/share/nginx/thor-brand/
