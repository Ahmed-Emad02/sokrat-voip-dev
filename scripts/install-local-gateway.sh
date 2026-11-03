#!/bin/bash
# Install the local multi-tenant Sokrat gateway used as the app's LAN fallback.
#
# This is the Docker gateway (control + tenant API + SIP WSS + push), not the
# native push-only service. It owns :8095 inside the container, so the native
# sokrat-push-gateway.service must be disabled when this gateway is active.
set -euo pipefail

GATEWAY_SOURCE="${SOKRAT_GATEWAY_SOURCE:-/opt/sokrat-push-gateway}"
IMAGE="${SOKRAT_GATEWAY_IMAGE:-sokrat/push-gateway:latest}"
CONTAINER="${SOKRAT_GATEWAY_CONTAINER:-sokrat-gateway-local}"
ETC_DIR="${SOKRAT_GATEWAY_ETC:-/etc/sokrat-local}"
DATA_DIR="${SOKRAT_GATEWAY_DATA:-/var/lib/sokrat-gateway-local}"
PROV_DIR="${SOKRAT_GATEWAY_PROV:-/var/lib/sokrat-tenant-provisioning-local}"
LOG_DIR="${SOKRAT_GATEWAY_LOG:-/var/log/sokrat-local}"
HTTP_PORT="${SOKRAT_GATEWAY_HTTP_PORT:-18080}"
WS_PORT="${SOKRAT_GATEWAY_WS_PORT:-18088}"
CONTROL_PORT="${SOKRAT_GATEWAY_CONTROL_PORT:-18002}"
TENANT_PORT="${SOKRAT_GATEWAY_TENANT_PORT:-19097}"

log() { printf '[local-gateway] %s\n' "$*"; }
die() { printf '[local-gateway] ERROR: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root"
command -v docker >/dev/null 2>&1 || die "Docker is required for the local fallback gateway"
systemctl enable --now docker >/dev/null 2>&1 || true
if ! docker info >/dev/null 2>&1; then
    die "Docker daemon is not available"
fi

# The native push-only service and the container both bind :8095.
if systemctl list-unit-files sokrat-push-gateway.service >/dev/null 2>&1; then
    systemctl disable --now sokrat-push-gateway.service 2>/dev/null || true
fi
# Stop the previous instance first so its own :8095 listener does not trip the
# guard below. Data volumes are preserved.
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
if ss -ltn 2>/dev/null | awk '{print $4}' | grep -Eq '(^|:)(8095)$'; then
    owner=$(ss -ltnp 2>/dev/null | grep -E ':(8095)\b' || true)
    die "port 8095 is already in use by a non-gateway process: $owner"
fi

# Resolve the LAN address used by the mobile app's fallback setting.
if [ -z "${SOKRAT_GATEWAY_HOST:-}" ]; then
    SOKRAT_GATEWAY_HOST=$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')
fi
[ -n "$SOKRAT_GATEWAY_HOST" ] || die "could not detect LAN address; set SOKRAT_GATEWAY_HOST"
[ -n "${MYSQL_ROOT_PWD:-}" ] || MYSQL_ROOT_PWD=$(awk -F= '/^mysqlrootpwd=/{sub(/^mysqlrootpwd=/, ""); print; exit}' /etc/issabel.conf 2>/dev/null | tr -d '"' | xargs || true)
[ -n "$MYSQL_ROOT_PWD" ] || die "MySQL root password not found (expected /etc/issabel.conf)"

install -d -m 0755 "$ETC_DIR" "$ETC_DIR/firebase" "$LOG_DIR"
install -d -m 0700 "$DATA_DIR" "$PROV_DIR" "$DATA_DIR/secrets"

# FCM is optional at runtime but is provided by the Sokrat installer.
FCM_SRC=/etc/sokrat/firebase/service-account.json
if [ -f "$FCM_SRC" ]; then
    install -m 0644 "$FCM_SRC" "$ETC_DIR/firebase-service-account.json"
    install -m 0644 "$FCM_SRC" "$ETC_DIR/firebase/service-account.json"
    log "FCM service account copied"
fi

# Reuse an existing admin password if present; otherwise generate one.
ADMIN_PASSWORD_FILE="$ETC_DIR/gateway-admin-initial-password"
if [ ! -s "$ADMIN_PASSWORD_FILE" ]; then
    (umask 077; head -c 18 /dev/urandom | base64 | tr -d '=\n' > "$ADMIN_PASSWORD_FILE")
fi
ADMIN_PASS=$(cat "$ADMIN_PASSWORD_FILE")
LOCAL_PBX_ID_FILE="$ETC_DIR/local-pbx-id"
if [ ! -s "$LOCAL_PBX_ID_FILE" ]; then
    (umask 077; printf 'pbx_%s\n' "$(openssl rand -hex 8)" > "$LOCAL_PBX_ID_FILE")
fi
LOCAL_PBX_ID=$(cat "$LOCAL_PBX_ID_FILE")
# Reuse the PBX id already present in the local control store.
if [ -s "$DATA_DIR/control.json" ]; then
    EXISTING_PBX_ID=$(python3 -c 'import json,sys; c=json.load(open(sys.argv[1])); print((c.get("pbx") or [{}])[0].get("id") or "")' "$DATA_DIR/control.json" 2>/dev/null || true)
    if printf '%s' "$EXISTING_PBX_ID" | grep -Eq '^pbx_[a-f0-9]{16}$'; then
        LOCAL_PBX_ID="$EXISTING_PBX_ID"
        printf '%s\n' "$LOCAL_PBX_ID" > "$LOCAL_PBX_ID_FILE"
    fi
fi
LOCAL_HOOK_FILE="$ETC_DIR/local-hook-token"
if [ ! -s "$LOCAL_HOOK_FILE" ]; then
    (umask 077; openssl rand -hex 32 > "$LOCAL_HOOK_FILE")
fi
LOCAL_HOOK_TOKEN=$(cat "$LOCAL_HOOK_FILE")
LOCAL_HOOK_HASH=$(printf '%s' "$LOCAL_HOOK_TOKEN" | sha256sum | awk '{print $1}')
ADMIN_HASH=$(printf '%s' "$ADMIN_PASS" | python3 -c '
import os, base64, hashlib, sys
pwd = sys.stdin.buffer.read()
salt = os.urandom(16)
derived = hashlib.scrypt(pwd, salt=salt, n=16384, r=8, p=1, maxmem=32*1024*1024, dklen=64)
print("scrypt$16384$8$1$" + base64.b64encode(salt).decode() + "$" + base64.b64encode(derived).decode())
')

cat > "$ETC_DIR/gateway.env" <<EOF
NODE_ENV=production
PORT=8095
CONTROL_PORT=${CONTROL_PORT}
CONTROL_LISTEN_HOST=127.0.0.1
CONTROL_ALLOW_PUBLIC=true
CONTROL_TRUST_PROXY=true
CONTROL_COOKIE_SECURE=false
TENANT_PORT=${TENANT_PORT}
GATEWAY_PUBLIC_HOST=${SOKRAT_GATEWAY_HOST}
GATEWAY_HTTP_PORT=${HTTP_PORT}
GATEWAY_WS_PORT=${WS_PORT}
GATEWAY_TLS_ENABLED=false
GATEWAY_HTTPS_PORT=18443
GATEWAY_WSS_PORT=18089
GATEWAY_LISTEN_IP=${SOKRAT_GATEWAY_HOST}
GATEWAY_PRIVATE_IP=${SOKRAT_GATEWAY_HOST}
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=root
DB_PASS=${MYSQL_ROOT_PWD}
DB_NAME=asterisk
FCM_ENABLED=true
APNS_ENABLED=false
TURN_SHARED_SECRET=$(head -c 32 /dev/urandom | od -A n -v -t x1 | tr -d ' \n')
TURN_PUBLIC_HOST=${SOKRAT_GATEWAY_HOST}
TENANT_RUNTIME_FILE=/var/lib/sokrat-gateway/tenant-runtime.json
TENANT_PUSH_FILE=/var/lib/sokrat-gateway/push.json
SOKRAT_HEARTBEAT_ENABLED=true
SOKRAT_HEARTBEAT_STALE_MS=180000
SOKRAT_HEARTBEAT_TICK_MS=30000
PBX_PROXY_CONFIG=/dev/null
LOCAL_AUTO_APPROVE=true
LOCAL_PBX_ID=${LOCAL_PBX_ID}
LOCAL_SIP_AUTH=true
PBX_AUTH_URL=http://127.0.0.1:8080
EOF
chmod 0600 "$ETC_DIR/gateway.env"

cat > "$ETC_DIR/gateway-control.env" <<EOF
CONTROL_DATA_FILE=/var/lib/sokrat-gateway/control.json
CONTROL_MAX_ENABLED_PBX=10
CONTROL_ADMIN_PASSWORD_HASH='${ADMIN_HASH}'
TENANT_RUNTIME_FILE=/var/lib/sokrat-gateway/tenant-runtime.json
SOKRAT_HEARTBEAT_ENABLED=true
GOOGLE_APPLICATION_CREDENTIALS=/etc/sokrat/firebase-service-account.json
LOCAL_AUTO_APPROVE=true
LOCAL_PBX_ID=${LOCAL_PBX_ID}
LOCAL_SIP_AUTH=true
PBX_AUTH_URL=http://127.0.0.1:8080
EOF
chmod 0600 "$ETC_DIR/gateway-control.env"

# Seed the local-only PBX identity. Cloud records are never copied here.
NOW=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
if [ ! -s "$DATA_DIR/control.json" ]; then
    python3 - "$DATA_DIR/control.json" "$LOCAL_PBX_ID" "$NOW" <<'PYBOOT'
import json, sys
path, pbx_id, now = sys.argv[1:]
record = {
    "schemaVersion": 2,
    "pbx": [{
        "id": pbx_id,
        "name": "local-pbx",
        "wsURL": "ws://127.0.0.1:8088/ws",
        "apiURL": "http://127.0.0.1:8095/",
        "mediaIps": ["127.0.0.1"],
        "enabled": True,
        "management": {
            "customer": "local",
            "loginHostname": None,
            "extensionPolicyRequired": False,
            "approvalStatus": "approved",
            "reviewedInstallationId": None
        },
        "createdAt": now,
        "updatedAt": now
    }],
    "extensions": [],
    "enrollmentTokens": [],
    "devices": [],
    "audit": []
}
with open(path, "w") as handle:
    json.dump(record, handle, indent=2)
PYBOOT
fi
if [ ! -s "$DATA_DIR/tenant-runtime.json" ]; then
    printf '{"relays":{},"hookHashes":{"%s":"%s"}}\n' "$LOCAL_PBX_ID" "$LOCAL_HOOK_HASH" > "$DATA_DIR/tenant-runtime.json"
else
    python3 -c 'import json,sys; p=sys.argv[1]; d=json.load(open(p)); d.setdefault("relays",{}); d.setdefault("hookHashes",{})[sys.argv[2]]=sys.argv[3]; json.dump(d,open(p,"w"),indent=2)' "$DATA_DIR/tenant-runtime.json" "$LOCAL_PBX_ID" "$LOCAL_HOOK_HASH"
fi
# PBX-side local hook. This is intentionally loopback-only.
cat > "$ETC_DIR/local-gateway-hook.json" <<EOF
{"gatewayUrl":"http://127.0.0.1:18080","pbxId":"${LOCAL_PBX_ID}","token":"${LOCAL_HOOK_TOKEN}"}
EOF
chmod 0640 "$ETC_DIR/local-gateway-hook.json"
chown root:asterisk "$ETC_DIR/local-gateway-hook.json" 2>/dev/null || true
install -m 0640 "$ETC_DIR/local-gateway-hook.json" /etc/sokrat/local-gateway-hook.json
chown root:asterisk /etc/sokrat/local-gateway-hook.json 2>/dev/null || true

# Build or load the multi-tenant image if it is not already present.
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    IMAGE_TAR=""
    for candidate in \
        "${SOKRAT_GATEWAY_IMAGE_TAR:-}" \
        "$GATEWAY_SOURCE/installer-bundle/packages/sokrat-push-gateway-image.tar.gz" \
        "$GATEWAY_SOURCE/installer-bundle/packages/sokrat-push-gateway-image.tar" \
        "/opt/sokrat-voip/installer-bundle/packages/sokrat-push-gateway-image.tar.gz"; do
        [ -n "$candidate" ] && [ -f "$candidate" ] && { IMAGE_TAR="$candidate"; break; }
    done
    if [ -n "$IMAGE_TAR" ]; then
        log "loading gateway image from $IMAGE_TAR"
        case "$IMAGE_TAR" in
            *.gz) gzip -dc "$IMAGE_TAR" | docker load ;;
            *) docker load -i "$IMAGE_TAR" ;;
        esac
    elif [ -f "$GATEWAY_SOURCE/Dockerfile" ]; then
        log "building gateway image from $GATEWAY_SOURCE"
        DOCKER_UID=$(id -u sokrat-push 2>/dev/null || echo 999)
        DOCKER_GID=$(id -g sokrat-push 2>/dev/null || echo 999)
        docker build --build-arg "SOKRAT_UID=$DOCKER_UID" --build-arg "SOKRAT_GID=$DOCKER_GID" -t "$IMAGE" "$GATEWAY_SOURCE"
    else
        die "gateway image missing and no Dockerfile/image archive found"
    fi
fi

IMG_UID=$(docker run --rm --entrypoint id "$IMAGE" -u sokrat-push 2>/dev/null || echo 999)
IMG_GID=$(docker run --rm --entrypoint id "$IMAGE" -g sokrat-push 2>/dev/null || echo 999)
chown -R "$IMG_UID:$IMG_GID" "$DATA_DIR" "$LOG_DIR" "$PROV_DIR" 2>/dev/null || true
chown "$IMG_UID:$IMG_GID" "$DATA_DIR/control.json" "$DATA_DIR/tenant-runtime.json" 2>/dev/null || true
find "$DATA_DIR" -maxdepth 1 -type f -exec chmod 0600 {} + 2>/dev/null || true

docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" --network host --restart unless-stopped \
    --env-file "$ETC_DIR/gateway.env" \
    --env-file "$ETC_DIR/gateway-control.env" \
    -v "$ETC_DIR:/etc/sokrat" \
    -v "$DATA_DIR:/var/lib/sokrat-gateway" \
    -v "$PROV_DIR:/var/lib/sokrat-tenant-provisioning" \
    -v "$LOG_DIR:/var/log/sokrat" \
    "$IMAGE" >/dev/null

for _ in $(seq 1 30); do
    if curl -fsS -m 2 http://127.0.0.1:8095/health >/dev/null 2>&1; then
        log "gateway health OK on :8095"
        log "fallback API: http://${SOKRAT_GATEWAY_HOST}:${HTTP_PORT}"
        log "fallback WSS: ws://${SOKRAT_GATEWAY_HOST}:${WS_PORT}/ws"
        exit 0
    fi
    sleep 2
done
docker logs --tail 80 "$CONTAINER" >&2 || true
die "gateway container did not become healthy"
