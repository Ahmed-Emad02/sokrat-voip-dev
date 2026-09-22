#!/bin/bash
# ==============================================================================
# Sokrat VOIP — Issabel 5 & Asterisk 18 Offline Appliance Setup Script
# Target OS: Rocky Linux 8.x
# ==============================================================================
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MARIADB_PASS="admin"
WEB_ADMIN_PASS="admin"
SIP_DRIVER="chan_sip"

echo "=================================================================="
echo " Starting Issabel 5 & Asterisk 18 Setup"
echo " MariaDB Password:     $MARIADB_PASS"
echo " Web Admin Password:   $WEB_ADMIN_PASS"
echo " Default SIP Protocol: $SIP_DRIVER"
echo "=================================================================="

# 1. Join split parts and unpack RPMs and Binaries
if ls "$SCRIPT_DIR"/sokrat-prereqs.tar.gz.part-* 1> /dev/null 2>&1; then
    echo "--> Reassembling multi-part archive and unpacking..."
    cat "$SCRIPT_DIR"/sokrat-prereqs.tar.gz.part-* | tar -xz -C "$SCRIPT_DIR/"
fi

# 2. Configure Local RPM Repository
echo "--> Configuring local file repository..."
cat << REPO_EOF > /etc/yum.repos.d/sokrat-local-bundle.repo
[sokrat-local-bundle]
name=Sokrat Local Bundle
baseurl=file://${SCRIPT_DIR}/rpms/
enabled=1
gpgcheck=0
REPO_EOF

# 3. Enable remi php:remi-7.4 and powertools for Rocky 8 if present
dnf -y module reset php 2>/dev/null || true
dnf -y module enable php:remi-7.4 2>/dev/null || dnf -y module enable php:7.4 2>/dev/null || true
dnf -y config-manager --set-enabled powertools 2>/dev/null || true

# 4. Install MariaDB, Apache, and Asterisk 18 + Issabel 5 from local repo
echo "--> Installing Asterisk 18 and Issabel 5 packages..."
dnf --disablerepo="*" --enablerepo="sokrat-local-bundle" install -y \
    mariadb-server mariadb httpd \
    asterisk18 asterisk18-core asterisk18-dahdi asterisk18-devel asterisk18-configs asterisk18-voicemail \
    issabel-framework issabelPBX issabel-security issabel-reports issabel-addons \
    sox sqlite || dnf install -y "${SCRIPT_DIR}"/rpms/*.rpm

# 5. Install binaries (Node.js, ffmpeg, pico2wave)
echo "--> Installing core binaries..."
if [ -f "$SCRIPT_DIR/binaries/node" ]; then
    cp "$SCRIPT_DIR/binaries/node" /usr/local/bin/
    chmod +x /usr/local/bin/node
fi

if [ -f "$SCRIPT_DIR/binaries/ffmpeg" ]; then
    cp "$SCRIPT_DIR/binaries/ffmpeg" /usr/local/bin/
    chmod +x /usr/local/bin/ffmpeg
fi

if [ -f "$SCRIPT_DIR/binaries/pico2wave" ]; then
    cp "$SCRIPT_DIR/binaries/pico2wave" /usr/bin/
    chmod +x /usr/bin/pico2wave
fi

if [ -d "$SCRIPT_DIR/binaries/picotts" ]; then
    mkdir -p /usr/share/picotts
    cp -r "$SCRIPT_DIR/binaries/picotts/"* /usr/share/picotts/
fi

# 6. Start MariaDB and apply passwords non-interactively
echo "--> Starting MariaDB..."
systemctl enable --now mariadb
sleep 2

echo "--> Initializing Issabel 5 non-interactively..."
touch /installamp

if [ -f /usr/bin/issabel-admin-passwords ]; then
    /usr/bin/issabel-admin-passwords --cli init "$MARIADB_PASS" "$WEB_ADMIN_PASS" || true
fi

# Disable interactive firstboot prompt on reboot
systemctl disable issabel-firstboot.service 2>/dev/null || true

# 7. Configure SIP Driver to chan_sip
echo "--> Setting default SIP driver to $SIP_DRIVER..."
mysql -u root -p"$MARIADB_PASS" asterisk -e "UPDATE issabelpbx_settings SET value = '$SIP_DRIVER' WHERE keyword = 'SIPDRIVER';" 2>/dev/null || true

# 8. Start and enable Asterisk & Apache
echo "--> Starting Asterisk and Apache services..."
systemctl enable --now httpd
systemctl enable --now asterisk
amportal a r 2>/dev/null || true

echo "=================================================================="
echo " Issabel 5 & Asterisk 18 Setup Complete!"
echo " MariaDB root password: $MARIADB_PASS"
echo " Issabel Web Admin:     admin / $WEB_ADMIN_PASS"
echo " SIP Driver configured: $SIP_DRIVER"
echo " System is ready for Sokrat VOIP installation."
echo "=================================================================="
