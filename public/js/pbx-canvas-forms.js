/*
 * Native PBX Canvas forms.
 * Pure form schema and payload builders backed by the existing PBX APIs.
 * No PBX data is stored here; this module only describes controls.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.PbxCanvasForms = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const text = value => value === null || value === undefined ? '' : String(value).trim();

    function nodeOptions(nodes, types, method) {
        return (nodes || [])
            .filter(node => node && types.includes(node.type) && !node.placeholder)
            .map(node => ({ value: text(node[method] || node.refId), label: node.title || node.refId }));
    }

    function extensions(nodes) {
        return (nodes || [])
            .filter(node => node && node.type === 'extension' && !node.placeholder)
            .map(node => ({ value: text(node.refId), label: node.title || text(node.refId) }));
    }

    function destinationOptions(nodes, current) {
        const out = [];
        const seen = new Set();
        const add = (value, label) => {
            value = text(value);
            if (!value || seen.has(value)) return;
            seen.add(value);
            out.push({ value, label });
        };
        (nodes || []).forEach(node => {
            if (!node || node.placeholder) return;
            let value = '';
            if (node.type === 'extension') value = `from-did-direct,${node.refId},1`;
            else if (node.type === 'ringgroup') value = `ext-group,${node.refId},1`;
            else if (node.type === 'queue') value = `ext-queues,${node.refId},1`;
            else if (node.type === 'ivr') value = `ivr,${node.refId},1`;
            else if (node.type === 'timecondition') value = `timeconditions,${node.refId},1`;
            else if (node.type === 'announcement') value = `app-announcement-${node.refId},s,1`;
            else if (node.type === 'terminal' || node.type === 'external') value = node.data && node.data.raw ? node.data.raw : '';
            add(value, node.title || value);
        });
        add(current, current);
        return out.sort((a, b) => a.label.localeCompare(b.label));
    }

    function commonOptions() {
        return {
            yesNo: [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }],
            onOff: [{ value: 'off', label: 'Enabled' }, { value: 'on', label: 'Disabled' }],
            onOffStrict: [{ value: 'off', label: 'No' }, { value: 'on', label: 'Yes' }],
            recording: [{ value: 'yes', label: 'Yes (record calls)' }, { value: 'no', label: 'No' }],
            strategies: [
                { value: 'ringall', label: 'Ring All' },
                { value: 'hunt', label: 'Hunt' },
                { value: 'memoryhunt', label: 'Memory Hunt' },
                { value: 'random', label: 'Random' },
                { value: 'firstavailable', label: 'First Available' }
            ],
            queueStrategies: ['rrmemory', 'ringall', 'leastrecent', 'fewestcalls', 'random', 'linear', 'wrandom']
                .map(value => ({ value, label: value })),
            directDial: [{ value: 'disabled', label: 'Disabled' }, { value: 'ext-local,vmu,1', label: 'Extensions' }],
            ttsLanguages: ['en-US', 'en-GB', 'es-ES', 'fr-FR', 'it-IT', 'de-DE'].map(value => ({ value, label: value })),
            repeatKeys: [{ value: '', label: 'None' }, ...['0','1','2','3','4','5','6','7','8','9','*','#'].map(value => ({ value, label: value }))]
        };
    }

    function recordingOptions(ctx, selected) {
        const rows = (ctx.recordings || []).map(rec => ({
            value: String(rec.id),
            label: `${rec.displayname || rec.filename || rec.id}${rec.filename ? ` (${rec.filename})` : ''}`
        }));
        if (!rows.some(row => row.value === String(selected || 0))) rows.unshift({ value: '0', label: 'None / TTS' });
        return rows;
    }

    function mohOptions(ctx, selected) {
        const rows = (ctx.mohCategories || []).map(cat => ({ value: cat.name || cat, label: cat.name || cat }));
        if (!rows.some(row => row.value === 'default')) rows.unshift({ value: 'default', label: 'default' });
        if (!rows.some(row => row.value === 'none')) rows.push({ value: 'none', label: 'none (silence)' });
        if (selected && !rows.some(row => row.value === String(selected))) rows.unshift({ value: String(selected), label: String(selected) });
        return rows;
    }

    function announcementOptions(nodes, selected) {
        const rows = [{ value: '0', label: 'None' }, ...nodeOptions(nodes, ['announcement'], 'refId')];
        if (selected && !rows.some(row => row.value === String(selected))) rows.unshift({ value: String(selected), label: String(selected) });
        return rows;
    }

    function timegroupOptions(ctx, selected) {
        const rows = (ctx.timegroups || []).map(group => ({ value: String(group.id), label: group.description || group.name || String(group.id) }));
        if (selected && !rows.some(row => row.value === String(selected))) rows.unshift({ value: String(selected), label: String(selected) });
        return rows;
    }

    function groupOptions(ctx, selected) {
        const rows = (ctx.employeeGroups || []).map(group => ({ value: String(group.name || group.id), label: group.display_name || group.name || group.name_en || String(group.id) }));
        if (selected && !rows.some(row => row.value === String(selected))) rows.unshift({ value: String(selected), label: String(selected) });
        rows.unshift({ value: '', label: 'None' });
        return rows;
    }

    function trunkOptions(nodes) {
        return nodeOptions(nodes, ['trunk'], 'refId').map(row => ({ ...row, value: Number(row.value) }));
    }

    function splitMembers(value) {
        if (Array.isArray(value)) return value.map(text).filter(Boolean);
        return text(value).split(/[-\s,]+/).filter(Boolean);
    }

    function commonDestinationSection(fields) {
        return { title: 'Destination', fields };
    }

    function build(type, node, ctx) {
        ctx = ctx || {};
        const isEdit = Boolean(node);
        const data = node && node.data ? node.data : {};
        const nodes = ctx.nodes || [];
        const opt = commonOptions();
        let values;
        let sections;
        let endpoint;
        let payload;
        let validate;
        let title;

        if (type === 'extension') {
            values = {
                extension: text(data.extension || node && node.refId),
                name: text(data.name),
                secret: '',
                tech: text(data.tech || 'pjsip') === 'sip' ? 'sip' : 'pjsip',
                voicemail: text(data.voicemail) === 'default' || text(data.voicemail) === 'enabled' ? 'default' : 'novm',
                denoise: text(data.denoise || 'off'),
                vad_gate: text(data.vad_gate || '0'),
                vad_db: text(data.vad_db || 'off'),
                agc: text(data.agc || 'off'),
                auto_answer: text(data.auto_answer || 'user_choice'),
                dnd: text(data.dnd || 'user_choice'),
                disable_outbound_ringing_cancel: text(data.disable_outbound_ringing_cancel || '0'),
                is_group_admin: Boolean(data.is_group_admin),
                title: text(data.title),
                emp_group: text(data.emp_group),
                photo: text(data.photo)
            };
            sections = [
                { title: 'Extension credentials & device', fields: [
                    { name: 'extension', label: 'User extension ID', type: 'text', required: true, disabled: isEdit, readonly: isEdit },
                    { name: 'name', label: 'Display name', type: 'text', required: true },
                    { name: 'secret', label: 'Secret (password)', type: 'password', required: !isEdit, placeholder: isEdit ? 'Leave blank to keep current secret' : '' },
                    { name: 'tech', label: 'Extension technology', type: 'select', options: [
                        { value: 'pjsip', label: 'WebRTC Softphone (browser/mobile)' },
                        { value: 'sip', label: 'Generic SIP device (UDP / 5060)' }
                    ] },
                    { name: 'voicemail', label: 'Voicemail option', type: 'select', options: [
                        { value: 'novm', label: 'Disabled (No voicemail)' },
                        { value: 'default', label: 'Enabled (Voicemail active)' }
                    ] }
                ] },
                { title: 'AI voice processing & audio DSP', fields: [
                    { name: 'denoise', label: 'AI noise suppression (RNNoise)', type: 'select', options: [
                        { value: 'both', label: 'Enabled (RX + TX)' }, { value: 'off', label: 'Disabled' },
                        { value: 'rx', label: 'Microphone only (RX)' }, { value: 'tx', label: 'Speaker only (TX)' }
                    ] },
                    { name: 'vad_gate', label: 'VAD silence gate', type: 'select', options: [
                        { value: '1', label: 'Enabled (100% silence on pauses)' }, { value: '0', label: 'Disabled (continuous filter)' }
                    ] },
                    { name: 'vad_db', label: 'Decibel cutoff (dBFS)', type: 'select', options: ['off','-55','-50','-45','-42','-38','-35','-30'].map(value => ({ value, label: value === 'off' ? 'Auto / neural only' : value + ' dBFS' })) },
                    { name: 'agc', label: 'Auto gain control (Speex AGC)', type: 'select', options: [
                        { value: 'off', label: 'Disabled' }, { value: '8000', label: 'Enabled (8000 balanced)' },
                        { value: '6000', label: 'Enabled (6000 gentle)' }, { value: '10000', label: 'Enabled (10000 loud)' },
                        { value: '12000', label: 'Enabled (12000 boosted)' }
                    ] }
                ] },
                { title: 'WebRTC policies', fields: [
                    { name: 'auto_answer', label: 'Auto answer', type: 'select', options: [
                        { value: 'user_choice', label: 'User choice' }, { value: 'force_on', label: 'Force on' }, { value: 'force_off', label: 'Force off' }
                    ] },
                    { name: 'dnd', label: 'Do not disturb', type: 'select', options: [
                        { value: 'user_choice', label: 'User choice' }, { value: 'force_on', label: 'Force on' }, { value: 'force_off', label: 'Force off' }
                    ] },
                    { name: 'disable_outbound_ringing_cancel', label: 'Disable outbound ringing cancel', type: 'select', options: [
                        { value: '0', label: 'No' }, { value: '1', label: 'Yes' }
                    ] }
                ] },
                { title: 'Employee profile', fields: [
                    { name: 'title', label: 'Job title', type: 'text', placeholder: 'e.g. Sales Manager' },
                    { name: 'emp_group', label: 'Employee group', type: 'select', options: groupOptions(ctx, data.emp_group || '') },
                    { name: 'is_group_admin', label: 'Group admin (call pickup authority)', type: 'checkbox' }
                ] }
            ];
            endpoint = isEdit
                ? { method: 'PUT', url: `/api/config/extensions/${encodeURIComponent(node.refId)}` }
                : { method: 'POST', url: '/api/config/extensions' };
            payload = v => ({
                extension: text(v.extension), name: text(v.name), secret: text(v.secret), tech: v.tech,
                voicemail: v.voicemail, denoise: v.denoise, vad_gate: v.vad_gate, vad_db: v.vad_db, agc: v.agc,
                auto_answer: v.auto_answer, dnd: v.dnd, disable_outbound_ringing_cancel: v.disable_outbound_ringing_cancel,
                is_group_admin: Boolean(v.is_group_admin), title: text(v.title), emp_group: text(v.emp_group), photo: text(v.photo)
            });
            validate = v => {
                if (!/^\d+$/.test(text(v.extension))) return 'Extension number must be numeric.';
                if (!text(v.name)) return 'Display name is required.';
                if (!isEdit && !text(v.secret)) return 'A secret is required.';
                return '';
            };
            title = isEdit ? 'Edit Extension · ' + node.title : 'Add Extension';
        }

        if (type === 'inbound') {
            values = {
                description: text(data.description), extension: text(data.extension), cidnum: text(data.cidnum),
                destination: text(data.destination) || 'app-blackhole,hangup,1',
                alertinfo: text(data.alertinfo), ringing: text(data.ringing),
                grppre: text(data.grppre), pricid: text(data.pricid), delay_answer: text(data.delay_answer || 0)
            };
            sections = [
                { title: 'Inbound route matching rules', fields: [
                    { name: 'description', label: 'Description', type: 'text', placeholder: 'e.g. Sales inbound' },
                    { name: 'extension', label: 'DID number', type: 'text', placeholder: 'Blank = ANY' },
                    { name: 'cidnum', label: 'Caller ID number', type: 'text', placeholder: 'Blank = ANY', wide: true }
                ] },
                commonDestinationSection([
                    { name: 'destination', label: 'Target destination', type: 'destination', required: true, options: destinationOptions(nodes, data.destination) }
                ]),
                { title: 'Advanced routing options', fields: [
                    { name: 'alertinfo', label: 'Alert info', type: 'text' },
                    { name: 'ringing', label: 'Ringing', type: 'text' },
                    { name: 'grppre', label: 'Group prefix', type: 'text' },
                    { name: 'pricid', label: 'Private caller ID', type: 'text' },
                    { name: 'delay_answer', label: 'Answer delay (seconds)', type: 'number', min: 0 }
                ] }
            ];
            endpoint = { method: isEdit ? 'PUT' : 'POST', url: '/api/config/routes/inbound' };
            payload = v => ({
                ...(isEdit ? {
                    originalExtension: text(data.extension), originalCidnum: text(data.cidnum),
                    originalDescription: text(data.description), originalDestination: text(data.destination)
                } : {}),
                description: text(v.description), extension: text(v.extension), cidnum: text(v.cidnum),
                destination: text(v.destination), alertinfo: text(v.alertinfo), ringing: text(v.ringing),
                grppre: text(v.grppre), pricid: text(v.pricid), delay_answer: text(v.delay_answer || 0)
            });
            validate = v => !text(v.destination) ? 'Destination is required.' : '';
            title = (isEdit ? 'Edit Inbound Route · ' : 'Add Inbound Route') + (node ? node.title : '');
        }

        if (type === 'outbound') {
            values = {
                name: text(data.name), outcid: text(data.outcid), outcid_mode: text(data.outcid_mode),
                patterns: Array.isArray(data.patterns) && data.patterns.length
                    ? data.patterns.map(p => ({ prefix: p.prefix || '', pattern: p.pattern || '', cid: p.cid || '', prepend: p.prepend || '' }))
                    : [{ prefix: '', pattern: 'X.', cid: '', prepend: '' }],
                trunks: (data.trunks || []).map(t => Number(t.trunk_id))
            };
            sections = [
                { title: 'Outbound route definition', fields: [
                    { name: 'name', label: 'Route name', type: 'text', required: true },
                    { name: 'outcid', label: 'Route CID (optional)', type: 'text' },
                    { name: 'outcid_mode', label: 'Route CID behavior', type: 'select', options: [
                        { value: '', label: 'Use extension caller ID' }, { value: 'override_extension', label: 'Override extension caller ID' }
                    ] }
                ] },
                { title: 'Dial patterns & prefix rules', fields: [
                    { name: 'patterns', label: 'Dial patterns', type: 'patterns', required: true }
                ] },
                { title: 'Target trunk failover sequence', fields: [
                    { name: 'trunks', label: 'Trunk sequence', type: 'sequence', required: true, options: trunkOptions(nodes) }
                ] }
            ];
            endpoint = isEdit
                ? { method: 'PUT', url: `/api/config/routes/outbound/${encodeURIComponent(data.route_id || node.refId)}` }
                : { method: 'POST', url: '/api/config/routes/outbound' };
            payload = v => ({
                name: text(v.name), outcid: text(v.outcid), outcid_mode: text(v.outcid_mode),
                patterns: (v.patterns || []).filter(p => text(p.pattern)), trunks: (v.trunks || []).map(Number).filter(Number.isFinite)
            });
            validate = v => {
                if (!text(v.name)) return 'Route name is required.';
                if (!(v.patterns || []).some(p => text(p.pattern))) return 'At least one dial pattern is required.';
                if (!(v.trunks || []).length) return 'At least one trunk is required.';
                return '';
            };
            title = (isEdit ? 'Edit Outbound Route · ' : 'Add Outbound Route') + (node ? node.title : '');
        }

        if (type === 'trunk') {
            values = {
                name: text(data.name), tech: text(data.tech || 'custom'), disabled: text(data.disabled || 'off'),
                outcid: text(data.outcid), keepcid: text(data.keepcid || 'off'), maxchans: text(data.maxchans),
                dialoutprefix: text(data.dialoutprefix), dialopts: text(data.dialopts || 'TR'), continue: text(data.continue || 'off'),
                failscript: text(data.failscript), usercontext: text(data.usercontext), register: text(data.register),
                channelid: text(data.channelid) || (isEdit ? '' : 'dongle/i:$OUTNUM$'), host: text(data.host),
                username: text(data.username), secret: text(data.secret), context: text(data.context || 'from-trunk'),
                peerdetails: text(data.peerdetails), userdetails: text(data.userdetails),
                dialrules: (data.dialrules || data.dialpatterns || []).map(rule => ({
                    prepend: rule.prepend || '', prefix: rule.prefix || rule.match_pattern_prefix || '', pattern: rule.pattern || rule.match_pattern_pass || ''
                }))
            };
            sections = [
                { title: 'Trunk identity', fields: [
                    { name: 'name', label: 'Trunk name', type: 'text', required: true },
                    { name: 'tech', label: 'Trunk technology', type: 'select', options: [
                        { value: 'custom', label: 'Custom (dongle / local / Dahdi)' }, { value: 'sip', label: 'SIP (chan_sip)' }, { value: 'iax2', label: 'IAX2' }
                    ] },
                    { name: 'disabled', label: 'Status', type: 'select', options: opt.onOff }
                ] },
                { title: 'Caller ID & dialing', fields: [
                    { name: 'outcid', label: 'Outbound caller ID', type: 'text' },
                    { name: 'keepcid', label: 'Caller ID policy', type: 'select', options: [
                        { value: 'off', label: 'Allow any CID' }, { value: 'on', label: 'Block foreign CIDs' },
                        { value: 'cnum', label: 'CID number only' }, { value: 'all', label: 'All CID' }
                    ] },
                    { name: 'maxchans', label: 'Max channels', type: 'number', min: 0 },
                    { name: 'dialoutprefix', label: 'Dial prefix', type: 'text' },
                    { name: 'dialopts', label: 'Dial options', type: 'text' },
                    { name: 'continue', label: 'Continue after dial', type: 'select', options: opt.onOffStrict },
                    { name: 'failscript', label: 'Failover script', type: 'text', wide: true }
                ] },
                { title: 'Custom trunk', fields: [
                    { name: 'channelid', label: 'Custom dial string', type: 'text', wide: true }
                ] },
                { title: 'SIP / IAX2 peer', fields: [
                    { name: 'host', label: 'Host', type: 'text' },
                    { name: 'username', label: 'Username', type: 'text' },
                    { name: 'secret', label: 'Secret', type: 'password' },
                    { name: 'context', label: 'Context', type: 'text' },
                    { name: 'usercontext', label: 'User context', type: 'text' },
                    { name: 'register', label: 'Register string', type: 'text', wide: true },
                    { name: 'peerdetails', label: 'Peer details', type: 'textarea', rows: 4, wide: true },
                    { name: 'userdetails', label: 'User details', type: 'textarea', rows: 4, wide: true }
                ] },
                { title: 'Dial rules', fields: [
                    { name: 'dialrules', label: 'Dial rules', type: 'rules' }
                ] }
            ];
            endpoint = isEdit
                ? { method: 'PUT', url: `/api/config/trunks/${encodeURIComponent(node.refId)}` }
                : { method: 'POST', url: '/api/config/trunks' };
            payload = v => ({
                name: text(v.name), tech: v.tech, disabled: v.disabled, outcid: text(v.outcid), keepcid: v.keepcid,
                maxchans: text(v.maxchans), dialoutprefix: text(v.dialoutprefix), dialopts: text(v.dialopts),
                continue: v.continue, failscript: text(v.failscript), usercontext: text(v.usercontext), register: text(v.register),
                channelid: text(v.channelid), host: text(v.host), username: text(v.username), secret: text(v.secret),
                context: text(v.context), peerdetails: v.peerdetails, userdetails: v.userdetails,
                dialrules: (v.dialrules || []).filter(rule => text(rule.prefix) || text(rule.pattern))
            });
            validate = v => {
                if (!text(v.name)) return 'Trunk name is required.';
                if (!text(v.channelid)) return 'Custom dial string is required.';
                return '';
            };
            title = (isEdit ? 'Edit Trunk · ' : 'Add Trunk') + (node ? node.title : '');
        }

        if (type === 'ringgroup') {
            values = {
                grpnum: text(data.grpnum || node && node.refId), description: text(data.description),
                strategy: text(data.strategy || 'ringall'), grptime: text(data.grptime || 20),
                grplist: splitMembers(data.grplist), annmsg_id: text(data.annmsg_id || 0),
                ringing: text(data.ringing || 'Ring'), postdest: text(data.postdest) || 'app-blackhole,hangup,1'
            };
            sections = [
                { title: 'Ring group definition', fields: [
                    { name: 'grpnum', label: 'Group number', type: 'text', required: true, disabled: isEdit, readonly: isEdit },
                    { name: 'description', label: 'Description', type: 'text', required: true },
                    { name: 'strategy', label: 'Ring strategy', type: 'select', options: opt.strategies },
                    { name: 'grptime', label: 'Ring time (seconds)', type: 'number', min: 5, max: 120 }
                ] },
                { title: 'Members', fields: [
                    { name: 'grplist', label: 'Member extensions', type: 'members', options: extensions(nodes), wide: true }
                ] },
                { title: 'Announcement & music', fields: [
                    { name: 'annmsg_id', label: 'Announcement', type: 'select', options: announcementOptions(nodes, data.annmsg_id || 0) },
                    { name: 'ringing', label: 'Music on hold / ringing', type: 'select', options: [{ value: 'Ring', label: 'Ring (default)' }, ...mohOptions(ctx, data.ringing)] }
                ] },
                commonDestinationSection([
                    { name: 'postdest', label: 'Destination if no answer', type: 'destination', required: true, options: destinationOptions(nodes, data.postdest) }
                ])
            ];
            endpoint = isEdit
                ? { method: 'PUT', url: `/api/config/ringgroups/${encodeURIComponent(node.refId)}` }
                : { method: 'POST', url: '/api/config/ringgroups' };
            payload = v => ({
                grpnum: text(v.grpnum), description: text(v.description), grplist: (v.grplist || []).join('-'),
                strategy: v.strategy, grptime: text(v.grptime), annmsg_id: text(v.annmsg_id || 0),
                ringing: v.ringing, postdest: text(v.postdest)
            });
            validate = v => {
                if (!/^\d+$/.test(text(v.grpnum))) return 'Group number must be numeric.';
                if (!text(v.description)) return 'Description is required.';
                return '';
            };
            title = (isEdit ? 'Edit Ring Group · ' : 'Add Ring Group') + (node ? node.title : '');
        }

        if (type === 'queue') {
            values = {
                extension: text(data.extension || node && node.refId), descr: text(data.descr),
                static_members: splitMembers(data.static_members), dynmembers: splitMembers(data.dynmembers),
                strategy: text(data.strategy || 'rrmemory'), musicclass: text(data.musicclass || 'default'),
                joinannounce_id: text(data.joinannounce_id || 0), recording: data.monitor_type === '' ? 'no' : 'yes',
                maxwait: text(data.maxwait || ''), timeout: text(data.timeout || 15), retry: text(data.retry || 5),
                autofill: text(data.autofill || 'yes'), skip_busy: text(data.cwignore === 1 || data.cwignore === '1' || data.skip_busy === 'yes' ? 'yes' : 'no'),
                dest: text(data.dest) || 'app-blackhole,hangup,1', destcontinue: text(data.destcontinue) || 'app-blackhole,hangup,1',
                joinempty: text(data.joinempty || 'yes'), leavewhenempty: text(data.leavewhenempty || 'no')
            };
            sections = [
                { title: 'Queue definition', fields: [
                    { name: 'extension', label: 'Queue number', type: 'text', required: true, disabled: isEdit, readonly: isEdit },
                    { name: 'descr', label: 'Queue name', type: 'text', required: true },
                    { name: 'strategy', label: 'Ring strategy', type: 'select', options: opt.queueStrategies },
                    { name: 'musicclass', label: 'Music on hold', type: 'select', options: mohOptions(ctx, data.musicclass) },
                    { name: 'joinannounce_id', label: 'Join announcement', type: 'select', options: announcementOptions(nodes, data.joinannounce_id || 0) },
                    { name: 'recording', label: 'Call recording', type: 'select', options: opt.recording },
                    { name: 'maxwait', label: 'Max wait (seconds; 0 = unlimited)', type: 'number', min: 0 },
                    { name: 'timeout', label: 'Agent timeout (seconds)', type: 'number', min: 1 },
                    { name: 'retry', label: 'Retry (seconds)', type: 'number', min: 1 },
                    { name: 'autofill', label: 'Autofill', type: 'select', options: opt.yesNo },
                    { name: 'skip_busy', label: 'Skip busy agents', type: 'select', options: opt.yesNo }
                ] },
                { title: 'Agents', fields: [
                    { name: 'static_members', label: 'Static agents', type: 'members', options: extensions(nodes), wide: true },
                    { name: 'dynmembers', label: 'Dynamic agents', type: 'members', options: extensions(nodes), wide: true }
                ] },
                { title: 'Failover destinations', fields: [
                    { name: 'dest', label: 'Failover destination', type: 'destination', required: true, options: destinationOptions(nodes, data.dest) },
                    { name: 'destcontinue', label: 'Continue destination', type: 'destination', required: true, options: destinationOptions(nodes, data.destcontinue) }
                ] },
                { title: 'Advanced queue behavior', fields: [
                    { name: 'joinempty', label: 'Join empty', type: 'text' },
                    { name: 'leavewhenempty', label: 'Leave when empty', type: 'text' }
                ] }
            ];
            endpoint = isEdit
                ? { method: 'PUT', url: `/api/config/queues/${encodeURIComponent(node.refId)}` }
                : { method: 'POST', url: '/api/config/queues' };
            payload = v => ({
                extension: text(v.extension), descr: text(v.descr), static_members: (v.static_members || []).join('-'),
                dynmembers: (v.dynmembers || []).join('-'), strategy: v.strategy, musicclass: v.musicclass,
                joinannounce_id: text(v.joinannounce_id || 0), recording: v.recording, maxwait: text(v.maxwait),
                timeout: text(v.timeout), retry: text(v.retry), autofill: v.autofill, skip_busy: v.skip_busy,
                dest: text(v.dest), destcontinue: text(v.destcontinue), joinempty: text(v.joinempty), leavewhenempty: text(v.leavewhenempty)
            });
            validate = v => {
                if (!/^\d+$/.test(text(v.extension))) return 'Queue number must be numeric.';
                if (!text(v.descr)) return 'Queue name is required.';
                return '';
            };
            title = (isEdit ? 'Edit Queue · ' : 'Add Queue') + (node ? node.title : '');
        }

        if (type === 'ivr') {
            values = {
                name: text(data.name), description: text(data.description), announcement: text(data.announcement || 0),
                directdial: text(data.directdial || 'disabled'), timeout_time: text(data.timeout_time || 10),
                timeout_loops: text(data.timeout_loops || 3), timeout_retry_recording: text(data.timeout_retry_recording || 'default'),
                timeout_destination: text(data.timeout_destination) || 'app-blackhole,hangup,1',
                invalid_loops: text(data.invalid_loops || 3), invalid_retry_recording: text(data.invalid_retry_recording || 'default'),
                invalid_destination: text(data.invalid_destination) || 'app-blackhole,hangup,1',
                entries: (data.entries || []).map(entry => ({
                    selection: text(entry.selection), dest: text(entry.dest || entry.destination), ivr_ret: Boolean(entry.ivr_ret)
                }))
            };
            if (!values.entries.length) values.entries = [{ selection: '1', dest: 'app-blackhole,hangup,1', ivr_ret: false }];
            sections = [
                { title: 'IVR menu', fields: [
                    { name: 'name', label: 'IVR name', type: 'text', required: true },
                    { name: 'description', label: 'Description', type: 'text' },
                    { name: 'announcement', label: 'Announcement greeting', type: 'select', options: announcementOptions(nodes, data.announcement || 0) },
                    { name: 'directdial', label: 'Direct dial', type: 'select', options: opt.directDial }
                ] },
                { title: 'Timeout settings', fields: [
                    { name: 'timeout_time', label: 'Timeout (seconds)', type: 'number', min: 1, max: 60 },
                    { name: 'timeout_loops', label: 'Retries', type: 'number', min: 0, max: 10 },
                    { name: 'timeout_retry_recording', label: 'Retry recording', type: 'text' },
                    { name: 'timeout_destination', label: 'Timeout destination', type: 'destination', required: true, options: destinationOptions(nodes, data.timeout_destination) }
                ] },
                { title: 'Invalid input settings', fields: [
                    { name: 'invalid_loops', label: 'Invalid retries', type: 'number', min: 0, max: 10 },
                    { name: 'invalid_retry_recording', label: 'Invalid retry recording', type: 'text' },
                    { name: 'invalid_destination', label: 'Invalid destination', type: 'destination', required: true, options: destinationOptions(nodes, data.invalid_destination) }
                ] },
                { title: 'Keypress options', fields: [
                    { name: 'entries', label: 'IVR options', type: 'ivrEntries', wide: true, options: destinationOptions(nodes, '') }
                ] }
            ];
            endpoint = isEdit
                ? { method: 'PUT', url: `/api/config/ivrs/${encodeURIComponent(node.refId)}` }
                : { method: 'POST', url: '/api/config/ivrs' };
            payload = v => ({
                name: text(v.name), description: text(v.description), announcement: text(v.announcement || 0),
                directdial: v.directdial, timeout_time: text(v.timeout_time), timeout_loops: text(v.timeout_loops),
                timeout_retry_recording: text(v.timeout_retry_recording), timeout_destination: text(v.timeout_destination),
                invalid_loops: text(v.invalid_loops), invalid_retry_recording: text(v.invalid_retry_recording),
                invalid_destination: text(v.invalid_destination),
                entries: (v.entries || []).filter(e => text(e.selection) && text(e.dest)).map(e => ({
                    selection: text(e.selection), dest: text(e.dest), ivr_ret: e.ivr_ret ? 1 : 0
                }))
            });
            validate = v => {
                if (!text(v.name)) return 'IVR name is required.';
                const selections = (v.entries || []).map(e => text(e.selection)).filter(Boolean);
                if (new Set(selections).size !== selections.length) return 'IVR menu digits must be unique.';
                if ((v.entries || []).some(e => text(e.selection) && !text(e.dest))) return 'Every IVR option needs a destination.';
                return '';
            };
            title = (isEdit ? 'Edit IVR · ' : 'Add IVR') + (node ? node.title : '');
        }

        if (type === 'timecondition') {
            values = {
                displayname: text(data.displayname), timegroup_id: text(data.timegroup_id),
                truegoto: text(data.truegoto) || 'app-blackhole,hangup,1',
                falsegoto: text(data.falsegoto) || 'app-blackhole,hangup,1'
            };
            sections = [
                { title: 'Time condition identity', fields: [
                    { name: 'displayname', label: 'Display name', type: 'text', required: true },
                    { name: 'timegroup_id', label: 'Time group', type: 'select', required: true, options: timegroupOptions(ctx, data.timegroup_id) }
                ] },
                { title: 'Destinations', fields: [
                    { name: 'truegoto', label: 'Destination if matched', type: 'destination', required: true, options: destinationOptions(nodes, data.truegoto) },
                    { name: 'falsegoto', label: 'Destination if not matched', type: 'destination', required: true, options: destinationOptions(nodes, data.falsegoto) }
                ] }
            ];
            endpoint = isEdit
                ? { method: 'PUT', url: `/api/config/timeconditions/${encodeURIComponent(node.refId)}` }
                : { method: 'POST', url: '/api/config/timeconditions' };
            payload = v => ({
                displayname: text(v.displayname), timegroup_id: text(v.timegroup_id),
                truegoto: text(v.truegoto), falsegoto: text(v.falsegoto)
            });
            validate = v => {
                if (!text(v.displayname)) return 'Display name is required.';
                if (!text(v.timegroup_id)) return 'Time group is required.';
                if (!text(v.truegoto) || !text(v.falsegoto)) return 'Both destinations are required.';
                return '';
            };
            title = (isEdit ? 'Edit Time Condition · ' : 'Add Time Condition') + (node ? node.title : '');
        }

        if (type === 'announcement') {
            values = {
                description: text(data.description), recording_id: text(data.recording_id || 0),
                allow_skip: Boolean(data.allow_skip), return_ivr: Boolean(data.return_ivr), noanswer: Boolean(data.noanswer),
                repeat_msg: text(data.repeat_msg), tts_lang: text(data.tts_lang || 'en-US'), tts_text: text(data.tts_text),
                post_dest: text(data.post_dest) || 'app-blackhole,hangup,1'
            };
            sections = [
                { title: 'Announcement', fields: [
                    { name: 'description', label: 'Announcement name', type: 'text', required: true },
                    { name: 'recording_id', label: 'System recording', type: 'select', options: recordingOptions(ctx, values.recording_id) },
                    { name: 'repeat_msg', label: 'Repeat message key', type: 'select', options: opt.repeatKeys },
                    { name: 'tts_lang', label: 'TTS language', type: 'select', options: opt.ttsLanguages },
                    { name: 'tts_text', label: 'TTS text (used when no recording)', type: 'textarea', rows: 3, wide: true }
                ] },
                { title: 'Playback behavior', fields: [
                    { name: 'allow_skip', label: 'Allow skip', type: 'checkbox' },
                    { name: 'return_ivr', label: 'Return to IVR', type: 'checkbox' },
                    { name: 'noanswer', label: 'Don’t answer', type: 'checkbox' }
                ] },
                commonDestinationSection([
                    { name: 'post_dest', label: 'Destination after announcement', type: 'destination', required: true, options: destinationOptions(nodes, data.post_dest) }
                ])
            ];
            endpoint = isEdit
                ? { method: 'PUT', url: `/api/config/announcements/${encodeURIComponent(node.refId)}` }
                : { method: 'POST', url: '/api/config/announcements' };
            payload = v => ({
                description: text(v.description), recording_id: text(v.recording_id || 0),
                allow_skip: v.allow_skip ? 1 : 0, return_ivr: v.return_ivr ? 1 : 0, noanswer: v.noanswer ? 1 : 0,
                repeat_msg: text(v.repeat_msg), tts_lang: v.tts_lang, tts_text: text(v.tts_text), post_dest: text(v.post_dest)
            });
            validate = v => {
                if (!text(v.description)) return 'Announcement name is required.';
                if (!text(v.post_dest)) return 'Destination is required.';
                return '';
            };
            title = (isEdit ? 'Edit Announcement · ' : 'Add Announcement') + (node ? node.title : '');
        }

        if (type === 'timegroup') {
            values = {
                description: text(data.description),
                rules: (Array.isArray(data.rules) ? data.rules : []).map(rule => ({
                    name: text(rule.name),
                    time: text(rule.time),
                    weekday: text(rule.weekday),
                    monthday: text(rule.monthday),
                    month: text(rule.month)
                }))
            };
            if (!values.rules.length) values.rules = [{ name: '', time: '09:00-17:00', weekday: 'mon-fri', monthday: '*', month: '*' }];
            sections = [
                { title: 'Time group definition', fields: [
                    { name: 'description', label: 'Description', type: 'text', required: true, wide: true }
                ] },
                { title: 'Time rules', fields: [
                    { name: 'rules', label: 'Rules', type: 'timeRules', wide: true }
                ] }
            ];
            endpoint = isEdit
                ? { method: 'PUT', url: `/api/config/timegroups/${encodeURIComponent(node.refId)}` }
                : { method: 'POST', url: '/api/config/timegroups' };
            payload = v => ({
                description: text(v.description),
                rules: (v.rules || []).filter(rule => text(rule.time) || text(rule.weekday) || text(rule.monthday) || text(rule.month)).map(rule => ({
                    name: text(rule.name),
                    time: text(rule.time),
                    weekday: text(rule.weekday) || '*',
                    monthday: text(rule.monthday) || '*',
                    month: text(rule.month) || '*'
                }))
            });
            validate = v => !text(v.description) ? 'Description is required.' : '';
            title = isEdit ? 'Edit Time Group · ' + node.title : 'Add Time Group';
        }

        if (type === 'moh') {
            if (isEdit) {
                const files = Array.isArray(data.files) ? data.files : [];
                values = {
                    name: text(data.name || node.refId),
                    sort: text(data.sort || 'alpha'),
                    mode: text(data.mode || 'files'),
                    files: String(files.length || data.fileCount || 0)
                };
                sections = [
                    { title: 'Music On Hold category', fields: [
                        { name: 'name', label: 'Category name', type: 'text', disabled: true },
                        { name: 'sort', label: 'Sort order', type: 'text', disabled: true },
                        { name: 'mode', label: 'Mode', type: 'text', disabled: true },
                        { name: 'files', label: 'Audio tracks', type: 'text', disabled: true }
                    ] }
                ];
                endpoint = null;
                payload = () => ({});
                validate = () => '';
                title = 'Music On Hold · ' + (data.name || node.refId);
                return {
                    type, title, isEdit, sections, values, endpoint, payload, validate, readOnly: true
                };
            }
            values = { name: '', sort: 'alpha' };
            sections = [
                { title: 'New Music On Hold category', fields: [
                    { name: 'name', label: 'Category name', type: 'text', required: true, wide: true, placeholder: 'e.g. promo_music' },
                    { name: 'sort', label: 'Sort order', type: 'select', wide: true, options: [
                        { value: 'alpha', label: 'alpha — alphabetical' },
                        { value: 'rand', label: 'rand — random' },
                        { value: 'random_start', label: 'random_start — random start' }
                    ] }
                ] }
            ];
            endpoint = { method: 'POST', url: '/api/config/moh/category' };
            payload = v => ({ name: text(v.name), sort: v.sort || 'alpha' });
            validate = v => !text(v.name) ? 'Category name is required.' : '';
            title = 'Add Music On Hold';
        }

        if (!sections) return null;
        return {
            type,
            title,
            isEdit,
            sections,
            values,
            endpoint,
            payload,
            validate: validate || (() => ''),
            readOnly: false
        };
    }

    return {
        build,
        destinationOptions,
        extensions,
        splitMembers,
        commonOptions
    };
});
