"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ejs = require("ejs");

test("Sidebar: Sokrat Gateway tunnel button and modal render strictly for root user only", () => {
    const templatePath = path.join(__dirname, "../views/sidebar.ejs");
    const template = fs.readFileSync(templatePath, "utf8");

    // Case 1: Root user
    const htmlRoot = ejs.render(template, {
        isRootUser: true,
        currentUser: "root",
        user: "root",
        isSuperAdmin: true,
        currentLang: "en",
        isRtl: false,
        activeTab: "dashboard",
        userPermissions: ["*"],
        crmConnected: false
    });
    assert.match(htmlRoot, /id="gatewayTunnelBtn"/, "Root user must see the Gateway Tunnel button");
    assert.match(htmlRoot, /id="gatewayTunnelModal"/, "Root user must have the Gateway Tunnel modal in DOM");

    // Case 2: Non-root user (admin)
    const htmlAdmin = ejs.render(template, {
        isRootUser: false,
        currentUser: "admin",
        user: "admin",
        isSuperAdmin: true,
        currentLang: "en",
        isRtl: false,
        activeTab: "dashboard",
        userPermissions: ["*"],
        crmConnected: false
    });
    assert.doesNotMatch(htmlAdmin, /id="gatewayTunnelBtn"/, "Non-root admin must NOT see the Gateway Tunnel button");
    assert.doesNotMatch(htmlAdmin, /id="gatewayTunnelModal"/, "Non-root admin must NOT have the Gateway Tunnel modal");

    // Case 3: Regular user (employee)
    const htmlUser = ejs.render(template, {
        isRootUser: false,
        currentUser: "user1",
        user: "user1",
        isSuperAdmin: false,
        currentLang: "ar",
        isRtl: true,
        activeTab: "dashboard",
        userPermissions: ["tab-dashboard"],
        crmConnected: false
    });
    assert.doesNotMatch(htmlUser, /id="gatewayTunnelBtn"/, "Regular user must NOT see the Gateway Tunnel button");
    assert.doesNotMatch(htmlUser, /id="gatewayTunnelModal"/, "Regular user must NOT have the Gateway Tunnel modal");
});

test("Server: /api/settings/gateway-tunnel routes exist and enforce root access", () => {
    const serverCode = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
    assert.match(serverCode, /app\.get\(['"]\/api\/settings\/gateway-tunnel['"]/, "GET endpoint must be registered");
    assert.match(serverCode, /app\.post\(['"]\/api\/settings\/gateway-tunnel['"]/, "POST endpoint must be registered");
    assert.match(serverCode, /hasRootAccess\(req\)/, "Endpoint must check hasRootAccess");
});
