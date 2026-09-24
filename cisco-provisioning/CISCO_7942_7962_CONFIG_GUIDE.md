# Cisco 7942G / 7962G IP Phone Configuration Guide for Asterisk & Issabel PBX

A comprehensive guide for provisioning and connecting Cisco 7942G, 7962G, 7945G, and 7965G Unified IP phones with Asterisk (chan_sip) and Issabel / FreePBX environments.

---

## 📋 1. Prerequisites & Firmware Verification

Cisco 7942G/7962G phones were designed primarily for Cisco Unified Communications Manager (CUCM) using the SCCP (Skinny) protocol. To use them with standard Asterisk SIP, the phone **must have SIP firmware installed**.

### How to Check the Firmware Version
Open a browser and navigate to the phone's web interface:
```text
http://<PHONE_IP>/
```
Look for the **App Load ID**:
* **SIP Firmware (Compatible)**: Starts with `jar42sip` or `apps42sip` (e.g., `jar42sip.8-5-4TH1-6.sbn` or `apps42.9-3-1ES26.sbn`).
* **SCCP Firmware (Incompatible without cross-flashing)**: Starts with `jar42sccp` or `apps42sccp`.

> **Important**: In the XML configuration file, leave `<loadInformation></loadInformation>` **blank** unless you are deliberately upgrading firmware. Populating this tag with a firmware name that does not exist in `/tftpboot` will cause the phone to fail booting or enter an endless TFTP download loop.

---

## 🛠️ 2. TFTP Provisioning Setup

Cisco phones download their configuration via TFTP on boot.

### Required Files in `/tftpboot/`:
1. **`SEP<MAC_ADDRESS>.cnf.xml`**: Device configuration (MAC must be uppercase without colons, e.g., `SEP08CC68E96950.cnf.xml`).
2. **`dialplan.xml`**: Local dial rules allowing immediate dialing without waiting for inter-digit timers.
3. **`XMLDefault.cnf.xml`**: Default fallback specifying SIP protocol.

### Permissions
Ensure all files in `/tftpboot/` are readable by the TFTP daemon:
```bash
chmod 644 /tftpboot/*.xml
chown -R root:root /tftpboot/
```

### Enable TFTP Service (Issabel / CentOS / Rocky Linux)
Check `/etc/xinetd.d/tftp`:
```ini
service tftp
{
    socket_type     = dgram
    protocol        = udp
    wait            = yes
    user            = root
    server          = /usr/sbin/in.tftpd
    server_args     = -s -vv /tftpboot
    disable         = no
    flags           = IPv4
}
```
Restart xinetd:
```bash
systemctl restart xinetd
```

---

## 📱 3. Phone Keypad Configuration

To point the phone to the TFTP server manually:

1. Press the **Settings** button (icon with checkboxes/directories).
2. Navigate to **Network Configuration** (Option `3`) and press **Select**.
3. Press **`**#`** on the keypad to unlock settings (the padlock icon in the upper-right corner will change to an open lock).
4. Scroll to **Alternate TFTP** (Option `32`):
   * Press **Edit** (or the toggle softkey) to change to **`Yes`**.
   * Press **Save**.
5. Scroll to **TFTP Server 1** (Option `33`):
   * Press **Edit**.
   * Enter your PBX IP address (e.g., `192.168.100.128`).
   * *Use the `*` key on the numeric keypad to type each dot (`.`)*.
   * Press **Validate** and then **Save**.
6. Press the **Save** softkey at the bottom to apply network changes. The phone will restart its network stack and fetch the XML configuration.

---

## ⚠️ 4. The Critical Asterisk NAT / force_rport Issue

### The Symptom
The phone downloads its XML configuration, displays its extension number, but remains stuck on **"Registering"**.
In the phone's internal console log (`http://<PHONE_IP>/FS/cache/log`), you will see:
```text
ERR: JVM: %REG auth failed: ack timer
```
In Asterisk logs (`/var/log/asterisk/messages`), Asterisk receives `REGISTER`, sends `401 Unauthorized` challenge, and repeats the challenge 10+ times until timing out.

### The Cause
* In Asterisk / FreePBX / Issabel, extensions are often created with **`nat=yes`** (`force_rport=yes`) by default.
* Cisco 7942 SIP firmware is strictly compliant with RFC 3261 Via header routing. When `nat=yes` is enabled, Asterisk forces responses back to the UDP source port (`force_rport`).
* Because Cisco 7942 expects responses to follow the standard Via header routing, it **drops the 401 Unauthorized challenge packet**, timing out on its internal ACK timer.

### The Fix
For any Cisco IP phone on the local LAN, set **`nat=no`**.

In Issabel / FreePBX, add the override in `/etc/asterisk/sip_custom_post.conf` so it will survive GUI updates:
```ini
[110](+)
nat=no
```
Then reload the SIP module in Asterisk:
```bash
asterisk -rx "sip reload"
```

Verify registration status:
```bash
asterisk -rx "sip show peer 110"
```
You should see:
```text
Status       : OK (28 ms)
Useragent    : Cisco-CP7942G/8.5.3
Addr->IP     : 192.168.100.38:5060
Force rport  : No
Symmetric RTP: No
```

---

## 📄 5. XML Configuration File Anatomy

Key elements in `SEP<MAC>.cnf.xml`:

```xml
<device>
  <deviceProtocol>SIP</deviceProtocol>
  <!-- Keep empty to prevent firmware downgrade/reflash loops -->
  <loadInformation></loadInformation>

  <dialTemplate>dialplan.xml</dialTemplate>

  <devicePool>
    <dateTimeSetting>
      <dateTemplate>D/M/Y</dateTemplate>
      <!-- Cisco firmware requires exact predefined timezones -->
      <timeZone>Greenwich Standard Time</timeZone>
      <ntps>
        <ntp>
          <name>192.168.100.128</name>
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
            <processNodeName>192.168.100.128</processNodeName>
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

    <phoneLabel>110</phoneLabel>

    <sipLines>
      <line button="1">
        <featureID>9</featureID>
        <featureLabel>110</featureLabel>
        <proxy>192.168.100.128</proxy>
        <port>5060</port>
        <name>110</name>
        <displayName>110</displayName>
        <contact>110</contact>
        <autoAnswer>
          <autoAnswerEnabled>2</autoAnswerEnabled>
        </autoAnswer>
        <callWaiting>3</callWaiting>
        <authName>110</authName>
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
    </sipLines>
  </sipProfile>
</device>
```

---

## 🔍 6. Troubleshooting Diagnostics

### 1. View Live Phone Status via Web Browser
* Device Information: `http://<PHONE_IP>/CGI/Java/Serviceability?adapter=device.statistics.device`
* Network Configuration: `http://<PHONE_IP>/CGI/Java/Serviceability?adapter=device.statistics.configuration`
* Status & Error Messages: `http://<PHONE_IP>/CGI/Java/Serviceability?adapter=device.settings.status.messages`
* Raw System Console Logs: `http://<PHONE_IP>/FS/cache/log1` (or `log2`, `log3`)

### 2. Inspect TFTP Activity on the PBX
```bash
grep in.tftpd /var/log/messages | tail -n 30
```

### 3. Inspect SIP Handshake on Asterisk
Run in Asterisk CLI:
```bash
asterisk -rvvv
sip set debug on
```
Or check Asterisk security logs:
```bash
grep -E "ChallengeSent|SuccessfulAuth" /var/log/asterisk/messages | tail -n 20
```

### 4. Reboot Phone Remotely
From the phone keypad: Press `Settings` → enter `**#**`. The phone will reset and re-download its configuration files.
