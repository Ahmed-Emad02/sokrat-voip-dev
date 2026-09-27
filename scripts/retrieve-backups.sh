#!/bin/bash
# ==============================================================================
# Sokrat VoIP — Safe Backup Retrieval & Export Script
# Target: Issabel 5 / Asterisk 18 servers running sokrat-voip
# ==============================================================================
# Usage:
#   1. Local bundling (saves to /opt/sokrat-voip/backups/):
#        bash scripts/retrieve-backups.sh
#   2. Remote 1-liner streaming directly to local machine:
#        ssh root@<server-ip> "bash /opt/sokrat-voip/scripts/retrieve-backups.sh --stream" > sokrat_backup.tar.gz
#   3. Create fresh snapshot & retrieve:
#        bash scripts/retrieve-backups.sh --create
#   4. List available snapshots:
#        bash scripts/retrieve-backups.sh --list
# ==============================================================================

set -euo pipefail

INSTALL_DIR="/opt/sokrat-voip"
BACKUP_DIR="${INSTALL_DIR}/backups"
MODE="file" # "file", "stream", or "list"
TARGET_SNAPSHOT="latest"
CREATE_FRESH=false
OUTPUT_FILE=""

# Parse command line options
while [[ $# -gt 0 ]]; do
    case "$1" in
        -s|--stream|--stdout)
            MODE="stream"
            shift
            ;;
        -l|--list)
            MODE="list"
            shift
            ;;
        -a|--all)
            TARGET_SNAPSHOT="all"
            shift
            ;;
        -c|--create)
            CREATE_FRESH=true
            shift
            ;;
        -t|--timestamp)
            TARGET_SNAPSHOT="$2"
            shift 2
            ;;
        -o|--output)
            OUTPUT_FILE="$2"
            shift 2
            ;;
        -h|--help)
            cat << 'EOF'
Sokrat VoIP Backup Retrieval Tool

Usage:
  retrieve-backups.sh [OPTIONS]

Options:
  -s, --stream, --stdout    Stream the compressed tarball (.tar.gz) directly to stdout.
                            Ideal for piping over SSH to a remote client.
  -l, --list                List all available snapshot timestamps and files.
  -a, --all                 Bundle all existing snapshots instead of just the latest.
  -c, --create              Create a fresh live snapshot before bundling.
  -t, --timestamp <TS>      Select a specific snapshot by timestamp (YYYYMMDD_HHMMSS).
  -o, --output <file>       Specify output path for the .tar.gz archive (file mode).
  -h, --help                Show this help message.

Examples:
  # Stream latest backup directly to your local workstation:
  ssh root@192.168.100.89 "bash /opt/sokrat-voip/scripts/retrieve-backups.sh --stream" > backup_latest.tar.gz

  # Bundle latest backup locally on the server:
  bash /opt/sokrat-voip/scripts/retrieve-backups.sh

  # Create a fresh snapshot right now and bundle it:
  bash /opt/sokrat-voip/scripts/retrieve-backups.sh --create
EOF
            exit 0
            ;;
        *)
            echo "Unknown option: $1" >&2
            echo "Use --help for usage instructions." >&2
            exit 1
            ;;
    esac
done

# Safe logger: in stream mode, write to stderr so stdout remains a clean binary stream
log() {
    if [ "$MODE" = "stream" ]; then
        echo "$@" >&2
    else
        echo "$@"
    fi
}

detect_mysql_auth() {
    local pwd
    pwd=$(grep mysqlrootpwd /etc/issabel.conf 2>/dev/null | cut -d= -f2- | xargs || true)
    if [ -z "$pwd" ]; then
        pwd=$(grep AMPDBPASS /etc/amportal.conf 2>/dev/null | cut -d= -f2- | xargs || true)
    fi

    if [ -n "$pwd" ] && mysql -u root -p"$pwd" -e "SELECT 1;" >/dev/null 2>&1; then
        echo "-u root -p$pwd"
    elif mysql -u root -padmin -e "SELECT 1;" >/dev/null 2>&1; then
        echo "-u root -padmin"
    elif mysql -e "SELECT 1;" >/dev/null 2>&1; then
        echo ""
    else
        echo "-u root"
    fi
}

create_live_snapshot() {
    local ts
    ts=$(date +%Y%m%d_%H%M%S)
    log "Creating fresh snapshot [${ts}]..."
    mkdir -p "$BACKUP_DIR"

    if [ -f /etc/asterisk/extensions_custom.conf ]; then
        cp -a /etc/asterisk/extensions_custom.conf "${BACKUP_DIR}/extensions_custom.conf.bak_${ts}"
        log "  Backed up extensions_custom.conf"
    fi

    if [ -f /etc/asterisk/dongle.conf ]; then
        cp -a /etc/asterisk/dongle.conf "${BACKUP_DIR}/dongle.conf.bak_${ts}"
        log "  Backed up dongle.conf"
    fi

    local auth_str
    auth_str=$(detect_mysql_auth)
    local auth_arr=()
    read -r -a auth_arr <<< "$auth_str"

    if command -v mysqldump &>/dev/null; then
        mysqldump "${auth_arr[@]}" --single-transaction --routines --triggers asterisk > "${BACKUP_DIR}/asterisk_pbx.bak_${ts}.sql" 2>/dev/null || true
        mysqldump "${auth_arr[@]}" --single-transaction asteriskcdrdb > "${BACKUP_DIR}/asterisk_cdr.bak_${ts}.sql" 2>/dev/null || true
        log "  Created MariaDB database snapshots (asterisk & asteriskcdrdb)"
    fi
}

# Ensure backup directory exists
mkdir -p "$BACKUP_DIR"

# Check if fresh creation requested
if [ "$CREATE_FRESH" = true ]; then
    create_live_snapshot
fi

# Discover available snapshots
get_all_snapshots() {
    find "$BACKUP_DIR" -maxdepth 1 -type f -name "*.bak_*" 2>/dev/null \
        | grep -oE '[0-9]{8}_[0-9]{6}' \
        | sort -u
}

AVAILABLE_SNAPSHOTS=()
while IFS= read -r s; do
    if [ -n "$s" ]; then
        AVAILABLE_SNAPSHOTS+=("$s")
    fi
done < <(get_all_snapshots)

if [ ${#AVAILABLE_SNAPSHOTS[@]} -eq 0 ]; then
    log "Notice: No existing snapshots found in ${BACKUP_DIR}."
    create_live_snapshot
    while IFS= read -r s; do
        if [ -n "$s" ]; then
            AVAILABLE_SNAPSHOTS+=("$s")
        fi
    done < <(get_all_snapshots)
fi

if [ ${#AVAILABLE_SNAPSHOTS[@]} -eq 0 ]; then
    echo "ERROR: Unable to locate or create backup snapshots." >&2
    exit 1
fi

LATEST_SNAPSHOT="${AVAILABLE_SNAPSHOTS[${#AVAILABLE_SNAPSHOTS[@]}-1]}"

# Handle --list mode
if [ "$MODE" = "list" ]; then
    echo "========================================================"
    echo " 📦 Sokrat VoIP Available Backup Snapshots"
    echo " Location: ${BACKUP_DIR}"
    echo "========================================================"
    printf "%-4s %-20s %-12s %s\n" "No." "Timestamp" "Files" "Total Size"
    echo "--------------------------------------------------------"
    idx=1
    for snap in "${AVAILABLE_SNAPSHOTS[@]}"; do
        files=($(find "$BACKUP_DIR" -maxdepth 1 -type f -name "*.bak_${snap}*" -exec basename {} \;))
        total_size=$(find "$BACKUP_DIR" -maxdepth 1 -type f -name "*.bak_${snap}*" -exec du -ch {} + | grep total$ | cut -f1)
        is_latest=""
        if [ "$snap" = "$LATEST_SNAPSHOT" ]; then
            is_latest=" (latest)"
        fi
        printf "%-4d %-20s %-12d %s%s\n" "$idx" "$snap" "${#files[@]}" "$total_size" "$is_latest"
        ((idx++))
    done
    echo "========================================================"
    exit 0
fi

# Determine files to include
FILES_TO_PACK=()
CHOSEN_LABEL=""

if [ "$TARGET_SNAPSHOT" = "all" ]; then
    CHOSEN_LABEL="all_snapshots"
    while IFS= read -r f; do
        if [ -n "$f" ]; then
            FILES_TO_PACK+=("$(basename "$f")")
        fi
    done < <(find "$BACKUP_DIR" -maxdepth 1 -type f -name "*.bak_*" 2>/dev/null)
elif [ "$TARGET_SNAPSHOT" = "latest" ]; then
    CHOSEN_LABEL="${LATEST_SNAPSHOT}"
    while IFS= read -r f; do
        if [ -n "$f" ]; then
            FILES_TO_PACK+=("$(basename "$f")")
        fi
    done < <(find "$BACKUP_DIR" -maxdepth 1 -type f -name "*.bak_${LATEST_SNAPSHOT}*" 2>/dev/null)
else
    CHOSEN_LABEL="${TARGET_SNAPSHOT}"
    while IFS= read -r f; do
        if [ -n "$f" ]; then
            FILES_TO_PACK+=("$(basename "$f")")
        fi
    done < <(find "$BACKUP_DIR" -maxdepth 1 -type f -name "*.bak_${TARGET_SNAPSHOT}*" 2>/dev/null)
fi

if [ ${#FILES_TO_PACK[@]} -eq 0 ]; then
    echo "ERROR: No backup files matched snapshot filter: ${TARGET_SNAPSHOT}" >&2
    exit 1
fi

# Stream mode (pipe directly to stdout)
if [ "$MODE" = "stream" ]; then
    log "Streaming backup archive [${CHOSEN_LABEL}] (${#FILES_TO_PACK[@]} files)..."
    tar -czf - -C "$BACKUP_DIR" "${FILES_TO_PACK[@]}"
    log "Stream complete."
    exit 0
fi

# File mode (create compressed archive on disk)
if [ -z "$OUTPUT_FILE" ]; then
    OUTPUT_FILE="${BACKUP_DIR}/sokrat_backup_${CHOSEN_LABEL}.tar.gz"
fi

log "========================================================"
log " 📦 Sokrat VoIP Backup Packager"
log " Snapshot: ${CHOSEN_LABEL}"
log "========================================================"
log "Packing ${#FILES_TO_PACK[@]} files into ${OUTPUT_FILE}..."

tar -czf "$OUTPUT_FILE" -C "$BACKUP_DIR" "${FILES_TO_PACK[@]}"

# Symlink latest if packaging latest
if [ "$CHOSEN_LABEL" = "$LATEST_SNAPSHOT" ]; then
    LATEST_LINK="${BACKUP_DIR}/sokrat_backup_latest.tar.gz"
    ln -sf "$OUTPUT_FILE" "$LATEST_LINK"
fi

# Generate SHA256 checksum
SHA_FILE="${OUTPUT_FILE}.sha256"
(cd "$(dirname "$OUTPUT_FILE")" && sha256sum "$(basename "$OUTPUT_FILE")" > "$(basename "$SHA_FILE")")

ARCHIVE_SIZE=$(du -h "$OUTPUT_FILE" | cut -f1)
log "Archive created successfully!"
log "  File:     ${OUTPUT_FILE}"
log "  Size:     ${ARCHIVE_SIZE}"
log "  Checksum: $(cat "$SHA_FILE" | cut -d' ' -f1)"
log ""
log "Contents:"
for f in "${FILES_TO_PACK[@]}"; do
    file_size=$(du -h "${BACKUP_DIR}/${f}" | cut -f1)
    log "  - ${f} (${file_size})"
done

SERVER_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "<server-ip>")

log ""
log "--------------------------------------------------------"
log " 🚀 How to retrieve this backup from another machine:"
log "--------------------------------------------------------"
log " Option 1: Direct 1-liner SSH stream (No temp file on client):"
log "   ssh root@${SERVER_IP} \"bash /opt/sokrat-voip/scripts/retrieve-backups.sh --stream\" > sokrat_backup_${CHOSEN_LABEL}.tar.gz"
log ""
log " Option 2: Secure Copy (SCP):"
log "   scp root@${SERVER_IP}:${OUTPUT_FILE} ./"
log "========================================================"
