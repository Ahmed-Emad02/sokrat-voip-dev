#!/bin/bash
# Additive packages only; no routes, firewall reset, Asterisk restart or config.
set -euo pipefail
if ! command -v openvpn >/dev/null 2>&1 || ! command -v iptables >/dev/null 2>&1 || ! python3 -c 'import cryptography' >/dev/null 2>&1; then
    if command -v dnf >/dev/null 2>&1; then
        dnf -y install openvpn iptables python3-cryptography
    elif command -v apt-get >/dev/null 2>&1; then
        DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends openvpn iptables python3-cryptography
    else
        echo 'Install OpenVPN >= 2.4, iptables and Python cryptography before reverse TLS pairing' >&2
        exit 1
    fi
fi
python3 -c 'import cryptography'
test -c /dev/net/tun
command -v iptables >/dev/null
echo 'Reverse TLS media dependencies verified; no network configuration changed'
