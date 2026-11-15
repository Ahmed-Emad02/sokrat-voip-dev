#!/usr/bin/env bash
# Snapshot and restore the local SIM-first dongle-mapping rollout.
#
# This script never edits Asterisk or the database unless the caller explicitly
# runs the restore action and confirms it. It is designed so a rollout can be
# reverted at any time:
#
#   scripts/revert-dongle-mapping.sh snapshot pre-rollout
#   ... deploy/test ...
#   scripts/revert-dongle-mapping.sh list
#   scripts/revert-dongle-mapping.sh restore --latest --yes
#
# Add --drop-schema to remove sim_inventory and gsm_dongles.mapping_override.
# Without it, those additive schema objects are left in place for a later retry.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_ROOT="${SOKRAT_DONGLE_MAPPING_BACKUP_ROOT:-/var/backups/sokrat-dongle-mapping}"
SERVICE_NAME="${SOKRAT_SERVICE_NAME:-sokrat-voip}"
DB_NAME="${DB_NAME:-asterisk}"

REPO_FILES=(
    "server.js"
    "lib/dongle-mapping.js"
    "lib/sms-index.js"
    "test/dongle-mapping.test.js"
    "test/sms-index.test.js"
    "test/installer-and-schema.test.js"
    "backend/install_db.sql"
    "install.sh"
    "installer-bundle/install-sokrat.sh"
    "installer-bundle/binaries/chan_dongle.so"
    "asterisk/chan_dongle.patch"
    "dongle.conf"
    "scripts/safe-upgrade.sh"
)

DRIVER_MODULES=(
    "/usr/lib64/asterisk/modules/chan_dongle.so"
    "/usr/lib/asterisk/modules/chan_dongle.so"
)

SYSTEM_FILES=(
    "/etc/asterisk/extensions_custom.conf"
    "/etc/asterisk/dongle.conf"
    "${DRIVER_MODULES[@]}"
)

ASTDB_FAMILIES=(
    "dongle_map"
    "sim_map"
    "DONGLE_NUMBERS"
    "DONGLE_SETTINGS"
    "DONGLE_DEVICE_MAP"
)

usage() {
    cat <<'EOF'
Usage:
  revert-dongle-mapping.sh snapshot [label]
  revert-dongle-mapping.sh list
  revert-dongle-mapping.sh restore [backup-dir] [options]

Options for restore:
  --latest             Use the newest snapshot under the backup root.
  --yes                Required to perform the restore.
  --dry-run            Print actions without changing anything.
  --skip-files         Do not restore source/config files.
  --skip-db            Do not restore gsm_dongles/sim_inventory data.
  --skip-astdb         Do not restore Asterisk AstDB families.
  --drop-schema        Drop sim_inventory and gsm_dongles.mapping_override.
  --no-restart         Do not restart sokrat-voip, Asterisk, or reload dialplan.

Restoring a snapshot that contains chan_dongle.so restarts Asterisk, because a
module binary cannot be replaced safely by module reload alone.

Environment:
  SOKRAT_DONGLE_MAPPING_BACKUP_ROOT   Backup root (default /var/backups/sokrat-dongle-mapping)
  SOKRAT_SERVICE_NAME                 systemd service (default sokrat-voip)
  DB_NAME                             Database name (default asterisk)

The script reads DB_HOST, DB_USER and DB_PASS from /opt/sokrat-voip/.env when
present. It never prints credentials.
EOF
}

require_root() {
    if [[ "${EUID}" -ne 0 ]]; then
        echo "This operation must run as root." >&2
        exit 1
    fi
}

load_db_credentials() {
    if [[ -f "$ROOT_DIR/.env" ]]; then
        set -a
        set +u
        # shellcheck disable=SC1091
        . "$ROOT_DIR/.env"
        set -u
        set +a
    fi
    DB_HOST="${DB_HOST:-localhost}"
    DB_USER="${DB_USER:-root}"
    if [[ -z "${DB_PASS:-}" && -f /etc/issabel.conf ]]; then
        DB_USER="${DB_USER:-root}"
        DB_PASS="$(grep -m1 '^mysqlrootpwd' /etc/issabel.conf 2>/dev/null | cut -d= -f2- | xargs || true)"
    fi
    export MYSQL_PWD="${DB_PASS:-}"
}

mysql_cmd() {
    mysql --connect-timeout=5 -h "$DB_HOST" -u "$DB_USER" "$@"
}

table_exists() {
    local table="$1"
    local count
    count="$(mysql_cmd -Nse "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='$DB_NAME' AND TABLE_NAME='$table'" 2>/dev/null || echo 0)"
    [[ "$count" = "1" ]]
}

asterisk_alive() {
    command -v asterisk >/dev/null 2>&1 && asterisk -rx 'core show version' >/dev/null 2>&1
}

snapshot_file() {
    local source="$1"
    local destination="$2"
    if [[ -e "$source" ]]; then
        mkdir -p "$(dirname "$destination")"
        cp -a "$source" "$destination"
    else
        mkdir -p "$(dirname "$destination")"
        : > "${destination}.absent"
    fi
}

snapshot() {
    local label="${1:-manual}"
    require_root
    load_db_credentials

    local timestamp backup_dir
    timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
    backup_dir="$BACKUP_ROOT/${timestamp}-${label//[^A-Za-z0-9_.-]/_}"
    mkdir -p "$backup_dir/files" "$backup_dir/astdb"

    {
        echo "created_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
        echo "label=$label"
        echo "repo=$ROOT_DIR"
        echo "git_commit=$(git -C "$ROOT_DIR" rev-parse HEAD 2>/dev/null || echo unknown)"
        echo "db_name=$DB_NAME"
    } > "$backup_dir/manifest"

    local relative
    for relative in "${REPO_FILES[@]}"; do
        snapshot_file "$ROOT_DIR/$relative" "$backup_dir/files/$relative"
    done
    local absolute
    for absolute in "${SYSTEM_FILES[@]}"; do
        snapshot_file "$absolute" "$backup_dir/files$absolute"
    done

    if command -v mysqldump >/dev/null 2>&1; then
        local tables=("gsm_dongles")
        if table_exists "sim_inventory"; then
            tables+=("sim_inventory")
            : > "$backup_dir/sim_inventory.present"
        fi
        mysqldump --single-transaction --no-create-info --skip-triggers \
            -h "$DB_HOST" -u "$DB_USER" "$DB_NAME" "${tables[@]}" > "$backup_dir/db-data.sql"
        echo "db_tables=${tables[*]}" >> "$backup_dir/manifest"
    else
        echo "db_tables=mysqldump-unavailable" >> "$backup_dir/manifest"
    fi

    if asterisk_alive; then
        local family
        for family in "${ASTDB_FAMILIES[@]}"; do
            asterisk -rx "database show $family" > "$backup_dir/astdb/$family.txt" 2>/dev/null || true
        done
        echo "astdb=snapshotted" >> "$backup_dir/manifest"
    else
        echo "astdb=asterisk-unavailable" >> "$backup_dir/manifest"
    fi

    echo "$backup_dir" > "$BACKUP_ROOT/latest"
    echo "Snapshot created: $backup_dir"
}

list_snapshots() {
    if [[ ! -d "$BACKUP_ROOT" ]]; then
        echo "No snapshots under $BACKUP_ROOT"
        return 0
    fi
    find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' 2>/dev/null | sort -r
}

latest_snapshot() {
    if [[ -f "$BACKUP_ROOT/latest" ]]; then
        local latest
        latest="$(cat "$BACKUP_ROOT/latest")"
        if [[ -d "$latest" ]]; then
            echo "$latest"
            return 0
        fi
    fi
    find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -printf '%p\n' 2>/dev/null | sort -r | head -n 1
}

restore_file() {
    local source="$1"
    local target="$2"
    if [[ -e "${source}.absent" ]]; then
        rm -f "$target"
        echo "  remove $target"
    elif [[ -e "$source" ]]; then
        mkdir -p "$(dirname "$target")"
        cp -a "$source" "$target"
        echo "  restore $target"
    else
        echo "  warning: snapshot missing $source; leaving $target unchanged" >&2
    fi
}

restore_astdb() {
    local backup_dir="$1"
    if ! asterisk_alive; then
        echo "  Asterisk is not reachable; skipping AstDB restore." >&2
        return 1
    fi
    local family file line key value
    for family in "${ASTDB_FAMILIES[@]}"; do
        file="$backup_dir/astdb/$family.txt"
        [[ -f "$file" ]] || continue
        asterisk -rx "database deltree $family" >/dev/null 2>&1 || true
        while IFS= read -r line; do
            [[ "$line" == *"/$family/"* ]] || continue
            key="${line#*/$family/}"
            key="${key%%[[:space:]]*}"
            value="${line#*: }"
            value="${value#"${value%%[![:space:]]*}"}"
            [[ "$key" =~ ^[A-Za-z0-9_:+.-]+$ ]] || continue
            [[ "$value" =~ ^[A-Za-z0-9_:+.-]+$ ]] || continue
            asterisk -rx "database put $family $key $value" >/dev/null 2>&1 || true
        done < "$file"
        echo "  restore AstDB $family"
    done
}

restore_db() {
    local backup_dir="$1"
    local dump="$backup_dir/db-data.sql"
    if [[ ! -s "$dump" ]]; then
        echo "  no database dump in snapshot; skipping DB restore." >&2
        return 0
    fi
    local has_inventory=0
    if [[ -f "$backup_dir/sim_inventory.present" ]] || grep -q 'INSERT INTO `sim_inventory`' "$dump"; then
        has_inventory=1
    fi
    mysql_cmd -e "SET FOREIGN_KEY_CHECKS=0; DELETE FROM \`$DB_NAME\`.\`gsm_dongles\`;" 2>/dev/null || true
    if [[ "$has_inventory" -eq 1 ]]; then
        mysql_cmd -e "SET FOREIGN_KEY_CHECKS=0; DELETE FROM \`$DB_NAME\`.\`sim_inventory\`;" 2>/dev/null || true
    fi
    mysql_cmd "$DB_NAME" < "$dump"
    echo "  restore gsm_dongles"
    if [[ "$has_inventory" -eq 1 ]]; then
        echo "  restore sim_inventory"
    fi
}

drop_schema() {
    load_db_credentials
    mysql_cmd -e "ALTER TABLE \`$DB_NAME\`.\`gsm_dongles\` DROP COLUMN \`mapping_override\`;" 2>/dev/null || true
    mysql_cmd -e "DROP TABLE IF EXISTS \`$DB_NAME\`.\`sim_inventory\`;" 2>/dev/null || true
    echo "  dropped sim_inventory and gsm_dongles.mapping_override"
}

restore() {
    local backup_dir=""
    local assume_yes=0
    local dry_run=0
    local skip_files=0
    local skip_db=0
    local skip_astdb=0
    local drop_new_schema=0
    local no_restart=0
    local driver_restored=0

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --latest) backup_dir="$(latest_snapshot)"; shift ;;
            --yes) assume_yes=1; shift ;;
            --dry-run) dry_run=1; shift ;;
            --skip-files) skip_files=1; shift ;;
            --skip-db) skip_db=1; shift ;;
            --skip-astdb) skip_astdb=1; shift ;;
            --drop-schema) drop_new_schema=1; shift ;;
            --no-restart) no_restart=1; shift ;;
            -*)
                echo "Unknown restore option: $1" >&2
                usage
                exit 2
                ;;
            *)
                if [[ -n "$backup_dir" ]]; then
                    echo "Unexpected extra argument: $1" >&2
                    exit 2
                fi
                backup_dir="$1"
                shift
                ;;
        esac
    done

    if [[ -z "$backup_dir" ]]; then
        backup_dir="$(latest_snapshot)"
    fi
    if [[ -z "$backup_dir" || ! -d "$backup_dir" ]]; then
        echo "Snapshot not found. Run '$0 list'." >&2
        exit 1
    fi

    require_root
    load_db_credentials

    echo "Snapshot: $backup_dir"
    [[ -f "$backup_dir/manifest" ]] && cat "$backup_dir/manifest"
    echo "Planned restore:"

    if [[ "$dry_run" -eq 1 ]]; then
        [[ "$skip_files" -eq 0 ]] && echo "  files: restore repository files and /etc/asterisk config"
        [[ "$skip_db" -eq 0 ]] && echo "  database: restore gsm_dongles and sim_inventory data"
        [[ "$skip_astdb" -eq 0 ]] && echo "  AstDB: restore ${ASTDB_FAMILIES[*]}"
        [[ "$drop_new_schema" -eq 1 ]] && echo "  schema: drop sim_inventory and mapping_override"
        echo "Dry run only; nothing changed."
        return 0
    fi

    if [[ "$assume_yes" -ne 1 ]]; then
        echo "Refusing to restore without --yes."
        exit 1
    fi

    if [[ "$skip_files" -eq 0 ]]; then
        local snapshot_bundle="$backup_dir/files/installer-bundle/binaries/chan_dongle.so"
        if [[ -e "$snapshot_bundle" ]] && ! cmp -s "$snapshot_bundle" "$ROOT_DIR/installer-bundle/binaries/chan_dongle.so"; then
            driver_restored=1
        fi
        local module_path snapshot_module
        for module_path in "${DRIVER_MODULES[@]}"; do
            snapshot_module="$backup_dir/files$module_path"
            if [[ -e "$snapshot_module" ]]; then
                if [[ ! -e "$module_path" ]] || ! cmp -s "$snapshot_module" "$module_path"; then
                    driver_restored=1
                fi
            elif [[ -e "${snapshot_module}.absent" && -e "$module_path" ]]; then
                driver_restored=1
            fi
        done
        local relative absolute
        for relative in "${REPO_FILES[@]}"; do
            restore_file "$backup_dir/files/$relative" "$ROOT_DIR/$relative"
        done
        for absolute in "${SYSTEM_FILES[@]}"; do
            restore_file "$backup_dir/files$absolute" "$absolute"
        done
    fi

    if [[ "$skip_db" -eq 0 ]]; then
        restore_db "$backup_dir"
    fi
    if [[ "$skip_astdb" -eq 0 ]]; then
        restore_astdb "$backup_dir" || true
    fi
    if [[ "$drop_new_schema" -eq 1 ]]; then
        drop_schema
    fi

    if [[ "$no_restart" -eq 0 ]]; then
        if systemctl list-unit-files | grep -q "^${SERVICE_NAME}\.service"; then
            systemctl restart "$SERVICE_NAME"
            echo "  restarted $SERVICE_NAME"
        fi
        if [[ "$driver_restored" -eq 1 ]]; then
            if systemctl list-unit-files | grep -q '^asterisk\.service'; then
                systemctl restart asterisk
                echo "  restarted asterisk to load the restored chan_dongle binary"
            else
                echo "  warning: chan_dongle was restored but asterisk.service was not found; restart Asterisk manually." >&2
            fi
        elif asterisk_alive; then
            asterisk -rx 'dialplan reload' >/dev/null 2>&1 || true
            echo "  reloaded Asterisk dialplan"
        fi
    fi

    echo "Restore complete."
}

main() {
    local action="${1:-help}"
    shift || true
    case "$action" in
        snapshot) snapshot "${1:-manual}" ;;
        list) list_snapshots ;;
        restore) restore "$@" ;;
        help|-h|--help) usage ;;
        *) usage; exit 2 ;;
    esac
}

main "$@"
