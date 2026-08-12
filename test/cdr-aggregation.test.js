const test = require('node:test');
const assert = require('node:assert/strict');
const { aggregateCdrRows, getExtensionStats } = require('../lib/cdr-aggregation');

test('aggregateCdrRows groups legs by linkedid or uniqueid', () => {
    const rawLegs = [
        { uniqueid: '100.1', linkedid: '100.1', calldate: '2026-08-12 10:00:00', src: '01012345678', dst: '101', duration: 10, billsec: 5, disposition: 'NO ANSWER' },
        { uniqueid: '100.2', linkedid: '100.1', calldate: '2026-08-12 10:00:05', src: '01012345678', dst: '102', duration: 25, billsec: 20, disposition: 'ANSWERED', recordingfile: 'rec1.wav' }
    ];

    const aggregated = aggregateCdrRows(rawLegs, ['01012345678']);

    assert.equal(aggregated.length, 1);
    const call = aggregated[0];
    assert.equal(call.id, '100.1');
    assert.equal(call.disposition, 'ANSWERED');
    assert.equal(call.duration_seconds, 25);
    assert.equal(call.billable_seconds, 20);
    assert.equal(call.recording.available, true);
    assert.ok(call.recording.media_id);
});

test('aggregateCdrRows with knownExtensions correctly classifies internal, inbound, and outbound calls for extension 101', () => {
    const knownExtensions = new Set(['101', '102', '111']);

    const legs = [
        // Leg 1: 101 -> 102 (both known extensions) -> internal
        { uniqueid: '1', linkedid: '1', calldate: '2026-08-12 10:00:00', src: '101', dst: '102', duration: 10, billsec: 5, disposition: 'ANSWERED' },
        // Leg 2: 01012345678 -> 101 (external src) -> inbound
        { uniqueid: '2', linkedid: '2', calldate: '2026-08-12 10:10:00', src: '01012345678', dst: '101', duration: 30, billsec: 25, disposition: 'ANSWERED' },
        // Leg 3: 101 -> 01099999999 (external dst) -> outbound
        { uniqueid: '3', linkedid: '3', calldate: '2026-08-12 10:20:00', src: '101', dst: '01099999999', duration: 15, billsec: 10, disposition: 'ANSWERED' }
    ];

    const aggregated = aggregateCdrRows(legs, { agentExtension: '101', knownExtensions });

    assert.equal(aggregated.length, 3);
    const internalCall = aggregated.find(c => c.id === '1');
    const inboundCall = aggregated.find(c => c.id === '2');
    const outboundCall = aggregated.find(c => c.id === '3');

    assert.equal(internalCall.direction, 'internal');
    assert.equal(inboundCall.direction, 'inbound');
    assert.equal(outboundCall.direction, 'outbound');
});

test('getExtensionStats direction filter correctly separates inbound, outbound, and internal calls', async () => {
    const mockRows = [
        // Internal 101 -> 102
        { uniqueid: '1', linkedid: '1', calldate: '2026-08-12 10:00:00', src: '101', dst: '102', cnum: '101', did: '', clid: '101', duration: 30, billsec: 25, disposition: 'ANSWERED' },
        // Inbound 01011111111 -> 101
        { uniqueid: '2', linkedid: '2', calldate: '2026-08-12 10:10:00', src: '01011111111', dst: '101', cnum: '01011111111', did: '', clid: '01011111111', duration: 30, billsec: 25, disposition: 'ANSWERED' },
        // Outbound 101 -> 01022222222
        { uniqueid: '3', linkedid: '3', calldate: '2026-08-12 10:20:00', src: '101', dst: '01022222222', cnum: '101', did: '', clid: '101', duration: 45, billsec: 40, disposition: 'ANSWERED' }
    ];

    const mockPool = {
        async query(sql) {
            if (sql.includes('asteriskcdrdb.cdr')) {
                return [mockRows];
            }
            if (sql.includes('asterisk.users')) {
                return [[{ extension: '101' }, { extension: '102' }]];
            }
            return [[]];
        }
    };

    const allStats = await getExtensionStats(mockPool, '101', { direction: 'all' });
    assert.equal(allStats.summary.total_calls, 3);
    assert.equal(allStats.summary.inbound_calls, 1);
    assert.equal(allStats.summary.outbound_calls, 1);
    assert.equal(allStats.summary.internal_calls, 1);

    // Invariant check
    assert.equal(allStats.summary.total_calls, allStats.summary.inbound_calls + allStats.summary.outbound_calls + allStats.summary.internal_calls);
});
