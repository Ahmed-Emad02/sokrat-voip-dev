"""Per-installation media PKI; no shared tenant keys and no network side effects."""
import datetime
import secrets

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

from tunnel_media import validate_plan


def new_material(plan):
    validate_plan(plan)
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
        usage = ExtendedKeyUsageOID.CLIENT_AUTH if role == "gateway" else ExtendedKeyUsageOID.SERVER_AUTH
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
    return {name: material[name] for name in ("ca.crt", role + ".crt", role + ".key", "tls-crypt.key")}
