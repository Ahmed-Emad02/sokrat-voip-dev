#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Sokrat tenant gateway readiness for this PBX.
#
# The tenant gateway (PBX manager) admits a device only when the PBX itself
# can be reached and can wake a device. This script prepares the PBX side of
# that contract on a fresh install and on every upgrade:
#
#   1. an additive shared push context in /etc/asterisk/extensions_sokrat.conf,
#      carrying the variables the
#      gateway's tenant hook expects (TARGET_EXT, SOKRAT_LINKEDID,
#      SOKRAT_CALL_ID, SOKRAT_CALLER_NUM, SOKRAT_CALLER_NAME).
#   2. inclusion of that context without replacing any shared dialing macro.
#      Actual incoming wake is separately compiled by install-webrtc-wake.py
#      for exact provisioned WebRTC targets only.
#   3. a stable installation id and a readiness manifest in /etc/sokrat,
#      so the dashboard/operator can verify what the gateway will see.
#   4. a check of the endpoints the gateway dials: the Asterisk SIP
#      WebSocket (8088 plain / 8089 TLS) and the Sokrat API (8080).
#
# It never touches trunk macros, extension registrations or any desktop SIP
# behaviour, and it never restarts Asterisk.
#
# Usage: sokrat-gateway-readiness.sh [--check|--apply] [--no-reload]
#   --check     verify only, change nothing, exit 1 when not ready
#   --apply     (default) prepare the PBX idempotently
#   --no-reload  do not reload the Asterisk dialplan (caller reloads later)
# ─────────────────────────────────────────────────────────────────────────────
set -u

MODE="apply"
RELOAD="yes"
for arg in "$@"; do
    case "$arg" in
        --check) MODE="check" ;;
        --apply) MODE="apply" ;;
        --no-reload) RELOAD="no" ;;
        *) echo "Unknown option: $arg" >&2; exit 2 ;;
    esac
done

DIALPLAN_FILE="/etc/asterisk/extensions_sokrat.conf"
STATE_DIR="/etc/sokrat"
MANIFEST="$STATE_DIR/pbx-gateway.json"
INSTALL_ID_FILE="$STATE_DIR/pbx-installation-id"
MARKER="; sokrat-gateway-readiness v1"
PUSH_GATEWAY_URL="${SOKRAT_PUSH_GATEWAY_URL:-http://127.0.0.1:8095}"
SIP_WS_PLAIN_PORT=8088
SIP_WS_TLS_PORT=8089
API_PORT=8080

problems=0
note() { echo "  $*"; }
problem() { echo "  WARNING: $*" >&2; problems=$((problems + 1)); }

# ── helpers ──────────────────────────────────────────────────────────────────
listening_port() {
    local port="$1"
    if command -v ss >/dev/null 2>&1; then
        ss -H -lnt "sport = :$port" 2>/dev/null | grep -q . && return 0
        return 1
    fi
    netstat -lnt 2>/dev/null | grep -q ":$port " && return 0
    return 1
}

tailscale_ipv4() {
    local ip=""
    if command -v tailscale >/dev/null 2>&1; then
        ip="$(tailscale ip -4 2>/dev/null | head -n 1 | tr -d '[:space:]')"
    fi
    if [ -z "$ip" ]; then
        ip="$(ip -4 -o addr show 2>/dev/null | awk '$2 ~ /tailscale/ {split($4, a, "/"); print a[1]; exit}')"
    fi
    case "$ip" in
        100.*) [ "${ip#100.}" != "$ip" ] || ip="" ;;
        *) ip="" ;;
    esac
    # 100.64.0.0/10 is the only range the gateway accepts for onboarding.
    if [ -n "$ip" ]; then
        local second="${ip#100.}"; second="${second%%.*}"
        if [ "$second" -lt 64 ] 2>/dev/null || [ "$second" -gt 127 ] 2>/dev/null; then ip=""; fi
    fi
    echo "$ip"
}

push_context_count() {
    [ -f "$DIALPLAN_FILE" ] || { echo 0; return; }
    grep -c '^\[sub-sokrat-push-send\]' "$DIALPLAN_FILE" 2>/dev/null || echo 0
}

# ── detection ────────────────────────────────────────────────────────────────
ts_ip="$(tailscale_ipv4)"
ws_plain="no"; listening_port "$SIP_WS_PLAIN_PORT" && ws_plain="yes"
ws_tls="no"; listening_port "$SIP_WS_TLS_PORT" && ws_tls="yes"
api="no"; listening_port "$API_PORT" && api="yes"

if [ -z "$ts_ip" ]; then
    problem "No Tailscale IPv4 (100.64.0.0/10) found. The gateway dials the PBX over Tailscale."
fi

if [ "$ws_plain" != "yes" ] && [ "$ws_tls" != "yes" ]; then
    problem "Asterisk SIP WebSocket is not listening on $SIP_WS_PLAIN_PORT (plain) or $SIP_WS_TLS_PORT (TLS)."
fi

if [ "$api" != "yes" ]; then
    problem "Sokrat API is not listening on port $API_PORT."
fi

if [ "$(push_context_count)" -eq 0 ] && [ "$MODE" = "check" ]; then
    problem "Missing [sub-sokrat-push-send] context in $DIALPLAN_FILE."
fi

if [ "$(push_context_count)" -gt 1 ]; then
    problem "More than one [sub-sokrat-push-send] context in $DIALPLAN_FILE."
fi

if [ "$MODE" = "check" ]; then
    echo "Sokrat gateway readiness: $([ "$problems" -eq 0 ] && echo READY || echo NOT READY)"
    note "tailscale ipv4: ${ts_ip:-none}"
    note "sip websocket : $SIP_WS_PLAIN_PORT=$ws_plain $SIP_WS_TLS_PORT=$ws_tls"
    note "sokrat api    : $API_PORT=$api"
    note "push context  : $DIALPLAN_FILE"
    exit "$([ "$problems" -eq 0 ] && echo 0 || echo 1)"
fi

# ── apply ────────────────────────────────────────────────────────────────────
install -d -m 0755 "$STATE_DIR"

# Stable installation id, generated once and never rotated by an upgrade.
if [ ! -f "$INSTALL_ID_FILE" ]; then
    if command -v uuidgen >/dev/null 2>&1; then
        uuidgen > "$INSTALL_ID_FILE"
    else
        cat /proc/sys/kernel/random/uuid > "$INSTALL_ID_FILE"
    fi
    chmod 0644 "$INSTALL_ID_FILE"
fi
install_id="$(tr -d '[:space:]' < "$INSTALL_ID_FILE")"

changed=0
if [ "$(push_context_count)" -eq 0 ]; then
    echo "  Creating the shared tenant push context in $DIALPLAN_FILE..."
    touch "$DIALPLAN_FILE"
    cat >> "$DIALPLAN_FILE" <<'EOF'
; Sokrat VOIP - mobile push wake dialplan
; sokrat-gateway-readiness v1
[sub-sokrat-push-send]
exten => s,1,Set(TARGET_EXT=${ARG1})
 same => n,GotoIf($["${TARGET_EXT}"=""]?done)
 same => n,Set(SOKRAT_LINKEDID=${FILTER(0-9A-Za-z.-,${CHANNEL(linkedid)})})
 same => n,Set(__SOKRAT_CALL_ID=${FILTER(0-9a-f-,${SHELL(/usr/bin/uuidgen --sha1 --namespace b32a7f28-4bcc-5a56-a51f-2ad6f65f746b --name ${SOKRAT_LINKEDID})})})
 same => n,Set(HASH(__SIPHEADERS,X-Sokrat-Call-ID)=${SOKRAT_CALL_ID})
 same => n,Set(SOKRAT_CALLER_NUM=${IF($["${CALLERID(num)}" = ""]?0:${CALLERID(num)})})
 same => n,Set(SOKRAT_CALLER_NAME=${IF($["${CALLERID(name)}" = ""]?${SOKRAT_CALLER_NUM}:${CALLERID(name)})})
 same => n,Set(SOKRAT_ENC_CALLER=${URIENCODE(${SOKRAT_CALLER_NUM})})
 same => n,Set(SOKRAT_ENC_NAME=${URIENCODE(${SOKRAT_CALLER_NAME})})
 same => n,NoOp([callId=${SOKRAT_CALL_ID}] sending wake callee=${TARGET_EXT} linkedid=${SOKRAT_LINKEDID})
 same => n,System(nohup /usr/bin/curl -s --max-time 2 "$PUSH_GATEWAY_URL/api/push/incoming-call?callee=${TARGET_EXT}&caller=${SOKRAT_ENC_CALLER}&callerName=${SOKRAT_ENC_NAME}&callId=${SOKRAT_CALL_ID}" >/dev/null 2>&1 &)
 same => n,System(nohup env SOKRAT_HOOK_CONFIG="/etc/sokrat/gateway-hook.json" /usr/bin/python3 "/usr/local/bin/sokrat-tenant-push-hook.py" "${URIENCODE(${TARGET_EXT})}" "${URIENCODE(${SOKRAT_CALLER_NUM})}" "${URIENCODE(${SOKRAT_CALLER_NAME})}" "${SOKRAT_CALL_ID}" >/dev/null 2>&1 &)
 same => n(done),Return()
EOF
    chown asterisk:asterisk "$DIALPLAN_FILE" 2>/dev/null || true
    chmod 0640 "$DIALPLAN_FILE" 2>/dev/null || true
    if [ "$DIALPLAN_FILE" = "/etc/asterisk/extensions_sokrat.conf" ]; then
        for ov in "/etc/asterisk/extensions_override_issabelpbx.conf" "/etc/asterisk/extensions_override_freepbx.conf"; do
            if [ -f "$ov" ] && ! grep -q "extensions_sokrat.conf" "$ov" 2>/dev/null; then
                echo "#include extensions_sokrat.conf" >> "$ov"
            fi
        done
    fi
    changed=1
    echo "  Shared tenant push context created; no shared dialing macros changed."
fi

# Readiness manifest: no secrets, only what the gateway/operator needs to see.
ws_url="ws://${ts_ip:-127.0.0.1}:$SIP_WS_PLAIN_PORT/ws"
api_url="http://${ts_ip:-127.0.0.1}:$API_PORT"
media_ips="[]"
[ -n "$ts_ip" ] && media_ips="[\"$ts_ip\"]"
push_present="false"
[ "$(push_context_count)" -gt 0 ] && push_present="true"
ws_bool="false"; [ "$ws_plain" = "yes" ] && ws_bool="true"
tls_bool="false"; [ "$ws_tls" = "yes" ] && tls_bool="true"
api_bool="false"; [ "$api" = "yes" ] && api_bool="true"
cat > "$MANIFEST" <<EOF
{
  "schemaVersion": 1,
  "installationId": "$install_id",
  "tailscaleIPv4": "$ts_ip",
  "wsURL": "$ws_url",
  "apiURL": "$api_url",
  "mediaIps": $media_ips,
  "pushContextFile": "$DIALPLAN_FILE",
  "pushContextPresent": $push_present,
  "sipWebSocket": { "plain": $ws_bool, "tls": $tls_bool },
  "apiReachable": $api_bool,
  "updatedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
chmod 0644 "$MANIFEST"
if ! python3 -m json.tool "$MANIFEST" >/dev/null 2>&1; then
    echo "  ERROR: the readiness manifest is not valid JSON; remove $MANIFEST and re-run." >&2
    exit 1
fi

if [ "$changed" = "1" ] && [ "$RELOAD" = "yes" ]; then
    asterisk -rx "dialplan reload" >/dev/null 2>&1 || echo "  WARNING: dialplan reload failed; run 'asterisk -rx \"dialplan reload\"' manually."
fi

echo "Sokrat gateway readiness:"
note "tailscale ipv4 : ${ts_ip:-none}"
note "sip websocket  : $ws_url (plain $ws_plain / tls $ws_tls)"
note "sokrat api     : $api_url"
note "manifest       : $MANIFEST"
note "installation id: $install_id"
if [ -n "$ts_ip" ]; then
    note "dashboard entry: PBX address $ts_ip"
fi
exit 0
