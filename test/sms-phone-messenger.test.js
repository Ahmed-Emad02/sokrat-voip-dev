const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

test('views/gsm-dongles.ejs renders Phone Messenger dual-pane chat interface in en and ar', async () => {
    const donglesEjsPath = path.join(__dirname, '../views/gsm-dongles.ejs');
    const content = fs.readFileSync(donglesEjsPath, 'utf8');

    // Structural elements of the phone chat messenger
    assert.ok(content.includes('id="sms-messenger-container"'), 'Should contain sms-messenger-container');
    assert.ok(content.includes('id="sms-threads-pane"'), 'Should contain sms-threads-pane (left pane)');
    assert.ok(content.includes('id="sms-chat-pane"'), 'Should contain sms-chat-pane (right pane)');
    assert.ok(content.includes('id="sms-thread-search"'), 'Should contain thread search input');
    assert.ok(content.includes('id="sms-threads-list"'), 'Should contain thread list');
    assert.ok(content.includes('id="sms-messages-stream"'), 'Should contain chat bubbles stream');
    assert.ok(content.includes('id="sms-quick-composer-form"'), 'Should contain quick composer form');
    assert.ok(content.includes('id="sms-composer-input"'), 'Should contain composer textarea');
    assert.ok(content.includes('id="sms-composer-send-btn"'), 'Should contain composer send button');
    assert.ok(content.includes('selectSmsThread'), 'Should contain selectSmsThread function');
    assert.ok(content.includes('groupSmsIntoThreads'), 'Should contain groupSmsIntoThreads function');

    // Render in English
    const htmlEn = await ejs.renderFile(donglesEjsPath, {
        currentLang: 'en',
        currentPage: '/gsm-dongles',
        user: { username: 'admin', role: 'admin' },
        devices: [{ ID: 'dongle0', Number: '01000000001', State: 'Free', Provider: 'Vodafone', IMEI: '123', IMSI: '123' }],
        allowedTabs: ['dashboard', 'gsm-dongles'],
        isRoot: true,
        moment: require('moment')
    });
    assert.ok(htmlEn.includes('SMS Messenger'), 'Rendered English should contain SMS Messenger title');
    assert.ok(htmlEn.includes('New Chat'), 'Rendered English should contain New Chat button');

    // Render in Arabic
    const htmlAr = await ejs.renderFile(donglesEjsPath, {
        currentLang: 'ar',
        currentPage: '/gsm-dongles',
        user: { username: 'admin', role: 'admin' },
        devices: [{ ID: 'dongle0', Number: '01000000001', State: 'Free', Provider: 'Vodafone', IMEI: '123', IMSI: '123' }],
        allowedTabs: ['dashboard', 'gsm-dongles'],
        isRoot: true,
        moment: require('moment')
    });
    assert.ok(htmlAr.includes('المحادثات والرسائل'), 'Rendered Arabic should contain Arabic title');
    assert.ok(htmlAr.includes('محادثة جديدة'), 'Rendered Arabic should contain New Chat in Arabic');
});

test('views/cdr.ejs renders cleanly without duplicate export buttons', async () => {
    const cdrEjsPath = path.join(__dirname, '../views/cdr.ejs');
    const content = fs.readFileSync(cdrEjsPath, 'utf8');

    // Count occurrences of exportCSV
    // Count occurrences of exportCSV button onclick
    const matches = content.match(/onclick="exportCSV\(\)"/g) || [];
    assert.equal(matches.length, 1, 'There should be exactly one exportCSV button in the template header');

    const html = await ejs.renderFile(cdrEjsPath, {
        currentLang: 'en',
        currentPage: '/cdr',
        user: { username: 'admin', role: 'admin' },
        canExportCdr: true,
        isRtl: false,
        moment: require('moment'),
        filters: { page: 1, perPage: 25, startDate: new Date(), endDate: new Date() },
        pagination: { page: 1, perPage: 25, total: 0, totalPages: 1 },
        calls: [],
        allowedTabs: ['dashboard', 'cdr', 'cdr-export']
    });

    const renderedButtons = html.match(/Export CSV/g) || [];
    assert.equal(renderedButtons.length, 1, 'Rendered HTML should have exactly one Export CSV label');
});

test('thread grouping logic correctly pairs two-way incoming and outgoing messages by phone endpoint', () => {
    const messages = [
        { id: 1, dongleId: 'dongle0', sender: '+201012345678', direction: 'incoming', content: 'Hello there', timestamp: 1000 },
        { id: 2, dongleId: 'dongle0', recipient: '+201012345678', direction: 'outgoing', content: 'Hi! How can I help you?', timestamp: 2000 },
        { id: 3, dongleId: 'dongle0', sender: '+201012345678', direction: 'incoming', content: 'I need order status', timestamp: 3000 },
        { id: 4, dongleId: 'dongle1', sender: '+201198765432', direction: 'incoming', content: 'Are you open?', timestamp: 4000 }
    ];

    const normalizePhoneEndpoint = (num) => String(num || '').replace(/[\s\-\(\)]/g, '').trim();

    const threadMap = new Map();
    messages.forEach(msg => {
        const rawEndpoint = msg.endpoint || (msg.direction === 'outgoing' ? msg.recipient : msg.sender);
        const endpoint = normalizePhoneEndpoint(rawEndpoint);
        if (!threadMap.has(endpoint)) {
            threadMap.set(endpoint, { endpoint, messages: [] });
        }
        threadMap.get(endpoint).messages.push(msg);
    });

    assert.equal(threadMap.size, 2, 'Should have 2 distinct conversation threads');
    const thread1 = threadMap.get('+201012345678');
    assert.ok(thread1);
    assert.equal(thread1.messages.length, 3, 'Thread 1 should have 3 messages (2 incoming, 1 outgoing)');
    assert.equal(thread1.messages[1].direction, 'outgoing');
    assert.equal(thread1.messages[1].content, 'Hi! How can I help you?');
});
