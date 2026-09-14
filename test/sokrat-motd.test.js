const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

test("Sokrat MOTD Script", async (t) => {
    const mockBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "sokrat-motd-test-"));
    const cacheFile = path.join(mockBinDir, ".sokrat_public_ip");
    
    // Create a helper to write mock commands
    const writeMock = (cmd, script) => {
        const filePath = path.join(mockBinDir, cmd);
        fs.writeFileSync(filePath, `#!/bin/bash\n${script}\n`);
        fs.chmodSync(filePath, "755");
    };

    t.after(() => {
        fs.rmSync(mockBinDir, { recursive: true, force: true });
    });

    // Default mock ip command
    writeMock("ip", `
        if [ "$1" = "-4" ] && [ "$2" = "-o" ] && [ "$3" = "addr" ] && [ "$4" = "show" ]; then
            echo "1: lo    inet 127.0.0.1/8 scope host lo\\       valid_lft forever preferred_lft forever"
            echo "2: eth0    inet 192.168.1.50/24 brd 192.168.1.255 scope global eth0\\       valid_lft forever preferred_lft forever"
            echo "3: tailscale0    inet 100.64.0.1/32 scope global tailscale0\\       valid_lft forever preferred_lft forever"
            echo "4: docker0    inet 172.17.0.1/16 scope global docker0\\       valid_lft forever preferred_lft forever"
            echo "5: veth1234    inet 172.18.0.2/16 scope global veth1234\\       valid_lft forever preferred_lft forever"
            exit 0
        fi
        exit 0
    `);

    // Default mock curl command
    writeMock("curl", `
        if [[ "$*" == *"ifconfig.me"* ]]; then
            echo "203.0.113.5"
            exit 0
        fi
        exit 1
    `);

    await t.test("Normal execution with all services active and dongles", async () => {
        writeMock("systemctl", `
            if [ "$1" = "is-active" ] && [ "$2" = "sokrat-voip" ]; then
                echo "active"
                exit 0
            fi
            exit 1
        `);

        writeMock("asterisk", `
            if [ "$2" = "core show version" ]; then
                echo "Asterisk 18.19.0 built by root on x86_64"
                exit 0
            elif [ "$2" = "core show channels" ]; then
                echo "2 active calls"
                exit 0
            elif [ "$2" = "dongle show devices" ]; then
                echo "ID           Group State      RSSI Mode Submode Provider Name  Model      Firmware          IMEI             IMSI             Number        "
                echo "dongle0      0     Free       18   0    0       Vodafone       E173       11.126.15.00.00   86...            ...              Unknown       "
                echo "dongle1      0     Free       23   0    0       Orange EG      E173       21.157.71.00.272  868...           ...              Unknown       "
                echo "dongle2      0     Not connec 0    0    0       NONE                                                                          Unknown       "
                exit 0
            fi
            exit 1
        `);

        fs.writeFileSync(cacheFile, "203.0.113.5\n");

        const { stdout, stderr } = await execFileAsync("bash", ["scripts/sokrat-motd.sh"], {
            env: { ...process.env, PATH: `${mockBinDir}:${process.env.PATH}`, SOKRAT_PUBLIC_IP_CACHE: cacheFile }
        });

        assert.ok(stdout.includes("SOKRAT VOIP Enterprise PBX Dashboard"), "Missing logo text");
        assert.ok(stdout.includes("Dashboard Access:"), "Missing URL section");
        assert.ok(stdout.includes("\x1b[1;37mSokrat Service: \x1b[1;32m● ACTIVE"), "Missing active service status with white label");
        assert.ok(stdout.includes("\x1b[1;37mAsterisk:       \x1b[1;32m● Asterisk 18.19.0"), "Missing asterisk active status with white label");
        assert.ok(stdout.includes("Active Calls: \x1b[1;31m2"), "Missing asterisk calls in red");
        assert.ok(stdout.includes("\x1b[1;37mSystem load:"), "Missing system load label in white");
        assert.ok(stdout.includes("\x1b[1;37mMemory:         \x1b[1;37m[\x1b[1;31m"), "Memory gauge brackets should be white and bar red");
        assert.ok(stdout.includes("\x1b[1;37mUsage on /:     \x1b[1;37m[\x1b[1;31m"), "Usage on / gauge brackets should be white and bar red");
        assert.ok(stdout.includes("\x1b[1;37mSwap usage:     \x1b[1;31m"), "Swap usage stat value should be red");
        assert.ok(stdout.includes("GSM Dongles"), "Missing dongles section");
        assert.ok(stdout.includes("DEVICE       STATE          RSSI       PROVIDER          PHONE NUMBER"), "Missing aligned table header");
        assert.ok(stdout.includes("dongle0"), "Missing dongle0");
        assert.ok(stdout.includes("Vodafone"), "Missing provider name");
        assert.ok(stdout.includes("dongle2"), "Missing dongle2");
        assert.ok(stdout.includes("Not connec"), "Missing Not connected state");
        assert.equal(stderr, "", "Should not have any stderr output");
    });

    await t.test("Offline Asterisk and inactive systemctl", async () => {
        writeMock("systemctl", `
            if [ "$1" = "is-active" ] && [ "$2" = "sokrat-voip" ]; then
                echo "inactive"
                exit 0
            fi
            exit 1
        `);

        writeMock("asterisk", `
            if [ "$2" = "core show version" ]; then
                echo "Unable to connect to remote asterisk (does /var/run/asterisk/asterisk.ctl exist?)"
                exit 1
            fi
            exit 1
        `);

        const { stdout, stderr } = await execFileAsync("bash", ["scripts/sokrat-motd.sh"], {
            env: { ...process.env, PATH: `${mockBinDir}:${process.env.PATH}`, SOKRAT_PUBLIC_IP_CACHE: cacheFile }
        });

        assert.ok(stdout.includes("Sokrat Service: \x1b[1;31m○ INACTIVE"), "Missing inactive service status");
        assert.ok(stdout.includes("Asterisk:       \x1b[1;31m○ OFFLINE"), "Missing asterisk offline status");
        assert.ok(stdout.includes("No GSM dongles detected / Asterisk offline"), "Missing offline dongles message");
        assert.equal(stderr, "", "Should not have any stderr output");
    });

    await t.test("Asterisk active but no chan_dongle loaded", async () => {
        writeMock("systemctl", `echo "active"`);
        writeMock("asterisk", `
            if [ "$2" = "core show version" ]; then
                echo "Asterisk 18.19.0"
                exit 0
            elif [ "$2" = "core show channels" ]; then
                echo "0 active calls"
                exit 0
            elif [ "$2" = "dongle show devices" ]; then
                echo "No such command 'dongle show devices' (type 'core show help dongle show' for other possible commands)"
                exit 1
            fi
            exit 1
        `);

        const { stdout, stderr } = await execFileAsync("bash", ["scripts/sokrat-motd.sh"], {
            env: { ...process.env, PATH: `${mockBinDir}:${process.env.PATH}`, SOKRAT_PUBLIC_IP_CACHE: cacheFile }
        });

        assert.ok(stdout.includes("No GSM dongles detected / Asterisk offline"), "Missing offline/missing dongles message");
        assert.ok(!stdout.includes("DEVICE    STATE"), "Table should not be printed");
    });

    await t.test("chan_dongle loaded but no dongles plugged in", async () => {
        writeMock("systemctl", `echo "active"`);
        writeMock("asterisk", `
            if [ "$2" = "core show version" ]; then
                echo "Asterisk 18.19.0"
                exit 0
            elif [ "$2" = "core show channels" ]; then
                echo "0 active calls"
                exit 0
            elif [ "$2" = "dongle show devices" ]; then
                echo "ID           Group State      RSSI Mode Submode Provider Name  Model      Firmware          IMEI             IMSI             Number        "
                exit 0
            fi
            exit 1
        `);

        const { stdout, stderr } = await execFileAsync("bash", ["scripts/sokrat-motd.sh"], {
            env: { ...process.env, PATH: `${mockBinDir}:${process.env.PATH}`, SOKRAT_PUBLIC_IP_CACHE: cacheFile }
        });

        assert.ok(stdout.includes("No GSM dongles connected"), "Missing no dongles message");
    });

    await t.test("Network Addresses multi-interface output, container filtering, and WAN IP", async () => {
        fs.writeFileSync(cacheFile, "203.0.113.5\n");

        const { stdout, stderr } = await execFileAsync("bash", ["scripts/sokrat-motd.sh"], {
            env: { ...process.env, PATH: `${mockBinDir}:${process.env.PATH}`, SOKRAT_PUBLIC_IP_CACHE: cacheFile }
        });

        assert.ok(stdout.includes("Network Addresses"), "Missing Network Addresses header");
        assert.ok(stdout.includes("INTERFACE    TYPE           IPV4 ADDRESS        SCOPE / INFO"), "Missing Network Addresses table header");
        assert.ok(stdout.includes("eth0"), "Missing eth0 interface");
        assert.ok(stdout.includes("Private"), "Missing Private classification");
        assert.ok(stdout.includes("192.168.1.50"), "Missing eth0 IP");
        assert.ok(stdout.includes("Internal LAN"), "Missing Internal LAN scope");
        assert.ok(stdout.includes("tailscale0"), "Missing tailscale0 interface");
        assert.ok(stdout.includes("VPN/Mesh"), "Missing VPN/Mesh classification");
        assert.ok(stdout.includes("100.64.0.1"), "Missing tailscale IP");
        assert.ok(stdout.includes("VPN Overlay"), "Missing VPN Overlay scope");
        assert.ok(stdout.includes("external"), "Missing external interface");
        assert.ok(stdout.includes("Public"), "Missing Public classification");
        assert.ok(stdout.includes("203.0.113.5"), "Missing public WAN IP");
        assert.ok(stdout.includes("External Gateway"), "Missing External Gateway scope");
        assert.ok(!stdout.includes("docker0"), "docker0 should be filtered out");
        assert.ok(!stdout.includes("veth1234"), "veth1234 should be filtered out");
        assert.equal(stderr, "", "Should not have any stderr output");
    });

    await t.test("Network Addresses offline/unavailable fallback when curl fails", async () => {
        writeMock("curl", "exit 1");
        fs.writeFileSync(cacheFile, "");

        const { stdout, stderr } = await execFileAsync("bash", ["scripts/sokrat-motd.sh"], {
            env: { ...process.env, PATH: `${mockBinDir}:${process.env.PATH}`, SOKRAT_PUBLIC_IP_CACHE: cacheFile }
        });

        assert.ok(stdout.includes("external"), "Missing external interface");
        assert.ok(stdout.includes("Unavailable / Offline"), "Missing Unavailable / Offline status");
        assert.equal(stderr, "", "Should not have any stderr output");
    });
});
