#!/usr/bin/env bash
# Persistent Issabel/FreePBX logging, without changing unrelated logger categories.
# Usage: enable-dongle-logging.sh [--no-reload]
# SOKRAT_ROOT is an offline installation/test root (never a live CLI target).
# Rotation checks size every minute: 250M is a threshold, not a hard disk cap.
set -euo pipefail
umask 077

case "${1:-}" in ""|--no-reload) ;; *) echo "Usage: $0 [--no-reload]" >&2; exit 2;; esac
ROOT="${SOKRAT_ROOT:-}"
AST_DIR="$ROOT/etc/asterisk"
ASTERISK_BIN="${ASTERISK_BIN:-/usr/sbin/asterisk}"
PHP_BIN="${PHP_BIN:-php}"
BOOTSTRAP="${PBX_BOOTSTRAP:-$ROOT/etc/issabelpbx.conf}"
[[ -f "$BOOTSTRAP" ]] || BOOTSTRAP="$ROOT/etc/freepbx.conf"
[[ -f "$BOOTSTRAP" ]] || { echo "dongle logging: PBX bootstrap unavailable" >&2; exit 1; }
WORK=$(mktemp -d)
trap 'rm -rf -- "$WORK"' EXIT

# Resolve, rather than replace, PBX config symlinks. Copy metadata (including
# ACLs/labels) before writing; failed transformations never truncate the source.
replace() {
    local target=$1 source=$2 resolved tmp
    resolved=$(readlink -m -- "$target")
    mkdir -p -- "$(dirname -- "$resolved")"
    tmp=$(mktemp "$(dirname -- "$resolved")/.sokrat-logging.XXXXXX")
    if [[ -e "$resolved" ]]; then
        cp --preserve=all -- "$resolved" "$tmp"
    else
        case "$target" in
            "$AST_DIR"/*) chmod 0640 "$tmp"; chown --reference="$AST_DIR" "$tmp";;
            *) chmod 0644 "$tmp";;
        esac
    fi
    if ! cat -- "$source" >"$tmp" || ! mv -f -- "$tmp" "$resolved"; then
        rm -f -- "$tmp"
        return 1
    fi
}

# The logfiles module owns the DB and generated additional file. Move only its
# full row into the supported custom include. A normal PBX regeneration now
# preserves that ownership, instead of reintroducing a duplicate full channel.
# Never expose PHP/bootstrap errors (which can contain credentials).
if ! timeout --kill-after=5s 30s "$PHP_BIN" -d display_errors=0 -d log_errors=0 \
    /dev/stdin "$BOOTSTRAP" "$WORK/db-full" "$WORK/additional" >/dev/null 2>&1 <<'PHP'
<?php
try {
    ob_start();
    require $argv[1];
    if (!isset($db, $amp_conf)) throw new Exception('bootstrap');
    if (!function_exists('logfiles_get_config')) {
        require_once $amp_conf['AMPWEBROOT'].'/admin/modules/logfiles/functions.inc.php';
    }
    if (!function_exists('logfiles_get_config') || !class_exists('logfiles_conf')) {
        throw new Exception('module');
    }
    $rows = $db->getAll('SELECT * FROM logfile_logfiles', DB_FETCHMODE_ASSOC);
    if (!is_array($rows)) throw new Exception('database read');
    $categories = array();
    foreach ($rows as $row) {
        if ($row['name'] !== 'full') continue;
        foreach ($row as $key => $value) {
            if ($key !== 'name' && $value === 'on') {
                $categories[] = $key === 'verbose' ? 'verbose(3)' : $key;
            }
        }
    }
    $result = $db->query("DELETE FROM logfile_logfiles WHERE name = 'full'");
    if ($result === false || (class_exists('PEAR') && PEAR::isError($result))) {
        throw new Exception('database write');
    }
    logfiles_get_config('asterisk');
    $generated = logfiles_conf::create()->generateConf('logger_logfiles_additional.conf');
    if (!is_string($generated)) throw new Exception('generation');
    if (file_put_contents($argv[2], implode(',', $categories)."\n") === false ||
        file_put_contents($argv[3], $generated) === false) throw new Exception('output');
    ob_end_clean();
} catch (Throwable $e) {
    while (ob_get_level()) ob_end_clean();
    exit(1);
}
PHP
then
    echo "dongle logging: PBX logging configuration failed" >&2
    exit 1
fi

# Consolidate full definitions, retaining every operator category. All other
# custom lines remain byte-for-byte. Migrate legacy inline full definitions too.
touch "$WORK/empty"
LOGGER="$AST_DIR/logger.conf"
CUSTOM="$AST_DIR/logger_logfiles_custom.conf"
[[ -f "$LOGGER" ]] || { echo "dongle logging: logger.conf missing" >&2; exit 1; }
CUSTOM_INPUT="$CUSTOM"
[[ -f "$CUSTOM_INPUT" ]] || CUSTOM_INPUT="$WORK/empty"
ADDITIONAL_INPUT="$AST_DIR/logger_logfiles_additional.conf"
[[ -f "$ADDITIONAL_INPUT" ]] || ADDITIONAL_INPUT="$WORK/empty"
awk '
    function add(s, n,a,i,v) {
        sub(/;.*/, "", s); n=split(s,a,",")
        for(i=1;i<=n;i++) {
            gsub(/^[ \t]+|[ \t]+$/, "", a[i])
            if(a[i]=="verbose") { all_verbose=1; continue }
            if(a[i] ~ /^verbose\([0-9]+\)$/) {
                v=a[i]; sub(/^verbose\(/,"",v); sub(/\)$/,"",v)
                if(v+0>verbose_level) verbose_level=v+0
                continue
            }
            if(a[i]!="" && !seen[a[i]]++) order[++count]=a[i]
        }
    }
    FNR==NR { add($0); next }
    /^[ \t]*full[ \t]*=>/ { line=$0; sub(/^[^=]*=>[ \t]*/, "", line); add(line) }
    END {
        add("debug,error,notice,verbose(3),warning")
        printf "full => "
        for(i=1;i<=count;i++) printf "%s%s", i==1?"":",", order[i]
        printf "%s%s\n", count?",":"", all_verbose?"verbose":"verbose(" verbose_level ")"
    }
' "$WORK/db-full" "$LOGGER" "$CUSTOM_INPUT" "$ADDITIONAL_INPUT" >"$WORK/full"
awk '!/^[ \t]*full[ \t]*=>/' "$CUSTOM_INPUT" >"$WORK/custom"
cat "$WORK/full" >>"$WORK/custom"
awk '
    /^[ \t]*full[ \t]*=>/ { next }
    /^[ \t]*#(try)?include[ \t]+["<]?logger_logfiles_custom.conf[">]?[ \t]*(;.*)?$/ { next }
    /^[ \t]*\[logfiles\][ \t]*(;.*)?$/ {
        found=1; print; print "#include logger_logfiles_custom.conf"; next
    }
    { print }
    END {
        if(!found) {
            print "\n[logfiles]"
            print "#include logger_logfiles_custom.conf"
        }
    }
' "$LOGGER" >"$WORK/logger"

AST_CONF="$AST_DIR/asterisk.conf"
AST_INPUT="$AST_CONF"
[[ -f "$AST_INPUT" ]] || AST_INPUT="$WORK/empty"
awk '
    function finish() {
        if(inopt && !v) print "verbose = 3"
        if(inopt && !d) print "debug = 2"
    }
    /^[ \t]*\[/ {
        finish(); inopt=($0 ~ /^[ \t]*\[options\]/)
        if(inopt) { found=1; v=0; d=0 }
    }
    inopt && /^[ \t]*verbose[ \t]*=/ {
        if(!v++) { split($0,a,"="); print "verbose = " (a[2]+0>3?a[2]+0:3) }; next
    }
    inopt && /^[ \t]*debug[ \t]*=/ {
        if(!d++) { split($0,a,"="); print "debug = " (a[2]+0>2?a[2]+0:2) }; next
    }
    { print }
    END { finish(); if(!found) print "\n[options]\nverbose = 3\ndebug = 2" }
' "$AST_INPUT" >"$WORK/asterisk"
replace "$CUSTOM" "$WORK/custom"
replace "$AST_DIR/logger_logfiles_additional.conf" "$WORK/additional"
replace "$LOGGER" "$WORK/logger"
replace "$AST_CONF" "$WORK/asterisk"

# Change only the three diagnostic log stanzas. Queue_log and atftp retain their
# operator-supplied monthly policy. Numbered archives permit multiple rotations
# per day (global dateext would otherwise collide).
ROTATE="$ROOT/etc/logrotate.d/asterisk"
ROTATE_INPUT="$ROTATE"
[[ -f "$ROTATE_INPUT" ]] || ROTATE_INPUT="$WORK/empty"
awk '
    function policy() {
        print "    daily\n    maxsize 250M\n    rotate 14\n    compress\n    delaycompress\n    nodateext"
    }
    function missing(name) {
        if(seen[name]) return
        print "/var/log/asterisk/" name " {"
        policy()
        print "    missingok\n    notifempty\n    su asterisk asterisk"
        print "    create 0640 asterisk asterisk"
        print "    postrotate"
        print "        /usr/bin/timeout --kill-after=5s 15s /usr/sbin/asterisk -rx \"logger reload\" >/dev/null 2>&1"
        print "    endscript\n}"
    }
    !inblock && /^[ \t]*#/ { print; next }
    !inblock {
        header=header " " $0
        if($0 !~ /\{/) { print; next }
        target=0; other=0; inblock=1
        n=split(header,paths,/[ \t\r\n]+/)
        for(i=1;i<=n;i++) {
            p=paths[i]; gsub(/["{}]/,"",p)
            if(p ~ /^\/var\/log\/asterisk\/(full|messages|security)$/) {
                target=1; sub(/^.*\//,"",p); seen[p]=1
            } else if(p ~ /^\//) other=1
        }
        if(target && other) { bad=1; exit 1 }
        header=""
        print
        if(target) policy()
        next
    }
    /^[ \t]*(postrotate|prerotate|firstaction|lastaction|preremove)[ \t]*$/ { inscript=1 }
    inscript {
        print
        if($0 ~ /^[ \t]*endscript[ \t]*$/) inscript=0
        next
    }
    target && /^[ \t]*(daily|weekly|monthly|yearly|hourly|size|maxsize|minsize|rotate|compress|nocompress|delaycompress|nodelaycompress|dateext|nodateext|dateformat)([ \t]|$)/ { next }
    { print }
    /^[ \t]*}/ { target=0; inblock=0 }
    END {
        if(inblock) exit 1
        if(!bad) { missing("full"); missing("messages"); missing("security") }
    }
' "$ROTATE_INPUT" >"$WORK/rotate"
replace "$ROTATE" "$WORK/rotate"

# Static enablement also works on offline roots. No service operations here.
UNIT_SOURCE="$(dirname -- "$(readlink -f -- "$0")")/systemd"
mkdir -p "$ROOT/etc/systemd/system/timers.target.wants"
replace "$ROOT/etc/systemd/system/sokrat-asterisk-logrotate.service" "$UNIT_SOURCE/sokrat-asterisk-logrotate.service"
replace "$ROOT/etc/systemd/system/sokrat-asterisk-logrotate.timer" "$UNIT_SOURCE/sokrat-asterisk-logrotate.timer"
ln -sfn ../sokrat-asterisk-logrotate.timer "$ROOT/etc/systemd/system/timers.target.wants/sokrat-asterisk-logrotate.timer"
if [[ "${1:-}" != "--no-reload" && -z "$ROOT" ]]; then
    timeout --kill-after=5s 15s "$ASTERISK_BIN" -rx "core set verbose 3" >/dev/null
    timeout --kill-after=5s 15s "$ASTERISK_BIN" -rx "core set debug 2" >/dev/null
    timeout --kill-after=5s 15s "$ASTERISK_BIN" -rx "logger reload" >/dev/null
fi
echo "dongle logging: verbose >=3, debug >=2; rotation checks 250M every minute, 14 compressed archives (not a hard size cap)"
