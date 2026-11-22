'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('../public/js/pbx-canvas-model');

const entities = {
    extensions: [{ extension: '101', name: 'Sales', tech: 'pjsip' }],
    trunks: [{ trunkid: 1, name: 'tr-1', tech: 'custom', channelid: 'dongle/i:1/$OUTNUM$' }],
    inboundRoutes: [{ extension: '20100', cidnum: '', description: 'Main', destination: 'ext-group,600,1' }],
    outboundRoutes: [{ route_id: 10, name: 'out', patterns: [{ pattern: 'X.' }], trunks: [{ trunk_id: 1, seq: 1 }] }],
    ringgroups: [{ grpnum: '600', description: 'Sales group', postdest: 'from-did-direct,101,1' }],
    queues: [],
    ivrs: [{ id: 2, name: 'Main IVR', entries: [{ selection: '1', dest: 'from-did-direct,101,1' }], timeout_destination: 'app-blackhole,hangup,1' }],
    announcements: [],
    timeconditions: [],
    voicemails: []
};

test('destination parsing and encoding round-trips supported PBX types', () => {
    assert.equal(model.parseDestination('from-did-direct,101,1').type, 'extension');
    assert.equal(model.parseDestination('ext-group,600,1').type, 'ringgroup');
    assert.equal(model.parseDestination('ext-queues,700,1').type, 'queue');
    assert.equal(model.parseDestination('ivr,2,1').type, 'ivr');
    assert.equal(model.parseDestination('timeconditions,3,1').type, 'timecondition');
    assert.equal(model.parseDestination('app-announcement-5,s,1').type, 'announcement');
    assert.equal(model.encodeDestination({ type: 'extension', refId: '101' }), 'from-did-direct,101,1');
    assert.equal(model.encodeDestination({ type: 'ringgroup', refId: '600' }), 'ext-group,600,1');
});

test('graph maps entities and destination edges', () => {
    const graph = model.buildGraph(entities);
    assert.ok(graph.nodeMap.has('inbound:20100:ANY'));
    assert.ok(graph.nodeMap.has('ringgroup:600'));
    assert.ok(graph.nodeMap.has('outbound:10'));
    assert.ok(graph.nodeMap.has('trunk:1'));
    assert.ok(graph.edges.some(e => e.source === 'inbound:20100:ANY' && e.target === 'ringgroup:600'));
    assert.ok(graph.edges.some(e => e.source === 'ringgroup:600' && e.target === 'extension:101'));
    assert.ok(graph.edges.some(e => e.source === 'ivr:2' && e.target === 'extension:101'));
    assert.ok(graph.edges.some(e => e.source === 'outbound:10' && e.target === 'trunk:1'));
});

test('connections are type checked and update plans use existing APIs', () => {
    const graph = model.buildGraph(entities);
    const inbound = graph.nodeMap.get('inbound:20100:ANY');
    const trunk = graph.nodeMap.get('trunk:1');
    assert.equal(model.canConnect(inbound, inbound.ports[0], trunk).ok, false);
    assert.equal(model.canConnect(inbound, inbound.ports[0], graph.nodeMap.get('ringgroup:600')).ok, true);

    const ivrTarget = graph.nodeMap.get('extension:101');
    graph.edges = graph.edges.filter(e => !(e.source === 'inbound:20100:ANY' && e.sourcePort === 'destination'));
    graph.edges.push({ id: 'draft', source: 'inbound:20100:ANY', sourcePort: 'destination', target: ivrTarget.key, targetType: 'extension' });
    graph.edgeKeys = new Set();
    const plan = model.buildUpdatePlan(graph);
    assert.equal(plan.errors.length, 0);
    assert.ok(plan.updates.some(u => u.url === '/api/config/routes/inbound' && u.body.destination === 'from-did-direct,101,1'));
});

test('saved layout only changes node coordinates', () => {
    const graph = model.buildGraph(entities);
    const key = graph.nodes[0].key;
    model.loadSavedPositions(graph.nodes, { [key]: { x: 999, y: 111 } });
    assert.equal(graph.nodeMap.get(key).x, 999);
    assert.equal(graph.nodeMap.get(key).y, 111);
});

test('preexisting incomplete outbound route does not block unrelated edits', () => {
    const graph = model.buildGraph({
        ...entities,
        outboundRoutes: [
            ...entities.outboundRoutes,
            { route_id: 107, name: 'out-107', patterns: [{ pattern: 'X.' }], trunks: [] }
        ]
    });
    graph.originalEdges = graph.edges.map(e => ({ ...e }));
    graph.edges = graph.edges.filter(e => !(e.source === 'inbound:20100:ANY' && e.sourcePort === 'destination'));
    graph.edges.push({ id: 'draft', source: 'inbound:20100:ANY', sourcePort: 'destination', target: 'extension:101', targetType: 'extension' });
    const plan = model.buildUpdatePlan(graph);
    assert.equal(plan.errors.length, 0);
    assert.ok(plan.updates.some(u => u.url === '/api/config/routes/inbound'));
});

test('removing the last outbound trunk is rejected as an invalid draft', () => {
    const graph = model.buildGraph(entities);
    graph.originalEdges = graph.edges.map(e => ({ ...e }));
    graph.edges = graph.edges.filter(e => !(e.source === 'outbound:10' && e.sourcePort === 'trunks'));
    const plan = model.buildUpdatePlan(graph);
    assert.ok(plan.errors.some(error => error.includes('no trunk')));
});

test('removing an inbound destination is rejected as an invalid draft', () => {
    const graph = model.buildGraph(entities);
    graph.originalEdges = graph.edges.map(e => ({ ...e }));
    graph.edges = graph.edges.filter(e => !(e.source === 'inbound:20100:ANY' && e.sourcePort === 'destination'));
    const plan = model.buildUpdatePlan(graph);
    assert.ok(plan.errors.some(error => error.includes('no destination')));
});

test('terminal and external destinations can receive non-trunk connections', () => {
    const graph = model.buildGraph({
        ...entities,
        inboundRoutes: [
            ...entities.inboundRoutes,
            { extension: '20101', cidnum: '', description: 'External', destination: 'custom-app,s,1' }
        ]
    });
    const inbound = graph.nodeMap.get('inbound:20100:ANY');
    const ringgroup = graph.nodeMap.get('ringgroup:600');
    const terminal = [...graph.nodeMap.values()].find(node => node.type === 'terminal');
    const external = [...graph.nodeMap.values()].find(node => node.type === 'external');
    assert.ok(terminal);
    assert.ok(external);
    assert.equal(model.canConnect(inbound, inbound.ports[0], terminal).ok, true);
    assert.equal(model.canConnect(ringgroup, ringgroup.ports[0], external).ok, true);
    assert.equal(model.encodeDestination(terminal), terminal.data.raw);
});

test('update plans carry field-level changes and node keys', () => {
    const graph = model.buildGraph(entities);
    graph.originalEdges = graph.edges.map(e => ({ ...e }));
    graph.edges = graph.edges.filter(e => !(e.source === 'inbound:20100:ANY' && e.sourcePort === 'destination'));
    graph.edges.push({ id: 'draft', source: 'inbound:20100:ANY', sourcePort: 'destination', target: 'extension:101', targetType: 'extension' });
    const plan = model.buildUpdatePlan(graph);
    const update = plan.updates.find(item => item.url === '/api/config/routes/inbound');
    assert.equal(update.nodeKey, 'inbound:20100:ANY');
    assert.deepEqual(update.changes, [{ field: 'Destination', from: 'ext-group,600,1', to: 'from-did-direct,101,1' }]);
});

test('duplicate IVR menu digits are rejected', () => {
    const graph = model.buildGraph({
        ...entities,
        ivrs: [{ id: 2, name: 'Main IVR', entries: [
            { selection: '1', dest: 'from-did-direct,101,1' },
            { selection: '1', dest: 'ext-group,600,1' }
        ], timeout_destination: 'app-blackhole,hangup,1' }]
    });
    const plan = model.buildUpdatePlan(graph);
    assert.ok(plan.errors.some(error => error.includes('duplicate menu digit')));
});

test('destination cycles are rejected', () => {
    const graph = model.buildGraph({
        ...entities,
        inboundRoutes: [{ extension: '20100', cidnum: '', description: 'Main', destination: 'ivr,2,1' }],
        ivrs: [{ id: 2, name: 'Main IVR', entries: [{ selection: '1', dest: 'ext-group,600,1' }], timeout_destination: 'app-blackhole,hangup,1' }],
        ringgroups: [{ grpnum: '600', description: 'Loop', postdest: 'ivr,2,1' }]
    });
    const plan = model.buildUpdatePlan(graph);
    assert.ok(plan.errors.some(error => error.includes('Destination cycle')));
});

test('card deletion emits the existing DELETE API and blocks referenced nodes', () => {
    const graph = model.buildGraph(entities);
    const inbound = graph.nodeMap.get('inbound:20100:ANY');
    const activeNodes = graph.nodes.filter(node => node.key !== inbound.key);
    const activeEdges = graph.edges.filter(edge => edge.source !== inbound.key && edge.target !== inbound.key);
    const nodeMap = new Map(activeNodes.map(node => [node.key, node]));
    const plan = model.buildUpdatePlan({
        nodes: activeNodes,
        nodeMap,
        edges: activeEdges,
        originalEdges: graph.edges.map(edge => ({ ...edge })),
        deletedNodes: [inbound]
    });
    assert.equal(plan.errors.length, 0);
    assert.ok(plan.deletions.some(item => item.url === '/api/config/routes/inbound' && item.method === 'DELETE'));

    const referenced = model.buildGraph({
        ...entities,
        ringgroups: [{ grpnum: '600', description: 'Sales group', postdest: 'from-did-direct,101,1', grplist: '101-102' }]
    });
    const extension = referenced.nodeMap.get('extension:101');
    const noIncoming = referenced.edges.filter(edge => edge.target !== extension.key);
    assert.match(model.nodeDeleteError(extension, { nodes: referenced.nodes, edges: noIncoming }), /Remove 101 from Ring Group 600/);
});

test('terminal cards are not deletable', () => {
    const graph = model.buildGraph(entities);
    const terminal = graph.nodeMap.get('terminal:hangup,1');
    const noTerminalIncoming = graph.edges.filter(edge => edge.target !== terminal.key);
    assert.match(model.nodeDeleteError(terminal, { nodes: graph.nodes, edges: noTerminalIncoming }), /cannot be deleted/);
});

test('time groups render as config cards and are protected while linked', () => {
    const graph = model.buildGraph({
        ...entities,
        timegroups: [{ id: 4, description: 'Office hours', rules: [{ time: '09:00-17:00', weekday: 'mon-fri' }], linked_conditions_count: 1 }],
        timeconditions: [{ timeconditions_id: 3, displayname: 'Office route', timegroup_id: 4, truegoto: 'app-blackhole,hangup,1', falsegoto: 'app-blackhole,hangup,1' }]
    });
    const group = graph.nodeMap.get('timegroup:4');
    const condition = graph.nodeMap.get('timecondition:3');
    assert.ok(group);
    assert.equal(group.title, 'Office hours');
    assert.match(model.nodeDeleteError(group, { nodes: graph.nodes, edges: graph.edges }), /used by Office route/);
    assert.ok(model.deletionForNode(group));
    assert.equal(condition.data.timegroup_id, 4);
});

test('required destination ports are enforced for changed route cards', () => {
    const graph = model.buildGraph({
        ...entities,
        timeconditions: [{ timeconditions_id: 3, displayname: 'Office hours', timegroup_id: 1, truegoto: '', falsegoto: '' }]
    });
    const condition = graph.nodeMap.get('timecondition:3');
    graph.edges = graph.edges.filter(edge => edge.source !== condition.key);
    const plan = model.buildUpdatePlan(graph);
    assert.ok(plan.errors.some(error => error.includes('Office hours') && error.includes('match destination')));
    assert.ok(plan.errors.some(error => error.includes('Office hours') && error.includes('no-match destination')));
});

test('extension membership edges update ring group and queue membership', () => {
    const graph = model.buildGraph({
        ...entities,
        extensions: [
            { extension: '101', name: 'Sales', tech: 'pjsip' },
            { extension: '102', name: 'Support', tech: 'pjsip' }
        ],
        ringgroups: [{ grpnum: '600', description: 'Sales group', grplist: '101', postdest: 'app-blackhole,hangup,1' }],
        queues: [{ extension: '700', descr: 'Support queue', static_members: ['102'], dest: 'app-blackhole,hangup,1', destcontinue: 'app-blackhole,hangup,1' }]
    });
    const extension = graph.nodeMap.get('extension:101');
    const extension2 = graph.nodeMap.get('extension:102');
    const ringgroup = graph.nodeMap.get('ringgroup:600');
    const queue = graph.nodeMap.get('queue:700');
    assert.ok(extension.ports.some(port => port.id === 'membership'));
    assert.ok(graph.edges.some(edge => edge.kind === 'membership' && edge.source === extension.key && edge.target === ringgroup.key));
    assert.ok(graph.edges.some(edge => edge.kind === 'membership' && edge.source === extension2.key && edge.target === queue.key));
    assert.equal(model.canConnect(extension2, extension2.ports.find(port => port.id === 'membership'), ringgroup).ok, true);
    assert.equal(model.canConnect(extension2, extension2.ports.find(port => port.id === 'membership'), queue).ok, true);
    assert.equal(model.canConnect(extension2, extension2.ports.find(port => port.id === 'membership'), extension).ok, false);
    assert.equal(model.findCycles(graph).length, 0);

    graph.originalEdges = graph.edges.map(edge => ({ ...edge }));
    graph.edges.push({ id: 'draft-member', source: extension2.key, sourcePort: 'membership', target: ringgroup.key, targetType: 'ringgroup', kind: 'membership' });
    const plan = model.buildUpdatePlan(graph);
    const ringUpdate = plan.updates.find(item => item.url === '/api/config/ringgroups/600');
    assert.ok(ringUpdate);
    assert.equal(ringUpdate.body.grplist, '101-102');
    assert.ok(ringUpdate.changes.some(change => change.field === 'Members'));
});

test('membership links do not create false destination cycles', () => {
    const graph = model.buildGraph({
        ...entities,
        ringgroups: [{ grpnum: '600', description: 'Loop', grplist: '101', postdest: 'from-did-direct,101,1' }]
    });
    assert.equal(model.findCycles(graph).length, 0);
    const plan = model.buildUpdatePlan(graph);
    assert.equal(plan.errors.length, 0);
});

test('ambiguous card pairs expose every valid connection type', () => {
    const graph = model.buildGraph(entities);
    const extension = graph.nodeMap.get('extension:101');
    const ringgroup = graph.nodeMap.get('ringgroup:600');
    const queue = graph.nodeMap.get('queue:700') || null;
    const inbound = graph.nodeMap.get('inbound:20100:ANY');
    assert.equal(extension.ports.find(port => port.id === 'membership').multiple, true);

    const ringOptions = model.connectionCandidates(extension, ringgroup);
    assert.equal(ringOptions.length, 2);
    assert.ok(ringOptions.some(option => option.sourceKey === extension.key && option.detail === 'Membership'));
    assert.ok(ringOptions.some(option => option.sourceKey === ringgroup.key && option.detail === 'After timeout'));

    assert.equal(model.connectionCandidates(inbound, extension).length, 1);
    assert.equal(model.connectionCandidates(ringgroup, ringgroup).length, 0);
});

test('queue membership and failover relationships are all selectable', () => {
    const graph = model.buildGraph({
        ...entities,
        extensions: [
            { extension: '101', name: 'Sales', tech: 'pjsip' },
            { extension: '102', name: 'Support', tech: 'pjsip' }
        ],
        queues: [{ extension: '700', descr: 'Support', static_members: ['102'], dest: 'app-blackhole,hangup,1', destcontinue: 'app-blackhole,hangup,1' }]
    });
    const extension = graph.nodeMap.get('extension:101');
    const queue = graph.nodeMap.get('queue:700');
    const options = model.connectionCandidates(extension, queue);
    assert.equal(options.length, 3);
    assert.ok(options.some(option => option.sourceKey === extension.key && option.detail === 'Membership'));
    assert.ok(options.some(option => option.sourceKey === queue.key && option.detail === 'After timeout'));
    assert.ok(options.some(option => option.sourceKey === queue.key && option.detail === 'Continue'));

    graph.originalEdges = graph.edges.map(edge => ({ ...edge }));
    graph.edges.push({ id: 'queue-member', source: extension.key, sourcePort: 'membership', target: queue.key, targetType: 'queue', kind: 'membership' });
    const plan = model.buildUpdatePlan(graph);
    const update = plan.updates.find(item => item.url === '/api/config/queues/700');
    assert.ok(update);
    assert.deepEqual(update.body.static_members.split('-').sort(), ['101', '102']);
});

test('default layout gives each type its own columns with at most seven cards', () => {
    const nodes = [];
    for (let index = 0; index < 8; index += 1) nodes.push({ type: 'extension', details: [], ports: [], x: 0, y: 0 });
    for (let index = 0; index < 2; index += 1) nodes.push({ type: 'inbound', details: [], ports: [], x: 0, y: 0 });
    model.autoLayoutNodes(nodes);
    const extensionXs = [...new Set(nodes.slice(0, 8).map(node => node.x))];
    const inboundXs = [...new Set(nodes.slice(8).map(node => node.x))];
    assert.equal(extensionXs.length, 2);
    assert.equal(inboundXs.length, 1);
    assert.ok(inboundXs[0] < extensionXs[0]);
    extensionXs.forEach(x => {
        assert.ok(nodes.slice(0, 8).filter(node => node.x === x).length <= 7);
    });
});

test('music on hold categories become read-only cards and default is protected', () => {
    const graph = model.buildGraph({
        ...entities,
        mohCategories: [
            { name: 'default', sort: 'alpha', files: [] },
            { name: 'promo', sort: 'rand', files: [{ filename: 'one.wav' }] }
        ]
    });
    const defaultMoh = graph.nodeMap.get('moh:default');
    const promo = graph.nodeMap.get('moh:promo');
    assert.ok(defaultMoh);
    assert.ok(promo);
    assert.equal(promo.title, 'MOH · promo');
    assert.match(model.nodeDeleteError(defaultMoh, { nodes: graph.nodes, edges: graph.edges }), /cannot be deleted/i);
    assert.equal(model.nodeDeleteError(promo, { nodes: graph.nodes, edges: graph.edges }), '');
});
