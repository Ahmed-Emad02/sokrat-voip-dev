#!/bin/bash
# ==============================================================================
# Sokrat VOIP — 100% Offline Issabel 5 & Asterisk 18 Appliance Setup Script
# Target OS: Rocky Linux 8.x
# Zero internet connection required. All ~670 RPMs & binaries bundled locally.
# ==============================================================================
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MARIADB_PASS="admin"
WEB_ADMIN_PASS="admin"
SIP_DRIVER="chan_sip"

echo "=================================================================="
echo " Starting 100% Offline Issabel 5 & Asterisk 18 Setup"
echo " MariaDB Password:     $MARIADB_PASS"
echo " Web Admin Password:   $WEB_ADMIN_PASS"
echo " Default SIP Protocol: $SIP_DRIVER"
echo " Internet Dependent:   NO (100% Local Bundle)"
echo "=================================================================="

# 1. Join split parts and unpack RPMs and Binaries
if ls "$SCRIPT_DIR"/sokrat-prereqs.tar.gz.part-* 1> /dev/null 2>&1; then
    echo "--> Reassembling multi-part offline archive and unpacking..."
    cat "$SCRIPT_DIR"/sokrat-prereqs.tar.gz.part-* | tar -xz -C "$SCRIPT_DIR/"
fi

# Detect rpm directory
RPM_DIR="$SCRIPT_DIR/all-rpms"
if [ ! -d "$RPM_DIR" ] && [ -d "$SCRIPT_DIR/rpms" ]; then
    RPM_DIR="$SCRIPT_DIR/rpms"
fi

# 2. Configure Local Offline RPM Repository
echo "--> Configuring local file repository..."
cat << REPO_EOF > /etc/yum.repos.d/sokrat-local-bundle.repo
[sokrat-local-bundle]
name=Sokrat Local Offline Bundle
baseurl=file://${RPM_DIR}/
enabled=1
gpgcheck=0
REPO_EOF

# Ensure git and tar are installed for repo management
if ! command -v git &>/dev/null; then
    rpm -Uvh --replacepkgs --nodeps "${RPM_DIR}"/git*.rpm "${RPM_DIR}"/perl*.rpm 2>/dev/null || true
fi
echo "--> Configuring local file repository..."
cat << REPO_EOF > /etc/yum.repos.d/sokrat-local-bundle.repo
[sokrat-local-bundle]
name=Sokrat Local Offline Bundle
baseurl=file://${RPM_DIR}/
enabled=1
gpgcheck=0
REPO_EOF

# 3. Disable SELinux immediately to avoid permission issues
echo "--> Disabling SELinux..."
setenforce 0 2>/dev/null || true
if [ -f /etc/selinux/config ]; then
    sed -i 's/SELINUX=enforcing/SELINUX=disabled/' /etc/selinux/config 2>/dev/null || true
fi

# 4. Install EVERYTHING strictly offline from the local bundle
echo "--> Installing all database, web, Asterisk 18 & Issabel 5 packages offline..."
dnf --disablerepo="*" --enablerepo="sokrat-local-bundle" install -y --nogpgcheck --allowerasing "${RPM_DIR}"/*.rpm || \
rpm -Uvh --replacepkgs --nodeps "${RPM_DIR}"/*.rpm || true

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

if [ -f "$SCRIPT_DIR/binaries/chan_dongle.so" ]; then
    mkdir -p /usr/lib64/asterisk/modules
    cp "$SCRIPT_DIR/binaries/chan_dongle.so" /usr/lib64/asterisk/modules/
fi

# 6. Start MariaDB and apply passwords non-interactively
echo "--> Starting MariaDB..."
systemctl enable --now mariadb
sleep 2

# Provision initial databases with install_amp if not present
if [ -d /usr/src/issabelPBX/framework ]; then
    echo "--> Running install_amp to seed asterisk & asteriskcdrdb..."
    /usr/src/issabelPBX/framework/install_amp --dbuser=root --dbpass="$MARIADB_PASS" --installdb --scripted --language=en 2>/dev/null || \
    /usr/src/issabelPBX/framework/install_amp --dbuser=root --installdb --scripted --language=en 2>/dev/null || true
fi

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

# Ensure chan_sip is enabled in modules_custom.conf
if [ -f /etc/asterisk/modules_custom.conf ]; then
    grep -q "load = chan_sip.so" /etc/asterisk/modules_custom.conf || echo "load = chan_sip.so" >> /etc/asterisk/modules_custom.conf
fi

# 8. Set proper file ownership and permissions for Issabel web GUI
echo "--> Setting file permissions..."
mkdir -p /var/www/html/var/templates_c
chown -R asterisk:asterisk /var/www/html /etc/asterisk /var/lib/asterisk /var/log/asterisk
chmod -R 775 /var/www/html/var 2>/dev/null || true
echo "--> Setting file permissions..."
chown -R asterisk:asterisk /var/www/html /etc/asterisk /var/lib/asterisk /var/log/asterisk
chmod -R 775 /var/www/html/var 2>/dev/null || true

# 9. Start and enable Asterisk & Apache
echo "--> Starting Asterisk and Apache services..."
systemctl enable --now httpd
systemctl enable --now php-fpm
systemctl enable --now asterisk
amportal a r 2>/dev/null || true

echo "=================================================================="
echo " 100% Offline Setup Complete!"
echo " MariaDB root password: $MARIADB_PASS"
echo " Issabel Web Admin:     admin / $WEB_ADMIN_PASS"
echo " SIP Driver configured: $SIP_DRIVER"
echo " System is ready for Sokrat VOIP installation."
echo "=================================================================="
