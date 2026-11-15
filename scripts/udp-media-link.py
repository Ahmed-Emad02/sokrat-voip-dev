#!/usr/bin/env python3
"""HMAC-authenticated, unencrypted point-to-point UDP media link.

The daemon carries one tenant's point-to-point TUN over UDP between a PBX and
the gateway. It does not encrypt: authentication prevents unauthenticated
frames and tunnel tenants from injecting traffic, and the inner packet checks
plus the existing per-interface firewall retain tenant isolation. All control
and data frames are authenticated with direction-specific keys derived from
the shared ``udp.key`` so a valid frame reflected at its sender is rejected.

The configuration is a small JSON document written by install-media-link.py;
it is never read from a request. Keys, sockets, hooks and the TUN device are
validated before any device or service state is created.
"""
import argparse
import errno
import fcntl
import hashlib
import hmac
import ipaddress
import json
import os
import re
import select
import signal
import socket
import stat
import struct
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from tunnel_media import validate_plan, validate_transport

MAGIC = b"SKMU"
VERSION = 2
HELLO = 1
CHALLENGE = 2
RESPONSE = 3
ACK = 4
DATA = 5
KEEPALIVE = 6
TYPES = frozenset((HELLO, CHALLENGE, RESPONSE, ACK, DATA, KEEPALIVE))
HEADER = struct.Struct("!4sBBQ16sH")
HEADER_SIZE = HEADER.size
TAG_SIZE = 32
MAX_PAYLOAD = 1400
MAX_FRAME = HEADER_SIZE + TAG_SIZE + MAX_PAYLOAD
# Keeps control frames clear of the 64-68 byte payload band the Sales path drops.
CONTROL_PADDING = 48
REPLAY_WINDOW = 128
CANDIDATE_TTL = 5.0
PENDING_TTL = 5.0
RETRY_INTERVAL = 1.0
# Ten seconds matches the long-standing default on paths that carry the
# authenticated link; padded control frames are what keep the mapping alive, not
# a shorter cadence.
KEEPALIVE_INTERVAL = 10.0
PEER_TIMEOUT = 45.0
# A tuple that carried no authenticated frame for three keepalives is presumed
# stalled on the path; the PBX escapes it by binding a fresh source port.
CLIENT_REBIND_TIMEOUT = 3 * KEEPALIVE_INTERVAL
CONFIG_KEYS = frozenset(("role", "plan", "transport", "keyFile", "up", "down"))
KEY_RE = re.compile(r"\A[a-f0-9]{64}\n\Z")
IFNAMSIZ = 16
IFF_TUN = 0x0001
IFF_NO_PI = 0x1000
TUNSETIFF = 0x400454CA
STOP = False


class ProtocolError(Exception):
    """A datagram is not a well-formed authenticated frame."""


def mac_key(key, sender):
    """Directional MAC key; the peer uses the opposite direction."""
    if sender not in (b"gateway", b"pbx"):
        raise ValueError("Invalid media MAC direction")
    return hmac.new(key, b"mac" + sender, hashlib.sha256).digest()


def direction_keys(key, role):
    """Return (transmit MAC key, receive MAC key) for this role."""
    if role == "gateway":
        return mac_key(key, b"gateway"), mac_key(key, b"pbx")
    if role == "pbx":
        return mac_key(key, b"pbx"), mac_key(key, b"gateway")
    raise ValueError("Invalid media role")


def session_id(key, client_nonce, server_nonce):
    return hmac.new(key, b"session" + client_nonce + server_nonce,
                    hashlib.sha256).digest()[:16]


def pack_frame(tx_key, frame_type, sequence, session, payload):
    if frame_type not in TYPES:
        raise ValueError("Invalid frame type")
    if not isinstance(sequence, int) or not 0 <= sequence < 1 << 64:
        raise ValueError("Invalid frame sequence")
    if not isinstance(session, bytes) or len(session) != 16:
        raise ValueError("Invalid frame session")
    if not isinstance(payload, bytes) or len(payload) > MAX_PAYLOAD:
        raise ValueError("Invalid frame payload")
    header = HEADER.pack(MAGIC, VERSION, frame_type, sequence, session,
                         len(payload))
    body = header + payload
    return body + hmac.new(tx_key, body, hashlib.sha256).digest()


def pad_control(payload):
    """Pad a control frame payload with zeros.

    The Sales path silently drops datagrams whose payload is 64-68 bytes once
    a few have crossed in either direction, and every unpadded control frame
    sits exactly in that band. Padding to CONTROL_PADDING keeps authenticated
    control traffic flowing without changing any state machine.
    """
    missing = CONTROL_PADDING - len(payload)
    if missing <= 0:
        return payload
    return payload + b"\x00" * missing


def unpad_control(payload, expected):
    """Return the semantic control payload, or None if padding is not zero.

    Unpadded peers stay compatible: an absent tail is also valid padding.
    """
    if len(payload) < expected:
        return None
    if payload[expected:].strip(b"\x00"):
        return None
    return payload[:expected]


def parse_frame(rx_key, data):
    """Authenticate and decode one frame; never returns unauthenticated data."""
    if not isinstance(data, bytes) or len(data) < HEADER_SIZE + TAG_SIZE:
        raise ProtocolError("short frame")
    if len(data) > MAX_FRAME:
        raise ProtocolError("oversized frame")
    magic, version, frame_type, sequence, session, length = \
        HEADER.unpack(data[:HEADER_SIZE])
    if magic != MAGIC or version != VERSION or frame_type not in TYPES:
        raise ProtocolError("invalid frame header")
    if length > MAX_PAYLOAD or length != len(data) - HEADER_SIZE - TAG_SIZE:
        raise ProtocolError("invalid frame length")
    body = data[:HEADER_SIZE + length]
    expected = hmac.new(rx_key, body, hashlib.sha256).digest()
    if not hmac.compare_digest(expected, data[HEADER_SIZE + length:]):
        raise ProtocolError("invalid frame tag")
    return frame_type, sequence, session, body[HEADER_SIZE:]


class ReplayWindow(object):
    """Bounded duplicate/old-sequence filter for one sender direction."""

    def __init__(self, size=REPLAY_WINDOW):
        self.size = size
        self.highest = 0
        self.seen = 0

    def reset(self):
        self.highest = 0
        self.seen = 0

    def accept(self, sequence):
        if not isinstance(sequence, int) or sequence <= 0:
            return False
        if sequence > self.highest:
            shift = sequence - self.highest
            if shift >= self.size:
                self.seen = 1
            else:
                self.seen = ((self.seen << shift) & ((1 << self.size) - 1)) | 1
            self.highest = sequence
            return True
        delta = self.highest - sequence
        if delta >= self.size:
            return False
        bit = 1 << delta
        if self.seen & bit:
            return False
        self.seen |= bit
        return True


def valid_inner(payload, source, destination):
    """Accept only unfragmented UDP IPv4 between the two tunnel addresses."""
    if not isinstance(payload, bytes) or len(payload) < 20:
        return False
    if payload[0] >> 4 != 4:
        return False
    header_length = (payload[0] & 0x0F) * 4
    if header_length < 20 or len(payload) < header_length:
        return False
    total = (payload[2] << 8) | payload[3]
    if total != len(payload):
        return False
    if struct.unpack("!H", payload[6:8])[0] & 0x3FFF:
        return False
    if payload[9] != socket.IPPROTO_UDP:
        return False
    return payload[12:16] == source and payload[16:20] == destination


def encode_inner(payload, source, destination):
    """Omit the two IPv4 addresses already fixed by the authenticated plan."""
    if not valid_inner(payload, source, destination) or len(payload) > MAX_PAYLOAD:
        return None
    return payload[:12] + payload[20:]


def decode_inner(payload, source, destination):
    """Restore exact header/checksum bytes; the peer cannot choose addresses."""
    if not isinstance(payload, bytes) or not 12 <= len(payload) <= MAX_PAYLOAD - 8:
        return None
    packet = payload[:12] + source + destination + payload[12:]
    return packet if valid_inner(packet, source, destination) else None


def fresh_nonce():
    return os.urandom(16)


class GatewayLink(object):
    """Gateway half: answers handshakes and pins one PBX endpoint."""

    def __init__(self, key, plan, clock=time.monotonic, nonce=fresh_nonce):
        self.key = key
        self.tx_key, self.rx_key = direction_keys(key, "gateway")
        self.pbx_address = ipaddress.IPv4Address(plan["pbxIp"]).packed
        self.gateway_address = ipaddress.IPv4Address(plan["gatewayIp"]).packed
        self.clock = clock
        self.nonce = nonce
        self.emit = None
        self.tun_write = None
        self.candidate = None
        self.active_address = None
        self.active_session = None
        self.send_sequence = 0
        self.replay = ReplayWindow()
        self.last_received = None

    def _emit(self, frame_type, sequence, session, payload, address):
        if self.emit is not None:
            self.emit(pack_frame(self.tx_key, frame_type, sequence, session,
                                 payload), address)

    def handle_datagram(self, data, address):
        now = self.clock()
        try:
            frame_type, sequence, session, payload = parse_frame(self.rx_key, data)
        except ProtocolError:
            return
        if frame_type == HELLO:
            if sequence != 0 or unpad_control(payload, 0) is None:
                return
            candidate = self.candidate
            if (candidate is None or now > candidate["expires"]
                    or address != candidate["address"]
                    or session != candidate["client_nonce"]):
                candidate = {
                    "address": address,
                    "client_nonce": session,
                    "server_nonce": self.nonce(),
                    "expires": now + CANDIDATE_TTL,
                }
                self.candidate = candidate
            self._emit(CHALLENGE, 0, session,
                       pad_control(candidate["server_nonce"]), address)
            return
        if frame_type == RESPONSE:
            if sequence != 0:
                return
            nonce = unpad_control(payload, 16)
            if nonce is None:
                return
            candidate = self.candidate
            if candidate is not None and now > candidate["expires"]:
                self.candidate = None
                candidate = None
            if (candidate is not None and address == candidate["address"]
                    and session == candidate["client_nonce"]
                    and nonce == candidate["server_nonce"]):
                sid = session_id(self.key, session, nonce)
                self.active_address = address
                self.active_session = sid
                self.send_sequence = 0
                self.replay.reset()
                self.last_received = now
                self.candidate = None
                self._emit(ACK, 0, sid, pad_control(b""), address)
                return
            if self.active_address == address and self.active_session is not None:
                sid = session_id(self.key, session, nonce)
                if hmac.compare_digest(sid, self.active_session):
                    # Lost ACK: resend it without touching the replay state or
                    # the sender sequence of an already active session.
                    self._emit(ACK, 0, self.active_session, pad_control(b""),
                               address)
            return
        if frame_type not in (DATA, KEEPALIVE):
            return
        if self.active_address is None or address != self.active_address:
            return
        if session != self.active_session or not self.replay.accept(sequence):
            return
        self.last_received = now
        if frame_type == DATA:
            packet = decode_inner(payload, self.pbx_address, self.gateway_address)
            if packet is not None and self.tun_write is not None:
                self.tun_write(packet)
        else:
            self.send_sequence += 1
            self._emit(KEEPALIVE, self.send_sequence, self.active_session,
                       pad_control(b""), self.active_address)

    def send_data(self, payload):
        if self.active_address is None or self.active_session is None:
            return False
        encoded = encode_inner(payload, self.gateway_address, self.pbx_address)
        if encoded is None:
            return False
        self.send_sequence += 1
        self._emit(DATA, self.send_sequence, self.active_session, encoded,
                   self.active_address)
        return True

    def poll(self):
        if (self.candidate is not None
                and self.clock() > self.candidate["expires"]):
            self.candidate = None

    def timeout(self, now):
        if self.candidate is not None:
            return max(0.0, min(1.0, self.candidate["expires"] - now))
        return 1.0


class ClientLink(object):
    """PBX half: initiates handshakes and talks only to the gateway address."""

    def __init__(self, key, plan, gateway_address, clock=time.monotonic,
                 nonce=fresh_nonce):
        self.key = key
        self.tx_key, self.rx_key = direction_keys(key, "pbx")
        self.pbx_address = ipaddress.IPv4Address(plan["pbxIp"]).packed
        self.gateway_ip = ipaddress.IPv4Address(plan["gatewayIp"]).packed
        self.gateway_address = gateway_address
        self.clock = clock
        self.nonce = nonce
        self.emit = None
        self.tun_write = None
        self.client_nonce = None
        self.server_nonce = None
        self.pending = False
        self.pending_started = 0.0
        self.next_retry = 0.0
        self.active = False
        self.session = None
        self.send_sequence = 0
        self.replay = ReplayWindow()
        self.last_received = 0.0
        self.last_sent = 0.0

    def _emit(self, frame_type, sequence, session, payload):
        if self.emit is not None:
            self.emit(pack_frame(self.tx_key, frame_type, sequence, session,
                                 payload), self.gateway_address)

    def start(self):
        now = self.clock()
        self.active = False
        self.session = None
        self.client_nonce = self.nonce()
        self.server_nonce = None
        self.pending = True
        self.pending_started = now
        self.next_retry = now + RETRY_INTERVAL
        self.last_sent = now
        self.send_sequence = 0
        self._emit(HELLO, 0, self.client_nonce, pad_control(b""))

    def handle_datagram(self, data, address):
        if address != self.gateway_address:
            return
        now = self.clock()
        try:
            frame_type, sequence, session, payload = parse_frame(self.rx_key, data)
        except ProtocolError:
            return
        if frame_type == CHALLENGE:
            if not self.pending or now - self.pending_started >= PENDING_TTL:
                return
            if sequence != 0 or session != self.client_nonce:
                return
            nonce = unpad_control(payload, 16)
            if nonce is None or self.server_nonce is not None:
                return
            self.server_nonce = nonce
            self.next_retry = now + RETRY_INTERVAL
            self.last_sent = now
            self._emit(RESPONSE, 0, self.client_nonce,
                       pad_control(self.server_nonce))
            return
        if frame_type == ACK:
            if not self.pending or self.server_nonce is None:
                return
            if now - self.pending_started >= PENDING_TTL:
                return
            if (sequence != 0 or unpad_control(payload, 0) is None
                    or session != session_id(self.key, self.client_nonce,
                                             self.server_nonce)):
                return
            self.active = True
            self.pending = False
            self.session = session
            self.send_sequence = 0
            self.replay.reset()
            self.last_received = now
            self.last_sent = now
            return
        if frame_type not in (DATA, KEEPALIVE):
            return
        if not self.active or session != self.session:
            return
        if not self.replay.accept(sequence):
            return
        self.last_received = now
        if frame_type == DATA:
            packet = decode_inner(payload, self.gateway_ip, self.pbx_address)
            if packet is not None and self.tun_write is not None:
                self.tun_write(packet)

    def send_data(self, payload):
        if not self.active or self.session is None:
            return False
        encoded = encode_inner(payload, self.pbx_address, self.gateway_ip)
        if encoded is None:
            return False
        self.send_sequence += 1
        self.last_sent = self.clock()
        self._emit(DATA, self.send_sequence, self.session, encoded)
        return True

    def poll(self):
        now = self.clock()
        if self.pending and now - self.pending_started >= PENDING_TTL:
            self.start()
            return
        if self.pending:
            if now >= self.next_retry:
                self.next_retry = now + RETRY_INTERVAL
                self.last_sent = now
                if self.server_nonce is None:
                    self._emit(HELLO, 0, self.client_nonce, pad_control(b""))
                else:
                    self._emit(RESPONSE, 0, self.client_nonce,
                               pad_control(self.server_nonce))
            return
        if not self.active:
            return
        if now - self.last_received >= PEER_TIMEOUT:
            self.start()
            return
        if now - self.last_sent >= KEEPALIVE_INTERVAL:
            self.send_sequence += 1
            self.last_sent = now
            self._emit(KEEPALIVE, self.send_sequence, self.session,
                       pad_control(b""))

    def timeout(self, now):
        limit = 1.0
        if self.pending:
            limit = min(limit, max(0.0, self.next_retry - now),
                        max(0.0, self.pending_started + PENDING_TTL - now))
        if self.active:
            limit = min(limit, max(0.0, self.last_received + PEER_TIMEOUT - now),
                        max(0.0, self.last_sent + KEEPALIVE_INTERVAL - now))
        return max(0.0, limit)


def _protected_ancestors(directory):
    current = directory
    while True:
        info = os.lstat(current)
        if (not stat.S_ISDIR(info.st_mode) or info.st_uid != 0
                or info.st_mode & 0o022):
            raise ValueError("Untrusted media installation directory")
        parent = os.path.dirname(current)
        if parent == current:
            return
        current = parent


def read_protected(path, limit):
    """Read a root-only regular file after checking it and its ancestors."""
    _protected_ancestors(os.path.dirname(path))
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags)
    try:
        info = os.fstat(descriptor)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0
                or info.st_mode & 0o077):
            raise ValueError("Untrusted media installation file")
        if info.st_size > limit:
            raise ValueError("Media file too large")
        data = os.read(descriptor, limit + 1)
        if len(data) > limit:
            raise ValueError("Media file too large")
        return data
    finally:
        os.close(descriptor)


def decode_key(text):
    if not isinstance(text, str) or not KEY_RE.match(text):
        raise ValueError("Invalid plain media key")
    return bytes.fromhex(text[:-1])


def validate_config(document, path):
    """Validate the whole media.conf document before any filesystem access."""
    if (not isinstance(path, str) or not os.path.isabs(path)
            or os.path.normpath(path) != path):
        raise ValueError("Invalid media config path")
    if not isinstance(document, dict) or set(document) != CONFIG_KEYS:
        raise ValueError("Invalid media config")
    role = document["role"]
    if role not in ("gateway", "pbx"):
        raise ValueError("Invalid media role")
    plan = validate_plan(document["plan"])
    transport = validate_transport(document["transport"], plan)
    if transport is None or transport["mode"] != "plain-udp":
        raise ValueError("Invalid plain media transport")
    directory = os.path.dirname(path)
    names = (("keyFile", "udp.key"), ("up", "link-up"), ("down", "link-down"))
    for field, name in names:
        value = document[field]
        if not isinstance(value, str) or value != directory + "/" + name:
            raise ValueError("Invalid media config path")
    return {
        "role": role, "plan": plan, "transport": transport,
        "directory": directory, "keyFile": document["keyFile"],
        "up": document["up"], "down": document["down"],
    }


def check_hook(path, directory):
    if os.path.dirname(path) != directory:
        raise ValueError("Invalid media hook path")
    info = os.lstat(path)
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0
            or info.st_mode & 0o022 or not info.st_mode & stat.S_IXUSR):
        raise ValueError("Untrusted media hook")


def load_configuration(path):
    if (not isinstance(path, str) or not os.path.isabs(path)
            or os.path.normpath(path) != path):
        raise ValueError("Invalid media config path")
    document = json.loads(read_protected(path, 65536).decode("utf-8"))
    config = validate_config(document, path)
    config["key"] = decode_key(
        read_protected(config["keyFile"], 128).decode("ascii"))
    check_hook(config["up"], config["directory"])
    check_hook(config["down"], config["directory"])
    return config


def open_tun(interface):
    name = interface.encode("ascii")
    if len(name) >= IFNAMSIZ:
        raise ValueError("Invalid media interface")
    descriptor = os.open("/dev/net/tun", os.O_RDWR | os.O_NONBLOCK)
    try:
        request = bytearray(40)
        struct.pack_into("16sH", request, 0, name, IFF_TUN | IFF_NO_PI)
        fcntl.ioctl(descriptor, TUNSETIFF, request)
        flags = fcntl.fcntl(descriptor, fcntl.F_GETFL)
        fcntl.fcntl(descriptor, fcntl.F_SETFL, flags | os.O_NONBLOCK)
        return descriptor
    except Exception:
        os.close(descriptor)
        raise


def run_hook(path):
    result = subprocess.run([path], stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL, timeout=30)
    if result.returncode != 0:
        raise RuntimeError("Media link hook failed")


def resolve_gateway(transport):
    host = transport["host"]
    try:
        ipaddress.IPv4Address(host)
        return (host, transport["port"])
    except ValueError:
        pass
    addresses = socket.getaddrinfo(host, transport["port"], socket.AF_INET,
                                   socket.SOCK_DGRAM)
    return (addresses[0][4][0], transport["port"])


def _send(sock, data, address):
    try:
        sock.sendto(data, address)
    except OSError as error:
        if error.errno not in (errno.ENETUNREACH, errno.EHOSTUNREACH,
                               errno.ENOBUFS, errno.EAGAIN):
            raise


def client_rebind_due(now, created, last_received):
    """True when an unchanged client socket has seen no authenticated frame."""
    return now - max(created, last_received) >= CLIENT_REBIND_TIMEOUT


def rebind_client_socket(sock):
    """Return a bound nonblocking replacement for a stalled client socket.

    The replacement binds before the old socket closes so the operating system
    cannot hand back the stalled port; a failed replacement leaks nothing.
    """
    replacement = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        replacement.bind(("", 0))
        replacement.setblocking(False)
    except Exception:
        replacement.close()
        raise
    sock.close()
    return replacement


def _write_tun(tun, payload):
    try:
        os.write(tun, payload)
    except OSError as error:
        if error.errno not in (errno.EAGAIN, errno.ENOBUFS, errno.EIO):
            raise


def _stop(signum, frame):
    global STOP
    STOP = True


def serve(config):
    global STOP
    STOP = False
    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)
    plan = config["plan"]
    role = config["role"]
    transport = config["transport"]
    tun = open_tun(plan["interface"])
    sock = None
    hooked = False
    try:
        run_hook(config["up"])
        hooked = True
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        if role == "gateway":
            sock.bind(("0.0.0.0", transport["port"]))
            link = GatewayLink(config["key"], plan)
        else:
            sock.bind(("", 0))
            link = ClientLink(config["key"], plan, resolve_gateway(transport))
        sock.setblocking(False)
        socket_created = link.clock()
        link.emit = lambda data, address: _send(sock, data, address)
        link.tun_write = lambda payload: _write_tun(tun, payload)
        sys.stderr.write("udp-media-link: %s %s port %d\n" % (
            role, plan["interface"], transport["port"]))
        sys.stderr.flush()
        if role == "pbx":
            link.start()
        while not STOP:
            now = link.clock()
            # The emit closure reads this local, so replacing it rebinds sends.
            if role == "pbx" and client_rebind_due(now, socket_created,
                                                   link.last_received):
                sock = rebind_client_socket(sock)
                socket_created = now
                link.start()
            link.poll()
            readable, _, _ = select.select([sock, tun], [], [], link.timeout(now))
            if sock in readable:
                for _ in range(64):
                    try:
                        data, address = sock.recvfrom(MAX_FRAME + 1)
                    except (BlockingIOError, OSError) as error:
                        if isinstance(error, BlockingIOError) or \
                                error.errno == errno.EAGAIN:
                            break
                        raise
                    if len(data) > MAX_FRAME:
                        continue
                    link.handle_datagram(data, address)
            if tun in readable:
                for _ in range(64):
                    try:
                        packet = os.read(tun, 4096)
                    except OSError as error:
                        if error.errno == errno.EAGAIN:
                            break
                        raise
                    if not packet or len(packet) > MAX_PAYLOAD:
                        continue
                    link.send_data(packet)
    finally:
        if sock is not None:
            sock.close()
        if hooked:
            run_hook(config["down"])
        os.close(tun)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, help="media.conf path")
    arguments = parser.parse_args(argv)
    if os.geteuid() != 0:
        raise ValueError("Root is required")
    serve(load_configuration(arguments.config))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        sys.stderr.write("udp-media-link: %s\n" % (error,))
        sys.exit(1)
