#!/bin/bash
# Additive packages only; no routes, firewall reset, Asterisk restart or config.
set -euo pipefail
if ! command -v openvpn >/dev/null 2>&1 || ! command -v iptables >/dev/null 2>&1 || ! python3 -c 'import cryptography' >/dev/null 2>&1; then
    if [ "${SOKRAT_OFFLINE:-0}" = "1" ]; then
        echo 'Offline bundle is missing OpenVPN >= 2.4, iptables, or Python cryptography; install them manually before reverse TLS pairing' >&2
        exit 1
    elif command -v dnf >/dev/null 2>&1; then
        dnf -y install openvpn iptables python3-cryptography
    elif command -v apt-get >/dev/null 2>&1; then
        DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends openvpn iptables python3-cryptography
    else
        echo 'Install OpenVPN >= 2.4, iptables and Python cryptography before reverse TLS pairing' >&2
        exit 1
    fi
fi

# A packaged OpenVPN 2.3 satisfies 'command -v' but generates a configuration
# that media_config() refuses, so pairing would fail later with a generic error.
# Resolve the same binary install-media-link.py uses and require 2.4 or newer 2.x.
OPENVPN_BIN=""
for candidate in /usr/sbin/openvpn /usr/bin/openvpn /usr/local/sbin/openvpn; do
    if [ -x "$candidate" ]; then
        OPENVPN_BIN="$candidate"
        break
    fi
done
if [ -z "$OPENVPN_BIN" ]; then
    OPENVPN_BIN="$(command -v openvpn 2>/dev/null || true)"
fi
if [ -z "$OPENVPN_BIN" ]; then
    echo 'OpenVPN is required for reverse TLS or direct media' >&2
    exit 1
fi
# A valid 2.x package prints its version and exits 0, except Rocky's OpenVPN
# 2.4 build which prints a valid banner and then exits 1. Capture the banner
# without letting that exit status abort the script, and accept no other
# nonzero status: a crashed or missing binary must never pass the preflight.
OPENVPN_MINOR=""
verify_openvpn_binary() {
    local binary="$1" output status minor
    if output=$("$binary" --version 2>/dev/null); then
        status=0
    else
        status=$?
    fi
    if [ "$status" -gt 1 ]; then
        echo "OpenVPN 2.4 or newer 2.x is required; $binary failed to report its version (exit $status)" >&2
        return 1
    fi
    minor=$(printf '%s\n' "$output" | awk 'NR == 1 && $1 == "OpenVPN" && $2 ~ /^2\.[0-9]+(\.[0-9]+)?$/ { split($2, v, "."); print v[2]; exit }')
    case "$minor" in
        ''|*[!0-9]*)
            echo "OpenVPN 2.4 or newer 2.x is required; $binary is unsupported" >&2
            return 1
            ;;
    esac
    if [ "$minor" -lt 4 ]; then
        echo "OpenVPN 2.4 or newer 2.x is required; $binary reports 2.$minor" >&2
        return 1
    fi
    OPENVPN_MINOR="$minor"
}
verify_openvpn_binary "$OPENVPN_BIN" || exit 1

python3 -c 'import cryptography'
test -c /dev/net/tun
command -v iptables >/dev/null
echo "Media dependencies verified (OpenVPN 2.$OPENVPN_MINOR); no network configuration changed"
