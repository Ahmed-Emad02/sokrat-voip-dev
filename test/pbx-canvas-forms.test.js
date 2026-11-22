'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const forms = require('../public/js/pbx-canvas-forms');

const nodes = [
    { key: 'extension:101', type: 'extension', refId: '101', title: 'Ext 101', data: { extension: '101', name: 'Sales' } },
    { key: 'extension:102', type: 'extension', refId: '102', title: 'Ext 102', data: { extension: '102', name: 'Support' } },
    { key: 'ringgroup:600', type: 'ringgroup', refId: '600', title: 'Ring Group 600', data: { grpnum: '600' } },
    { key: 'queue:700', type: 'queue', refId: '700', title: 'Queue 700', data: { extension: '700' } },
    { key: 'ivr:2', type: 'ivr', refId: '2', title: 'Main IVR', data: { id: 2 } },
    { key: 'announcement:5', type: 'announcement', refId: '5', title: 'Welcome', data: { announcement_id: 5 } },
    { key: 'trunk:1', type: 'trunk', refId: '1', title: 'tr-1', data: { trunkid: 1 } },
    { key: 'terminal:hangup,1', type: 'terminal', refId: 'hangup,1', title: 'Hangup', data: { raw: 'app-blackhole,hangup,1' } }
];

const ctx = {
    nodes,
    timegroups: [{ id: 1, description: 'Office hours' }],
    recordings: [{ id: 3, displayname: 'Greeting', filename: 'greeting' }],
    mohCategories: ['default', 'jazz'],
    employeeGroups: [{ name: 'management', display_name: 'Management' }]
};

test('native new extension form starts with a blank password', () => {
    const form = forms.build('extension', null, ctx);
    assert.equal(form.values.secret, '');
    assert.equal(form.validate({ ...form.values, extension: '105', name: 'New', secret: '' }), 'A secret is required.');
});

test('native extension form carries edit fields and PUT endpoint', () => {
    const node = { ...nodes[0], data: { ...nodes[0].data, title: 'Manager', emp_group: 'management', voicemail: 'default', auto_answer: 'force_on' } };
    const form = forms.build('extension', node, ctx);
    assert.equal(form.endpoint.method, 'PUT');
    assert.equal(form.endpoint.url, '/api/config/extensions/101');
    assert.equal(form.values.title, 'Manager');
    assert.equal(form.values.emp_group, 'management');
    const payload = form.payload({ ...form.values, name: 'Sales', secret: '' });
    assert.equal(payload.voicemail, 'default');
    assert.equal(payload.emp_group, 'management');
    assert.equal(form.validate({ ...form.values, extension: '101', name: 'Sales', secret: '' }), '');
});

test('native inbound and outbound forms produce API-ready payloads', () => {
    const inbound = forms.build('inbound', {
        key: 'inbound:+20100:ANY', type: 'inbound', refId: '+20100:ANY', title: 'Main',
        data: { extension: '+20100', cidnum: '', destination: 'ext-group,600,1', description: 'Main' }
    }, ctx);
    assert.equal(inbound.endpoint.url, '/api/config/routes/inbound');
    const inboundPayload = inbound.payload({ ...inbound.values, destination: 'from-did-direct,101,1' });
    assert.equal(inboundPayload.originalExtension, '+20100');
    assert.equal(inboundPayload.destination, 'from-did-direct,101,1');

    const outbound = forms.build('outbound', null, ctx);
    assert.equal(outbound.endpoint.method, 'POST');
    const payload = outbound.payload({
        ...outbound.values,
        name: 'Outbound',
        patterns: [{ prefix: '0', pattern: 'X.', cid: '', prepend: '' }],
        trunks: [1, 2]
    });
    assert.equal(payload.name, 'Outbound');
    assert.deepEqual(payload.trunks, [1, 2]);
    assert.equal(outbound.validate({ ...outbound.values, name: '', patterns: [], trunks: [] }).length > 0, true);
});

test('native trunk form includes protocol, flags, and dial rules', () => {
    const form = forms.build('trunk', {
        key: 'trunk:4', type: 'trunk', refId: '4', title: 'tr-4',
        data: { trunkid: 4, name: 'tr-4', tech: 'custom', channelid: 'dongle/i:1/$OUTNUM$', disabled: 'off', continue: 'off' }
    }, ctx);
    assert.equal(form.endpoint.url, '/api/config/trunks/4');
    const payload = form.payload({
        ...form.values,
        dialrules: [{ prefix: '0', pattern: 'X.', prepend: '' }]
    });
    assert.equal(payload.tech, 'custom');
    assert.equal(payload.channelid, 'dongle/i:1/$OUTNUM$');
    assert.equal(payload.dialrules.length, 1);
});

test('native ring group, queue, and announcement forms normalize collections', () => {
    const ring = forms.build('ringgroup', {
        key: 'ringgroup:600', type: 'ringgroup', refId: '600', title: 'Ring Group 600',
        data: { grpnum: '600', description: 'Sales', grplist: '101-102', strategy: 'ringall', postdest: 'app-blackhole,hangup,1' }
    }, ctx);
    const ringPayload = ring.payload({ ...ring.values, description: 'Sales', grplist: ['101', '102'] });
    assert.equal(ringPayload.grplist, '101-102');

    const queue = forms.build('queue', {
        key: 'queue:700', type: 'queue', refId: '700', title: 'Queue 700',
        data: { extension: '700', descr: 'Support', static_members: ['101'], dest: 'app-blackhole,hangup,1', destcontinue: 'app-blackhole,hangup,1' }
    }, ctx);
    const queuePayload = queue.payload({ ...queue.values, descr: 'Support', static_members: ['101', '102'] });
    assert.equal(queuePayload.static_members, '101-102');

    const ann = forms.build('announcement', null, ctx);
    const annPayload = ann.payload({ ...ann.values, description: 'Welcome', recording_id: '3', post_dest: 'app-blackhole,hangup,1' });
    assert.equal(annPayload.recording_id, '3');
    assert.equal(annPayload.post_dest, 'app-blackhole,hangup,1');
});

test('native IVR form validates duplicate digits and returns retry settings', () => {
    const form = forms.build('ivr', null, ctx);
    const values = {
        ...form.values,
        name: 'Menu',
        entries: [{ selection: '1', dest: 'from-did-direct,101,1', ivr_ret: true }, { selection: '1', dest: 'ext-group,600,1', ivr_ret: false }]
    };
    assert.match(form.validate(values), /unique/);
    values.entries[1].selection = '2';
    assert.equal(form.validate(values), '');
    const payload = form.payload(values);
    assert.equal(payload.entries.length, 2);
    assert.equal(payload.entries[0].ivr_ret, 1);
});

test('native time group form builds description and rules payload', () => {
    const add = forms.build('timegroup', null, ctx);
    assert.equal(add.endpoint.method, 'POST');
    assert.equal(add.endpoint.url, '/api/config/timegroups');
    const payload = add.payload({
        ...add.values,
        description: 'Office hours',
        rules: [{ name: 'Weekday', time: '09:00-17:00', weekday: 'mon-fri', monthday: '*', month: '*' }]
    });
    assert.equal(payload.description, 'Office hours');
    assert.equal(payload.rules.length, 1);
    assert.equal(payload.rules[0].weekday, 'mon-fri');

    const edit = forms.build('timegroup', { key: 'timegroup:4', type: 'timegroup', refId: '4', title: 'Office', data: { id: 4, description: 'Office', rules: [] } }, ctx);
    assert.equal(edit.endpoint.method, 'PUT');
    assert.equal(edit.endpoint.url, '/api/config/timegroups/4');
});

test('native music on hold forms add categories and show existing ones read-only', () => {
    const add = forms.build('moh', null, ctx);
    assert.equal(add.endpoint.method, 'POST');
    assert.equal(add.endpoint.url, '/api/config/moh/category');
    assert.equal(add.payload({ name: 'promo', sort: 'rand' }).name, 'promo');
    const edit = forms.build('moh', {
        key: 'moh:promo', type: 'moh', refId: 'promo', title: 'MOH · promo',
        data: { name: 'promo', sort: 'rand', mode: 'files', files: [{ filename: 'one.wav' }] }
    }, ctx);
    assert.equal(edit.readOnly, true);
    assert.equal(edit.endpoint, null);
    assert.equal(edit.values.files, '1');
});
