# Cisco 7942G / 7962G / 7945G / 7965G IP Phone Configuration Guide for Asterisk & Issabel PBX

A comprehensive, production-tested guide for provisioning and connecting Cisco 7942G, 7962G, 7945G, and 7965G Unified IP phones with Asterisk (`chan_sip`) and Issabel / FreePBX environments on Rocky Linux 8 / CentOS 8.

---

## 📱 Model Comparison & Architecture

| Feature | Cisco 7942G | Cisco 7962G | Cisco 7945G | Cisco 7965G |
| :--- | :--- | :--- | :--- | :--- |
| **Display** | 4-bit Grayscale (320x222) | 4-bit Grayscale (320x222) | **Color TFT** (320x240) | **Color TFT** (320x240) |
| **Ethernet** | 10/100 Mbps | 10/100 Mbps | **Gigabit 10/100/1000** | **Gigabit 10/100/1000** |
| **Line Keys** | 2 | 6 | 2 | 6 |
| **Audio** | Wideband G.722 | Wideband G.722 | Wideband G.722 | Wideband G.722 |
| **SIP Firmware Prefix** | `jar42sip` / `apps42sip` | `jar42sip` / `apps42sip` | `jar45sip` / `apps45sip` | `jar45sip` / `apps45sip` |
| **SCCP Firmware Prefix** | `jar42sccp` / `apps42sccp` | `jar42sccp` / `apps42sccp` | `jar45sccp` / `apps45sccp` | `jar45sccp` / `apps45sccp` |

---

## 📋 1. Prerequisites & Firmware Verification

Cisco 7900-series phones were designed primarily for Cisco Unified Communications Manager (CUCM) using the proprietary SCCP (Skinny) protocol. To connect them to standard Asterisk `chan_sip`, the phone **must have SIP firmware installed**.

### How to Check the Firmware Version
Open a web browser and navigate to the phone's web interface:
```text
http://<PHONE_IP>/
```
Look for the **App Load ID**:

* **SIP Firmware (Ready for Asterisk)**:
  * **7942G / 7962G**: Starts with `jar42sip` or `apps42sip` (e.g. `jar42sip.8-5-4TH1-6.sbn` or `apps42.9-3-1ES26.sbn`).
  * **7945G / 7965G**: Starts with `jar45sip` or `apps45sip` (e.g. `jar45sip.8-4-2-38.sbn` or `apps45.9-4-2SR1-1S.sbn`).
* **SCCP Firmware (Incompatible without cross-flashing)**:
  * Starts with `jar42sccp`, `apps42sccp`, `jar45sccp`, or `apps45sccp`. The phone will not talk to Asterisk `chan_sip` until flashed with a SIP firmware image.

> ⚠️ **CRITICAL FIRMWARE SAFETY RULE**: In your XML configuration file (`SEP<MAC>.cnf.xml`), **always leave `<loadInformation></loadInformation>` completely blank** unless you have staged the exact firmware binaries in `/tftpboot`. Populating this tag with a firmware name that is missing or inaccessible will cause the phone to fail booting or enter an endless TFTP download loop.

---

## 🛠️ 2. TFTP Provisioning Setup (Rocky Linux 8 / Issabel 5)

Cisco phones fetch their initial configuration via TFTP (UDP port 69) on boot.

### Required Files in `/tftpboot/`:
1. **`SEP<MAC_ADDRESS>.cnf.xml`**: Device configuration (MAC must be uppercase without colons, e.g. `SEP002414B20F3E.cnf.xml`).
2. **`dialplan.xml`**: Local dial rules allowing immediate dialing without waiting for inter-digit timers.
3. **`XMLDefault.cnf.xml`**: Fallback configuration specifying the SIP protocol.

### Step 1: Set Permissions
Ensure all files in `/tftpboot/` are readable:
```bash
chmod 644 /tftpboot/*.xml
chown -R root:root /tftpboot/
```

### Step 2: Configure Systemd TFTP Daemon
On modern Rocky Linux 8 / Issabel 5, `xinetd` is obsolete. TFTP is managed by systemd (`tftp.socket` and `tftp.service`).

By default, systemd points `in.tftpd` to `/var/lib/tftpboot`. To serve files from `/tftpboot`, create a systemd drop-in override:

```bash
mkdir -p /etc/systemd/system/tftp.service.d
cat << 'EOF' > /etc/systemd/system/tftp.service.d/override.conf
[Service]
ExecStart=
ExecStart=/usr/sbin/in.tftpd -s -v -v /tftpboot
EOF

# Create a symlink safeguard so either path resolves
rmdir /var/lib/tftpboot 2>/dev/null
ln -s /tftpboot /var/lib/tftpboot

# Reload systemd and start the TFTP services
systemctl daemon-reload
systemctl enable --now tftp.socket
systemctl enable --now tftp.service
```

Verify that TFTP is listening on UDP port 69:
```bash
systemctl status tftp.socket tftp.service
ss -lunp | grep 69
```

### Step 3: Open the Firewall (firewalld)
By default, `firewalld` blocks incoming TFTP traffic. You **must** open UDP port 69:
```bash
firewall-cmd --add-port=69/udp --permanent
firewall-cmd --reload
```

### Step 4: Verify TFTP Service Locally
Test that TFTP is actively serving configuration files using Python:
```bash
python3 -c "
import socket
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
rrq = b'\x00\x01XMLDefault.cnf.xml\x00octet\x00'
s.sendto(rrq, ('127.0.0.1', 69))
s.settimeout(2.0)
try:
    data, addr = s.recvfrom(516)
    if data[:2] == b'\x00\x03':
        print('✅ TFTP Server is working! Received DATA block #1')
    else:
        print('Received unexpected opcode:', data[:2])
except Exception as e:
    print('❌ TFTP test failed:', e)
"
```

---

## 📱 3. Phone Keypad Configuration

To point the Cisco handset to your PBX TFTP server:

1. Press the physical **Settings** button (icon with checkboxes/folder).
2. Navigate to **Network Configuration** (Option `3`) and press **Select**.
3. Press **`**#`** on the keypad to unlock editing (the padlock icon in the upper-right corner will change to an **open lock**).
4. Scroll to **Alternate TFTP** (Option `32`):
   * Press **Edit** (or the toggle softkey) to change the value to **`Yes`**.
   * Press **Save**.
5. Scroll to **TFTP Server 1** (Option `33`):
   * Press **Edit**.
   * Enter your PBX IP address (e.g. `192.168.100.50`).
   * *Note: Press the `*` key on the numeric keypad to type dots (`.`)*.
   * Press **Validate** and then **Save**.
6. Press the **Save** softkey at the bottom of the screen. The phone will restart its network stack, request `SEP<MAC>.cnf.xml` from the PBX, and apply the configuration.

---

## ⚠️ 4. The Critical Asterisk NAT / force_rport Issue

### The Symptom
The phone downloads its XML configuration via TFTP, shows its assigned extension number on the display, but remains permanently stuck on **"Registering"**.

In the phone's internal console log (`http://<PHONE_IP>/FS/cache/log2`), you will see:
```text
ERR: JVM: %REG auth failed: ack timer
```
In Asterisk logs (`/var/log/asterisk/messages`), Asterisk receives `REGISTER`, sends a `401 Unauthorized` challenge, and repeats the challenge repeatedly without ever receiving the authenticated response.

### The Cause
* FreePBX / Issabel extensions default to **`nat=yes`** (`force_rport=yes`, `comedia=yes`).
* Cisco 7900-series SIP firmware strictly enforces RFC 3261 Via header routing. When `nat=yes` is enabled, Asterisk forces responses back to the UDP source port (`force_rport`).
* Because the Cisco phone expects responses to match standard Via header routing, it **drops the 401 challenge packet**, timing out on its internal ACK timer.

### The Fix
For any Cisco IP phone on the local LAN or VPN, you **must disable NAT**:

1. In `/etc/asterisk/sip_custom_post.conf`, add a persistent override for the extension:
   ```ini
   [101](+)
   nat=no
   ```
2. Also update MariaDB so GUI changes (`retrieve_conf`) retain `nat=no`:
   ```bash
   mysql -u root -padmin asterisk -e "UPDATE sip SET data='no' WHERE id='101' AND keyword='nat';"
   /var/lib/asterisk/bin/retrieve_conf
   asterisk -rx "sip reload"
   ```

### Verify Registration
Run the Asterisk peer inspection command:
```bash
asterisk -rx "sip show peer 101"
```
You should see:
```text
Status       : OK (28 ms)
Useragent    : Cisco-CP7945G/8.4.0   (or Cisco-CP7942G/8.5.3)
Addr->IP     : 192.168.100.96:5060
Force rport  : No
Symmetric RTP: No
```

---

## 📄 5. XML Configuration File Anatomy

The device configuration file must be named `/tftpboot/SEP<MAC>.cnf.xml` (all uppercase MAC address without colons, e.g. `SEP002414B20F3E.cnf.xml`).

```xml
<?xml version="1.0" encoding="UTF-8"?>
<device>
  <deviceProtocol>SIP</deviceProtocol>
  <!-- Keep empty to prevent firmware downgrade/reflash loops -->
  <loadInformation></loadInformation>
  <sshUserId>admin</sshUserId>
  <sshPassword>admin</sshPassword>

  <dialTemplate>dialplan.xml</dialTemplate>

  <devicePool>
    <dateTimeSetting>
      <dateTemplate>D/M/Y</dateTemplate>
      <!-- Cisco firmware requires exact predefined timezones -->
      <timeZone>Greenwich Standard Time</timeZone>
      <ntps>
        <ntp>
          <name>192.168.100.50</name>
          <ntpMode>Unicast</ntpMode>
        </ntp>
      </ntps>
    </dateTimeSetting>

    <callManagerGroup>
      <members>
        <member priority="0">
          <callManager>
            <ports>
              <ethernetPhonePort>2000</ethernetPhonePort>
              <sipPort>5060</sipPort>
              <securedSipPort>5061</securedSipPort>
            </ports>
            <processNodeName>192.168.100.50</processNodeName>
          </callManager>
        </member>
      </members>
    </callManagerGroup>
  </devicePool>

  <sipProfile>
    <sipProxies>
      <backupProxy></backupProxy>
      <backupProxyPort></backupProxyPort>
      <emergencyProxy></emergencyProxy>
      <emergencyProxyPort></emergencyProxyPort>
      <outboundProxy></outboundProxy>
      <outboundProxyPort></outboundProxyPort>
      <registerWithProxy>true</registerWithProxy>
    </sipProxies>

    <dialTemplate>dialplan.xml</dialTemplate>

    <sipPorts>
      <sipPort>5060</sipPort>
    </sipPorts>

    <!-- Disables KPML overlap dialing (Fixes 484 Address Incomplete errors) -->
    <kpml>0</kpml>

    <phoneLabel>101</phoneLabel>

    <sipLines>
      <!-- Line 1 -->
      <line button="1">
        <featureID>9</featureID>
        <featureLabel>101</featureLabel>
        <proxy>192.168.100.50</proxy>
        <port>5060</port>
        <name>101</name>
        <displayName>101</displayName>
        <contact>101</contact>
        <autoAnswer>
          <autoAnswerEnabled>2</autoAnswerEnabled>
        </autoAnswer>
        <callWaiting>3</callWaiting>
        <authName>101</authName>
        <authPassword>sss333</authPassword>
        <sharedLine>false</sharedLine>
        <messageWaitingLampPolicy>1</messageWaitingLampPolicy>
        <messagesNumber>*97</messagesNumber>
        <ringSettingIdle>4</ringSettingIdle>
        <ringSettingActive>5</ringSettingActive>
        <forwardCallInfoDisplay>
          <callerName>true</callerName>
          <callerNumber>false</callerNumber>
          <redirectedNumber>false</redirectedNumber>
          <dialedNumber>true</dialedNumber>
        </forwardCallInfoDisplay>
      </line>

      <!-- Optional Line 2 (for multi-line models: 7942G, 7945G, 7962G, 7965G) -->
      <!--
      <line button="2">
        <featureID>9</featureID>
        <featureLabel>102</featureLabel>
        <proxy>192.168.100.50</proxy>
        <port>5060</port>
        <name>102</name>
        <displayName>102</displayName>
        <contact>102</contact>
        <authName>102</authName>
        <authPassword>sss333</authPassword>
      </line>
      -->
    </sipLines>
  </sipProfile>
</device>
```

---

## 📋 6. Fast Dial Plan (`dialplan.xml`)

Without a dialplan template, Cisco phones pause for 5 to 10 seconds after dialing before initiating a call (waiting for the inter-digit timer).

Save this to `/tftpboot/dialplan.xml`:
```xml
<DIALTEMPLATE>
    <!-- Match 3-digit extensions (100-999) immediately without delay -->
    <TEMPLATE MATCH="..." TIMEOUT="0"/>
    <!-- Match feature codes like *97, *8, etc. immediately -->
    <TEMPLATE MATCH="*#" TIMEOUT="0" Rewrite="%1"/>
    <!-- Fallback for standard numbers -->
    <TEMPLATE MATCH="*" TIMEOUT="4"/>
</DIALTEMPLATE>
```

---

## 🔍 7. Troubleshooting, Diagnostics & Remote Management

### 1. View Live Phone Status via Web Browser
Cisco phones host a built-in web server with real-time diagnostic pages:
* **Device Information**: `http://<PHONE_IP>/CGI/Java/Serviceability?adapter=device.statistics.device`
* **Network & TFTP Settings**: `http://<PHONE_IP>/CGI/Java/Serviceability?adapter=device.statistics.configuration`
* **Status & Error Messages**: `http://<PHONE_IP>/CGI/Java/Serviceability?adapter=device.settings.status.messages`
* **Raw Console Logs**: `http://<PHONE_IP>/FS/cache/log2` (shows real-time registration attempts and SIP transactions)

### 2. Inspect TFTP Activity on the PBX
To watch TFTP requests as phones boot:
```bash
journalctl -u tftp.service -f
```

### 3. Remote Reboot & Config Reload via Asterisk SIP NOTIFY
Instead of walking to the physical phone or power cycling it, you can trigger a remote configuration reload and reboot from the Asterisk CLI.

1. Ensure the Cisco check-sync event is defined in `/etc/asterisk/sip_notify_custom.conf`:
   ```ini
   [cisco-check-cfg]
   Event=>check-sync
   Content-Length=>0
   ```
2. Reload Asterisk SIP:
   ```bash
   asterisk -rx "sip reload"
   ```
3. Issue the reboot command to the phone extension:
   ```bash
   asterisk -rx "sip notify cisco-check-cfg 101"
   ```
   The phone will respond with `200 OK`, reload its TFTP configuration, and reboot.

### 4. Originating a Verification Call
Test audio transmission and ringing directly from the PBX:
```bash
asterisk -rx "channel originate SIP/101 application Playback tt-weasels"
```
The phone will ring with G.722 wideband audio.

### 5. Moving a Phone from an Old PBX (Legacy IP Trap)
If a phone was previously provisioned with an old PBX IP (e.g. `192.168.100.237`), its non-volatile memory retains that IP as its SIP proxy. If the phone is powered on before fetching the new TFTP configuration, it will broadcast ARP requests looking for the old IP.

To intercept the phone and allow it to connect immediately:
```bash
# Add the legacy IP as a temporary secondary IP on your PBX interface:
ip addr add 192.168.100.237/24 dev enp7s0
```
Asterisk will immediately answer the registration request, allowing you to send `sip notify cisco-check-cfg` to force the phone to download its new TFTP configuration.
