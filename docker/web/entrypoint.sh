#!/bin/sh
set -eu

: "${CINATOKEN_ADMIN_UPSTREAM:=http://admin:8789}"
: "${CINATOKEN_WEB_PUBLIC_ENABLED:=false}"
: "${CINATOKEN_WEB_SSR_UPSTREAM:=http://gateway-web-ssr:8791}"
: "${CINATOKEN_WEB_ACCOUNT_ENABLED:=false}"
: "${CINATOKEN_WEB_ADMIN_DASHBOARD_ENABLED:=false}"
: "${CINATOKEN_WEB_ADMIN_USERS_ENABLED:=false}"
: "${CINATOKEN_WEB_ADMIN_USER_DETAIL_ENABLED:=false}"
: "${CINATOKEN_WEB_ADMIN_PROVIDERS_ENABLED:=false}"
: "${CINATOKEN_WEB_ADMIN_MODELS_ENABLED:=false}"
: "${CINATOKEN_WEB_ADMIN_ENDPOINTS_ENABLED:=false}"
: "${CINATOKEN_WEB_ADMIN_ROUTES_ENABLED:=false}"
: "${CINATOKEN_WEB_ADMIN_DATA_POLICIES_ENABLED:=false}"
: "${CINATOKEN_WEB_ADMIN_PRESETS_ENABLED:=false}"
: "${CINATOKEN_WEB_ADMIN_GUARDRAILS_ENABLED:=false}"
: "${CINATOKEN_WEB_ADMIN_RELIABILITY_ENABLED:=false}"
: "${CINATOKEN_WEB_ADMIN_MODEL_ANALYTICS_ENABLED:=false}"
: "${CINATOKEN_WEB_ADMIN_PROVIDER_ANALYTICS_ENABLED:=false}"
: "${CINATOKEN_WEB_ADMIN_USER_ANALYTICS_ENABLED:=false}"
: "${CINATOKEN_WEB_ADMIN_REQUEST_LOGS_ENABLED:=false}"
: "${CINATOKEN_WEB_ADMIN_BUDGET_AUDIT_ENABLED:=false}"
: "${CINATOKEN_WEB_ADMIN_TOOL_INVOCATIONS_ENABLED:=false}"
: "${CINATOKEN_WEB_ADMIN_CONFIG_TIMEZONE_ENABLED:=false}"
: "${CINATOKEN_WEB_ADMIN_CONFIG_ENABLED:=false}"
: "${CINATOKEN_WEB_ADMIN_ACCESS_KEYS_ENABLED:=false}"
: "${CINATOKEN_WEB_ADMIN_KEYS_ENABLED:=false}"
: "${CINATOKEN_WEB_ADMIN_SHARED_KEYS_ENABLED:=false}"
: "${CINATOKEN_WEB_ADMIN_TOOLS_ENABLED:=false}"
: "${CINATOKEN_WEB_ADMIN_PLAYGROUND_ENABLED:=false}"
: "${CINATOKEN_WEB_ADMIN_SIMULATOR_ENABLED:=false}"
: "${CINATOKEN_WEB_ADMIN_WITHDRAWALS_ENABLED:=false}"
: "${CINATOKEN_WEB_ADMIN_NFT_MINTS_ENABLED:=false}"
: "${CINATOKEN_WEB_PROXY_ORIGINS:=}"

# Keep this strict contract aligned with packages/web/scripts/proxy-origin-policy.mjs.
# Read the environment as data (not awk -v escapes) and never substitute raw input.
export CINATOKEN_WEB_PROXY_ORIGINS
if ! CINATOKEN_WEB_PROXY_CONNECT_SRC="$(LC_ALL=C awk '
function valid_host(host, count, labels, i) {
    if (host == "[::1]") return 1
    if (length(host) > 253) return 0
    count = split(host, labels, ".")
    if (host ~ /^[0-9.]+$/) {
        if (count != 4) return 0
        for (i = 1; i <= count; i++) {
            if (length(labels[i]) > 3 || labels[i] !~ /^(0|[1-9][0-9]*)$/ || labels[i] + 0 > 255) return 0
        }
        return 1
    }
    for (i = 1; i <= count; i++) {
        if (length(labels[i]) > 63 || labels[i] !~ /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/) return 0
    }
    return labels[count] ~ /^[a-z]([a-z0-9-]*[a-z0-9])?$/
}
BEGIN {
    value = ENVIRON["CINATOKEN_WEB_PROXY_ORIGINS"]
    if (length(value) > 4096 || value ~ /[^a-z0-9:\/.,\[\] -]/) exit 1
    gsub(/^ +| +$/, "", value)
    sources = sprintf("%cself%c wss:", 39, 39)
    if (value == "") { print sources; exit }
    count = split(value, entries, ",")
    if (count > 16) exit 1
    unique_count = 0
    for (i = 1; i <= count; i++) {
        origin = entries[i]
        gsub(/^ +| +$/, "", origin)
        if (origin !~ /^https?:\/\/([a-z0-9.-]+|\[::1\])(:[0-9]+)?$/) exit 1
        scheme = "http"
        if (index(origin, "https://") == 1) scheme = "https"
        authority = substr(origin, length(scheme) + 4)
        host = authority
        port = ""
        if (index(authority, "[::1]") == 1) {
            host = "[::1]"
            if (length(authority) > 5) port = substr(authority, 7)
        } else if (index(authority, ":") > 0) {
            host = substr(authority, 1, index(authority, ":") - 1)
            port = substr(authority, index(authority, ":") + 1)
        }
        if (!valid_host(host)) exit 1
        if (port != "" && (length(port) > 5 || port !~ /^[1-9][0-9]*$/ || port + 0 > 65535)) exit 1
        if (scheme == "http" && host != "localhost" && host != "127.0.0.1" && host != "[::1]") exit 1
        if (!(origin in seen)) {
            seen[origin] = 1
            origins[++unique_count] = origin
            sources = sources " " origin
        }
    }
    for (i = 1; i <= unique_count; i++) {
        socket_origin = origins[i]
        sub(/^http/, "ws", socket_origin)
        sources = sources " " socket_origin
    }
    print sources
}')"; then
    echo 'CINATOKEN_WEB_PROXY_ORIGINS must contain at most 16 trusted HTTP(S) origins' >&2
    exit 1
fi
export CINATOKEN_WEB_PROXY_CONNECT_SRC

case "$CINATOKEN_WEB_ACCOUNT_ENABLED" in
    true|false) ;;
    *) echo 'CINATOKEN_WEB_ACCOUNT_ENABLED must be true or false' >&2; exit 1 ;;
esac

case "$CINATOKEN_WEB_ADMIN_DASHBOARD_ENABLED" in
    true|false) ;;
    *) echo 'CINATOKEN_WEB_ADMIN_DASHBOARD_ENABLED must be true or false' >&2; exit 1 ;;
esac

case "$CINATOKEN_WEB_ADMIN_USERS_ENABLED" in
    true|false) ;;
    *) echo 'CINATOKEN_WEB_ADMIN_USERS_ENABLED must be true or false' >&2; exit 1 ;;
esac

case "$CINATOKEN_WEB_ADMIN_USER_DETAIL_ENABLED" in
    true|false) ;;
    *) echo 'CINATOKEN_WEB_ADMIN_USER_DETAIL_ENABLED must be true or false' >&2; exit 1 ;;
esac

case "$CINATOKEN_WEB_ADMIN_PROVIDERS_ENABLED" in
    true|false) ;;
    *) echo 'CINATOKEN_WEB_ADMIN_PROVIDERS_ENABLED must be true or false' >&2; exit 1 ;;
esac

case "$CINATOKEN_WEB_ADMIN_MODELS_ENABLED" in
    true|false) ;;
    *) echo 'CINATOKEN_WEB_ADMIN_MODELS_ENABLED must be true or false' >&2; exit 1 ;;
esac

case "$CINATOKEN_WEB_ADMIN_ENDPOINTS_ENABLED" in
    true|false) ;;
    *) echo 'CINATOKEN_WEB_ADMIN_ENDPOINTS_ENABLED must be true or false' >&2; exit 1 ;;
esac

case "$CINATOKEN_WEB_ADMIN_ROUTES_ENABLED" in
    true|false) ;;
    *) echo 'CINATOKEN_WEB_ADMIN_ROUTES_ENABLED must be true or false' >&2; exit 1 ;;
esac

case "$CINATOKEN_WEB_ADMIN_DATA_POLICIES_ENABLED" in
    true|false) ;;
    *) echo 'CINATOKEN_WEB_ADMIN_DATA_POLICIES_ENABLED must be true or false' >&2; exit 1 ;;
esac

case "$CINATOKEN_WEB_ADMIN_PRESETS_ENABLED" in
    true|false) ;;
    *) echo 'CINATOKEN_WEB_ADMIN_PRESETS_ENABLED must be true or false' >&2; exit 1 ;;
esac

case "$CINATOKEN_WEB_ADMIN_GUARDRAILS_ENABLED" in
    true|false) ;;
    *) echo 'CINATOKEN_WEB_ADMIN_GUARDRAILS_ENABLED must be true or false' >&2; exit 1 ;;
esac

case "$CINATOKEN_WEB_ADMIN_RELIABILITY_ENABLED" in
    true|false) ;;
    *) echo 'CINATOKEN_WEB_ADMIN_RELIABILITY_ENABLED must be true or false' >&2; exit 1 ;;
esac
case "$CINATOKEN_WEB_ADMIN_MODEL_ANALYTICS_ENABLED" in
    true|false) ;;
    *) echo 'CINATOKEN_WEB_ADMIN_MODEL_ANALYTICS_ENABLED must be true or false' >&2; exit 1 ;;
esac
case "$CINATOKEN_WEB_ADMIN_PROVIDER_ANALYTICS_ENABLED" in
    true|false) ;;
    *) echo 'CINATOKEN_WEB_ADMIN_PROVIDER_ANALYTICS_ENABLED must be true or false' >&2; exit 1 ;;
esac
case "$CINATOKEN_WEB_ADMIN_USER_ANALYTICS_ENABLED" in
    true|false) ;;
    *) echo 'CINATOKEN_WEB_ADMIN_USER_ANALYTICS_ENABLED must be true or false' >&2; exit 1 ;;
esac
case "$CINATOKEN_WEB_ADMIN_REQUEST_LOGS_ENABLED" in
    true|false) ;;
    *) echo 'CINATOKEN_WEB_ADMIN_REQUEST_LOGS_ENABLED must be true or false' >&2; exit 1 ;;
esac
case "$CINATOKEN_WEB_ADMIN_BUDGET_AUDIT_ENABLED" in
    true|false) ;;
    *) echo 'CINATOKEN_WEB_ADMIN_BUDGET_AUDIT_ENABLED must be true or false' >&2; exit 1 ;;
esac
case "$CINATOKEN_WEB_ADMIN_TOOL_INVOCATIONS_ENABLED" in
    true|false) ;;
    *) echo 'CINATOKEN_WEB_ADMIN_TOOL_INVOCATIONS_ENABLED must be true or false' >&2; exit 1 ;;
esac

case "$CINATOKEN_WEB_ADMIN_CONFIG_TIMEZONE_ENABLED" in
    true|false) ;;
    *) echo 'CINATOKEN_WEB_ADMIN_CONFIG_TIMEZONE_ENABLED must be true or false' >&2; exit 1 ;;
esac

case "$CINATOKEN_WEB_ADMIN_CONFIG_ENABLED" in
    true|false) ;;
    *) echo 'CINATOKEN_WEB_ADMIN_CONFIG_ENABLED must be true or false' >&2; exit 1 ;;
esac

case "$CINATOKEN_WEB_ADMIN_ACCESS_KEYS_ENABLED" in
    true|false) ;;
    *) echo 'CINATOKEN_WEB_ADMIN_ACCESS_KEYS_ENABLED must be true or false' >&2; exit 1 ;;
esac

case "$CINATOKEN_WEB_ADMIN_KEYS_ENABLED" in
    true|false) ;;
    *) echo 'CINATOKEN_WEB_ADMIN_KEYS_ENABLED must be true or false' >&2; exit 1 ;;
esac

case "$CINATOKEN_WEB_ADMIN_SHARED_KEYS_ENABLED" in
    true|false) ;;
    *) echo 'CINATOKEN_WEB_ADMIN_SHARED_KEYS_ENABLED must be true or false' >&2; exit 1 ;;
esac

case "$CINATOKEN_WEB_ADMIN_TOOLS_ENABLED" in
    true|false) ;;
    *) echo 'CINATOKEN_WEB_ADMIN_TOOLS_ENABLED must be true or false' >&2; exit 1 ;;
esac

case "$CINATOKEN_WEB_ADMIN_PLAYGROUND_ENABLED" in
    true|false) ;;
    *) echo 'CINATOKEN_WEB_ADMIN_PLAYGROUND_ENABLED must be true or false' >&2; exit 1 ;;
esac

case "$CINATOKEN_WEB_ADMIN_SIMULATOR_ENABLED" in
    true|false) ;;
    *) echo 'CINATOKEN_WEB_ADMIN_SIMULATOR_ENABLED must be true or false' >&2; exit 1 ;;
esac

case "$CINATOKEN_WEB_ADMIN_WITHDRAWALS_ENABLED" in
    true|false) ;;
    *) echo 'CINATOKEN_WEB_ADMIN_WITHDRAWALS_ENABLED must be true or false' >&2; exit 1 ;;
esac

case "$CINATOKEN_WEB_ADMIN_NFT_MINTS_ENABLED" in
    true|false) ;;
    *) echo 'CINATOKEN_WEB_ADMIN_NFT_MINTS_ENABLED must be true or false' >&2; exit 1 ;;
esac

if ! printf '%s\n' "$CINATOKEN_ADMIN_UPSTREAM" | grep -Eq '^https?://([A-Za-z0-9._-]+|\[[0-9A-Fa-f:]+\])(:[0-9]{1,5})?$'; then
    echo 'CINATOKEN_ADMIN_UPSTREAM must contain only scheme, host and optional port' >&2
    exit 1
fi

case "$CINATOKEN_WEB_PUBLIC_ENABLED" in
    true|false) ;;
    *) echo 'CINATOKEN_WEB_PUBLIC_ENABLED must be true or false' >&2; exit 1 ;;
esac
if ! printf '%s\n' "$CINATOKEN_WEB_SSR_UPSTREAM" | grep -Eq '^https?://([A-Za-z0-9._-]+|\[[0-9A-Fa-f:]+\])(:[0-9]{1,5})?$'; then
    echo 'CINATOKEN_WEB_SSR_UPSTREAM must contain only scheme, host and optional port' >&2
    exit 1
fi
CINATOKEN_WEB_MANIFEST_SHA=""
if [ "$CINATOKEN_WEB_PUBLIC_ENABLED" = true ]; then
    CINATOKEN_WEB_MANIFEST_SHA="$(cat /usr/share/web-release/manifest.sha256)"
    if ! printf '%s\n' "$CINATOKEN_WEB_MANIFEST_SHA" | grep -Eq '^[a-f0-9]{64}$'; then
        echo 'Public SSR requires a verified Web manifest digest' >&2
        exit 1
    fi
fi
export CINATOKEN_WEB_PUBLIC_ENABLED CINATOKEN_WEB_SSR_UPSTREAM CINATOKEN_WEB_MANIFEST_SHA

if [ -z "${CINATOKEN_WEB_DNS_RESOLVER:-}" ]; then
    CINATOKEN_WEB_DNS_RESOLVER="$(awk '/^nameserver[[:space:]]/ { print $2; exit }' /etc/resolv.conf)"
fi
if ! printf '%s\n' "$CINATOKEN_WEB_DNS_RESOLVER" | grep -Eq '^[0-9.]+$'; then
    echo 'CINATOKEN_WEB_DNS_RESOLVER must be an IPv4 resolver address' >&2
    exit 1
fi

export CINATOKEN_ADMIN_UPSTREAM CINATOKEN_WEB_ACCOUNT_ENABLED CINATOKEN_WEB_ADMIN_DASHBOARD_ENABLED CINATOKEN_WEB_ADMIN_USERS_ENABLED CINATOKEN_WEB_ADMIN_USER_DETAIL_ENABLED CINATOKEN_WEB_ADMIN_PROVIDERS_ENABLED CINATOKEN_WEB_ADMIN_MODELS_ENABLED CINATOKEN_WEB_ADMIN_ENDPOINTS_ENABLED CINATOKEN_WEB_ADMIN_ROUTES_ENABLED CINATOKEN_WEB_ADMIN_DATA_POLICIES_ENABLED CINATOKEN_WEB_ADMIN_PRESETS_ENABLED CINATOKEN_WEB_ADMIN_GUARDRAILS_ENABLED CINATOKEN_WEB_ADMIN_RELIABILITY_ENABLED CINATOKEN_WEB_ADMIN_MODEL_ANALYTICS_ENABLED CINATOKEN_WEB_ADMIN_PROVIDER_ANALYTICS_ENABLED CINATOKEN_WEB_ADMIN_USER_ANALYTICS_ENABLED CINATOKEN_WEB_ADMIN_REQUEST_LOGS_ENABLED CINATOKEN_WEB_ADMIN_BUDGET_AUDIT_ENABLED CINATOKEN_WEB_ADMIN_TOOL_INVOCATIONS_ENABLED CINATOKEN_WEB_ADMIN_CONFIG_TIMEZONE_ENABLED CINATOKEN_WEB_ADMIN_CONFIG_ENABLED CINATOKEN_WEB_ADMIN_ACCESS_KEYS_ENABLED CINATOKEN_WEB_ADMIN_KEYS_ENABLED CINATOKEN_WEB_ADMIN_SHARED_KEYS_ENABLED CINATOKEN_WEB_ADMIN_TOOLS_ENABLED CINATOKEN_WEB_ADMIN_PLAYGROUND_ENABLED CINATOKEN_WEB_ADMIN_SIMULATOR_ENABLED CINATOKEN_WEB_ADMIN_WITHDRAWALS_ENABLED CINATOKEN_WEB_ADMIN_NFT_MINTS_ENABLED CINATOKEN_WEB_DNS_RESOLVER
# Substitute only configuration values: retain nginx's $http_host (with port),
# $request_uri and forwarded scheme/header variables as literal nginx syntax.
envsubst '${CINATOKEN_WEB_PUBLIC_ENABLED} ${CINATOKEN_WEB_SSR_UPSTREAM} ${CINATOKEN_WEB_MANIFEST_SHA} ${CINATOKEN_ADMIN_UPSTREAM} ${CINATOKEN_WEB_ACCOUNT_ENABLED} ${CINATOKEN_WEB_ADMIN_DASHBOARD_ENABLED} ${CINATOKEN_WEB_ADMIN_USERS_ENABLED} ${CINATOKEN_WEB_ADMIN_USER_DETAIL_ENABLED} ${CINATOKEN_WEB_ADMIN_PROVIDERS_ENABLED} ${CINATOKEN_WEB_ADMIN_MODELS_ENABLED} ${CINATOKEN_WEB_ADMIN_ENDPOINTS_ENABLED} ${CINATOKEN_WEB_ADMIN_ROUTES_ENABLED} ${CINATOKEN_WEB_ADMIN_DATA_POLICIES_ENABLED} ${CINATOKEN_WEB_ADMIN_PRESETS_ENABLED} ${CINATOKEN_WEB_ADMIN_GUARDRAILS_ENABLED} ${CINATOKEN_WEB_ADMIN_RELIABILITY_ENABLED} ${CINATOKEN_WEB_ADMIN_MODEL_ANALYTICS_ENABLED} ${CINATOKEN_WEB_ADMIN_PROVIDER_ANALYTICS_ENABLED} ${CINATOKEN_WEB_ADMIN_USER_ANALYTICS_ENABLED} ${CINATOKEN_WEB_ADMIN_REQUEST_LOGS_ENABLED} ${CINATOKEN_WEB_ADMIN_BUDGET_AUDIT_ENABLED} ${CINATOKEN_WEB_ADMIN_TOOL_INVOCATIONS_ENABLED} ${CINATOKEN_WEB_ADMIN_CONFIG_TIMEZONE_ENABLED} ${CINATOKEN_WEB_ADMIN_CONFIG_ENABLED} ${CINATOKEN_WEB_ADMIN_ACCESS_KEYS_ENABLED} ${CINATOKEN_WEB_ADMIN_KEYS_ENABLED} ${CINATOKEN_WEB_ADMIN_SHARED_KEYS_ENABLED} ${CINATOKEN_WEB_ADMIN_TOOLS_ENABLED} ${CINATOKEN_WEB_ADMIN_PLAYGROUND_ENABLED} ${CINATOKEN_WEB_ADMIN_SIMULATOR_ENABLED} ${CINATOKEN_WEB_ADMIN_WITHDRAWALS_ENABLED} ${CINATOKEN_WEB_ADMIN_NFT_MINTS_ENABLED} ${CINATOKEN_WEB_DNS_RESOLVER} ${CINATOKEN_WEB_PROXY_CONNECT_SRC}' \
    < /etc/nginx/web-entry.conf.template \
    > /etc/nginx/conf.d/default.conf
nginx -t
case "${1:-}" in
    --check) exit 0 ;;
    '') ;;
    *) echo 'Only --check is supported' >&2; exit 1 ;;
esac
exec nginx -g 'daemon off;'
