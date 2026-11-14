"""Per-installation media PKI; no shared tenant keys and no network side effects.

Certificate roles follow the transport. For the default FRP path the PBX is the
TLS server (SERVER_AUTH) and the gateway the TLS client (CLIENT_AUTH); for
``direct-udp`` the roles are reversed. Names stay ``<pbxId>-<role>`` so the
peer's verify-x509-name check remains tenant-scoped in both directions. For
``plain-udp`` no certificate is generated: both roles share one 32-byte random
HMAC key in ``udp.key``.
"""
import datetime
import secrets

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

from tunnel_media import validate_plan, validate_transport

TLS_KEYS = ("ca.crt", "gateway.crt", "gateway.key", "pbx.crt", "pbx.key", "tls-crypt.key")


def new_material(plan, transport=None):
    validate_plan(plan)
    transport = validate_transport(transport, plan)
    if transport is not None and transport["mode"] == "plain-udp":
        return {"udp.key": secrets.token_hex(32) + "\n"}
    direct = transport is not None
    now = datetime.datetime.now(datetime.timezone.utc)
    ca_key = ec.generate_private_key(ec.SECP256R1())
    ca_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, plan["pbxId"] + "-media-ca")])
    ca = (x509.CertificateBuilder().subject_name(ca_name).issuer_name(ca_name)
          .public_key(ca_key.public_key()).serial_number(x509.random_serial_number())
          .not_valid_before(now - datetime.timedelta(minutes=5))
          .not_valid_after(now + datetime.timedelta(days=3650))
          .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
          .add_extension(x509.SubjectKeyIdentifier.from_public_key(ca_key.public_key()), critical=False)
          .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()), critical=False)
          .add_extension(x509.KeyUsage(digital_signature=True, content_commitment=False,
                         key_encipherment=False, data_encipherment=False, key_agreement=False,
                         key_cert_sign=True, crl_sign=True, encipher_only=False,
                         decipher_only=False), critical=True)
          .sign(ca_key, hashes.SHA256()))
    result = {"ca.crt": ca.public_bytes(serialization.Encoding.PEM).decode("ascii")}
    for role in ("gateway", "pbx"):
        key = ec.generate_private_key(ec.SECP256R1())
        name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, plan["pbxId"] + "-" + role)])
        # The TLS server certificate presents SERVER_AUTH; the client side
        # presents CLIENT_AUTH. Direct UDP swaps which host is the server.
        server = (role == "gateway") == direct
        usage = ExtendedKeyUsageOID.SERVER_AUTH if server else ExtendedKeyUsageOID.CLIENT_AUTH
        cert = (x509.CertificateBuilder().subject_name(name).issuer_name(ca_name)
                .public_key(key.public_key()).serial_number(x509.random_serial_number())
                .not_valid_before(now - datetime.timedelta(minutes=5))
                .not_valid_after(now + datetime.timedelta(days=825))
                .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
                .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False)
                .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()), critical=False)
                .add_extension(x509.KeyUsage(digital_signature=True, content_commitment=False,
                               key_encipherment=False, data_encipherment=False, key_agreement=False,
                               key_cert_sign=False, crl_sign=False, encipher_only=False,
                               decipher_only=False), critical=True)
                .add_extension(x509.ExtendedKeyUsage([usage]), critical=True)
                .sign(ca_key, hashes.SHA256()))
        result[role + ".crt"] = cert.public_bytes(serialization.Encoding.PEM).decode("ascii")
        result[role + ".key"] = key.private_bytes(serialization.Encoding.PEM,
                serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode("ascii")
    # Same 2048-bit static-key format emitted by openvpn --genkey secret.
    raw = secrets.token_hex(256)
    result["tls-crypt.key"] = ("-----BEGIN OpenVPN Static key V1-----\n" +
                                "\n".join(raw[n:n + 32] for n in range(0, len(raw), 32)) +
                                "\n-----END OpenVPN Static key V1-----\n")
    # CA signing key is deliberately not persisted: replacement requires a new pair.
    return result


def for_role(material, role):
    if role not in ("gateway", "pbx"):
        raise ValueError("Invalid media role")
    if "udp.key" in material:
        # Plain material is one shared key for both roles. A mixed bundle would
        # smuggle certificate material past the plain installer's exact check.
        if any(name in material for name in TLS_KEYS):
            raise ValueError("Mixed media material")
        return {"udp.key": material["udp.key"]}
    return {name: material[name] for name in
            ("ca.crt", role + ".crt", role + ".key", "tls-crypt.key")}
