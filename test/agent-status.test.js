'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const agentStatus = require('../lib/agent-status');

test('interfaceExtension handles FreePBX Local members without treating 20-prefixed agents as the same extension', () => {
    assert.equal(agentStatus.interfaceExtension('Local/107@from-queue/n'), '107');
    assert.equal(agentStatus.interfaceExtension('PJSIP/107'), '107');
    assert.equal(agentStatus.interfaceExtension('SIP/101'), '101');
    assert.equal(agentStatus.interfaceExtension('Local/20107@from-queue/n'), '20107');
    assert.notEqual(agentStatus.interfaceExtension('Local/20107@from-queue/n'), '107');
});

test('resolveQueueInterfaces returns each exact queue member only once', async () => {
    const pool = {
        async query(sql) {
            assert.match(sql, /queues_details/);
            return [[
                { data: 'Local/107@from-queue/n,0' },
                { data: 'Local/107@from-queue/n,0' },
                { data: 'Local/20107@from-queue/n,0' },
                { data: 'PJSIP/107,0' },
                { data: 'Local/108@from-queue/n,0' },
            ]];
        },
    };
    assert.deepEqual(
        await agentStatus.resolveQueueInterfaces(pool, '107'),
        ['Local/107@from-queue/n', 'PJSIP/107'],
    );
});

test('applyAsteriskStatus preserves a forced admin DND policy', async () => {
    const commands = [];
    const execFileAsync = async (_bin, args) => {
        commands.push(args[1]);
        return { stdout: '' };
    };

    const result = await agentStatus.applyAsteriskStatus('107', 'meeting', {
        execFileAsync,
        policy: 'force_on',
        interfaces: ['Local/107@from-queue/n'],
    });

    assert.equal(result.policy, 'force_on');
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(commands, ['queue pause member Local/107@from-queue/n']);
});

test('applyAsteriskStatus clears and pauses user-choice DND and queues', async () => {
    const commands = [];
    const execFileAsync = async (_bin, args) => {
        commands.push(args[1]);
        return { stdout: '' };
    };

    await agentStatus.applyAsteriskStatus('107', 'available', {
        execFileAsync,
        policy: 'user_choice',
        interfaces: ['Local/107@from-queue/n'],
    });

    assert.deepEqual(commands, [
        'database del DND 107',
        'queue unpause member Local/107@from-queue/n',
    ]);
});

test('listDefinitions keeps static statuses and filters group-specific statuses', async () => {
    const pool = {
        async query(_sql, params) {
            assert.deepEqual(params, ['Support']);
            return [[
                { key: 'meeting', label_ar: 'اجتماع', label_en: 'Meeting', color: '#8b5cf6', sort_order: 3 },
                { key: 'training', label_ar: 'تدريب', label_en: 'Training', color: '#3b82f6', sort_order: 4 },
            ]];
        },
    };
    const definitions = await agentStatus.listDefinitions(pool, 'Support');
    assert.deepEqual(definitions.map((definition) => definition.key), [
        'available', 'meeting', 'training', 'offline',
    ]);
});
