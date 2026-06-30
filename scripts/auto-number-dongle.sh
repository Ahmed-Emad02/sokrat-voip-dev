#!/bin/bash
# Auto-provision dongle SIM numbers via USSD + AT commands + chan_dongle reload
# Tries Egyptian operator MSISDN USSD codes until one returns the number

USSD_CODES=("*888#" "*947#" "*110#")
ASTERISK_BIN="/usr/sbin/asterisk"
MAPPINGS_FILE="/opt/issabel-dashboard/sim_mappings.json"
LOG_FILE="/var/log/asterisk/full"

usage() {
    echo "Usage: $0 [dongle_id]"
    echo "  If dongle_id is given, only provision that dongle."
    echo "  Otherwise, checks all dongles and provisions those missing numbers."
    exit 1
}

extract_number() {
    local text="$1"
    text=$(echo "$text" | sed 's/٠/0/g; s/١/1/g; s/٢/2/g; s/٣/3/g; s/٤/4/g; s/٥/5/g; s/٦/6/g; s/٧/7/g; s/٨/8/g; s/٩/9/g')
    text=$(echo "$text" | tr -d '[:space:]-():=' | grep -oE '20?1[01258][0-9]{8}' | head -1)
    if [ -n "$text" ]; then
        echo "$text" | sed 's/^20/+20/; s/^0/+20/; s/^1/+201/'
    fi
}

provision_dongle() {
    local dongle="$1" found_number="" code=""
    echo "[AUTO-NUMBER] Checking $dongle..."

    local imsi=$("$ASTERISK_BIN" -rx "dongle show devices" 2>/dev/null | grep "$dongle" | awk '{print $11}')
    if [ -z "$imsi" ] || [ "$imsi" = "-" ]; then
        echo "[AUTO-NUMBER] $dongle has no IMSI yet (SIM not registered). Skipping."
        return 1
    fi

    echo "[AUTO-NUMBER] $dongle IMSI=$imsi - querying number via USSD..."

    for code in "${USSD_CODES[@]}"; do
        echo "[AUTO-NUMBER] Trying USSD $code on $dongle..."
        "$ASTERISK_BIN" -rx "dongle ussd $dongle $code" >/dev/null 2>&1
        sleep 8

        local raw=$(tail -30 "$LOG_FILE" 2>/dev/null | grep -i "$dongle" | grep -i "USSD.*Got" | tail -1)
        if [ -n "$raw" ]; then
            local extracted=$(extract_number "$raw")
            if [ -n "$extracted" ] && [[ "$extracted" =~ ^\+20[1-9] ]]; then
                found_number="$extracted"
                echo "[AUTO-NUMBER] Found number: $found_number via code $code"
                break
            fi
        fi
        sleep 2
    done

    if [ -z "$found_number" ]; then
        echo "[AUTO-NUMBER] Could not determine number for $dongle after all USSD attempts."
        return 1
    fi

    local clean=$(echo "$found_number" | sed 's/+//')
    echo "[AUTO-NUMBER] Writing $found_number to $dongle SIM..."
    "$ASTERISK_BIN" -rx "dongle cmd $dongle AT+CPBS=\"ON\"" >/dev/null 2>&1
    sleep 1
    "$ASTERISK_BIN" -rx "dongle cmd $dongle AT+CPBW=1,\"$clean\",145" >/dev/null 2>&1
    sleep 1

    echo "[AUTO-NUMBER] Reloading chan_dongle.so..."
    "$ASTERISK_BIN" -rx "module unload chan_dongle.so" >/dev/null 2>&1
    sleep 2
    "$ASTERISK_BIN" -rx "module load chan_dongle.so" >/dev/null 2>&1
    sleep 3

    "$ASTERISK_BIN" -rx "database put DONGLE_NUMBERS $imsi $found_number" >/dev/null 2>&1

    if command -v node &>/dev/null; then
        node -e "
            const fs = require('fs');
            const p = '$MAPPINGS_FILE';
            let m = {};
            try { m = JSON.parse(fs.readFileSync(p, 'utf8')); } catch(e) {}
            m['$imsi'] = '$found_number';
            fs.writeFileSync(p, JSON.stringify(m, null, 4));
        "
    fi

    echo "[AUTO-NUMBER] OK $dongle provisioned with $found_number"
    return 0
}

if [ "$1" = "-h" ] || [ "$1" = "--help" ]; then usage; fi

if [ -n "$1" ]; then
    provision_dongle "$1"
else
    DONGLE_IDS=$("$ASTERISK_BIN" -rx "dongle show devices" 2>/dev/null | grep -oP 'dongle\d+' | sort -u)
    for d in $DONGLE_IDS; do
        provision_dongle "$d"
    done
fi
