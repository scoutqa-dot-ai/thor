FROM nginx:alpine
RUN rm /etc/nginx/conf.d/default.conf
COPY entrypoint.sh /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
