#!/bin/bash
# Issabel Dashboard — Automated Uninstaller
# Removes dashboard application files and restores Issabel to default Apache configuration.
# DOES NOT touch the database.

set -euo pipefail

INSTALL_DIR=/opt/sokrat-voip

echo "============================================"
echo " Issabel Dashboard Uninstaller"
echo "============================================"

# 1. Stop and disable sokrat-voip service
echo "[1/5] Stopping and removing sokrat-voip systemd service..."
if systemctl is-active sokrat-voip &>/dev/null || systemctl is-enabled sokrat-voip &>/dev/null; then
    systemctl stop sokrat-voip 2>/dev/null || true
    systemctl disable sokrat-voip 2>/dev/null || true
fi
if [ -f /etc/systemd/system/sokrat-voip.service ]; then
    rm -f /etc/systemd/system/sokrat-voip.service
    systemctl daemon-reload
fi
echo "  Service stopped and unit file removed."
if systemctl is-active sokrat-softphone &>/dev/null || systemctl is-enabled sokrat-softphone &>/dev/null; then
    systemctl stop sokrat-softphone 2>/dev/null || true
    systemctl disable sokrat-softphone 2>/dev/null || true
fi
if [ -f /etc/systemd/system/sokrat-softphone.service ]; then
    rm -f /etc/systemd/system/sokrat-softphone.service
    systemctl daemon-reload
fi
echo "  Sokrat softphone service stopped and unit file removed."
if systemctl is-active sokrat-stt &>/dev/null || systemctl is-enabled sokrat-stt &>/dev/null; then
    systemctl stop sokrat-stt 2>/dev/null || true
    systemctl disable sokrat-stt 2>/dev/null || true
fi
if [ -f /etc/systemd/system/sokrat-stt.service ]; then
    rm -f /etc/systemd/system/sokrat-stt.service
    systemctl daemon-reload
fi
echo "  Sokrat STT service stopped and unit file removed."
if systemctl is-active sokrat-push-gateway &>/dev/null || systemctl is-enabled sokrat-push-gateway &>/dev/null; then
    systemctl stop sokrat-push-gateway 2>/dev/null || true
    systemctl disable sokrat-push-gateway 2>/dev/null || true
fi
if [ -f /etc/systemd/system/sokrat-push-gateway.service ]; then
    rm -f /etc/systemd/system/sokrat-push-gateway.service
    systemctl daemon-reload
fi
echo "  Sokrat Push Gateway service stopped and unit file removed."

# 2. Restore Apache configuration to default Issabel behavior
echo "[2/5] Restoring Apache web server configuration..."

# Remove dashboard reverse proxy config for port 80
if [ -f /etc/httpd/conf.d/dashboard.conf ]; then
    rm -f /etc/httpd/conf.d/dashboard.conf
    echo "  Removed /etc/httpd/conf.d/dashboard.conf"
fi

# Remove softphone reverse proxy config for port 8443
if [ -f /etc/httpd/conf.d/softphone.conf ]; then
    rm -f /etc/httpd/conf.d/softphone.conf
    echo "  Removed /etc/httpd/conf.d/softphone.conf"
fi

# Remove proxy directives inserted into ssl.conf
if [ -f /etc/httpd/conf.d/ssl.conf ]; then
    sed -i '/ProxyPreserveHost On/d' /etc/httpd/conf.d/ssl.conf 2>/dev/null || true
    sed -i '/RewriteEngine On/d' /etc/httpd/conf.d/ssl.conf 2>/dev/null || true
    sed -i '/RewriteCond %{HTTP:Upgrade}/d' /etc/httpd/conf.d/ssl.conf 2>/dev/null || true
    sed -i '/RewriteCond %{REQUEST_URI}/d' /etc/httpd/conf.d/ssl.conf 2>/dev/null || true
    sed -i '/RewriteRule.*ws:\/\/127\.0\.0\.1:8080/d' /etc/httpd/conf.d/ssl.conf 2>/dev/null || true
    sed -i '/ProxyPass.*8080/d' /etc/httpd/conf.d/ssl.conf 2>/dev/null || true
    sed -i '/ProxyPassReverse.*8080/d' /etc/httpd/conf.d/ssl.conf 2>/dev/null || true
    echo "  Cleaned proxy settings from /etc/httpd/conf.d/ssl.conf"
fi

# Remove Listen 3000 from httpd.conf and ensure Listen 80 is present
if [ -f /etc/httpd/conf/httpd.conf ]; then
    sed -i '/^Listen 3000/d' /etc/httpd/conf/httpd.conf
    if ! grep -q '^Listen 80' /etc/httpd/conf/httpd.conf; then
        echo "Listen 80" >> /etc/httpd/conf/httpd.conf
    fi
    echo "  Restored default Listen port (80) in httpd.conf"
fi

# Restart Apache to apply changes
if systemctl is-active httpd &>/dev/null; then
    systemctl restart httpd
    echo "  Apache restarted."
fi

# 3. Preserving database (explicit notice)
echo "[3/5] Database notice: Database tables were NOT touched or altered."

# 4. Remove root credential file if present
echo "[4/5] Cleaning up root credential file..."
rm -f /etc/sokrat-root-credential.txt

# 5. Remove dashboard directory
echo "[5/5] Removing dashboard installation directory..."
cd /tmp
if [ -d "$INSTALL_DIR" ]; then
    rm -rf "$INSTALL_DIR"
    echo "  Removed $INSTALL_DIR"
fi
if [ -d "/opt/sokrat-softphone" ]; then
    rm -rf "/opt/sokrat-softphone"
    echo "  Removed /opt/sokrat-softphone"
fi
if [ -d "/opt/sokrat-push-gateway" ]; then
    rm -rf "/opt/sokrat-push-gateway"
    echo "  Removed /opt/sokrat-push-gateway"
fi

echo "============================================"
echo " Uninstallation complete! Issabel default web GUI restored."
echo "============================================"
