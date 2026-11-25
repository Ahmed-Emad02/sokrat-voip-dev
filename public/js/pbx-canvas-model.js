/*
 * Sokrat PBX Canvas model.
 * Pure, dependency-free graph mapping between existing PBX entities and the
 * n8n-style canvas. Existing PBX APIs remain the source of truth.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.PbxCanvasModel = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const TYPE_META = {
        extension: { label: 'Extension', color: '#991b1b', icon: 'phone', input: true, output: false },
        inbound: { label: 'Inbound Route', color: '#059669', icon: 'inbound', input: false, output: true },
        outbound: { label: 'Outbound Route', color: '#7c3aed', icon: 'outbound', input: false, output: true },
        trunk: { label: 'Trunk', color: '#3b82f6', icon: 'trunk', input: true, output: false },
        ringgroup: { label: 'Ring Group', color: '#fb7185', icon: 'group', input: true, output: true },
        queue: { label: 'Queue', color: '#22d3ee', icon: 'queue', input: true, output: true },
        ivr: { label: 'IVR', color: '#c084fc', icon: 'ivr', input: true, output: true },
        timecondition: { label: 'Time Condition', color: '#fbbf24', icon: 'clock', input: true, output: true },
        announcement: { label: 'Announcement', color: '#f472b6', icon: 'speaker', input: true, output: true },
        timegroup: { label: 'Time Group', color: '#f97316', icon: 'clock', input: false, output: false },
        moh: { label: 'Music On Hold', color: '#eab308', icon: 'speaker', input: false, output: false },
        terminal: { label: 'Terminal', color: '#64748b', icon: 'terminal', input: false, output: false },
        external: { label: 'Destination', color: '#64748b', icon: 'external', input: true, output: false }
    };

    const DESTINATION_TYPES = ['extension', 'ringgroup', 'queue', 'ivr', 'timecondition', 'announcement', 'terminal', 'external'];
    const MAX_PORT_ROWS = 32;

    function text(value) {
        return value === null || value === undefined ? '' : String(value).trim();
    }

    function nodeKey(type, id) {
        return `${type}:${id}`;
    }

    function splitMembers(value) {
        if (Array.isArray(value)) return value.map(text).filter(Boolean);
        return text(value).split(/[-\s,]+/).filter(Boolean);
    }

    function parseDestination(raw) {
        const destination = text(raw);
        if (!destination) return null;
        let match;
        if ((match = /^ext-group,(\d+)/i.exec(destination))) return { type: 'ringgroup', id: match[1], raw: destination };
        if ((match = /^(?:ext-queues|from-queue),(\d+)/i.exec(destination))) return { type: 'queue', id: match[1], raw: destination };
        if ((match = /^(?:from-did-direct|from-internal|ext-local),(\d+)/i.exec(destination))) return { type: 'extension', id: match[1], raw: destination };
        if ((match = /^ivr,(\d+)/i.exec(destination))) return { type: 'ivr', id: match[1], raw: destination };
        if ((match = /^timeconditions,(\d+)/i.exec(destination))) return { type: 'timecondition', id: match[1], raw: destination };
        if ((match = /^app-announcement-(\d+)/i.exec(destination))) return { type: 'announcement', id: match[1], raw: destination };
        if ((match = /^app-blackhole,(.+)/i.exec(destination))) return { type: 'terminal', id: match[1], raw: destination };
        return { type: 'external', id: destination, raw: destination };
    }

    function encodeDestination(node) {
        if (!node) return '';
        const id = node.refId;
        switch (node.type) {
            case 'extension': return `from-did-direct,${id},1`;
            case 'ringgroup': return `ext-group,${id},1`;
            case 'queue': return `ext-queues,${id},1`;
            case 'ivr': return `ivr,${id},1`;
            case 'timecondition': return `timeconditions,${id},1`;
            case 'announcement': return `app-announcement-${id},s,1`;
            case 'terminal': return (node.data && node.data.raw) || node.raw || `app-blackhole,${id},1`;
            case 'external': return node.raw || id;
            default: return '';
        }
    }

    function makePort(id, label, kind, index, multiple) {
        return { id, label, kind: kind || 'destination', index: index || 0, multiple: Boolean(multiple) };
    }

    function makeNode(type, refId, data, title, subtitle, details, ports, options) {
        const meta = TYPE_META[type] || TYPE_META.external;
        return {
            key: nodeKey(type, refId),
            type,
            refId: String(refId),
            title: title || `${meta.label} ${refId}`,
            subtitle: subtitle || '',
            details: Array.isArray(details) ? details : [],
            ports: Array.isArray(ports) ? ports : [],
            input: options && options.input !== undefined ? options.input : meta.input,
            output: options && options.output !== undefined ? options.output : meta.output,
            data,
            placeholder: Boolean(options && options.placeholder)
        };
    }

    function autoLayoutNodes(nodes, requestedColumns) {
        const order = ['inbound', 'timecondition', 'timegroup', 'announcement', 'moh', 'ivr', 'ringgroup', 'queue', 'extension', 'outbound', 'trunk', 'terminal', 'external'];
        const groups = order
            .map(type => nodes.filter(node => node.type === type))
            .filter(group => group.length);
        const leftovers = nodes.filter(node => !order.includes(node.type));
        if (leftovers.length) groups.push(leftovers);
        if (!groups.length) return nodes;
        const estimatedHeight = node => 155 + Math.min(3, (node.details || []).length) * 17 + (node.ports || []).length * 27;
        let xOffset = 60;
        groups.forEach(group => {
            for (let start = 0; start < group.length; start += 7) {
                let yOffset = 70;
                group.slice(start, start + 7).forEach(node => {
                    node.x = xOffset;
                    node.y = yOffset;
                    yOffset += estimatedHeight(node) + 32;
                });
                xOffset += 370;
            }
        });
        return nodes;
    }

    function baseGraph(entities) {
        const nodes = [];
        const nodeMap = new Map();
        const edges = [];
        const edgeKeys = new Set();
        const externalNodes = new Map();

        function addNode(node) {
            if (!node) return null;
            const existing = nodeMap.get(node.key);
            if (existing) {
                if (existing.placeholder && !node.placeholder) {
                    Object.assign(existing, node, {
                        x: Number.isFinite(existing.x) ? existing.x : node.x,
                        y: Number.isFinite(existing.y) ? existing.y : node.y,
                        placeholder: false
                    });
                }
                return existing;
            }
            nodeMap.set(node.key, node);
            nodes.push(node);
            return node;
        }

        function addEdge(source, port, target, raw, label) {
            if (!source || !target) return;
            const key = `${source.key}|${port.id}|${target.key}`;
            if (edgeKeys.has(key)) return;
            edgeKeys.add(key);
            edges.push({
                id: `edge-${edges.length + 1}`,
                source: source.key,
                sourcePort: port.id,
                sourceLabel: port.label,
                target: target.key,
                targetType: target.type,
                kind: port.kind || 'destination',
                raw,
                label: label || port.label
            });
        }

        function resolveTarget(raw) {
            const parsed = parseDestination(raw);
            if (!parsed) return null;
            if (parsed.type === 'terminal') {
                const key = nodeKey('terminal', parsed.id);
                if (!nodeMap.has(key)) addNode(makeNode('terminal', parsed.id, parsed, `Hangup / ${parsed.id}`, '', [], [], { input: true, output: false }));
                return nodeMap.get(key);
            }
            if (parsed.type === 'external') {
                const key = nodeKey('external', parsed.raw);
                if (!externalNodes.has(key)) {
                    externalNodes.set(key, addNode(makeNode('external', parsed.raw, parsed, parsed.raw, 'Unmapped destination', [], [], { input: true, output: false })));
                }
                return externalNodes.get(key);
            }
            const key = nodeKey(parsed.type, parsed.id);
            if (nodeMap.has(key)) return nodeMap.get(key);
            const meta = TYPE_META[parsed.type] || TYPE_META.external;
            return addNode(makeNode(parsed.type, parsed.id, {}, `${meta.label} ${parsed.id}`, 'Loading…', [], [], {
                input: true,
                output: Boolean(meta.output),
                placeholder: true
            }));
        }

        const incoming = Array.isArray(entities.inboundRoutes) ? entities.inboundRoutes : [];
        const outbound = Array.isArray(entities.outboundRoutes) ? entities.outboundRoutes : [];
        const trunks = Array.isArray(entities.trunks) ? entities.trunks : [];
        const extensions = Array.isArray(entities.extensions) ? entities.extensions : [];
        const ringgroups = Array.isArray(entities.ringgroups) ? entities.ringgroups : [];
        const queues = Array.isArray(entities.queues) ? entities.queues : [];
        const ivrs = Array.isArray(entities.ivrs) ? entities.ivrs : [];
        const announcements = Array.isArray(entities.announcements) ? entities.announcements : [];
        const timeconditions = Array.isArray(entities.timeconditions) ? entities.timeconditions : [];
        const timegroups = Array.isArray(entities.timegroups) ? entities.timegroups : [];
        const mohCategories = Array.isArray(entities.mohCategories) ? entities.mohCategories : [];

        extensions.forEach(ext => addNode(makeNode('extension', ext.extension, ext, `Ext ${ext.extension}`, ext.name || 'Extension', [
            { label: 'Name', value: ext.name || '-' },
            { label: 'Tech', value: ext.tech || 'sip' }
        ], [makePort('membership', 'Membership', 'membership', 0, true)], { input: true, output: true })));

        trunks.forEach(trunk => addNode(makeNode('trunk', trunk.trunkid, trunk, trunk.name || `Trunk ${trunk.trunkid}`, trunk.tech || 'custom', [
            { label: 'Tech', value: trunk.tech || '-' },
            { label: 'SIM', value: trunk.simNumber || 'Unknown' },
            { label: 'Dial', value: trunk.channelid || trunk.host || '-' }
        ], [], { input: true, output: false })));

        const inboundKeys = new Set();
        incoming.forEach((route, index) => {
            const did = text(route.extension) || 'ANY';
            const cid = text(route.cidnum) || 'ANY';
            let key = `${did}:${cid}`;
            if (inboundKeys.has(key)) key = `${key}:${index}`;
            inboundKeys.add(key);
            const node = addNode(makeNode('inbound', key, route, text(route.description) || `Inbound ${did}`, `DID ${did} · CID ${cid}`, [
                { label: 'DID', value: did },
                { label: 'CID', value: cid }
            ], [makePort('destination', 'Destination', 'destination', 0)], { input: false, output: true }));
            if (route.destination) {
                const target = resolveTarget(route.destination);
                if (target) addEdge(node, node.ports[0], target, route.destination, 'Destination');
            }
        });

        const outboundKeys = new Set();
        outbound.forEach((route, index) => {
            const node = addNode(makeNode('outbound', route.route_id, route, route.name || `Outbound ${route.route_id}`, `${(route.patterns || []).length} patterns`, [
                { label: 'Patterns', value: String((route.patterns || []).length) },
                { label: 'Trunks', value: String((route.trunks || []).length) }
            ], [makePort('trunks', 'Trunks', 'trunks', 0, true)], { input: true, output: true }));
            (route.trunks || []).forEach((trunk, trunkIndex) => {
                const target = nodeMap.get(nodeKey('trunk', trunk.trunk_id));
                if (target) addEdge(node, makePort('trunks', 'Trunks', 'trunks', trunkIndex), target, String(trunk.trunk_id), `Trunk ${trunk.seq || trunkIndex + 1}`);
            });
            // A dial pattern's caller ID can pin the route to a specific extension.
            // Show that restriction as an extension -> outbound-route connection.
            const callerIds = new Set();
            (route.patterns || []).forEach(pattern => {
                const rawCid = text(pattern.cid || pattern.match_cid);
                rawCid.split(/[^0-9]+/).filter(Boolean).forEach(id => {
                    callerIds.add(id);
                    callerIds.add(id.replace(/^0+/, ''));
                });
            });
            callerIds.forEach(id => {
                if (!id) return;
                const extension = nodeMap.get(nodeKey('extension', id));
                if (!extension) return;
                const port = (extension.ports || []).find(item => item.id === 'membership') || (extension.ports || [])[0];
                if (port) addEdge(extension, port, node, id, 'Caller ID');
            });
            outboundKeys.add(String(route.route_id));
        });

        ringgroups.forEach(group => {
            const node = addNode(makeNode('ringgroup', group.grpnum, group, `Ring Group ${group.grpnum}`, group.description || '', [
                { label: 'Strategy', value: group.strategy || '-' },
                { label: 'Members', value: group.grplist || '-' }
            ], [makePort('postdest', 'After timeout', 'destination', 0)], { input: true, output: true }));
            if (group.postdest) {
                const target = resolveTarget(group.postdest);
                if (target) addEdge(node, node.ports[0], target, group.postdest, 'After timeout');
            }
            splitMembers(group.grplist).forEach(extensionId => {
                const extension = nodeMap.get(nodeKey('extension', extensionId));
                const port = extension && extension.ports.find(item => item.id === 'membership');
                if (extension && port) addEdge(extension, port, node, extensionId, 'Member');
            });
        });

        queues.forEach(queue => {
            const node = addNode(makeNode('queue', queue.extension, queue, `Queue ${queue.extension}`, queue.descr || '', [
                { label: 'Wait', value: queue.maxwait || '-' },
                { label: 'Strategy', value: queue.strategy || '-' }
            ], [makePort('dest', 'After timeout', 'destination', 0), makePort('destcontinue', 'Continue', 'destination', 1)], { input: true, output: true }));
            if (queue.dest) {
                const target = resolveTarget(queue.dest);
                if (target) addEdge(node, node.ports[0], target, queue.dest, 'After timeout');
            }
            if (queue.destcontinue && queue.destcontinue !== queue.dest) {
                const target = resolveTarget(queue.destcontinue);
                if (target) addEdge(node, node.ports[1], target, queue.destcontinue, 'Continue');
            }
            splitMembers(queue.static_members).forEach(extensionId => {
                const extension = nodeMap.get(nodeKey('extension', extensionId));
                const port = extension && extension.ports.find(item => item.id === 'membership');
                if (extension && port) addEdge(extension, port, node, extensionId, 'Member');
            });
        });

        ivrs.forEach(ivr => {
            const ports = (ivr.entries || []).map((entry, index) => makePort(`option:${entry.selection}`, `Option ${entry.selection}`, 'destination', index));
            if (ivr.timeout_destination) ports.push(makePort('timeout', 'Timeout', 'destination', ports.length));
            if (ivr.invalid_destination) ports.push(makePort('invalid', 'Invalid', 'destination', ports.length));
            const node = addNode(makeNode('ivr', ivr.id, ivr, ivr.name || `IVR ${ivr.id}`, ivr.description || '', [
                { label: 'Options', value: String((ivr.entries || []).length) },
                { label: 'Announcement', value: ivr.announcement || '-' }
            ], ports, { input: true, output: true }));
            (ivr.entries || []).forEach((entry, index) => {
                const target = resolveTarget(entry.dest || entry.destination);
                if (target) addEdge(node, node.ports[index], target, entry.dest || entry.destination, `Option ${entry.selection}`);
            });
            if (ivr.timeout_destination) {
                const target = resolveTarget(ivr.timeout_destination);
                if (target) addEdge(node, node.ports.find(p => p.id === 'timeout'), target, ivr.timeout_destination, 'Timeout');
            }
            if (ivr.invalid_destination) {
                const target = resolveTarget(ivr.invalid_destination);
                if (target) addEdge(node, node.ports.find(p => p.id === 'invalid'), target, ivr.invalid_destination, 'Invalid');
            }
        });

        announcements.forEach(announcement => {
            const node = addNode(makeNode('announcement', announcement.announcement_id, announcement, `Announcement ${announcement.announcement_id}`, announcement.description || '', [
                { label: 'Recording', value: announcement.recording_name || '-' },
                { label: 'TTS', value: announcement.tts_text ? 'Yes' : 'No' }
            ], [makePort('postdest', 'After announcement', 'destination', 0)], { input: true, output: true }));
            if (announcement.post_dest) {
                const target = resolveTarget(announcement.post_dest);
                if (target) addEdge(node, node.ports[0], target, announcement.post_dest, 'After announcement');
            }
        });

        timeconditions.forEach(condition => {
            const node = addNode(makeNode('timecondition', condition.timeconditions_id, condition, condition.displayname || `Time Condition ${condition.timeconditions_id}`, condition.timegroup_name || '', [
                { label: 'Time Group', value: condition.timegroup_name || condition.timegroup_id || '-' }
            ], [makePort('truegoto', 'Match', 'destination', 0), makePort('falsegoto', 'No match', 'destination', 1)], { input: true, output: true }));
            if (condition.truegoto) {
                const target = resolveTarget(condition.truegoto);
                if (target) addEdge(node, node.ports[0], target, condition.truegoto, 'Match');
            }
            if (condition.falsegoto) {
                const target = resolveTarget(condition.falsegoto);
                if (target) addEdge(node, node.ports[1], target, condition.falsegoto, 'No match');
            }
        });

        timegroups.forEach(group => {
            addNode(makeNode('timegroup', group.id, group, group.description || `Time Group ${group.id}`, `#${group.id}`, [
                { label: 'Rules', value: String((group.rules || []).length) },
                { label: 'Linked conditions', value: String(group.linked_conditions_count || 0) }
            ], [], { input: false, output: false }));
        });

        mohCategories.forEach(category => {
            const name = text(category.name) || text(category);
            const files = Array.isArray(category.files) ? category.files : [];
            addNode(makeNode('moh', name, category, name === 'default' ? 'Music On Hold · default' : `MOH · ${name}`, `${files.length || category.fileCount || 0} track${(files.length || category.fileCount || 0) === 1 ? '' : 's'}`, [
                { label: 'Sort', value: category.sort || 'alpha' },
                { label: 'Mode', value: category.mode || 'files' },
                { label: 'Tracks', value: String(files.length || category.fileCount || 0) }
            ], [], { input: false, output: false }));
        });

        // Stable layout: type-ordered columns with adaptive row counts. Saved
        // coordinates are applied by the browser; this is only the first-open fallback.
        autoLayoutNodes(nodes);

        return { nodes, edges, nodeMap, edgeKeys, externalNodes };
    }

    function connectionCandidates(first, second) {
        const candidates = [];
        const seen = new Set();
        const addDirection = (source, target) => {
            if (!source || !target || source.key === target.key) return;
            (source.ports || []).forEach(port => {
                const allowed = canConnect(source, port, target);
                if (!allowed.ok) return;
                const identity = `${source.key}|${port.id}|${target.key}`;
                if (seen.has(identity)) return;
                seen.add(identity);
                candidates.push({
                    sourceKey: source.key,
                    sourcePort: port.id,
                    sourceLabel: port.label,
                    targetKey: target.key,
                    targetLabel: target.title,
                    label: `${source.title} → ${target.title}`,
                    detail: port.label
                });
            });
        };
        addDirection(first, second);
        addDirection(second, first);
        return candidates;
    }

    function canConnect(sourceNode, port, targetNode) {
        if (!sourceNode || !port || !targetNode) return { ok: false, error: 'Invalid connection.' };
        if (!targetNode.input) return { ok: false, error: 'Target cannot receive connections.' };
        if (targetNode.placeholder) return { ok: false, error: 'Target configuration is missing; open classic config first.' };
        if (port.kind === 'trunks') {
            return targetNode.type === 'trunk' ? { ok: true } : { ok: false, error: 'Outbound trunk ports can only connect to trunks.' };
        }
        if (port.kind === 'membership') {
            return ['ringgroup', 'queue'].includes(targetNode.type)
                ? { ok: true }
                : { ok: false, error: 'Membership ports can only connect to a ring group or queue.' };
        }
        if (!DESTINATION_TYPES.includes(targetNode.type)) {
            return { ok: false, error: 'Target type is not a valid destination.' };
        }
        return { ok: true };
    }

    function outgoingSignature(nodeKey, edges) {
        const pairs = (edges || [])
            .filter(edge => edge.source === nodeKey)
            .map(edge => [edge.sourcePort, edge.target])
            .sort((a, b) => a[0].localeCompare(b[0]));
        return JSON.stringify(pairs);
    }

    function nodeHasConnectionChanges(nodeKey, graph) {
        if (!graph.originalEdges) return true;
        return outgoingSignature(nodeKey, graph.edges) !== outgoingSignature(nodeKey, graph.originalEdges);
    }

    function entitySignature(node) {
        return node ? JSON.stringify(node.data || {}) : '';
    }

    function nodeCanHaveIncoming(edges, nodeKey) {
        return (edges || []).some(edge => edge.target === nodeKey && edge.label !== 'Caller ID');
    }

    function memberIds(node) {
        if (!node) return [];
        if (node.type === 'ringgroup') return text(node.data && node.data.grplist).split(/[-\s,]+/).filter(Boolean);
        if (node.type === 'queue') {
            const members = node.data && node.data.static_members;
            return (Array.isArray(members) ? members : text(members).split(/[-\s,]+/)).map(text).filter(Boolean);
        }
        return [];
    }

    function nodeDeleteError(node, graph) {
        if (!node) return 'Card not found.';
        if (node.placeholder) return 'This card points to missing configuration; open classic config first.';
        const edges = graph && graph.edges ? graph.edges : [];
        if (nodeCanHaveIncoming(edges, node.key)) return 'Remove incoming connections before deleting this card.';
        if (node.type === 'terminal' || node.type === 'external') return 'Terminal and unmapped destinations cannot be deleted.';
        if (!deletionForNode(node)) return 'This card type cannot be deleted from the canvas.';
        const others = (graph && graph.nodes ? graph.nodes : []).filter(other => other.key !== node.key);
        const hiddenReference = others.find(other => memberIds(other).includes(String(node.refId)));
        if (hiddenReference) return `Remove ${node.refId} from ${hiddenReference.title} before deleting this card.`;
        if (node.type === 'moh' && ['default', 'none'].includes(String(node.refId))) return 'System MoH categories cannot be deleted.';
        if (node.type === 'moh') {
            return '';
        }
        if (node.type === 'timegroup') {
            const linked = others.find(other => other.type === 'timecondition' && String(other.data.timegroup_id) === String(node.refId));
            if (linked) return `Time group is used by ${linked.title}; change that time condition first.`;
        }
        return '';
    }

    function deletionForNode(node) {
        if (!node) return null;
        const data = node.data || {};
        switch (node.type) {
            case 'extension':
                return { label: `Delete extension ${node.title}`, method: 'DELETE', url: `/api/config/extensions/${encodeURIComponent(node.refId)}`, body: {} };
            case 'inbound':
                return {
                    label: `Delete inbound ${node.title}`,
                    method: 'DELETE',
                    url: '/api/config/routes/inbound',
                    body: {
                        extension: data.extension || '',
                        cidnum: data.cidnum || '',
                        description: data.description || '',
                        destination: data.destination || ''
                    }
                };
            case 'trunk':
                return { label: `Delete trunk ${node.title}`, method: 'DELETE', url: `/api/config/trunks/${encodeURIComponent(node.refId)}`, body: {} };
            case 'ringgroup':
                return { label: `Delete ring group ${node.title}`, method: 'DELETE', url: `/api/config/ringgroups/${encodeURIComponent(node.refId)}`, body: {} };
            case 'queue':
                return { label: `Delete queue ${node.title}`, method: 'DELETE', url: `/api/config/queues/${encodeURIComponent(node.refId)}`, body: {} };
            case 'announcement':
                return { label: `Delete announcement ${node.title}`, method: 'DELETE', url: `/api/config/announcements/${encodeURIComponent(data.announcement_id || node.refId)}`, body: {} };
            case 'ivr':
                return { label: `Delete IVR ${node.title}`, method: 'DELETE', url: `/api/config/ivrs/${encodeURIComponent(data.id || node.refId)}`, body: {} };
            case 'timecondition':
                return { label: `Delete time condition ${node.title}`, method: 'DELETE', url: `/api/config/timeconditions/${encodeURIComponent(data.timeconditions_id || node.refId)}`, body: {} };
            case 'timegroup':
                return { label: `Delete time group ${node.title}`, method: 'DELETE', url: `/api/config/timegroups/${encodeURIComponent(data.id || node.refId)}`, body: {} };
            case 'moh':
                return { label: `Delete MoH category ${node.title}`, method: 'DELETE', url: `/api/config/moh/category/${encodeURIComponent(node.refId)}`, body: {} };
            case 'outbound':
                return { label: `Delete outbound route ${node.title}`, method: 'DELETE', url: `/api/config/routes/outbound/${encodeURIComponent(data.route_id || node.refId)}`, body: {} };
            default:
                return null;
        }
    }

    function findCycles(graph) {
        const byKey = graph.nodeMap || new Map(graph.nodes.map(n => [n.key, n]));
        const adjacency = new Map();
        graph.edges.forEach(edge => {
            if (!byKey.has(edge.source) || !byKey.has(edge.target)) return;
            if (edge.kind === 'membership') return;
            if (!adjacency.has(edge.source)) adjacency.set(edge.source, []);
            adjacency.get(edge.source).push(edge.target);
        });
        const state = new Map();
        const stack = [];
        const cycles = [];
        const seen = new Set();
        const visit = key => {
            state.set(key, 1);
            stack.push(key);
            (adjacency.get(key) || []).forEach(next => {
                if (state.get(next) === 1) {
                    const start = stack.indexOf(next);
                    if (start !== -1) {
                        const cycle = stack.slice(start);
                        const canonical = cycle.slice().sort().join('|');
                        if (!seen.has(canonical)) {
                            seen.add(canonical);
                            cycles.push(cycle);
                        }
                    }
                } else if (!state.get(next)) {
                    visit(next);
                }
            });
            stack.pop();
            state.set(key, 2);
        };
        graph.nodes.forEach(node => {
            if (!state.get(node.key)) visit(node.key);
        });
        return cycles;
    }

    function validateGraph(graph) {
        const errors = [];
        const byKey = graph.nodeMap || new Map(graph.nodes.map(n => [n.key, n]));
        const edgesBySource = new Map();
        graph.edges.forEach(edge => {
            if (!edgesBySource.has(edge.source)) edgesBySource.set(edge.source, []);
            edgesBySource.get(edge.source).push(edge);
            const source = byKey.get(edge.source);
            const target = byKey.get(edge.target);
            if (!source || !target) errors.push(`Connection has a missing endpoint: ${edge.source} → ${edge.target}`);
        });
        const requiredPorts = {
            inbound: [['destination', 'destination']],
            outbound: [['trunks', 'trunk']],
            timecondition: [['truegoto', 'match destination'], ['falsegoto', 'no-match destination']],
            ringgroup: [['postdest', 'after-timeout destination']],
            announcement: [['postdest', 'after-announcement destination']]
        };
        graph.nodes.forEach(node => {
            if (!nodeHasConnectionChanges(node.key, graph)) return;
            (requiredPorts[node.type] || []).forEach(([portId, label]) => {
                if (!(edgesBySource.get(node.key) || []).some(edge => edge.sourcePort === portId)) {
                    errors.push(`${node.title} has no ${label}.`);
                }
            });
            if (node.type === 'ivr') {
                const selections = (node.data.entries || []).map(entry => text(entry.selection)).filter(Boolean);
                const duplicates = [...new Set(selections.filter((value, index) => selections.indexOf(value) !== index))];
                if (duplicates.length) {
                    errors.push(`IVR '${node.title}' has duplicate menu digit${duplicates.length > 1 ? 's' : ''}: ${duplicates.join(', ')}.`);
                }
            }
        });
        findCycles(graph).forEach(cycle => {
            if (graph.originalEdges && !cycle.some(key => nodeHasConnectionChanges(key, graph))) return;
            const labels = cycle.map(key => {
                const node = byKey.get(key);
                return node ? node.title : key;
            });
            errors.push(`Destination cycle: ${labels.join(' → ')} → ${labels[0]}.`);
        });
        return errors;
    }

    function groupEdges(edges) {
        const map = new Map();
        edges.forEach(edge => {
            if (!map.has(edge.source)) map.set(edge.source, []);
            map.get(edge.source).push(edge);
        });
        return map;
    }

    function normalizedMemberList(ids) {
        return (ids || []).map(value => String(value).trim()).filter(Boolean).sort().join('-');
    }

    function buildUpdatePlan(graph) {
        const byKey = graph.nodeMap || new Map(graph.nodes.map(n => [n.key, n]));
        const grouped = groupEdges(graph.edges);
        const updates = [];
        const deletions = [];
        const errors = validateGraph(graph);

        (graph.deletedNodes || []).forEach(node => {
            const deletion = deletionForNode(node);
            const deleteError = nodeDeleteError(node, { nodes: graph.nodes, edges: graph.edges });
            if (!deletion || deleteError) {
                errors.push(deleteError || `Card '${node.title}' cannot be deleted from the canvas.`);
                return;
            }
            deletions.push({
                ...deletion,
                nodeKey: node.key,
                changes: [{ field: 'Card', from: node.title, to: 'Deleted' }]
            });
        });

        graph.nodes.forEach(node => {
            const sourceEdges = grouped.get(node.key) || [];
            const getTarget = portId => {
                const edge = sourceEdges.find(e => e.sourcePort === portId);
                return edge ? byKey.get(edge.target) : null;
            };

            if (node.type === 'inbound') {
                const target = getTarget('destination');
                const next = target ? encodeDestination(target) : '';
                if (next && next !== text(node.data.destination)) {
                    updates.push({
                        label: `Inbound ${node.title}`,
                        nodeKey: node.key,
                        method: 'PUT',
                        url: '/api/config/routes/inbound',
                        changes: [{ field: 'Destination', from: text(node.data.destination) || '(empty)', to: next }],
                        body: {
                            originalExtension: node.data.extension || '',
                            originalCidnum: node.data.cidnum || '',
                            originalDescription: node.data.description || '',
                            originalDestination: node.data.destination || '',
                            description: node.data.description || '',
                            extension: node.data.extension || '',
                            cidnum: node.data.cidnum || '',
                            destination: next,
                            alertinfo: node.data.alertinfo || '',
                            ringing: node.data.ringing || '',
                            grppre: node.data.grppre || '',
                            pricid: node.data.pricid || '',
                            delay_answer: node.data.delay_answer || 0
                        }
                    });
                }
            }

            if (node.type === 'outbound') {
                const trunkEdges = sourceEdges.filter(e => e.sourcePort === 'trunks');
                const nextIds = trunkEdges.map(e => byKey.get(e.target)).filter(Boolean).map(n => Number(n.refId));
                const originalIds = (node.data.trunks || []).map(t => Number(t.trunk_id));
                if (nextIds.length && nextIds.join(',') !== originalIds.join(',')) {
                    updates.push({
                        label: `Outbound ${node.title}`,
                        nodeKey: node.key,
                        method: 'PUT',
                        url: `/api/config/routes/outbound/${node.data.route_id}`,
                        changes: [{ field: 'Trunk sequence', from: originalIds.join(' → ') || '(empty)', to: nextIds.join(' → ') }],
                        body: {
                            name: node.data.name,
                            outcid: node.data.outcid || '',
                            outcid_mode: node.data.outcid_mode || '',
                            patterns: node.data.patterns || [],
                            trunks: nextIds
                        }
                    });
                }
            }

            if (node.type === 'ivr') {
                const entries = (node.data.entries || []).map(entry => {
                    const target = getTarget(`option:${entry.selection}`);
                    return { ...entry, dest: target ? encodeDestination(target) : (entry.dest || entry.destination) };
                });
                const timeoutTarget = getTarget('timeout');
                const invalidTarget = getTarget('invalid');
                const nextTimeout = timeoutTarget ? encodeDestination(timeoutTarget) : node.data.timeout_destination;
                const nextInvalid = invalidTarget ? encodeDestination(invalidTarget) : node.data.invalid_destination;
                const changes = [];
                entries.forEach((entry, index) => {
                    const original = (node.data.entries || [])[index] || {};
                    const from = text(original.dest || original.destination);
                    const to = text(entry.dest);
                    if (from !== to) changes.push({ field: `Option ${entry.selection}`, from: from || '(empty)', to: to || '(empty)' });
                });
                if (text(nextTimeout) !== text(node.data.timeout_destination)) {
                    changes.push({ field: 'Timeout', from: text(node.data.timeout_destination) || '(empty)', to: nextTimeout || '(empty)' });
                }
                if (text(nextInvalid) !== text(node.data.invalid_destination)) {
                    changes.push({ field: 'Invalid', from: text(node.data.invalid_destination) || '(empty)', to: nextInvalid || '(empty)' });
                }
                const body = {
                    name: node.data.name,
                    description: node.data.description || '',
                    announcement: node.data.announcement || 0,
                    directdial: node.data.directdial || 'disabled',
                    timeout_time: node.data.timeout_time,
                    timeout_loops: node.data.timeout_loops,
                    timeout_retry_recording: node.data.timeout_retry_recording,
                    timeout_destination: nextTimeout,
                    invalid_loops: node.data.invalid_loops,
                    invalid_retry_recording: node.data.invalid_retry_recording,
                    invalid_destination: nextInvalid,
                    entries
                };
                if (changes.length) {
                    updates.push({ label: `IVR ${node.title}`, nodeKey: node.key, method: 'PUT', url: `/api/config/ivrs/${node.data.id}`, changes, body });
                }
            }

            if (node.type === 'timecondition') {
                const trueTarget = getTarget('truegoto');
                const falseTarget = getTarget('falsegoto');
                const nextTrue = trueTarget ? encodeDestination(trueTarget) : node.data.truegoto;
                const nextFalse = falseTarget ? encodeDestination(falseTarget) : node.data.falsegoto;
                if (text(nextTrue) !== text(node.data.truegoto) || text(nextFalse) !== text(node.data.falsegoto)) {
                    const changes = [];
                    if (text(nextTrue) !== text(node.data.truegoto)) changes.push({ field: 'Match', from: text(node.data.truegoto) || '(empty)', to: nextTrue || '(empty)' });
                    if (text(nextFalse) !== text(node.data.falsegoto)) changes.push({ field: 'No match', from: text(node.data.falsegoto) || '(empty)', to: nextFalse || '(empty)' });
                    updates.push({
                        label: `Time condition ${node.title}`,
                        nodeKey: node.key,
                        method: 'PUT',
                        url: `/api/config/timeconditions/${node.data.timeconditions_id}`,
                        changes,
                        body: {
                            displayname: node.data.displayname,
                            timegroup_id: node.data.timegroup_id,
                            truegoto: nextTrue,
                            falsegoto: nextFalse
                        }
                    });
                }
            }

            if (node.type === 'ringgroup') {
                const target = getTarget('postdest');
                const next = target ? encodeDestination(target) : node.data.postdest;
                const memberEdges = graph.edges.filter(edge => edge.kind === 'membership' && edge.target === node.key);
                const nextMembers = memberEdges.map(edge => byKey.get(edge.source)).filter(Boolean).map(member => member.refId).join('-');
                const originalMembers = String(node.data.grplist || '');
                const changes = [];
                if (text(next) !== text(node.data.postdest)) changes.push({ field: 'After timeout', from: text(node.data.postdest) || '(empty)', to: next || '(empty)' });
                if (normalizedMemberList(splitMembers(nextMembers)) !== normalizedMemberList(splitMembers(originalMembers))) {
                    changes.push({ field: 'Members', from: originalMembers || '(none)', to: nextMembers || '(none)' });
                }
                if (changes.length) {
                    updates.push({
                        label: `Ring group ${node.title}`,
                        nodeKey: node.key,
                        method: 'PUT',
                        url: `/api/config/ringgroups/${node.data.grpnum}`,
                        changes,
                        body: {
                            description: node.data.description,
                            grplist: nextMembers,
                            strategy: node.data.strategy,
                            grptime: node.data.grptime,
                            annmsg_id: node.data.annmsg_id,
                            ringing: node.data.ringing,
                            postdest: next
                        }
                    });
                }
            }

            if (node.type === 'queue') {
                const timeoutTarget = getTarget('dest');
                const continueTarget = getTarget('destcontinue');
                const nextDest = timeoutTarget ? encodeDestination(timeoutTarget) : node.data.dest;
                const nextContinue = continueTarget ? encodeDestination(continueTarget) : node.data.destcontinue;
                const memberEdges = graph.edges.filter(edge => edge.kind === 'membership' && edge.target === node.key);
                const nextMembers = memberEdges.map(edge => byKey.get(edge.source)).filter(Boolean).map(member => member.refId).join(',');
                const originalMembers = splitMembers(node.data.static_members).join('-');
                const changes = [];
                if (text(nextDest) !== text(node.data.dest)) changes.push({ field: 'After timeout', from: text(node.data.dest) || '(empty)', to: nextDest || '(empty)' });
                if (text(nextContinue) !== text(node.data.destcontinue)) changes.push({ field: 'Continue', from: text(node.data.destcontinue) || '(empty)', to: nextContinue || '(empty)' });
                if (normalizedMemberList(splitMembers(nextMembers)) !== normalizedMemberList(splitMembers(originalMembers))) {
                    changes.push({ field: 'Static members', from: originalMembers || '(none)', to: nextMembers || '(none)' });
                }
                if (changes.length) {
                    updates.push({
                        label: `Queue ${node.title}`,
                        nodeKey: node.key,
                        method: 'PUT',
                        url: `/api/config/queues/${node.data.extension}`,
                        changes,
                        body: {
                            descr: node.data.descr,
                            static_members: nextMembers,
                            dynmembers: node.data.dynmembers || '',
                            musicclass: node.data.musicclass || 'default',
                            joinannounce_id: node.data.joinannounce_id || 0,
                            maxwait: node.data.maxwait || '',
                            timeout: node.data.timeout,
                            retry: node.data.retry,
                            dest: nextDest,
                            destcontinue: nextContinue,
                            strategy: node.data.strategy,
                            autofill: node.data.autofill,
                            skip_busy: node.data.skip_busy || 'yes'
                        }
                    });
                }
            }

            if (node.type === 'announcement') {
                const target = getTarget('postdest');
                const next = target ? encodeDestination(target) : node.data.post_dest;
                if (text(next) !== text(node.data.post_dest)) {
                    updates.push({
                        label: `Announcement ${node.title}`,
                        nodeKey: node.key,
                        method: 'PUT',
                        url: `/api/config/announcements/${node.data.announcement_id}`,
                        changes: [{ field: 'After announcement', from: text(node.data.post_dest) || '(empty)', to: next || '(empty)' }],
                        body: {
                            description: node.data.description,
                            recording_id: node.data.recording_id || 0,
                            allow_skip: node.data.allow_skip || 0,
                            post_dest: next,
                            return_ivr: node.data.return_ivr || 0,
                            noanswer: node.data.noanswer || 0,
                            repeat_msg: node.data.repeat_msg || '',
                            tts_lang: node.data.tts_lang || 'en-US',
                            tts_text: node.data.tts_text || ''
                        }
                    });
                }
            }
        });

        return { updates, deletions, errors };
    }

    function loadSavedPositions(nodes, saved) {
        if (!saved || typeof saved !== 'object') return nodes;
        nodes.forEach(node => {
            const pos = saved[node.key];
            if (pos && Number.isFinite(Number(pos.x)) && Number.isFinite(Number(pos.y))) {
                node.x = Number(pos.x);
                node.y = Number(pos.y);
            }
        });
        return nodes;
    }

    function layoutSnapshot(nodes) {
        const out = {};
        nodes.forEach(node => { out[node.key] = { x: Math.round(node.x), y: Math.round(node.y) }; });
        return out;
    }

    return {
        TYPE_META,
        DESTINATION_TYPES,
        parseDestination,
        encodeDestination,
        buildGraph: baseGraph,
        autoLayoutNodes,
        canConnect,
        connectionCandidates,
        entitySignature,
        nodeDeleteError,
        deletionForNode,
        findCycles,
        validateGraph,
        buildUpdatePlan,
        loadSavedPositions,
        layoutSnapshot,
        nodeKey
    };
});
