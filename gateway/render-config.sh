#!/bin/sh
# Renders kong.yml.tmpl into the declarative config Kong loads, then hands over
# to Kong's own entrypoint. Settings come from the environment:
#   JWT_SECRET            required, the same secret billing-api signs tokens with
#   BILLING_API_UPSTREAM  backend origin (default http://billing-api:8000)
#   JWT_ISSUER            expected `iss` (default billing-api)
#   JWT_AUDIENCE          expected `aud` (default billing-clients)
set -eu

template=/gateway/kong.yml.tmpl
out="${KONG_DECLARATIVE_CONFIG:-/tmp/kong.yml}"

: "${JWT_SECRET:?JWT_SECRET must be set to the same value billing-api uses}"
upstream="${BILLING_API_UPSTREAM:-http://billing-api:8000}"
issuer="${JWT_ISSUER:-billing-api}"
audience="${JWT_AUDIENCE:-billing-clients}"

fail() { echo "render-config: $*" >&2; exit 1; }

# These end up inside YAML and Lua strings, so keep them to safe characters.
printf '%s' "$upstream" | grep -Eq '^https?://[A-Za-z0-9.:_-]+(/[A-Za-z0-9._~/-]*)?$' \
  || fail "BILLING_API_UPSTREAM must look like http(s)://host[:port][/path], got '$upstream'"
printf '%s' "$issuer" | grep -Eq '^[A-Za-z0-9._:/-]+$' || fail "JWT_ISSUER has unsupported characters"
printf '%s' "$audience" | grep -Eq '^[A-Za-z0-9._:/-]+$' || fail "JWT_AUDIENCE has unsupported characters"
case "$JWT_SECRET" in
  *"
"*) fail "JWT_SECRET must be a single line" ;;
esac

# The secret goes into a single-quoted YAML string ('' escapes '), and through
# sed, where \ & and the | delimiter need escaping.
sed_escape() { printf '%s' "$1" | sed -e 's/[\\&|]/\\&/g'; }
secret_yaml=$(printf '%s' "$JWT_SECRET" | sed -e "s/'/''/g")

umask 077
sed \
  -e "s|__BILLING_API_UPSTREAM__|$(sed_escape "$upstream")|g" \
  -e "s|__JWT_ISSUER__|$(sed_escape "$issuer")|g" \
  -e "s|__JWT_AUDIENCE__|$(sed_escape "$audience")|g" \
  -e "s|__JWT_SECRET__|$(sed_escape "$secret_yaml")|g" \
  "$template" > "$out"

echo "render-config: upstream=$upstream iss=$issuer aud=$audience -> $out" >&2
exec /docker-entrypoint.sh "$@"
