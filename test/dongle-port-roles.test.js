'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveInterfaceRoles } = require('../lib/dongle-port-roles');

function interfaces(numbers) {
    return new Map(numbers.map(number => [number, `/stable/if${number}`]));
}

test('keeps a known working pair even when the topology map suggests another pair', () => {
    const result = resolveInterfaceRoles({
        byInterface: interfaces([0, 2, 3]),
        roleEntry: { variants: [{ interfaces: [0, 2, 3], audio: 2, data: 3 }] },
        observed: { audioPort: '/stable/if0', dataPort: '/stable/if3' },
        preserveObserved: true
    });
    assert.deepEqual(result, { audioPort: '/stable/if0', dataPort: '/stable/if3', source: 'existing-working' });
});

test('uses a role only when its complete interface topology matches', () => {
    const result = resolveInterfaceRoles({
        byInterface: interfaces([0, 2, 3]),
        roleEntry: { variants: [
            { interfaces: [0, 1, 2], audio: 2, data: 1 },
            { interfaces: [0, 2, 3], audio: 2, data: 3 }
        ] }
    });
    assert.equal(result.audioPort, '/stable/if2');
    assert.equal(result.dataPort, '/stable/if3');
    assert.equal(result.source, 'topology');
});


test('uses the old-server middle/last convention for each known topology', () => {
    const classic = resolveInterfaceRoles({
        byInterface: interfaces([0, 1, 2]),
        roleEntry: { variants: [{ interfaces: [0, 1, 2], audio: 1, data: 2 }] }
    });
    assert.equal(classic.audioPort, '/stable/if1');
    assert.equal(classic.dataPort, '/stable/if2');

    const sparse = resolveInterfaceRoles({
        byInterface: interfaces([0, 2, 3]),
        roleEntry: { variants: [{ interfaces: [0, 2, 3], audio: 2, data: 3 }] }
    });
    assert.equal(sparse.audioPort, '/stable/if2');
    assert.equal(sparse.dataPort, '/stable/if3');
});

test('does not use a product role without a matching topology', () => {
    const result = resolveInterfaceRoles({
        byInterface: interfaces([0, 2, 3]),
        roleEntry: { audio: 2, data: 1 }
    });
    assert.equal(result.source, 'unresolved');
    assert.equal(result.audioPort, null);
});

test('uses the conservative standard only for an exact 0/1/2 topology', () => {
    const standard = resolveInterfaceRoles({ byInterface: interfaces([0, 1, 2]) });
    assert.deepEqual(standard, {
        audioPort: '/stable/if1', dataPort: '/stable/if2',
        audioInterface: 1, dataInterface: 2, source: 'default:0/1/2'
    });
    const nonStandard = resolveInterfaceRoles({ byInterface: interfaces([0, 1, 2, 3]) });
    assert.equal(nonStandard.source, 'unresolved');
});
