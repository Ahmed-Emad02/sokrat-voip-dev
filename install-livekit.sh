#!/bin/bash
# ==============================================================================
# Sokrat VOIP — LiveKit SFU provisioning
#
# Installs the self-hosted LiveKit server used by the desktop video rooms.
# The Sokrat VOIP backend mints room tokens; LiveKit only carries media.
# ==============================================================================
set -euo pipefail

export PATH="/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin:${PATH:-}"

LIVEKIT_VERSION="${LIVEKIT_VERSION:-1.13.11}"
LIVEKIT_BIN="${LIVEKIT_BIN:-/usr/local/bin/livekit-server}"
LIVEKIT_DIR="${LIVEKIT_DIR:-/opt/sokrat-livekit}"
LIVEKIT_CONFIG="${LIVEKIT_CONFIG:-/etc/sokrat/livekit.yaml}"
ENV_FILE="${ENV_FILE:-/opt/sokrat-voip/.env}"
LIVEKIT_USER="${LIVEKIT_USER:-sokrat-livekit}"
LIVEKIT_PORT="${LIVEKIT_PORT:-7880}"
LIVEKIT_TCP_PORT="${LIVEKIT_TCP_PORT:-7881}"
LIVEKIT_UDP_PORT="${LIVEKIT_UDP_PORT:-7882}"

env_value() {
    local key="$1"
    if [[ -f "$ENV_FILE" ]]; then
        grep -E "^${key}=" "$ENV_FILE" | tail -1 | cut -d= -f2- || true
    fi
}

set_env_value() {
    local key="$1"
    local value="$2"
    mkdir -p "$(dirname "$ENV_FILE")"
    touch "$ENV_FILE"
    if grep -qE "^${key}=" "$ENV_FILE"; then
        sed -i "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
    else
        printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
    fi
}

primary_ip() {
    local ip=""
    ip=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i <= NF; i++) if ($i == "src") { print $(i + 1); exit }}')
    if [[ -z "$ip" ]]; then
        ip=$(hostname -I 2>/dev/null | awk '{print $1}')
    fi
    printf '%s' "${ip:-127.0.0.1}"
}

arch_name() {
    case "$(uname -m)" in
        x86_64|amd64) echo "amd64" ;;
        aarch64|arm64) echo "arm64" ;;
        armv7l|armv7) echo "armv7" ;;
        *) echo "" ;;
    esac
}

download_livekit() {
    local arch
    arch=$(arch_name)
    if [[ -z "$arch" ]]; then
        echo "  Unsupported architecture for LiveKit: $(uname -m)"
        return 1
    fi
    local url="https://github.com/livekit/livekit/releases/download/v${LIVEKIT_VERSION}/livekit_${LIVEKIT_VERSION}_linux_${arch}.tar.gz"
    local temp_dir
    temp_dir=$(mktemp -d)
    echo "  Downloading LiveKit ${LIVEKIT_VERSION} (${arch})..."
    if ! curl -fsSL --retry 3 --connect-timeout 10 --max-time 240 "$url" -o "$temp_dir/livekit.tar.gz"; then
        rm -rf "$temp_dir"
        echo "  Could not download LiveKit. Video conference rooms will stay disabled until it is installed."
        return 1
    fi
    if ! tar -xzf "$temp_dir/livekit.tar.gz" -C "$temp_dir" livekit-server 2>/dev/null; then
        # Some releases unpack the binary at the archive root with a different
        # layout; find it before giving up.
        tar -xzf "$temp_dir/livekit.tar.gz" -C "$temp_dir" 2>/dev/null || true
    fi
    if [[ ! -f "$temp_dir/livekit-server" ]]; then
        rm -rf "$temp_dir"
        echo "  The LiveKit archive did not contain livekit-server."
        return 1
    fi
    install -m 0755 "$temp_dir/livekit-server" "$LIVEKIT_BIN"
    rm -rf "$temp_dir"
    echo "  LiveKit installed at $LIVEKIT_BIN"
}

if [[ ! -x "$LIVEKIT_BIN" ]]; then
    download_livekit || exit 0
fi

mkdir -p "$LIVEKIT_DIR" "$(dirname "$LIVEKIT_CONFIG")"
if ! id -u "$LIVEKIT_USER" >/dev/null 2>&1; then
    useradd -r -s /sbin/nologin -d "$LIVEKIT_DIR" -c "Sokrat LiveKit SFU" "$LIVEKIT_USER"
fi
chown -R "$LIVEKIT_USER:$LIVEKIT_USER" "$LIVEKIT_DIR" 2>/dev/null || true

API_KEY=$(env_value LIVEKIT_API_KEY)
API_SECRET=$(env_value LIVEKIT_API_SECRET)
if [[ -z "$API_KEY" || -z "$API_SECRET" ]]; then
    API_KEY="sokrat$(openssl rand -hex 4)"
    API_SECRET=$(openssl rand -hex 32)
fi

PUBLIC_URL="${LIVEKIT_PUBLIC_URL:-${LIVEKIT_URL:-$(env_value LIVEKIT_URL)}}"
if [[ -z "$PUBLIC_URL" ]]; then
    PUBLIC_URL="ws://$(primary_ip):${LIVEKIT_PORT}"
fi

cat > "$LIVEKIT_CONFIG" <<EOF
port: ${LIVEKIT_PORT}
bind_addresses:
  - "0.0.0.0"
rtc:
  tcp_port: ${LIVEKIT_TCP_PORT}
  port_range_start: ${LIVEKIT_UDP_PORT}
  port_range_end: ${LIVEKIT_UDP_PORT}
  use_external_ip: false
keys:
  ${API_KEY}: ${API_SECRET}
EOF
chown root:"$LIVEKIT_USER" "$LIVEKIT_CONFIG" 2>/dev/null || true
chmod 0640 "$LIVEKIT_CONFIG"

set_env_value LIVEKIT_URL "$PUBLIC_URL"
set_env_value LIVEKIT_API_KEY "$API_KEY"
set_env_value LIVEKIT_API_SECRET "$API_SECRET"
set_env_value LIVEKIT_TOKEN_TTL "7200"

cat > /etc/systemd/system/sokrat-livekit.service <<'UNIT'
[Unit]
Description=Sokrat LiveKit Video SFU
After=network.target
Wants=network.target

[Service]
Type=simple
User=sokrat-livekit
Group=sokrat-livekit
WorkingDirectory=/opt/sokrat-livekit
ExecStart=/usr/local/bin/livekit-server --config /etc/sokrat/livekit.yaml
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable sokrat-livekit >/dev/null 2>&1 || true
systemctl restart sokrat-livekit

# Local firewalls are disabled by the main installer, but keep this idempotent
# for installations that use firewalld.
if command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active --quiet firewalld 2>/dev/null; then
    firewall-cmd --permanent --add-port="${LIVEKIT_PORT}/tcp" >/dev/null 2>&1 || true
    firewall-cmd --permanent --add-port="${LIVEKIT_TCP_PORT}/tcp" >/dev/null 2>&1 || true
    firewall-cmd --permanent --add-port="${LIVEKIT_UDP_PORT}/udp" >/dev/null 2>&1 || true
    firewall-cmd --reload >/dev/null 2>&1 || true
fi

if systemctl is-active --quiet sokrat-livekit; then
    echo "  LiveKit SFU running on port ${LIVEKIT_PORT} (RTC ${LIVEKIT_TCP_PORT}/tcp, ${LIVEKIT_UDP_PORT}/udp)"
    echo "  LiveKit public URL: ${PUBLIC_URL}"
    echo "  For internet deployments, put LiveKit behind a CA-signed WSS/TURN endpoint and set LIVEKIT_URL."
else
    echo "  WARNING: LiveKit service did not start. Check /etc/sokrat/livekit.yaml and journalctl -u sokrat-livekit."
fi
