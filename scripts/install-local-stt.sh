#!/usr/bin/env bash
# Install the offline whisper.cpp runtime used by Sokrat VoIP.
# Inference remains entirely on the PBX after this one-time installation.
set -euo pipefail

WHISPER_VERSION="${WHISPER_VERSION:-v1.9.5}"
WHISPER_DIR="${WHISPER_DIR:-/opt/sokrat-stt/whisper.cpp}"
STATE_DIR="${STT_STATE_DIR:-/var/lib/sokrat-stt}"
MODEL_NAME="${STT_MODEL_NAME:-ggml-small-q5_1.bin}"
MODEL_SHA256="${STT_MODEL_SHA256:-ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb}"
MODEL_URL="${STT_MODEL_URL:-https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL_NAME}}"
VAD_NAME="${STT_VAD_NAME:-ggml-silero-v6.2.0.bin}"
VAD_SHA256="${STT_VAD_SHA256:-2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987}"
VAD_URL="${STT_VAD_URL:-https://huggingface.co/ggml-org/whisper-vad/resolve/main/${VAD_NAME}}"
ENV_DIR="${STT_ENV_DIR:-/etc/sokrat-voip}"
ENV_FILE="${STT_ENV_FILE:-${ENV_DIR}/stt.env}"
ENABLE_STT_WORKER="${ENABLE_STT_WORKER:-1}"

if [[ "${EUID}" -ne 0 ]]; then
    echo "This installer must run as root." >&2
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
BUNDLE_DIR="$(cd "$SCRIPT_DIR/../installer-bundle" 2>/dev/null && pwd)"

for command in sha256sum lscpu base64 tar; do
    command -v "$command" >/dev/null || { echo "Missing required command: $command" >&2; exit 1; }
done

if ! id asterisk >/dev/null 2>&1; then
    echo "The asterisk service account does not exist." >&2
    exit 1
fi

# 1. Install or compile whisper runtime
install -d -m 0755 "$(dirname "$WHISPER_DIR")"
WHISPER_BUNDLE=""
for cand_wb in "$BUNDLE_DIR/binaries/whisper-bin.tar.gz" "/opt/sokrat-voip/installer-bundle/binaries/whisper-bin.tar.gz" "/tmp/installer-bundle/binaries/whisper-bin.tar.gz"; do
    if [[ -f "$cand_wb" ]]; then
        WHISPER_BUNDLE="$cand_wb"
        break
    fi
done

if [[ -n "$WHISPER_BUNDLE" ]]; then
    echo "  Installing pre-compiled whisper.cpp runtime from offline bundle ($WHISPER_BUNDLE)..."
    install -d -m 0755 "$WHISPER_DIR/build-sokrat/bin"
    install -d -m 0755 "$WHISPER_DIR/build-gcc12/bin"
    tar -xzf "$WHISPER_BUNDLE" -C "$WHISPER_DIR/build-sokrat/bin"
    cp -a "$WHISPER_DIR/build-sokrat/bin/." "$WHISPER_DIR/build-gcc12/bin/" 2>/dev/null || true
    chmod 0755 "$WHISPER_DIR/build-sokrat/bin/whisper-"* "$WHISPER_DIR/build-gcc12/bin/whisper-"* 2>/dev/null || true
elif [[ -x "$WHISPER_DIR/build-sokrat/bin/whisper-server" ]] || [[ -x "$WHISPER_DIR/build-gcc12/bin/whisper-server" ]]; then
    echo "  Whisper runtime already compiled at $WHISPER_DIR"
else
    echo "  Offline bundle not found, falling back to online compilation..."
    dnf install -y cmake git curl gcc-toolset-12-gcc gcc-toolset-12-gcc-c++ 2>/dev/null || yum install -y cmake git curl gcc-toolset-12-gcc gcc-toolset-12-gcc-c++ || true
    if [[ ! -d "$WHISPER_DIR/.git" ]]; then
        git clone --branch "$WHISPER_VERSION" --depth 1 https://github.com/ggml-org/whisper.cpp.git "$WHISPER_DIR"
    fi
    git -C "$WHISPER_DIR" fetch --tags --depth 1 origin "$WHISPER_VERSION" 2>/dev/null || true
    git -C "$WHISPER_DIR" checkout --detach "$WHISPER_VERSION" 2>/dev/null || true

    source /opt/rh/gcc-toolset-12/enable 2>/dev/null || true
    if grep -qw avx2 /proc/cpuinfo && grep -qw fma /proc/cpuinfo; then
        ggml_avx2=ON
        ggml_fma=ON
    else
        ggml_avx2=OFF
        ggml_fma=OFF
    fi
    if grep -qw bmi2 /proc/cpuinfo; then ggml_bmi2=ON; else ggml_bmi2=OFF; fi
    cmake -S "$WHISPER_DIR" -B "$WHISPER_DIR/build-sokrat" \
        -DCMAKE_BUILD_TYPE=Release \
        -DGGML_NATIVE=OFF \
        -DGGML_AVX=ON \
        -DGGML_AVX2="$ggml_avx2" \
        -DGGML_FMA="$ggml_fma" \
        -DGGML_F16C=ON \
        -DGGML_BMI2="$ggml_bmi2" \
        -DWHISPER_BUILD_TESTS=OFF \
        -DWHISPER_BUILD_EXAMPLES=ON
    cmake --build "$WHISPER_DIR/build-sokrat" --target whisper-server whisper-cli -j2
fi

# Ensure both paths exist for systemd service compatibility
if [[ -d "$WHISPER_DIR/build-sokrat/bin" ]] && [[ ! -d "$WHISPER_DIR/build-gcc12/bin" ]]; then
    mkdir -p "$WHISPER_DIR/build-gcc12"
    ln -s "$WHISPER_DIR/build-sokrat/bin" "$WHISPER_DIR/build-gcc12/bin" 2>/dev/null || cp -a "$WHISPER_DIR/build-sokrat/bin" "$WHISPER_DIR/build-gcc12/bin"
elif [[ -d "$WHISPER_DIR/build-gcc12/bin" ]] && [[ ! -d "$WHISPER_DIR/build-sokrat/bin" ]]; then
    mkdir -p "$WHISPER_DIR/build-sokrat"
    ln -s "$WHISPER_DIR/build-gcc12/bin" "$WHISPER_DIR/build-sokrat/bin" 2>/dev/null || cp -a "$WHISPER_DIR/build-gcc12/bin" "$WHISPER_DIR/build-sokrat/bin"
fi

# 2. Install or unpack offline models
install -d -o asterisk -g asterisk -m 0750 "$STATE_DIR/models" "$STATE_DIR/tmp"

# Check if models can be unpacked from offline bundle
if ! [[ -s "$STATE_DIR/models/$MODEL_NAME" && -s "$STATE_DIR/models/$VAD_NAME" ]]; then
    STT_MODEL_CHUNKS=""
    for cand_chunk in "$BUNDLE_DIR" "/opt/sokrat-voip/installer-bundle" "/tmp/installer-bundle"; do
        if ls "$cand_chunk"/sokrat-stt-models.tar.gz.part-* 1>/dev/null 2>&1; then
            STT_MODEL_CHUNKS="$cand_chunk"
            break
        fi
    done
    if [[ -n "$STT_MODEL_CHUNKS" ]]; then
        echo "  Unpacking offline STT voice models from bundle ($STT_MODEL_CHUNKS)..."
        cat "$STT_MODEL_CHUNKS"/sokrat-stt-models.tar.gz.part-* | tar -xz -C "$STATE_DIR/models"
    fi
fi

download_verified() {
    local url="$1" destination="$2" checksum="$3"
    if [[ -s "$destination" ]] && echo "$checksum  $destination" | sha256sum -c - >/dev/null 2>&1; then
        return 0
    fi
    echo "  Downloading $(basename "$destination")..."
    if ! curl -fL --connect-timeout 5 --max-time 120 --retry 2 --output "${destination}.part" "$url" 2>/dev/null; then
        echo "  Notice: Could not download $(basename "$destination") (offline mode or network unavailable)"
        rm -f "${destination}.part" 2>/dev/null || true
        return 1
    fi
    if echo "$checksum  ${destination}.part" | sha256sum -c - >/dev/null 2>&1; then
        mv "${destination}.part" "$destination"
        return 0
    else
        echo "  Checksum mismatch for $(basename "$destination"), removing incomplete download"
        rm -f "${destination}.part" 2>/dev/null || true
        return 1
    fi
}

if ! (echo "$MODEL_SHA256  $STATE_DIR/models/$MODEL_NAME" | sha256sum -c - >/dev/null 2>&1); then
    download_verified "$MODEL_URL" "$STATE_DIR/models/$MODEL_NAME" "$MODEL_SHA256"
fi

if ! (echo "$VAD_SHA256  $STATE_DIR/models/$VAD_NAME" | sha256sum -c - >/dev/null 2>&1); then
    download_verified "$VAD_URL" "$STATE_DIR/models/$VAD_NAME" "$VAD_SHA256"
fi

chown -R asterisk:asterisk "$STATE_DIR/models"
chmod 0640 "$STATE_DIR/models/"*.bin 2>/dev/null || true

DB_USER="${DB_USER:-$(sed -n 's/^AMPDBUSER=//p' /etc/amportal.conf 2>/dev/null | head -n1)}"
DB_HOST="${DB_HOST:-$(sed -n 's/^AMPDBHOST=//p' /etc/amportal.conf 2>/dev/null | head -n1)}"
DB_PASS="${DB_PASS:-$(sed -n 's/^AMPDBPASS=//p' /etc/amportal.conf 2>/dev/null | head -n1)}"
if [[ -z "$DB_USER" || -z "$DB_PASS" ]]; then
    echo "Unable to obtain PBX database credentials from the environment or /etc/amportal.conf." >&2
    exit 1
fi

physical_cores=$(lscpu -p=CORE,SOCKET 2>/dev/null | awk -F, '!/^#/ {print $1 ":" $2}' | sort -u | wc -l)
if (( physical_cores >= 4 )); then
    whisper_threads=2
    whisper_cpu_quota=150
else
    whisper_threads=1
    whisper_cpu_quota=95
fi

install -d -m 0750 "$ENV_DIR"
{
    printf 'DB_HOST=%s\n' "${DB_HOST:-localhost}"
    printf 'DB_USER=%s\n' "$DB_USER"
    printf 'DB_PASS_B64=%s\n' "$(printf '%s' "$DB_PASS" | base64 -w0)"
    printf 'STT_LOCAL_ENDPOINT=http://127.0.0.1:8178/inference\n'
    printf 'STT_LOCAL_TIMEOUT_MS=1800000\n'
    printf 'STT_MAX_ATTEMPTS=3\n'
    printf 'STT_MAX_PENDING_JOBS=20\n'
} > "$ENV_FILE"
chown root:asterisk "$ENV_FILE"
chmod 0640 "$ENV_FILE"

cat > /etc/systemd/system/sokrat-whisper.service <<UNIT
[Unit]
Description=Sokrat Offline Whisper Speech-To-Text Engine
After=network.target

[Service]
Type=simple
User=asterisk
Group=asterisk
WorkingDirectory=$STATE_DIR
ExecStart=$WHISPER_DIR/build-sokrat/bin/whisper-server --host 127.0.0.1 --port 8178 --model $STATE_DIR/models/$MODEL_NAME --threads $whisper_threads --processors 1 --language ar --no-gpu --vad --vad-model $STATE_DIR/models/$VAD_NAME --suppress-nst
Restart=always
RestartSec=5
Nice=19
CPUSchedulingPolicy=idle
IOSchedulingClass=idle
CPUQuota=${whisper_cpu_quota}%
MemoryMax=2G
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=$STATE_DIR

[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/systemd/system/sokrat-stt.service <<UNIT
[Unit]
Description=Sokrat VoIP Offline/Cloud Speech-To-Text Worker
After=network.target mariadb.service mysqld.service asterisk.service sokrat-whisper.service
Wants=asterisk.service sokrat-whisper.service

[Service]
Type=simple
User=asterisk
Group=asterisk
SupplementaryGroups=asterisk
WorkingDirectory=/opt/sokrat-voip
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/node /opt/sokrat-voip/scripts/stt-worker.js
Restart=always
RestartSec=5
Nice=19
CPUSchedulingPolicy=idle
IOSchedulingClass=idle
CPUQuota=25%
MemoryMax=512M
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadOnlyPaths=/var/spool/asterisk/monitor /var/spool/asterisk/voicemail

[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/systemd/system/sokrat-stt-scan.service <<UNIT
[Unit]
Description=Queue recent Sokrat recordings for local transcription
After=mariadb.service mysqld.service

[Service]
Type=oneshot
User=asterisk
Group=asterisk
WorkingDirectory=/opt/sokrat-voip
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/node /opt/sokrat-voip/scripts/enqueue-stt.js scan
Nice=19
CPUSchedulingPolicy=idle
IOSchedulingClass=idle
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadOnlyPaths=/var/spool/asterisk/monitor /var/spool/asterisk/voicemail
UNIT

cat > /etc/systemd/system/sokrat-stt-scan.timer <<'UNIT'
[Unit]
Description=Periodically queue new call recordings and voicemails

[Timer]
OnBootSec=2min
OnUnitActiveSec=1min
AccuracySec=10s
Persistent=true

[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
systemctl enable sokrat-whisper.service sokrat-stt.service sokrat-stt-scan.timer
if [[ "$ENABLE_STT_WORKER" == "1" ]]; then
    systemctl start sokrat-whisper.service sokrat-stt.service sokrat-stt-scan.timer
    echo "Offline Sokrat STT installed and activated with ${whisper_threads} inference thread(s)."
else
    echo "Offline Sokrat STT installed with ${whisper_threads} inference thread(s). Enable it in PBX Settings, then start sokrat-whisper.service, sokrat-stt.service, and sokrat-stt-scan.timer."
fi
