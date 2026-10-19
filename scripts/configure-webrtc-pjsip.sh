#!/bin/bash
# Sokrat VOIP — idempotent WebRTC/PJSIP transport and multi-registration repair.
# Safe for fresh installs and in-place upgrades. Existing desktop SIP endpoints,
# outbound routes, trunks, and dialplans are not modified.

set -euo pipefail

ASTERISK_DIR="${ASTERISK_DIR:-/etc/asterisk}"
KEY_DIR="$ASTERISK_DIR/keys"
CERT_PATH="$KEY_DIR/asterisk.pem"
KEY_PATH="$KEY_DIR/asterisk.key"
PJSIP_TRP_CUSTOM="$ASTERISK_DIR/pjsip_transport_custom.conf"
PJSIP_TRP_ADDITIONAL="$ASTERISK_DIR/pjsip_transport_additional.conf"
PJSIP_ADDITIONAL="$ASTERISK_DIR/pjsip_additional.conf"
FUNCTIONS_FILE="${ISSABEL_CORE_FUNCTIONS:-/var/www/html/admin/modules/core/functions.inc.php}"
RETRIEVE_CONF="${RETRIEVE_CONF:-/var/lib/asterisk/bin/retrieve_conf}"
ASTERISK_BIN="${ASTERISK_BIN:-/usr/sbin/asterisk}"
MODULES_CUSTOM="$ASTERISK_DIR/modules_custom.conf"
SIP_GENERAL_CUSTOM="$ASTERISK_DIR/sip_general_custom.conf"
ASTERISK_CONF="$ASTERISK_DIR/asterisk.conf"
SKIP_RETRIEVE_CONF="${SKIP_RETRIEVE_CONF:-0}"
SKIP_ASTERISK_RELOAD="${SKIP_ASTERISK_RELOAD:-0}"
WEBRTC_EXTENSIONS="${WEBRTC_EXTENSIONS:-}"

log() { printf '  %s\n' "$*"; }

if [ "$(id -u)" -ne 0 ]; then
    echo "ERROR: configure-webrtc-pjsip.sh must run as root." >&2
    exit 1
fi

build_mysql_auth() {
    if [ -n "${MYSQL_ROOT_PWD:-}" ]; then
        MYSQL_AUTH=(-u root "-p${MYSQL_ROOT_PWD}")
        return
    fi

    local pwd=""
    pwd=$(grep -i '^mysqlrootpwd=' /etc/issabel.conf 2>/dev/null | cut -d= -f2- | xargs 2>/dev/null || true)
    if [ -z "$pwd" ]; then
        pwd=$(grep -i '^AMPDBPASS=' /etc/amportal.conf 2>/dev/null | cut -d= -f2- | xargs 2>/dev/null || true)
    fi

    if [ -n "$pwd" ] && mysql -u root -p"$pwd" -e 'SELECT 1' >/dev/null 2>&1; then
        MYSQL_AUTH=(-u root "-p${pwd}")
    elif mysql -u root -e 'SELECT 1' >/dev/null 2>&1; then
        MYSQL_AUTH=(-u root)
    else
        echo "ERROR: Unable to authenticate to MariaDB/MySQL as root." >&2
        exit 1
    fi
}

ensure_certificates() {
    mkdir -p "$KEY_DIR"
    if [ ! -s "$CERT_PATH" ] || [ ! -s "$KEY_PATH" ]; then
        rm -f "$CERT_PATH" "$KEY_PATH"
        openssl req -new -x509 -days 3650 -nodes \
            -out "$CERT_PATH" -keyout "$KEY_PATH" \
            -subj "/C=EG/O=Sokrat/CN=$(hostname -f 2>/dev/null || hostname 2>/dev/null || echo sokrat-voip)" \
            >/dev/null 2>&1
        log "Generated Asterisk WebRTC certificate and private key."
    fi
    chown asterisk:asterisk "$CERT_PATH" "$KEY_PATH" 2>/dev/null || true
    chmod 640 "$CERT_PATH" "$KEY_PATH"
}

ensure_channel_driver_settings() {
    touch "$MODULES_CUSTOM" "$SIP_GENERAL_CUSTOM"
    if ! grep -qE '^[[:space:]]*load[[:space:]]*=>[[:space:]]*chan_sip\.so' "$MODULES_CUSTOM"; then
        printf '\nload => chan_sip.so\n' >> "$MODULES_CUSTOM"
    fi
    if grep -qE '^[[:space:]]*websocket_enabled[[:space:]]*=' "$SIP_GENERAL_CUSTOM"; then
        sed -i 's/^[[:space:]]*websocket_enabled[[:space:]]*=.*/websocket_enabled=no/' "$SIP_GENERAL_CUSTOM"
    else
        printf '\n; PJSIP owns the WebRTC WebSocket transports\nwebsocket_enabled=no\n' >> "$SIP_GENERAL_CUSTOM"
    fi
    chown asterisk:asterisk "$MODULES_CUSTOM" "$SIP_GENERAL_CUSTOM" 2>/dev/null || true
    log "Reserved WebSocket handling for PJSIP while retaining chan_sip compatibility."
}

ensure_asterisk_socket_permissions() {
    [ -f "$ASTERISK_CONF" ] || return 0
    if grep -qE '^[[:space:]]*astctlpermissions[[:space:]]*=' "$ASTERISK_CONF"; then
        sed -i 's/^[[:space:]]*astctlpermissions[[:space:]]*=.*/astctlpermissions = 0775/' "$ASTERISK_CONF"
    else
        printf '\nastctlpermissions = 0775\n' >> "$ASTERISK_CONF"
    fi
    if grep -qE '^[[:space:]]*astctlgroup[[:space:]]*=' "$ASTERISK_CONF"; then
        sed -i 's/^[[:space:]]*astctlgroup[[:space:]]*=.*/astctlgroup = asterisk/' "$ASTERISK_CONF"
    else
        printf 'astctlgroup = asterisk\n' >> "$ASTERISK_CONF"
    fi
}

write_transports() {
    mkdir -p "$ASTERISK_DIR"
    cat > "$PJSIP_TRP_CUSTOM" <<'TRPEOF'
; Dedicated PJSIP Transports for WebRTC and Standard SIP (Managed by Sokrat VOIP)
[transport-ws]
type=transport
protocol=ws
bind=0.0.0.0:8088
allow_reload=true
local_net=192.168.0.0/16
local_net=10.0.0.0/8
local_net=172.16.0.0/12
local_net=100.64.0.0/10
local_net=127.0.0.0/8

[transport-wss]
type=transport
protocol=wss
bind=0.0.0.0:8089
allow_reload=true
local_net=192.168.0.0/16
local_net=10.0.0.0/8
local_net=172.16.0.0/12
local_net=100.64.0.0/10
local_net=127.0.0.0/8

[transport-udp]
type=transport
protocol=udp
bind=0.0.0.0:5066
allow_reload=true
local_net=192.168.0.0/16
local_net=10.0.0.0/8
local_net=172.16.0.0/12
local_net=100.64.0.0/10
local_net=127.0.0.0/8

[transport-tcp]
type=transport
protocol=tcp
bind=0.0.0.0:5066
allow_reload=true
local_net=192.168.0.0/16
local_net=10.0.0.0/8
local_net=172.16.0.0/12
local_net=100.64.0.0/10
local_net=127.0.0.0/8
TRPEOF
    chmod 640 "$PJSIP_TRP_CUSTOM"
    chown asterisk:asterisk "$PJSIP_TRP_CUSTOM" 2>/dev/null || true
    printf '; Dedicated transports managed via pjsip_transport_custom.conf\n' > "$PJSIP_TRP_ADDITIONAL"
    chmod 640 "$PJSIP_TRP_ADDITIONAL"
    chown asterisk:asterisk "$PJSIP_TRP_ADDITIONAL" 2>/dev/null || true
    log "Configured WS :8088, WSS :8089, UDP/TCP :5066 transports."
}

patch_issabel_generator() {
    [ -f "$FUNCTIONS_FILE" ] || return 0
    if ! grep -q "case 'maxcontacts':" "$FUNCTIONS_FILE"; then
        sed -i "s/case 'max_contacts':/case 'maxcontacts':\n                        case 'max_contacts':/" "$FUNCTIONS_FILE"
    fi
    if ! grep -q "case 'remove_unavailable':" "$FUNCTIONS_FILE"; then
        sed -i "s/case 'remove_existing':/case 'remove_existing':\n                        case 'remove_unavailable':/" "$FUNCTIONS_FILE"
    fi
    if ! grep -q "case 'inband_progress':" "$FUNCTIONS_FILE"; then
        sed -i "/case 'use_avpf':/i \                        case 'inband_progress':\n                        case 'inbandprogress':\n                            \$output1[]='inband_progress='.\$result2['data'];\n                            break;" "$FUNCTIONS_FILE"
    fi
    if ! grep -q "\$devopts\['inband_progress'\]" "$FUNCTIONS_FILE"; then
        sed -i "/\$devopts\['use_avpf'\]\['value'\]='yes';/a \                \$devopts['inband_progress']['value']='yes';" "$FUNCTIONS_FILE"
    fi
    log "Verified Issabel AOR option generation."
}

collect_extensions() {
    local candidates=""
    if [ -n "$WEBRTC_EXTENSIONS" ]; then
        candidates="$WEBRTC_EXTENSIONS"
    else
        candidates=$(mysql "${MYSQL_AUTH[@]}" asterisk -Nse "
            SELECT DISTINCT id
            FROM sip
            WHERE id REGEXP '^[0-9]+$'
              AND (
                (keyword='transport' AND LOWER(data) IN ('wss','ws','transport-wss','transport-ws'))
                OR (keyword='webrtc' AND LOWER(data) IN ('yes','1','true'))
                OR (keyword='avpf' AND LOWER(data)='yes' AND EXISTS (
                    SELECT 1 FROM sip auth
                    WHERE auth.id=sip.id AND auth.keyword='secret' AND auth.data<>''
                ))
              )
            ORDER BY CAST(id AS UNSIGNED);
        " 2>/dev/null || true)
    fi

    printf '%s\n' "$candidates" | tr ', ' '\n\n' | grep -E '^[0-9]+$' | sort -nu | tr '\n' ' '
}

upsert_extension_settings() {
    local ext="$1"
    local sql=""
    while IFS='|' read -r keyword data flags; do
        sql+="INSERT INTO sip (id,keyword,data,flags) VALUES ('${ext}','${keyword}','${data}',${flags}) ON DUPLICATE KEY UPDATE data=VALUES(data),flags=VALUES(flags);"
    done <<'EOF'
transport|transport-wss|14
webrtc|yes|18
media_encryption|dtls|18
dtls_cert_file|/etc/asterisk/keys/asterisk.pem|18
dtls_private_key|/etc/asterisk/keys/asterisk.key|18
dtls_verify|fingerprint|18
dtls_setup|actpass|18
ice_support|yes|18
use_avpf|yes|18
rtcp_mux|yes|18
force_rport|yes|18
rewrite_contact|yes|18
disallow|all|25
allow|opus,ulaw,alaw|26
max_contacts|10|16
remove_existing|no|18
remove_unavailable|yes|18
inband_progress|yes|18
direct_media|no|18
rtp_timeout|30|18
rtp_timeout_hold|60|18
rtp_keepalive|5|18
EOF
    mysql "${MYSQL_AUTH[@]}" asterisk -e "$sql" >/dev/null
}

patch_pjsip_custom_post() {
    [ -f "$ASTERISK_DIR/pjsip_custom_post.conf" ] || touch "$ASTERISK_DIR/pjsip_custom_post.conf"
    EXTENSION_LIST="$1" PJSIP_POST="$ASTERISK_DIR/pjsip_custom_post.conf" PJSIP_CUSTOM="$ASTERISK_DIR/pjsip_custom.conf" python3 - <<'PY'
import os
import re
from pathlib import Path

post_path = Path(os.environ['PJSIP_POST'])
custom_path = Path(os.environ['PJSIP_CUSTOM'])
extensions = set(os.environ.get('EXTENSION_LIST', '').split())
if not extensions:
    raise SystemExit(0)

if custom_path.exists():
    c_text = custom_path.read_text(encoding='utf-8')
    c_orig = c_text
    for ext in extensions:
        c_text = re.sub(rf'; BEGIN WEBRTC EXTENSION {ext}[\s\S]*?; END WEBRTC EXTENSION {ext}\r?\n?', '', c_text)
        c_text = re.sub(rf'\[({ext}|{ext}-auth)\][\s\S]*?(?=\n\[|\n; BEGIN|$)', '', c_text)
    if c_text != c_orig:
        custom_path.write_text(c_text.strip() + '\n', encoding='utf-8')

post_text = post_path.read_text(encoding='utf-8') if post_path.exists() else ''
required_params = [
    'transport=transport-wss',
    'webrtc=yes',
    'media_encryption=dtls',
    'dtls_cert_file=/etc/asterisk/keys/asterisk.pem',
    'dtls_private_key=/etc/asterisk/keys/asterisk.key',
    'dtls_verify=fingerprint',
    'dtls_setup=actpass',
    'ice_support=yes',
    'use_avpf=yes',
    'rtcp_mux=yes',
    'force_rport=yes',
    'rewrite_contact=yes',
    'direct_media=no',
    'rtp_symmetric=yes',
    'disallow=all',
    'allow=opus,ulaw,alaw',
    'rtp_timeout=30',
    'rtp_timeout_hold=60',
    'rtp_keepalive=5'
]

for ext in extensions:
    sec_pattern = re.compile(rf'(\[{ext}\]\(\+\)[\s\S]*?)(?=\n\[|$)')
    m = sec_pattern.search(post_text)
    if m:
        sec = m.group(1)
        for p in required_params:
            k = p.split('=')[0]
            if re.search(rf'(?m)^{k}=', sec):
                sec = re.sub(rf'(?m)^{k}=.*$', p, sec)
            else:
                sec += f'\n{p}'
        post_text = post_text[:m.start()] + sec + post_text[m.end():]
    else:
        post_text = post_text.strip() + f'\n\n[{ext}](+)\n' + '\n'.join(required_params) + '\n'

post_path.write_text(post_text.strip() + '\n', encoding='utf-8')
PY
}
patch_generated_aors() {
    [ -f "$PJSIP_ADDITIONAL" ] || return 0
    EXTENSION_LIST="$1" PJSIP_ADDITIONAL="$PJSIP_ADDITIONAL" python3 - <<'PY'
import os
import re
from pathlib import Path

path = Path(os.environ['PJSIP_ADDITIONAL'])
extensions = set(os.environ.get('EXTENSION_LIST', '').split())
if not extensions or not path.exists():
    raise SystemExit(0)

text = path.read_text(encoding='utf-8')
header_pattern = re.compile(r'(?m)^\[([^\]]+)\]\s*$')
headers = list(header_pattern.finditer(text))
parts = []
cursor = 0
changed = False

for index, header in enumerate(headers):
    start = header.start()
    end = headers[index + 1].start() if index + 1 < len(headers) else len(text)
    parts.append(text[cursor:start])
    section = text[start:end]
    cursor = end

    if header.group(1) in extensions and re.search(r'(?mi)^type\s*=\s*aor\s*$', section):
        for key, value in (('max_contacts', '10'), ('remove_existing', 'no'), ('remove_unavailable', 'yes')):
            pattern = re.compile(r'(?mi)^{}\s*=.*$'.format(re.escape(key)))
            desired = '{}={}'.format(key, value)
            if pattern.search(section):
                updated = pattern.sub(desired, section, count=1)
            else:
                updated = re.sub(r'(?mi)^(type\s*=\s*aor\s*)$', r'\1\n' + desired, section, count=1)
            if updated != section:
                section = updated
                changed = True
    parts.append(section)

parts.append(text[cursor:])
if changed:
    path.write_text(''.join(parts), encoding='utf-8')
PY
}

build_mysql_auth
ensure_certificates
ensure_channel_driver_settings
ensure_asterisk_socket_permissions
write_transports
patch_issabel_generator

EXTENSION_LIST=$(collect_extensions)
if [ -n "$EXTENSION_LIST" ]; then
    for extension in $EXTENSION_LIST; do
        upsert_extension_settings "$extension"
    done
    log "Applied WebRTC multi-registration settings to: $EXTENSION_LIST"
else
    log "No existing WebRTC extensions detected; future CRM sessions will self-provision."
fi

if [ "$SKIP_RETRIEVE_CONF" != "1" ] && [ -x "$RETRIEVE_CONF" ]; then
    "$RETRIEVE_CONF" >/dev/null 2>&1 || log "Warning: retrieve_conf reported an error; applying direct AOR repair."
fi
patch_generated_aors "$EXTENSION_LIST"
patch_pjsip_custom_post "$EXTENSION_LIST"

if [ "$SKIP_ASTERISK_RELOAD" != "1" ] && [ -x "$ASTERISK_BIN" ] && pgrep -x asterisk >/dev/null 2>&1; then
    "$ASTERISK_BIN" -rx 'pjsip reload' >/dev/null 2>&1 || true
fi

log "WebRTC/PJSIP configuration is ready."
