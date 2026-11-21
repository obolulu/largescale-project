# Kong Gateway (OSS) in DB-less mode, configured from kong.yml.tmpl at start.
FROM kong:3.9.1

COPY kong.yml.tmpl render-config.sh /gateway/
# Files copied from a Windows checkout can arrive unreadable for the kong user.
USER root
RUN chmod 0644 /gateway/kong.yml.tmpl && chmod 0755 /gateway/render-config.sh
USER kong

ENV KONG_DATABASE=off \
    KONG_DECLARATIVE_CONFIG=/tmp/kong.yml \
    KONG_PROXY_LISTEN="0.0.0.0:8080" \
    # No Admin API: the config is immutable at runtime. /status is for health probes.
    KONG_ADMIN_LISTEN=off \
    KONG_STATUS_LISTEN="0.0.0.0:8100" \
    # Default is one worker per host CPU; a small container needs two at most.
    KONG_NGINX_WORKER_PROCESSES=2 \
    KONG_PROXY_ACCESS_LOG=/dev/stdout \
    KONG_PROXY_ERROR_LOG=/dev/stderr \
    # Don't advertise the Kong version; keep latency headers and a request id.
    KONG_HEADERS="latency_tokens,X-Kong-Request-Id" \
    # The audience check in kong.yml.tmpl needs this one module in the Lua sandbox.
    KONG_UNTRUSTED_LUA_SANDBOX_REQUIRES=kong.plugins.jwt.jwt_parser

EXPOSE 8080 8100
ENTRYPOINT ["/gateway/render-config.sh"]
CMD ["kong", "docker-start"]
