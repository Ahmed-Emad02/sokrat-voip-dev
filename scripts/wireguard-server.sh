#!/bin/bash
# Shared embedded WireGuard server for the Sokrat mobile direct-PBX path.
#
# Sourced (never executed) by install.sh, installer-bundle/install-sokrat.sh and
# scripts/safe-upgrade.sh so a fresh install and an in-place upgrade reach the
# same state. Additive only: existing wg0.conf, private key, admission config
# and firewall layout are preserved, and no Asterisk, FRP or media unit is
# touched. The central gateway still supplies each device's public key and
# admission signal; this host only runs the data plane.

# A preserved secret must be a regular file we can hand to root only. A symlink
# is refused instead of followed, so chown/chmod and later reads cannot be
# redirected to another path. The path may be absent (caller creates it).
_sokrat_wireguard_secret_usable() {
    local file="$1"
    if [ ! -e "$file" ] && [ ! -L "$file" ]; then
        return 0
    fi
    if [ -L "$file" ] || [ ! -f "$file" ]; then
        return 1
    fi
    chown 0:0 "$file" 2>/dev/null || return 1
    chmod 600 "$file" 2>/dev/null || return 1
    return 0
}

install_wireguard_server() {
    local pkg_mgr="" old_umask wg_port wg_address allowed_cidr admission_token
    local secret_tmp
    local daemon_reload=0 dropin

    old_umask="$(umask)"
    wg_port="${SOKRAT_WG_PORT:-51830}"
    wg_address="${SOKRAT_WG_ADDRESS:-10.66.0.1/24}"
    allowed_cidr="${SOKRAT_WG_ALLOWED_CIDR:-10.66.0.0/24}"
    if ! [[ "$wg_address" =~ ^(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])(\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])){3}/([0-9]|[12][0-9]|3[0-2])$ ]]; then
        echo "  ERROR: SOKRAT_WG_ADDRESS must be one IPv4 address/prefix" >&2
        return 1
    fi

    case "$wg_port" in
        ''|*[!0-9]*) echo "  WARNING: invalid SOKRAT_WG_PORT; using 51830" >&2; wg_port=51830 ;;
    esac
    # The admission endpoint only accepts a private /8../30 IPv4 pool; an
    # invalid pool would make every device admission fail with 503.
    if ! [[ "$allowed_cidr" =~ ^(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])(\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])){3}/(8|9|[12][0-9]|30)$ ]]; then
        echo "  WARNING: invalid SOKRAT_WG_ALLOWED_CIDR; using 10.66.0.0/24" >&2
        allowed_cidr=10.66.0.0/24
    fi

    if command -v dnf >/dev/null 2>&1; then pkg_mgr="dnf"; elif command -v yum >/dev/null 2>&1; then pkg_mgr="yum"; fi

    if ! command -v wg >/dev/null 2>&1 || ! command -v wg-quick >/dev/null 2>&1; then
        if [ -n "$pkg_mgr" ]; then
            if $pkg_mgr install -y wireguard-tools >/dev/null 2>&1; then
                echo "  wireguard-tools installed"
            else
                echo "  WARNING: could not install wireguard-tools (continuing)"
            fi
        elif command -v apt-get >/dev/null 2>&1; then
            if apt-get update >/dev/null 2>&1 && apt-get install -y wireguard-tools >/dev/null 2>&1; then
                echo "  wireguard-tools installed"
            else
                echo "  WARNING: could not install wireguard-tools (continuing)"
            fi
        else
            echo "  WARNING: no supported package manager for wireguard-tools (continuing)"
        fi
    else
        echo "  wireguard-tools already installed"
    fi

    # /etc/sokrat keeps the established 0755 traverse: the Asterisk user must
    # reach the root-owned push hook (/etc/sokrat/gateway-hook.json) that the
    # WebRTC wake dispatcher runs as. Never tighten it to root-only here, but
    # do keep it root-owned and not writable by group/other.
    if [ -L /etc/sokrat ] || { [ -e /etc/sokrat ] && [ ! -d /etc/sokrat ]; }; then
        echo "  WARNING: /etc/sokrat is not a real directory; skipping WireGuard setup" >&2
        umask "$old_umask"
        return 0
    fi
    if [ ! -d /etc/sokrat ] && ! install -d -m 0755 /etc/sokrat; then
        echo "  WARNING: could not create /etc/sokrat; skipping WireGuard setup" >&2
        umask "$old_umask"
        return 0
    fi
    if ! chown 0:0 /etc/sokrat 2>/dev/null || ! chmod 0755 /etc/sokrat 2>/dev/null; then
        echo "  WARNING: cannot make /etc/sokrat root-owned 0755; skipping WireGuard setup" >&2
        umask "$old_umask"
        return 0
    fi

    # The WireGuard private key and wg0.conf are root-only; the directory is
    # tightened even when a previous install left it world-readable.
    if [ -L /etc/wireguard ] || { [ -e /etc/wireguard ] && [ ! -d /etc/wireguard ]; }; then
        echo "  WARNING: /etc/wireguard is not a real directory; skipping WireGuard setup" >&2
        umask "$old_umask"
        return 0
    fi
    if [ ! -d /etc/wireguard ] && ! install -d -m 0700 /etc/wireguard; then
        echo "  WARNING: could not create /etc/wireguard; skipping WireGuard setup" >&2
        umask "$old_umask"
        return 0
    fi
    if ! chown 0:0 /etc/wireguard 2>/dev/null || ! chmod 0700 /etc/wireguard 2>/dev/null; then
        echo "  WARNING: cannot make /etc/wireguard root-owned 0700; skipping WireGuard setup" >&2
        umask "$old_umask"
        return 0
    fi

    # Preserved admission config, server key and profile are validated before
    # use: a symlink or non-regular file is refused rather than followed, and
    # old permissive modes are tightened to root-only.
    if ! _sokrat_wireguard_secret_usable /etc/sokrat/wg-admission.json; then
        echo "  WARNING: /etc/sokrat/wg-admission.json is not a root-owned 0600 regular file (symlinks are refused); skipping WireGuard setup" >&2
        umask "$old_umask"
        return 0
    fi
    if ! _sokrat_wireguard_secret_usable /etc/wireguard/sokrat-server.key; then
        echo "  WARNING: /etc/wireguard/sokrat-server.key is not a root-owned 0600 regular file (symlinks are refused); skipping WireGuard setup" >&2
        umask "$old_umask"
        return 0
    fi
    if ! _sokrat_wireguard_secret_usable /etc/wireguard/wg0.conf; then
        echo "  WARNING: /etc/wireguard/wg0.conf is not a root-owned 0600 regular file (symlinks are refused); skipping WireGuard setup" >&2
        umask "$old_umask"
        return 0
    fi

    # Generate the admission token independently of the gateway. The same
    # token must be placed in the central gateway's
    # /etc/sokrat/wg-admission.json for automatic peer admission.
    if [ ! -s /etc/sokrat/wg-admission.json ]; then
        admission_token="${SOKRAT_WG_ADMISSION_TOKEN:-}"
        if [ -z "$admission_token" ]; then
            admission_token="$(openssl rand -hex 32 2>/dev/null || true)"
        fi
        case "$admission_token" in
            *[!0-9a-f]*) admission_token="" ;;
        esac
        if [ "${#admission_token}" -ne 64 ]; then
            admission_token=""
        fi
        if [ -n "$admission_token" ] \
            && secret_tmp="$(umask 077; mktemp /etc/sokrat/.wg-admission.XXXXXX 2>/dev/null)" \
            && printf '{"token":"%s","interface":"wg0","allowedCidr":"%s"}\n' \
                "$admission_token" "$allowed_cidr" > "$secret_tmp" \
            && chown 0:0 "$secret_tmp" \
            && chmod 600 "$secret_tmp" \
            && mv -f "$secret_tmp" /etc/sokrat/wg-admission.json; then
            echo "  WireGuard admission config created"
        else
            [ -n "${secret_tmp:-}" ] && rm -f "$secret_tmp" 2>/dev/null || true
            secret_tmp=""
            echo "  WARNING: no valid admission token (64 lowercase hex chars); WireGuard admission was not configured"
        fi
    else
        echo "  Existing WireGuard admission config preserved"
    fi

    if ! command -v wg >/dev/null 2>&1; then
        echo "  WARNING: WireGuard is unavailable; skipping interface setup"
        umask "$old_umask"
        return 0
    fi

    if [ ! -s /etc/wireguard/sokrat-server.key ]; then
        if secret_tmp="$(umask 077; mktemp /etc/wireguard/.sokrat-server.key.XXXXXX 2>/dev/null)" \
            && (umask 077; wg genkey > "$secret_tmp") \
            && chown 0:0 "$secret_tmp" \
            && chmod 600 "$secret_tmp" \
            && mv -f "$secret_tmp" /etc/wireguard/sokrat-server.key; then
            echo "  WireGuard server key generated"
        else
            [ -n "${secret_tmp:-}" ] && rm -f "$secret_tmp" 2>/dev/null || true
            secret_tmp=""
            echo "  WARNING: could not generate the WireGuard server key; skipping interface setup" >&2
            umask "$old_umask"
            return 0
        fi
    fi

    if [ ! -s /etc/wireguard/wg0.conf ]; then
        # Validate the key without putting it on stdout; the profile itself is
        # composed from the key file so the secret never lands in a variable.
        if ! wg pubkey < /etc/wireguard/sokrat-server.key >/dev/null 2>&1; then
            echo "  WARNING: WireGuard server key is empty or invalid; skipping interface setup" >&2
            umask "$old_umask"
            return 0
        fi
        if secret_tmp="$(umask 077; mktemp /etc/wireguard/.wg0.conf.XXXXXX 2>/dev/null)" \
            && (umask 077
                {
                    printf '[Interface]\nAddress = %s\nListenPort = %s\nPrivateKey = ' \
                        "$wg_address" "$wg_port"
                    tr -d '[:space:]' < /etc/wireguard/sokrat-server.key
                    printf '\n\n# Peers are added by the authenticated Sokrat admission endpoint.\n'
                } > "$secret_tmp") \
            && chown 0:0 "$secret_tmp" \
            && chmod 600 "$secret_tmp" \
            && mv -f "$secret_tmp" /etc/wireguard/wg0.conf; then
            echo "  WireGuard interface wg0 configured on ${wg_address} UDP ${wg_port}"
        else
            [ -n "${secret_tmp:-}" ] && rm -f "$secret_tmp" 2>/dev/null || true
            secret_tmp=""
            echo "  WARNING: could not write /etc/wireguard/wg0.conf; skipping interface setup" >&2
            umask "$old_umask"
            return 0
        fi
    else
        echo "  Existing /etc/wireguard/wg0.conf preserved"
    fi

    if command -v wg >/dev/null 2>&1; then
        local wg_public_key=""
        # Prefer the key the interface is actually running; a preserved
        # profile can predate sokrat-server.key. The configured profile is the
        # fallback. Never advertise a key derived from an unrelated file.
        wg_public_key="$(wg show wg0 public-key 2>/dev/null || true)"
        if ! [[ "$wg_public_key" =~ ^[A-Za-z0-9+/]{43}=$ ]]; then
            wg_public_key=""
            wg_public_key="$(
                awk '
                    /^[[:space:]]*\[/ {
                        section = $0
                        gsub(/[^A-Za-z]/, "", section)
                        next
                    }
                    section == "Interface" && /^[[:space:]]*PrivateKey[[:space:]]*=/ {
                        sub(/^[^=]*=[[:space:]]*/, "")
                        gsub(/[[:space:]]/, "")
                        if ($0 != "") { print; exit }
                    }
                ' /etc/wireguard/wg0.conf 2>/dev/null | wg pubkey 2>/dev/null || true
            )"
            [[ "$wg_public_key" =~ ^[A-Za-z0-9+/]{43}=$ ]] || wg_public_key=""
        fi
        if [ -n "$wg_public_key" ]; then
            echo "  WireGuard server public key: ${wg_public_key}"
        else
            echo "  WireGuard server public key: unavailable (wg0 is not running and wg0.conf has no usable PrivateKey)" >&2
        fi
    fi

    # Some Issabel/Rocky kernels do not ship the in-kernel WireGuard module.
    # If the userspace implementation is available, make wg-quick use it
    # instead of failing the entire direct-media setup.
    dropin="/etc/systemd/system/wg-quick@wg0.service.d/userspace.conf"
    if command -v wireguard-go >/dev/null 2>&1 \
        && ! (command -v modprobe >/dev/null 2>&1 && modprobe wireguard >/dev/null 2>&1); then
        if [ ! -f "$dropin" ]; then
            install -d -m 0755 "$(dirname "$dropin")"
            printf '%s\n' '[Service]' \
                'Environment=WG_QUICK_USERSPACE_IMPLEMENTATION=wireguard-go' > "$dropin"
            chmod 0644 "$dropin"
            daemon_reload=1
            echo "  Using userspace wireguard-go (kernel module unavailable)"
        fi
    fi

    if [ "$daemon_reload" -eq 1 ] && command -v systemctl >/dev/null 2>&1; then
        systemctl daemon-reload >/dev/null 2>&1 || true
    fi

    if command -v systemctl >/dev/null 2>&1; then
        systemctl enable wg-quick@wg0 >/dev/null 2>&1 || true
        if systemctl is-active --quiet wg-quick@wg0 2>/dev/null; then
            echo "  WireGuard wg0 already running"
        elif systemctl start wg-quick@wg0 >/dev/null 2>&1; then
            echo "  WireGuard wg0 started"
        else
            echo "  WARNING: could not start wg0 (check: journalctl -u wg-quick@wg0 -n 50)"
        fi
    else
        echo "  WARNING: systemctl is unavailable; wg0 was not enabled or started"
    fi

    # Open only the WireGuard port, and only when the permanent rule is
    # missing: an upgrade must not reload the firewall on every run.
    if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
        if ! firewall-cmd --permanent --query-port="${wg_port}/udp" >/dev/null 2>&1; then
            firewall-cmd --permanent --add-port="${wg_port}/udp" >/dev/null 2>&1 || true
            firewall-cmd --reload >/dev/null 2>&1 || true
            echo "  Firewall allows UDP ${wg_port}"
        else
            echo "  Firewall already allows UDP ${wg_port}"
        fi
    elif command -v ufw >/dev/null 2>&1; then
        if ! ufw status 2>/dev/null | grep -q "^${wg_port}/udp[[:space:]]*ALLOW"; then
            ufw allow "${wg_port}/udp" >/dev/null 2>&1 || true
            echo "  UFW allows UDP ${wg_port}"
        else
            echo "  UFW already allows UDP ${wg_port}"
        fi
    fi
    umask "$old_umask"
    echo "  WireGuard admission config: /etc/sokrat/wg-admission.json (share its token with the central gateway)"
    echo "  WireGuard dashboard: /vpn (interactive root only)"
    return 0
}
