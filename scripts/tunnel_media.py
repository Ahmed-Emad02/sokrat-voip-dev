"""Pure, bounded configuration for a per-PBX media link.

Three transports are supported. By default (``transport is None``) the PBX is
the TLS server on loopback only and FRPC carries that listener to the gateway
over FRP's TCP transport; the gateway's TLS client dials the FRPS loopback
mapping. That path is not end-to-end UDP below the tunnel: only the OpenVPN
payload is UDP. With ``transport={'mode': 'direct-udp', ...}`` the TLS roles
are reversed: the gateway is the TLS server on UDP 0.0.0.0:transport.port and
PBX dials transport.host:transport.port as the TLS client with ``nobind``.
With ``transport={'mode': 'plain-udp', ...}`` a small HMAC-authenticated UDP
daemon carries the same point-to-point TUN on the selected port; no OpenVPN
daemon or certificate material is used. Direct modes never fall back to FRP;
an explicit transaction changes them and enrollment preserves the selected
transport. The gateway needs no new route and the PBX gets no public media
listener. No default route, LAN route, NAT, Asterisk option or SIP endpoint is
changed.
"""
import ipaddress
import json
import re

ID_RE = re.compile(r"^pbx_[a-f0-9]{16}$")
HOST_LABEL_RE = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?")
TRANSPORT_KEYS = frozenset(("mode", "host", "port"))
TRANSPORT_MODES = frozenset(("direct-udp", "plain-udp"))
PRIVATE_POOLS = tuple(ipaddress.ip_network(cidr) for cidr in
                      ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"))


def allocation(pbx_id, slot, network):
    if not ID_RE.fullmatch(pbx_id):
        raise ValueError("Invalid PBX id")
    if type(slot) is not int or not 0 <= slot < 155:
        raise ValueError("Invalid tenant slot")
    pool = ipaddress.ip_network(network, strict=True)
    if pool.version != 4 or pool.prefixlen > 22 or not any(
            pool.network_address in private and pool.broadcast_address in private
            for private in PRIVATE_POOLS):
        raise ValueError("Media pool must be a private IPv4 /22 or larger")
    subnet = ipaddress.ip_network((int(pool.network_address) + slot * 4, 30))
    if subnet.network_address not in pool or subnet.broadcast_address not in pool:
        raise ValueError("Media address pool exhausted")
    return {
        "pbxId": pbx_id, "slot": slot, "interface": "skm" + str(slot),
        "gatewayIp": str(subnet.network_address + 1),
        "pbxIp": str(subnet.network_address + 2),
        "remoteMediaPort": 22000 + slot,
        "localMediaPort": 17001,
    }


def validate_plan(plan):
    """Do not let a modified enrollment document become root shell/config input."""
    if not isinstance(plan, dict):
        raise ValueError("Invalid media plan")
    try:
        slot = plan["slot"]
        base = int(ipaddress.IPv4Address(plan["gatewayIp"])) - slot * 4 - 1
        expected = allocation(plan["pbxId"], slot, str(ipaddress.IPv4Network((base, 22))))
    except (KeyError, TypeError, ValueError, ipaddress.AddressValueError) as exc:
        raise ValueError("Invalid media plan") from exc
    if plan != expected:
        raise ValueError("Invalid media plan")
    return plan


def validate_role(role):
    if role not in ("gateway", "pbx"):
        raise ValueError("Invalid media role")


def validate_transport(transport, plan):
    """Return a validated transport, or None for the existing FRP path.

    The value is interpolated into root-owned OpenVPN configuration, so it is
    checked as a whole before any material, key or service write happens.
    """
    if transport is None:
        return None
    validate_plan(plan)
    if not isinstance(transport, dict) or set(transport) != TRANSPORT_KEYS:
        raise ValueError("Invalid media transport")
    if not isinstance(transport["mode"], str) or transport["mode"] not in TRANSPORT_MODES:
        raise ValueError("Invalid media transport mode")
    host = transport["host"]
    if not isinstance(host, str) or not 0 < len(host) <= 253:
        raise ValueError("Invalid media transport host")
    try:
        ipaddress.IPv4Address(host)
    except ValueError:
        if re.fullmatch(r"[0-9.]+", host):
            raise ValueError("Invalid media transport host") from None
        # DNS name: bounded labels, no whitespace, comma, '#' or trailing dot.
        if not all(HOST_LABEL_RE.fullmatch(label) for label in host.split(".")):
            raise ValueError("Invalid media transport host") from None
    port = transport["port"]
    if type(port) is not int or not 1024 <= port <= 65535:
        raise ValueError("Invalid media transport port")
    return transport


def media_config(plan, role, directory, version=(2, 6), transport=None):
    validate_plan(plan)
    validate_role(role)
    transport = validate_transport(transport, plan)
    # Configuration paths are operator-derived, not arbitrary request input.
    if not re.fullmatch(r"/[A-Za-z0-9/_-]+", directory):
        raise ValueError("Invalid TLS material directory")
    if transport is not None and transport["mode"] == "plain-udp":
        # The plain daemon owns the TUN and both hooks; it never reads OpenVPN
        # options or certificate material, so no OpenVPN version is involved.
        return json.dumps({
            "role": role,
            "plan": plan,
            "transport": transport,
            "keyFile": f"{directory}/udp.key",
            "up": f"{directory}/link-up",
            "down": f"{directory}/link-down",
        }, sort_keys=True) + "\n"
    if version < (2, 4) or version >= (3, 0):
        raise ValueError("OpenVPN 2.4 or newer 2.x required")
    gateway = role == "gateway"
    local = plan["gatewayIp"] if gateway else plan["pbxIp"]
    remote = plan["pbxIp"] if gateway else plan["gatewayIp"]
    lines = [
        "# Managed Sokrat media link; no office/default routing",
        f"dev {plan['interface']}", "dev-type tun", "topology p2p",
        f"ifconfig {local} {remote}", "route-noexec", "ifconfig-noexec",
        # A reviewed up/down helper creates just this point-to-point address.
        "script-security 2",
        f"up {directory}/link-up", f"down {directory}/link-down", "down-pre",
        "persist-key", "persist-tun", "resolv-retry infinite", "keepalive 10 60",
        "tls-version-min 1.2", "cipher AES-256-GCM", "auth SHA256", "auth-nocache",
        f"ca {directory}/ca.crt", f"cert {directory}/{role}.crt",
        f"key {directory}/{role}.key", f"tls-crypt {directory}/tls-crypt.key",
        "tun-mtu 1400", "mssfix 0", "verb 3", "mute 10",
    ]
    if version >= (2, 5):
        lines += ["data-ciphers AES-256-GCM:AES-128-GCM", "data-ciphers-fallback AES-256-GCM"]
    else:
        lines += ["ncp-ciphers AES-256-GCM:AES-128-GCM"]
    if version >= (2, 6):
        lines += ["disable-dco"]
    if transport is None:
        if gateway:
            lines += ["tls-client", "proto tcp-client", "nobind",
                      f"remote 127.0.0.1 {plan['remoteMediaPort']}",
                      "remote-cert-tls server", f"verify-x509-name {plan['pbxId']}-pbx name"]
        else:
            lines += ["tls-server", "proto tcp-server", "local 127.0.0.1",
                      f"port {plan['localMediaPort']}", "dh none",
                      # OpenVPN 2.4 p2p tls-server restarts on its default poll
                      # timeout even while a peer is connected; 0 disables it.
                      "server-poll-timeout 0",
                      "remote-cert-tls client", f"verify-x509-name {plan['pbxId']}-gateway name"]
    elif gateway:
        # Direct UDP reverses the TLS roles: the gateway is the server and
        # pins the PBX certificate identity; no FRP loopback is involved.
        lines += ["tls-server", "proto udp", "local 0.0.0.0",
                  f"port {transport['port']}", "dh none",
                  # Same 2.4 p2p restart avoidance as the legacy server side.
                  "server-poll-timeout 0",
                  "remote-cert-tls client", f"verify-x509-name {plan['pbxId']}-pbx name"]
    else:
        lines += ["tls-client", "proto udp", "nobind",
                  f"remote {transport['host']} {transport['port']}",
                  "remote-cert-tls server", f"verify-x509-name {plan['pbxId']}-gateway name"]
    return "\n".join(lines) + "\n"


def link_script(plan, role, up):
    # No forwarding is needed: these are host-to-host addresses, not a LAN VPN.
    validate_plan(plan)
    validate_role(role)
    local = plan["gatewayIp"] if role == "gateway" else plan["pbxIp"]
    remote = plan["pbxIp"] if role == "gateway" else plan["gatewayIp"]
    iface = plan["interface"]
    slot = plan['slot']
    relay = f"{50000 + slot * 100}:{50099 + slot * 100}"
    local_ports, peer_ports = (relay, "10000:20000") if role == "gateway" else ("10000:20000", relay)
    chain = "SKM" + str(slot)
    commands = ["#!/bin/sh", "set -eu", "PATH=/usr/sbin:/usr/bin:/sbin:/bin", "export PATH"]
    if up:
        # Filter both host traffic and forwarding. A tenant cannot use the link
        # to reach gateway management, metadata, another PBX, or an office LAN.
        commands += [f"iptables -w -N {chain} 2>/dev/null || true",
                     f"iptables -w -F {chain}",
                     f"iptables -w -A {chain} -s {remote} -d {local} -p udp --sport {peer_ports} --dport {local_ports} -j ACCEPT",
                     f"iptables -w -A {chain} -s {local} -d {remote} -p udp --sport {local_ports} --dport {peer_ports} -j ACCEPT",
                     f"iptables -w -A {chain} -j DROP",
                     f"iptables -w -C INPUT -i {iface} -j {chain} 2>/dev/null || iptables -w -I INPUT 1 -i {iface} -j {chain}",
                     f"iptables -w -C OUTPUT -o {iface} -j {chain} 2>/dev/null || iptables -w -I OUTPUT 1 -o {iface} -j {chain}",
                     f"iptables -w -C FORWARD -i {iface} -j DROP 2>/dev/null || iptables -w -I FORWARD 1 -i {iface} -j DROP",
                     f"iptables -w -C FORWARD -o {iface} -j DROP 2>/dev/null || iptables -w -I FORWARD 1 -o {iface} -j DROP",
                     f"ip address replace {local} peer {remote}/32 dev {iface}",
                     f"ip link set dev {iface} mtu 1400 up"]
    else:
        commands += [f"ip address del {local} peer {remote}/32 dev {iface} 2>/dev/null || true"]
        # Leave the small interface-specific deny rules in place during restart;
        # this is fail-closed and does not affect any other interface.
    return "\n".join(commands) + "\n"
