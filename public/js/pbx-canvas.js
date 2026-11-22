/* Sokrat PBX Canvas — isolated visual editor. Existing config APIs remain authoritative. */
(function () {
    'use strict';

    const Model = window.PbxCanvasModel;
    const Forms = window.PbxCanvasForms;
    if (!Model || !Forms) {
        console.error('PBX Canvas model/forms not loaded');
        return;
    }

    const root = document.getElementById('pbx-canvas');
    const isRtl = root && root.dataset.rtl === 'true';
    const viewport = document.getElementById('canvas-viewport');
    const world = document.getElementById('canvas-world');
    const nodesLayer = document.getElementById('canvas-nodes');
    const edgesSvg = document.getElementById('canvas-edges');
    const emptyEl = document.getElementById('canvas-empty');
    const minimap = document.getElementById('canvas-minimap');
    const statusEl = document.getElementById('canvas-status');
    const inspectorEmpty = document.getElementById('canvas-inspector-empty');
    const inspectorBody = document.getElementById('canvas-inspector-body');
    const palette = document.getElementById('canvas-palette-grid');
    const searchInput = document.getElementById('canvas-search');
    const applyBtn = document.getElementById('canvas-apply-btn');
    const discardBtn = document.getElementById('canvas-discard-btn');
    const undoBtn = document.getElementById('canvas-undo-btn');
    const redoBtn = document.getElementById('canvas-redo-btn');
    const applyLabel = document.getElementById('canvas-apply-label');
    const reviewModal = document.getElementById('canvas-review-modal');
    const reviewBody = document.getElementById('canvas-review-body');
    const reviewStatus = document.getElementById('canvas-review-status');
    const reviewApply = document.getElementById('canvas-review-apply');
    const editorOverlay = document.getElementById('canvas-editor-overlay');
    const editorTitle = document.getElementById('canvas-editor-title');
    const editorForm = document.getElementById('canvas-native-form');
    const editorFields = document.getElementById('canvas-form-fields');
    const editorStatus = document.getElementById('canvas-form-status');
    const editorSubmit = document.getElementById('canvas-form-submit');
    const editorDelete = document.getElementById('canvas-editor-delete');
    const editorClassic = document.getElementById('canvas-editor-classic');
    const editorLoading = document.getElementById('canvas-editor-loading');
    const edgeToolbar = document.getElementById('canvas-edge-toolbar');
    const edgeToolbarLabel = document.getElementById('canvas-edge-toolbar-label');
    const connectionPopup = document.getElementById('canvas-connection-popup');
    const connectionOptions = document.getElementById('canvas-connection-options');
    const studioOverlay = document.getElementById('canvas-studio-overlay');
    const studioTitle = document.getElementById('canvas-studio-title');
    const studioStatus = document.getElementById('canvas-studio-status');
    const studioApply = document.getElementById('canvas-studio-apply');
    const toastEl = document.getElementById('canvas-toast');
    const topActionsEl = document.getElementById('canvas-top-actions');
    const mobileMenuBtn = document.getElementById('canvas-mobile-menu-btn');

    const LABELS = isRtl ? {
        ready: 'جاهز',
        loading: 'جاري تحميل إعدادات المقسم…',
        noData: 'لا توجد عناصر لعرضها.',
        selectTarget: 'اختر بطاقة هدف لإكمال الاتصال.',
        invalidTarget: 'هذا الاتصال غير مسموح.',
        sameNode: 'لا يمكن ربط البطاقة بنفسها.',
        duplicate: 'هذا الاتصال موجود بالفعل.',
        saved: 'تم حفظ الموضع.',
        applied: 'تم تطبيق تغييرات المقسم.',
        applyFailed: 'فشل تطبيق التغييرات: ',
        loadFailed: 'تعذر تحميل بعض إعدادات المقسم: ',
        noChanges: 'لا توجد تغييرات لتطبيقها.',
        validation: 'تحقق من التغييرات: ',
        created: 'تم إنشاء البطاقة.',
        createFailed: 'تعذر إنشاء البطاقة: ',
        remove: 'حذف الاتصال',
        openClassic: 'تعديل في الإعداد الكلاسيكي',
        connections: 'الاتصالات',
        incoming: 'الواردة',
        outgoing: 'الصادرة',
        addCard: 'إضافة بطاقة',
        create: 'إنشاء',
        cancel: 'إلغاء',
        search: 'ابحث عن بطاقة…',
        timegroup: 'مجموعة الوقت',
        noTimegroups: 'لا توجد مجموعات وقت متاحة.',
        unassigned: 'غير معين',
        deleteCard: 'حذف البطاقة',
        deleteConfirm: 'حذف هذه البطاقة من المسودة؟',
        deleted: 'تمت إضافة البطاقة إلى قائمة الحذف.',
        deleteBlocked: 'لا يمكن حذف البطاقة: ',
        reviewTitle: 'مراجعة التغييرات',
        reviewBack: 'رجوع',
        reviewApply: 'تطبيق التغييرات',
        reviewApplying: 'جاري التطبيق…',
        reviewNoChanges: 'لا توجد تغييرات لتطبيقها.',
        reviewUpdates: 'التحديثات',
        reviewDeletions: 'الحذف',
        reviewErrors: 'تحقق من الأخطاء',
        conflict: 'تغيّر إعداد المقسم منذ تحميل الصفحة. أعد التحميل ثم أعد المحاولة.',
        partialApply: 'تم تطبيق جزء من التغييرات؛ بقيت المسودة كما هي. راجع الأخطاء.',
        voicemailEnable: 'تفعيل البريد الصوتي لتحويلة موجودة',
        voicemailExtension: 'التحويلة',
        noExtensions: 'لا توجد تحويلات متاحة.',
        forwardingClassic: 'التحويل مُدار من الإعداد الكلاسيكي.',
        draftFirst: 'طبّق أو تجاهل المسودة الحالية قبل إضافة بطاقة.'
    } : {
        ready: 'Ready',
        loading: 'Loading PBX configuration…',
        noData: 'No configuration elements to display.',
        selectTarget: 'Select a target card to complete the connection.',
        invalidTarget: 'This connection is not allowed.',
        sameNode: 'A card cannot connect to itself.',
        duplicate: 'This connection already exists.',
        saved: 'Layout saved.',
        applied: 'PBX changes applied.',
        applyFailed: 'Failed to apply changes: ',
        loadFailed: 'Some PBX configuration could not be loaded: ',
        noChanges: 'No changes to apply.',
        validation: 'Review these changes: ',
        created: 'Card created.',
        createFailed: 'Could not create card: ',
        remove: 'Remove connection',
        openClassic: 'Edit in classic config',
        connections: 'Connections',
        incoming: 'Incoming',
        outgoing: 'Outgoing',
        addCard: 'Add card',
        create: 'Create',
        cancel: 'Cancel',
        search: 'Search cards…',
        timegroup: 'Time group',
        noTimegroups: 'No time groups available.',
        unassigned: 'Unassigned',
        deleteCard: 'Delete card',
        deleteConfirm: 'Delete this card from the draft?',
        deleted: 'Card added to the deletion list.',
        deleteBlocked: 'Cannot delete card: ',
        reviewTitle: 'Review changes',
        reviewBack: 'Back',
        reviewApply: 'Apply changes',
        reviewApplying: 'Applying…',
        reviewNoChanges: 'No changes to apply.',
        reviewUpdates: 'Updates',
        reviewDeletions: 'Deletions',
        reviewErrors: 'Validation errors',
        conflict: 'PBX configuration changed after this page loaded. Reload and retry.',
        partialApply: 'Some changes were applied; the draft was kept. Review the error and retry.',
        voicemailEnable: 'Enable voicemail on an existing extension',
        voicemailExtension: 'Extension',
        noExtensions: 'No extensions available.',
        forwardingClassic: 'Forwarding is managed in classic config.',
        draftFirst: 'Apply or discard the current draft before adding a card.'
    };

    const state = {
        baseNodes: [],
        nodes: [],
        nodeMap: new Map(),
        originalEdges: [],
        draftEdges: [],
        deletedKeys: [],
        originalDeletedKeys: [],
        history: [],
        future: [],
        reviewPlan: null,
        selectedKey: null,
        pending: null,
        zoom: 1,
        pan: { x: 70, y: 70 },
        loading: false,
        dragging: null,
        panning: null,
        lastDragAt: 0,
        connectionDrag: null,
        lastConnectDragAt: 0,
        connectPointer: null,
        reverseTargetKey: null,
        connectionChoices: [],
        studio: null,
        selectedEdgeId: null,
        filter: '',
        editor: null,
        formOptions: null,
        timegroups: []
    };

    const STORAGE_KEY = 'sokrat_pbx_canvas_layout_v8';

    function esc(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function toast(message, type) {
        if (!toastEl) return;
        toastEl.textContent = message;
        toastEl.className = 'canvas-toast visible' + (type ? ' ' + type : '');
        clearTimeout(toast._timer);
        toast._timer = setTimeout(() => {
            toastEl.classList.remove('visible');
        }, 4200);
    }

    async function getJson(url) {
        const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } });
        if (response.status === 401) {
            window.location.href = '/login';
            throw new Error('Unauthorized');
        }
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.success === false) {
            throw new Error(data.error || ('HTTP ' + response.status));
        }
        return data;
    }

    function iconSvg(type) {
        const icons = {
            extension: '<rect x="5" y="2" width="14" height="20" rx="2"/><path d="M9 18h6M9 6h.01M12 6h.01M15 6h.01"/>',
            inbound: '<path d="M11 16l-4-4m0 0l4-4m-4 4h14"/><path d="M3 21h18"/>',
            outbound: '<path d="M17 16l4-4m0 0l-4-4m4 4H7"/><path d="M3 3h18v18H3z" opacity=".25"/>',
            trunk: '<path d="M5 12h14M5 12a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2M5 12a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-4a2 2 0 0 0-2-2"/><path d="M7 8h.01M17 8h.01M7 16h.01M17 16h.01"/>',
            ringgroup: '<path d="M17 20h5v-2a3 3 0 0 0-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 0 1 5.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 0 1 9.288 0M15 7a3 3 0 1 1-6 0 3 3 0 0 1 6 0z"/>',
            queue: '<path d="M4 6h16M4 12h16M4 18h16"/>',
            ivr: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M8 9h8M8 13h5M8 17h3"/>',
            timecondition: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
            announcement: '<path d="M11 5 6 9H3v6h3l5 4V5z"/><path d="M15 9a4 4 0 0 1 0 6M18 6a8 8 0 0 1 0 12"/>',
            timegroup: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
            moh: '<path d="M9 19V6l12-2v13"/><circle cx="6" cy="19" r="3"/><circle cx="18" cy="17" r="3"/>',
            terminal: '<path d="m5 7 5 5-5 5M13 17h6"/>',
            external: '<path d="M14 3h7v7M10 14 21 3"/><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/>'
        };
        return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' + (icons[type] || icons.external) + '</svg>';
    }

    function typeLabel(type) {
        const meta = Model.TYPE_META[type] || Model.TYPE_META.external;
        return meta.label;
    }

    function nodeByKey(key) {
        return state.nodeMap.get(key) || null;
    }

    function edgeSignature(edges) {
        return edges.map(e => [e.source, e.sourcePort, e.target].join('|')).sort().join('||');
    }

    function draftSignature(edges, deletedKeys) {
        return edgeSignature(edges) + '##' + (deletedKeys || []).slice().sort().join(',');
    }

    function isDirty() {
        return draftSignature(state.draftEdges, state.deletedKeys) !== draftSignature(state.originalEdges, state.originalDeletedKeys);
    }

    function snapshotDraft() {
        return {
            edges: state.draftEdges.map(edge => ({ ...edge })),
            deletedKeys: state.deletedKeys.slice()
        };
    }

    function rebuildActiveNodes() {
        const deleted = new Set(state.deletedKeys);
        state.nodes = state.baseNodes.filter(node => !deleted.has(node.key));
        state.nodeMap = new Map(state.nodes.map(node => [node.key, node]));
    }

    function restoreDraft(snapshot) {
        state.draftEdges = (snapshot.edges || []).map(edge => ({ ...edge }));
        state.deletedKeys = (snapshot.deletedKeys || []).slice();
        state.pending = null;
        state.selectedEdgeId = null;
        rebuildActiveNodes();
        if (state.selectedKey && !state.nodeMap.has(state.selectedKey)) state.selectedKey = null;
        renderAll();
    }

    function pushHistory() {
        state.history.push(snapshotDraft());
        if (state.history.length > 50) state.history.shift();
        state.future = [];
    }

    function undoDraft() {
        if (!state.history.length) return;
        state.future.push(snapshotDraft());
        restoreDraft(state.history.pop());
    }

    function redoDraft() {
        if (!state.future.length) return;
        state.history.push(snapshotDraft());
        restoreDraft(state.future.pop());
    }

    function updateDirtyUi() {
        const dirty = isDirty();
        applyBtn.disabled = !dirty || state.loading;
        discardBtn.disabled = !dirty || state.loading;
        undoBtn.disabled = !state.history.length || state.loading;
        redoBtn.disabled = !state.future.length || state.loading;
        statusEl.classList.toggle('dirty', dirty);
        statusEl.textContent = dirty
            ? (isRtl ? 'تغييرات غير مطبقة' : 'Unsaved changes')
            : (state.loading ? LABELS.loading : LABELS.ready);
        applyLabel.textContent = isRtl ? 'تطبيق التغييرات' : 'Apply Changes';
    }

    function setStatus(message, dirty) {
        statusEl.textContent = message;
        statusEl.classList.toggle('dirty', Boolean(dirty));
    }

    function loadLayout() {
        try {
            return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {};
        } catch (_) {
            return {};
        }
    }

    function saveLayout() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(Model.layoutSnapshot(state.nodes)));
        } catch (_) {}
    }

    async function fetchEntities() {
        const requests = [
            getJson('/api/config/extensions'),
            getJson('/api/config/routes/inbound'),
            getJson('/api/config/routes/outbound'),
            getJson('/api/config/trunks'),
            getJson('/api/config/ringgroups'),
            getJson('/api/config/queues'),
            getJson('/api/config/ivrs'),
            getJson('/api/config/announcements'),
            getJson('/api/config/timeconditions'),
            getJson('/api/config/timegroups'),
            getJson('/api/config/moh')
        ];
        const results = await Promise.allSettled(requests);
        const names = ['extensions', 'inboundRoutes', 'outboundRoutes', 'trunks', 'ringgroups', 'queues', 'ivrs', 'announcements', 'timeconditions', 'timegroups', 'mohCategories'];
        const entities = {};
        const failures = [];
        results.forEach((result, index) => {
            const key = names[index];
            if (result.status === 'fulfilled') {
                const data = result.value || {};
                if (key === 'extensions') entities[key] = data.extensions || [];
                else if (key === 'inboundRoutes') entities[key] = data.routes || [];
                else if (key === 'outboundRoutes') entities[key] = data.routes || [];
                else if (key === 'trunks') entities[key] = data.trunks || [];
                else if (key === 'ringgroups') entities[key] = data.ringgroups || [];
                else if (key === 'queues') entities[key] = data.queues || [];
                else if (key === 'ivrs') entities[key] = data.ivrs || [];
                else if (key === 'announcements') entities[key] = data.announcements || [];
                else if (key === 'timeconditions') entities[key] = data.timeconditions || [];
                else if (key === 'timegroups') entities[key] = data.timegroups || [];
                else if (key === 'mohCategories') entities[key] = data.categories || [];
            } else {
                failures.push(key);
                entities[key] = [];
            }
        });
        return { entities, failures };
    }

    async function loadData(options) {
        const opts = options || {};
        const previousKeys = new Set(state.baseNodes.map(node => node.key));
        state.loading = true;
        setStatus(LABELS.loading, false);
        emptyEl.classList.remove('visible');
        const { entities, failures } = await fetchEntities();
        state.timegroups = entities.timegroups || [];
        const graph = Model.buildGraph(entities);
        const hasNewCards = graph.nodes.some(node => !previousKeys.has(node.key));
        const saved = loadLayout();
        Model.loadSavedPositions(graph.nodes, saved);
        state.baseNodes = graph.nodes;
        state.deletedKeys = [];
        state.originalDeletedKeys = [];
        state.history = [];
        state.future = [];
        rebuildActiveNodes();
        state.originalEdges = graph.edges.map(e => ({ ...e }));
        state.draftEdges = graph.edges.map(e => ({ ...e }));
        state.selectedKey = state.selectedKey && state.nodeMap.has(state.selectedKey) ? state.selectedKey : null;
        state.selectedEdgeId = null;
        state.pending = null;
        closeConnectionChooser();
        state.loading = false;
        if (failures.length) toast(LABELS.loadFailed + failures.join(', '), 'error');
        renderAll();
        updateDirtyUi();
        if (opts.fitNew && hasNewCards) requestAnimationFrame(fitView);
    }

    function renderPalette() {
        if (!palette) return;
        const types = ['inbound', 'timecondition', 'timegroup', 'announcement', 'moh', 'ivr', 'ringgroup', 'queue', 'extension', 'outbound', 'trunk'];
        palette.innerHTML = types.map(type => {
            const meta = Model.TYPE_META[type];
            return `<button type="button" class="canvas-palette-item" data-add-type="${type}" style="--item-color:${meta.color}">
                ${iconSvg(type)}<span>${esc(meta.label)}</span>
            </button>`;
        }).join('');
    }

    function portButtonHtml(node, port) {
        const active = state.pending && state.pending.nodeKey === node.key && state.pending.portId === port.id;
        const label = isRtl ? `مصدر: ${port.label}` : `Source: ${port.label}`;
        return `<button type="button" class="canvas-port-handle output${active ? ' active' : ''}" data-output-node="${esc(node.key)}" data-output-port="${esc(port.id)}" title="${esc(label)} — ${isRtl ? 'اسحب إلى بطاقة هدف' : 'drag to a destination card'}" aria-label="${esc(label)}"></button>`;
    }

    function nodeMatches(node, query) {
        return [node.title, node.subtitle, typeLabel(node.type), node.refId, node.key].join(' ').toLowerCase().includes(query);
    }

    function renderNodes() {
        if (!nodesLayer) return;
        nodesLayer.innerHTML = '';
        const selected = state.selectedKey;
        const pending = state.pending;
        state.nodes.forEach(node => {
            if (!node || !node.key) return;
            const meta = Model.TYPE_META[node.type] || Model.TYPE_META.external;
            const nodeEl = document.createElement('article');
            nodeEl.className = 'canvas-node' + (selected === node.key ? ' selected' : '') + (node.placeholder ? ' canvas-node-placeholder' : '');
            if (pending && pending.nodeKey !== node.key) nodeEl.classList.add('pending-target');
            nodeEl.style.left = Math.round(node.x) + 'px';
            nodeEl.style.top = Math.round(node.y) + 'px';
            nodeEl.style.setProperty('--node-color', meta.color);
            nodeEl.dataset.nodeKey = node.key;
            nodeEl.dataset.nodeType = node.type;

            const details = (node.details || []).slice(0, 3).map(d =>
                `<div class="canvas-node-detail"><span>${esc(d.label)}</span><strong title="${esc(d.value)}">${esc(d.value || '-')}</strong></div>`
            ).join('');
            const ports = (node.ports || []).map(port =>
                `<div class="canvas-port-row"><span>${esc(port.label)}</span>${portButtonHtml(node, port)}</div>`
            ).join('');
            const hasSource = Boolean(node.output && (node.ports || []).length);
            nodeEl.innerHTML = `
                ${node.input ? `<button type="button" class="canvas-port-handle input" data-input-node="${esc(node.key)}" title="${isRtl ? 'وجهة — أسقط اتصالاً هنا' : 'Destination — drop a connection here'}" aria-label="${isRtl ? 'وجهة' : 'Destination'}"></button>` : ''}
                <div class="canvas-node-head">
                    <div class="canvas-node-icon">${iconSvg(node.type)}</div>
                    <div class="canvas-node-title">
                        <h3 title="${esc(node.title)}">${esc(node.title || node.key)}</h3>
                        <p title="${esc(node.subtitle || '')}">${esc(node.subtitle || '')}</p>
                    </div>
                    <span class="canvas-node-type">${esc(typeLabel(node.type))}</span>
                </div>
                <div class="canvas-node-body">
                    ${details || '<div class="canvas-node-detail"><span>Reference</span><strong>' + esc(node.refId) + '</strong></div>'}
                    ${ports ? `<div class="canvas-ports">${ports}</div>` : ''}
                    <div class="canvas-node-io">
                        ${node.input ? `<span class="canvas-io-tag destination">◀ ${isRtl ? 'وجهة' : 'Destination'}</span>` : '<span></span>'}
                        ${hasSource ? `<span class="canvas-io-tag source">${node.type === 'extension' ? (isRtl ? 'عضوية' : 'Membership') : (isRtl ? 'مصدر' : 'Source')} ▶</span>` : ''}
                    </div>
                </div>`;
            nodesLayer.appendChild(nodeEl);
        });
        emptyEl.classList.toggle('visible', state.nodes.length === 0);
        requestAnimationFrame(drawEdges);
        renderMinimap();
    }

    function nodeRect(node) {
        const el = nodesLayer.querySelector(`[data-node-key="${cssEscape(node.key)}"]`);
        return el ? el.getBoundingClientRect() : null;
    }

    function cssEscape(value) {
        if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);
        return String(value).replace(/["\\]/g, '\\$&');
    }

    function findPort(nodeKey, portId) {
        return nodesLayer.querySelector(`[data-output-node="${cssEscape(nodeKey)}"][data-output-port="${cssEscape(portId)}"]`);
    }

    function inputPort(nodeKey) {
        return nodesLayer.querySelector(`[data-input-node="${cssEscape(nodeKey)}"]`);
    }

    function screenPoint(el) {
        if (!el) return null;
        const rect = viewport.getBoundingClientRect();
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2 - rect.left, y: r.top + r.height / 2 - rect.top };
    }

    function drawEdges() {
        if (!edgesSvg) return;
        const width = viewport.clientWidth;
        const height = viewport.clientHeight;
        edgesSvg.setAttribute('viewBox', `0 0 ${width} ${height}`);
        const selectedEdge = state.selectedEdgeId;
        const selectedNode = state.selectedKey;
        const query = state.filter;
        const matching = query ? new Set(state.nodes.filter(node => nodeMatches(node, query)).map(node => node.key)) : null;
        edgesSvg.innerHTML = state.draftEdges.map(edge => {
            const source = findPort(edge.source, edge.sourcePort);
            const target = inputPort(edge.target);
            if (!source || !target) return '';
            const a = screenPoint(source);
            const b = screenPoint(target);
            if (!a || !b) return '';
            const dx = Math.max(45, Math.abs(b.x - a.x) / 2);
            const path = `M ${a.x.toFixed(1)} ${a.y.toFixed(1)} C ${(a.x + dx).toFixed(1)} ${a.y.toFixed(1)}, ${(b.x - dx).toFixed(1)} ${b.y.toFixed(1)}, ${b.x.toFixed(1)} ${b.y.toFixed(1)}`;
            const related = selectedNode && (edge.source === selectedNode || edge.target === selectedNode);
            const dimmed = matching && !matching.has(edge.source) && !matching.has(edge.target);
            return `<path class="canvas-edge-path${edge.id === selectedEdge ? ' selected' : ''}${related ? ' neighbor' : ''}${dimmed ? ' dimmed' : ''}" data-edge-id="${esc(edge.id)}" data-source-key="${esc(edge.source)}" data-target-key="${esc(edge.target)}" d="${path}" vector-effect="non-scaling-stroke"></path>`;
        }).join('') + (state.pending && state.connectPointer ? (() => {
            const source = findPort(state.pending.nodeKey, state.pending.portId);
            const a = source && screenPoint(source);
            if (!a) return '';
            const b = state.connectPointer;
            const dx = Math.max(45, Math.abs(b.x - a.x) / 2);
            return `<path class="canvas-edge-path draft" d="M ${a.x.toFixed(1)} ${a.y.toFixed(1)} C ${(a.x + dx).toFixed(1)} ${a.y.toFixed(1)}, ${(b.x - dx).toFixed(1)} ${b.y.toFixed(1)}, ${b.x.toFixed(1)} ${b.y.toFixed(1)}" vector-effect="non-scaling-stroke"></path>`;
        })() : '') + (state.reverseTargetKey && state.connectPointer ? (() => {
            const target = inputPort(state.reverseTargetKey);
            const b = target && screenPoint(target);
            if (!b) return '';
            const a = state.connectPointer;
            const dx = Math.max(45, Math.abs(b.x - a.x) / 2);
            return `<path class="canvas-edge-path draft" d="M ${a.x.toFixed(1)} ${a.y.toFixed(1)} C ${(a.x + dx).toFixed(1)} ${a.y.toFixed(1)}, ${(b.x - dx).toFixed(1)} ${b.y.toFixed(1)}, ${b.x.toFixed(1)} ${b.y.toFixed(1)}" vector-effect="non-scaling-stroke"></path>`;
        })() : '');
        edgesSvg.querySelectorAll('[data-edge-id]').forEach(path => {
            path.addEventListener('click', event => {
                event.stopPropagation();
                state.selectedEdgeId = path.dataset.edgeId;
                state.selectedKey = null;
                updateEdgeToolbar();
                drawEdges();
            });
        });
        updateEdgeToolbar();
    }

    function renderMinimap() {
        if (!minimap || !state.nodes.length) {
            if (minimap) minimap.innerHTML = '';
            return;
        }
        const minX = Math.min(...state.nodes.map(n => n.x));
        const minY = Math.min(...state.nodes.map(n => n.y));
        const maxX = Math.max(...state.nodes.map(n => n.x + 280));
        const maxY = Math.max(...state.nodes.map(n => n.y + 180));
        const scale = Math.min((minimap.clientWidth - 10) / Math.max(1, maxX - minX), (minimap.clientHeight - 10) / Math.max(1, maxY - minY));
        minimap.innerHTML = state.nodes.map(node => {
            const meta = Model.TYPE_META[node.type] || Model.TYPE_META.external;
            return `<div class="canvas-minimap-node" style="left:${(5 + (node.x - minX) * scale).toFixed(1)}px;top:${(5 + (node.y - minY) * scale).toFixed(1)}px;width:${Math.max(4, 280 * scale).toFixed(1)}px;height:${Math.max(3, 80 * scale).toFixed(1)}px;background:${meta.color}"></div>`;
        }).join('');
    }

    function selectNode(key) {
        state.selectedKey = key;
        state.selectedEdgeId = null;
        state.nodes.forEach(node => {
            const el = nodesLayer.querySelector(`[data-node-key="${cssEscape(node.key)}"]`);
            if (el) el.classList.toggle('selected', node.key === key);
        });
        renderInspector();
        drawEdges();
    }

    function outgoingEdges(key) {
        return state.draftEdges.filter(edge => edge.source === key);
    }

    function incomingEdges(key) {
        return state.draftEdges.filter(edge => edge.target === key);
    }

    function renderInspector() {
        if (!inspectorBody || !inspectorEmpty) return;
        if (state.selectedEdgeId) {
            const edge = state.draftEdges.find(e => e.id === state.selectedEdgeId);
            if (!edge) { state.selectedEdgeId = null; return renderInspector(); }
            const source = nodeByKey(edge.source);
            const target = nodeByKey(edge.target);
            inspectorEmpty.hidden = true;
            inspectorBody.hidden = false;
            inspectorBody.innerHTML = `
                <div class="canvas-inspector-title">${isRtl ? 'اتصال' : 'Connection'}</div>
                <div class="canvas-inspector-sub">${esc(source ? source.title : edge.source)} → ${esc(target ? target.title : edge.target)}</div>
                <div class="canvas-inspector-section">
                    <div class="canvas-inspector-kv"><span>${isRtl ? 'المنفذ' : 'Port'}</span><span>${esc(edge.sourceLabel || edge.sourcePort)}</span></div>
                    <div class="canvas-inspector-kv"><span>${isRtl ? 'الهدف' : 'Target'}</span><span>${esc(target ? target.title : edge.target)}</span></div>
                </div>
                <button type="button" class="canvas-btn danger" id="canvas-remove-edge">${LABELS.remove}</button>`;
            document.getElementById('canvas-remove-edge').onclick = () => removeEdge(edge.id);
            return;
        }
        const node = state.selectedKey ? nodeByKey(state.selectedKey) : null;
        if (!node) {
            inspectorEmpty.hidden = false;
            inspectorBody.hidden = true;
            inspectorBody.innerHTML = '';
            return;
        }
        inspectorEmpty.hidden = true;
        inspectorBody.hidden = false;
        const out = outgoingEdges(node.key);
        const inc = incomingEdges(node.key);
        const connRows = items => items.length ? items.map(edge => {
            const other = nodeByKey(edge.source === node.key ? edge.target : edge.source);
            return `<div class="canvas-connection-item"><span>${esc(edge.label || edge.sourcePort)} → ${esc(other ? other.title : edge.target)}</span><button type="button" data-remove-edge="${esc(edge.id)}" title="${LABELS.remove}">✕</button></div>`;
        }).join('') : `<div class="canvas-inspector-sub">${isRtl ? 'لا يوجد' : 'None'}</div>`;
        inspectorBody.innerHTML = `
            <div class="canvas-inspector-title">${iconSvg(node.type)} ${esc(node.title)}</div>
            <div class="canvas-inspector-sub">${esc(typeLabel(node.type))} · ${esc(node.refId)}</div>
            <div class="canvas-inspector-section">
                <div class="canvas-inspector-label">${isRtl ? 'التفاصيل' : 'Details'}</div>
                ${(node.details || []).map(d => `<div class="canvas-inspector-kv"><span>${esc(d.label)}</span><span title="${esc(d.value)}">${esc(d.value || '-')}</span></div>`).join('') || `<div class="canvas-inspector-sub">${isRtl ? 'لا توجد تفاصيل' : 'No details'}</div>`}
            </div>
            <div class="canvas-inspector-section">
                <div class="canvas-inspector-label">${LABELS.outgoing}</div>
                ${connRows(out)}
            </div>
            <div class="canvas-inspector-section">
                <div class="canvas-inspector-label">${LABELS.incoming}</div>
                ${connRows(inc)}
            </div>
            ${node.type === 'extension' ? `<div class="canvas-inspector-sub">${LABELS.forwardingClassic}</div>` : ''}
            ${Model.deletionForNode(node) ? `<button type="button" class="canvas-btn danger canvas-inspector-delete" data-delete-node="${esc(node.key)}">${LABELS.deleteCard}</button>` : ''}
            <button type="button" class="canvas-btn" data-open-editor="${esc(node.key)}">${LABELS.openClassic}</button>`;
        inspectorBody.querySelectorAll('[data-remove-edge]').forEach(btn => {
            btn.addEventListener('click', () => removeEdge(btn.dataset.removeEdge));
        });
        const deleteBtn = inspectorBody.querySelector('[data-delete-node]');
        if (deleteBtn) deleteBtn.addEventListener('click', () => requestDeleteNode(deleteBtn.dataset.deleteNode));
        const editBtn = inspectorBody.querySelector('[data-open-editor]');
        if (editBtn) editBtn.addEventListener('click', () => {
            const target = nodeByKey(editBtn.dataset.openEditor);
            if (target) openCanvasEditor(target);
        });
    }

    function classicConfigUrl(node) {
        const tabs = {
            extension: 'extensions', inbound: 'inbound', outbound: 'outbound', trunk: 'trunks',
            ringgroup: 'ringgroups', queue: 'queues', ivr: 'ivr', timecondition: 'timeconditions',
            announcement: 'announcements', timegroup: 'timegroups', moh: 'recordings'
        };
        const data = node.data || {};
        const params = new URLSearchParams({ tab: tabs[node.type] || 'extensions', lang: isRtl ? 'ar' : 'en' });
        const id = node.type === 'inbound'
            ? data.extension
            : node.type === 'outbound' ? data.route_id
                : node.type === 'ringgroup' ? data.grpnum
                    : node.type === 'queue' ? data.extension
                        : node.type === 'ivr' ? data.id
                            : node.type === 'timecondition' ? data.timeconditions_id
                                : node.type === 'announcement' ? data.announcement_id
                                    : node.refId;
        if (node.type !== 'timegroup') {
            params.set('canvasEditType', node.type);
            if (id !== undefined && id !== null && String(id) !== '') params.set('canvasEditId', String(id));
            if (node.type === 'inbound') params.set('canvasEditCid', data.cidnum || '');
        }
        if (node.type === 'timegroup') params.set('canvasEditType', 'timegroup');
        if (node.type === 'timegroup') params.set('canvasEditId', String(node.refId));
        return '/config?' + params.toString();
    }

    function updateEdgeToolbar() {
        if (!edgeToolbar) return;
        const edge = state.selectedEdgeId ? state.draftEdges.find(item => item.id === state.selectedEdgeId) : null;
        if (!edge) {
            edgeToolbar.hidden = true;
            if (edgeToolbarLabel) edgeToolbarLabel.textContent = '';
            return;
        }
        const source = nodeByKey(edge.source);
        const target = nodeByKey(edge.target);
        edgeToolbar.hidden = false;
        if (edgeToolbarLabel) edgeToolbarLabel.textContent = (source ? source.title : edge.source) + ' → ' + (target ? target.title : edge.target);
    }

    function closeCanvasEditor(reload) {
        if (!state.editor) return;
        const wasAdd = state.editor.mode === 'add';
        state.editor = null;
        editorOverlay.classList.remove('open');
        editorOverlay.setAttribute('aria-hidden', 'true');
        editorFields.innerHTML = '';
        editorStatus.textContent = '';
        editorStatus.classList.remove('error');
        editorLoading.classList.remove('hidden');
        editorSubmit.disabled = false;
        editorSubmit.hidden = false;
        editorDelete.hidden = true;
        editorClassic.hidden = true;
        if (reload) {
            loadData().then(() => {
                if (wasAdd) fitView();
            }).catch(error => toast(LABELS.loadFailed + error.message, 'error'));
        }
    }

    function closeStudio() {
        if (!studioOverlay) return;
        state.studio = null;
        studioOverlay.hidden = true;
        studioStatus.textContent = '';
        studioStatus.classList.remove('error');
        studioApply.disabled = false;
    }

    async function openStudio(kind, target) {
        state.studio = { kind, ...target };
        studioTitle.textContent = kind === 'moh'
            ? (isRtl ? 'استوديو موسيقى الانتظار' : 'Music On Hold Studio') + (target.filename ? ' · ' + target.filename : '')
            : (isRtl ? 'استوديو التسجيل' : 'Recording Studio');
        studioStatus.textContent = '';
        studioStatus.classList.remove('error');
        document.getElementById('studio-gain').value = '0';
        document.getElementById('studio-normalize').value = '';
        document.getElementById('studio-compand').value = 'off';
        document.getElementById('studio-bass').value = '0';
        document.getElementById('studio-treble').value = '0';
        document.getElementById('studio-tempo').value = '1';
        document.getElementById('studio-fade-in').value = '0';
        document.getElementById('studio-fade-out').value = '0';
        document.getElementById('studio-pad-lead').value = '0';
        document.getElementById('studio-pad-trail').value = '0';
        document.getElementById('studio-bandpass').checked = false;
        document.getElementById('studio-hiss').checked = false;
        document.getElementById('studio-trim').checked = false;
        document.getElementById('studio-reset').checked = false;
        document.getElementById('studio-codecs').checked = true;
        document.getElementById('studio-codecs-wrap').hidden = kind !== 'recording';
        studioOverlay.hidden = false;
        try {
            const info = kind === 'moh'
                ? await getJson(`/api/config/moh/file/info?category=${encodeURIComponent(target.category)}&file=${encodeURIComponent(target.filename)}`)
                : await getJson(`/api/config/recordings/${encodeURIComponent(target.id)}/info`);
            const dsp = info.dspSettings || {};
            document.getElementById('studio-gain').value = String(info.gainDb !== undefined ? info.gainDb : (dsp.gainDb || 0));
            document.getElementById('studio-normalize').value = dsp.normDb !== undefined && dsp.normDb !== null ? String(dsp.normDb) : '';
            document.getElementById('studio-compand').value = ['off', 'soft', 'broadcast'].includes(dsp.compand) ? dsp.compand : 'off';
            document.getElementById('studio-bass').value = String(dsp.bass || 0);
            document.getElementById('studio-treble').value = String(dsp.treble || 0);
            document.getElementById('studio-tempo').value = String(dsp.tempo || 1);
            document.getElementById('studio-fade-in').value = String(dsp.fadeIn || 0);
            document.getElementById('studio-fade-out').value = String(dsp.fadeOut || 0);
            document.getElementById('studio-pad-lead').value = String(dsp.padLead || 0);
            document.getElementById('studio-pad-trail').value = String(dsp.padTrail || 0);
            document.getElementById('studio-bandpass').checked = Boolean(dsp.bandpass);
            document.getElementById('studio-hiss').checked = Boolean(dsp.hissFilter);
            document.getElementById('studio-trim').checked = Boolean(dsp.trimSilence);
        } catch (error) {
            studioStatus.textContent = error.message;
            studioStatus.classList.add('error');
        }
    }

    async function refreshCurrentEditor() {
        const editor = state.editor;
        if (!editor) return;
        const key = editor.node && editor.node.key;
        const type = editor.type;
        await loadData();
        const node = key ? nodeByKey(key) : null;
        await openCanvasEditor(node, type);
    }

    async function applyStudio() {
        if (!state.studio) return;
        const number = id => {
            const value = document.getElementById(id).value;
            return value === '' ? null : Number(value);
        };
        const body = {
            gainDb: number('studio-gain'),
            normDb: number('studio-normalize'),
            compand: document.getElementById('studio-compand').value,
            bandpass: document.getElementById('studio-bandpass').checked,
            hissFilter: document.getElementById('studio-hiss').checked,
            bass: number('studio-bass') || 0,
            treble: number('studio-treble') || 0,
            tempo: number('studio-tempo') || 1,
            trimSilence: document.getElementById('studio-trim').checked,
            fadeIn: number('studio-fade-in') || 0,
            fadeOut: number('studio-fade-out') || 0,
            enablePadLead: Number(document.getElementById('studio-pad-lead').value) > 0,
            padLead: number('studio-pad-lead') || 0,
            enablePadTrail: Number(document.getElementById('studio-pad-trail').value) > 0,
            padTrail: number('studio-pad-trail') || 0,
            resetToOriginal: document.getElementById('studio-reset').checked
        };
        const kind = state.studio.kind;
        let url;
        if (kind === 'moh') {
            body.category = state.studio.category;
            body.filename = state.studio.filename;
            url = '/api/config/moh/file/dsp';
        } else {
            body.generateCodecs = document.getElementById('studio-codecs').checked;
            url = `/api/config/recordings/${encodeURIComponent(state.studio.id)}/dsp`;
        }
        studioApply.disabled = true;
        studioStatus.textContent = isRtl ? 'جاري التطبيق…' : 'Applying…';
        studioStatus.classList.remove('error');
        try {
            const response = await fetch(url, {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                body: JSON.stringify(body)
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok || data.success === false) throw new Error(data.error || ('HTTP ' + response.status));
            toast(kind === 'moh' ? (isRtl ? 'تم تطبيق معالجة الصوت.' : 'Audio processing applied.') : (isRtl ? 'تم تطبيق معالجة التسجيل.' : 'Recording processing applied.'), 'success');
            closeStudio();
            if (kind === 'moh') await refreshCurrentEditor();
        } catch (error) {
            studioStatus.textContent = error.message;
            studioStatus.classList.add('error');
            studioApply.disabled = false;
        }
    }

    async function loadFormOptions() {
        if (state.formOptions) return state.formOptions;
        const [recordingsRes, mohRes, groupsRes] = await Promise.all([
            getJson('/api/config/recordings').catch(() => ({ recordings: [] })),
            getJson('/api/config/moh').catch(() => ({ categories: [] })),
            getJson('/api/employee/groups').catch(() => ({ groups: [] }))
        ]);
        state.formOptions = {
            recordings: recordingsRes.recordings || [],
            mohCategories: (mohRes.categories || []).map(category => category.name || category).filter(Boolean),
            employeeGroups: groupsRes.groups || []
        };
        return state.formOptions;
    }

    function fieldOptions(field, current) {
        const options = (typeof field.options === 'function' ? field.options() : field.options || []).map(option => ({
            value: String(option.value), label: option.label
        }));
        const value = current === undefined || current === null ? '' : String(current);
        if (value && !options.some(option => option.value === value)) options.unshift({ value, label: value });
        return options;
    }

    function optionHtml(options, selected, required) {
        const hasBlank = options.some(option => option.value === '');
        return (required || hasBlank ? '' : '<option value="">—</option>') +
            options.map(option => `<option value="${esc(option.value)}"${String(selected) === option.value ? ' selected' : ''}>${esc(option.label)}</option>`).join('');
    }

    function destinationFieldHtml(field, value) {
        const options = fieldOptions(field, value);
        const custom = value && !options.some(option => option.value === String(value));
        const optionRows = (field.required ? '' : '<option value="">— None —</option>') +
            options.map(option => `<option value="${esc(option.value)}"${!custom && String(value) === option.value ? ' selected' : ''}>${esc(option.label)}</option>`).join('') +
            '<option value="__custom__"' + (custom ? ' selected' : '') + '>Custom destination…</option>';
        return `<select name="${esc(field.name)}" data-destination-select data-required="${field.required ? 'true' : 'false'}">${optionRows}</select>
            <input class="canvas-form-custom" data-custom-for="${esc(field.name)}" name="${esc(field.name)}__custom" type="text" value="${custom ? esc(value) : ''}" placeholder="e.g. from-did-direct,101,1"${custom ? '' : ' hidden'}>`;
    }

    function simpleFieldHtml(field, value) {
        const common = `name="${esc(field.name)}"${field.required ? ' required' : ''}${field.disabled || field.readonly ? ' disabled' : ''}`;
        if (field.type === 'select') {
            const options = fieldOptions(field, value);
            return `<select ${common}>${optionHtml(options, value, field.required)}</select>`;
        }
        if (field.type === 'textarea') {
            return `<textarea ${common} rows="${field.rows || 3}" placeholder="${esc(field.placeholder || '')}">${esc(value || '')}</textarea>`;
        }
        if (field.type === 'number') {
            return `<input ${common} type="number" min="${field.min !== undefined ? field.min : ''}" max="${field.max !== undefined ? field.max : ''}" value="${esc(value || '')}" placeholder="${esc(field.placeholder || '')}">`;
        }
        if (field.type === 'checkbox') {
            return `<label class="canvas-form-field canvas-form-check"><input ${common} type="checkbox"${value ? ' checked' : ''}><span>${esc(field.label)}</span></label>`;
        }
        return `<input ${common} type="${field.type === 'password' ? 'password' : 'text'}" value="${esc(value || '')}" placeholder="${esc(field.placeholder || '')}" autocomplete="off">`;
    }

    function rowField(field, key, value, type) {
        return `<label class="canvas-form-field"><span>${esc(field.label || key)}</span><input data-key="${esc(key)}" type="${type || 'text'}" value="${esc(value || '')}" placeholder="${esc(field.placeholder || '')}"></label>`;
    }

    function repeatRowHtml(field, row) {
        if (field.type === 'patterns') {
            return `<div class="canvas-form-row" data-repeat-row>
                ${rowField({ label: 'Prepend' }, 'prepend', row.prepend)}
                ${rowField({ label: 'Prefix' }, 'prefix', row.prefix)}
                ${rowField({ label: 'Match pattern' }, 'pattern', row.pattern)}
                ${rowField({ label: 'Caller ID' }, 'cid', row.cid)}
                <div class="canvas-form-row-actions"><button type="button" class="canvas-form-icon-btn" data-remove-row title="Remove">✕</button></div>
            </div>`;
        }
        if (field.type === 'rules') {
            return `<div class="canvas-form-row" data-repeat-row>
                ${rowField({ label: 'Prepend' }, 'prepend', row.prepend)}
                ${rowField({ label: 'Prefix' }, 'prefix', row.prefix)}
                ${rowField({ label: 'Match pattern' }, 'pattern', row.pattern)}
                <div class="canvas-form-row-actions"><button type="button" class="canvas-form-icon-btn" data-remove-row title="Remove">✕</button></div>
            </div>`;
        }
        if (field.type === 'timeRules') {
            return `<div class="canvas-form-row time-rules-row" data-time-rule-row>
                ${rowField({ label: 'Name' }, 'name', row.name)}
                ${rowField({ label: 'Time' }, 'time', row.time, 'text')}
                ${rowField({ label: 'Weekday' }, 'weekday', row.weekday, 'text')}
                ${rowField({ label: 'Month day' }, 'monthday', row.monthday, 'text')}
                ${rowField({ label: 'Month' }, 'month', row.month, 'text')}
                <div class="canvas-form-row-actions"><button type="button" class="canvas-form-icon-btn" data-remove-row title="Remove">✕</button></div>
            </div>`;
        }
        if (field.type === 'ivrEntries') {
            const options = fieldOptions(field, row.dest);
            const custom = row.dest && !options.some(option => option.value === String(row.dest));
            const optionRows = options.map(option => `<option value="${esc(option.value)}"${custom ? '' : row.dest === option.value ? ' selected' : ''}>${esc(option.label)}</option>`).join('') +
                '<option value="__custom__"' + (custom ? ' selected' : '') + '>Custom destination…</option>';
            return `<div class="canvas-form-row" data-ivr-row>
                <label class="canvas-form-field"><span>Digit</span><input data-key="selection" type="text" value="${esc(row.selection || '')}" placeholder="1"></label>
                <label class="canvas-form-field"><span>Destination</span><select data-key="dest">${optionRows}</select><input data-key="destcustom" type="text" value="${custom ? esc(row.dest) : ''}" placeholder="Custom destination"${custom ? '' : ' hidden'}></label>
                <label class="canvas-form-check"><input data-key="ivr_ret" type="checkbox"${row.ivr_ret ? ' checked' : ''}><span>Return to IVR</span></label>
                <div class="canvas-form-row-actions"><button type="button" class="canvas-form-icon-btn" data-remove-row title="Remove">✕</button></div>
            </div>`;
        }
        return '';
    }

    function fieldHtml(field, value) {
        if (field.type === 'checkbox') return `<div class="canvas-form-field${field.wide ? ' wide' : ''}">${simpleFieldHtml(field, value)}</div>`;
        if (field.type === 'destination') {
            return `<label class="canvas-form-field${field.wide ? ' wide' : ''}"><span>${esc(field.label)}</span>${destinationFieldHtml(field, value)}</label>`;
        }
        if (field.type === 'members') {
            const selected = Array.isArray(value) ? value.map(String) : [];
            return `<div class="canvas-form-field wide"><span>${esc(field.label)}</span><div class="canvas-form-checks" data-members="${esc(field.name)}">${fieldOptions(field).map(option => `<label class="canvas-form-check-item"><input type="checkbox" value="${esc(option.value)}"${selected.includes(option.value) ? ' checked' : ''}><span>${esc(option.label)}</span></label>`).join('')}</div></div>`;
        }
        if (['patterns', 'rules', 'ivrEntries', 'timeRules'].includes(field.type)) {
            const rows = Array.isArray(value) && value.length ? value : [{}];
            return `<div class="canvas-form-field wide" data-repeater="${esc(field.name)}"><span>${esc(field.label)}</span><div class="canvas-form-repeater"><div class="canvas-form-rows">${rows.map(row => repeatRowHtml(field, row)).join('')}</div><button type="button" class="canvas-btn ghost canvas-form-add" data-add-row>+ Add row</button></div></div>`;
        }
        if (field.type === 'sequence') {
            const selected = Array.isArray(value) ? value : [];
            const rows = selected.length ? selected : [''];
            const options = fieldOptions(field);
            return `<div class="canvas-form-field wide" data-sequence="${esc(field.name)}"><span>${esc(field.label)}</span>
                <div class="canvas-form-repeater"><div class="canvas-form-rows">${rows.map((id, index) => `<div class="canvas-form-row" data-sequence-row>
                    <label class="canvas-form-field"><span>Sequence ${index + 1}</span><select data-seq-value>${optionHtml(options, id, true)}</select></label>
                    <div class="canvas-form-row-actions"><button type="button" class="canvas-form-icon-btn" data-move-up title="Move up">↑</button><button type="button" class="canvas-form-icon-btn" data-move-down title="Move down">↓</button><button type="button" class="canvas-form-icon-btn" data-remove-row title="Remove">✕</button></div>
                </div>`).join('')}</div><button type="button" class="canvas-btn ghost canvas-form-add" data-add-sequence>+ Add trunk</button></div></div>`;
        }
        return `<label class="canvas-form-field${field.wide ? ' wide' : ''}"><span>${esc(field.label)}${field.required ? ' *' : ''}</span>${simpleFieldHtml(field, value)}</label>`;
    }

    function appendExtensionPhoto(form) {
        const section = document.createElement('section');
        section.className = 'canvas-form-section';
        const photo = form.values.photo || '';
        section.innerHTML = `<h3 class="canvas-form-section-head">${isRtl ? 'صورة الموظف' : 'Employee photo'}</h3>
            <div class="canvas-media-row">
                <img class="canvas-photo-preview" id="canvas-photo-preview" alt="" src="${esc(photo)}">
                <input class="canvas-file-hidden" id="canvas-photo-file" type="file" accept="image/*">
                <input type="hidden" name="photo" value="${esc(photo)}">
                <div class="canvas-media-actions"><button type="button" class="canvas-btn ghost" id="canvas-photo-upload">${isRtl ? 'اختيار صورة' : 'Choose photo'}</button></div>
            </div>`;
        editorFields.appendChild(section);
        const file = section.querySelector('#canvas-photo-file');
        const hidden = section.querySelector('input[name="photo"]');
        const image = section.querySelector('#canvas-photo-preview');
        section.querySelector('#canvas-photo-upload').addEventListener('click', () => file.click());
        file.addEventListener('change', async () => {
            if (!file.files || !file.files[0]) return;
            const body = new FormData();
            body.append('photo', file.files[0]);
            try {
                const response = await fetch('/api/employee/photo', { method: 'POST', credentials: 'same-origin', body });
                const data = await response.json().catch(() => ({}));
                if (!response.ok || data.success === false) throw new Error(data.error || ('HTTP ' + response.status));
                form.values.photo = data.url;
                hidden.value = data.url;
                image.src = data.url;
                toast(isRtl ? 'تم رفع الصورة.' : 'Photo uploaded.', 'success');
            } catch (error) {
                toast((isRtl ? 'تعذر رفع الصورة: ' : 'Photo upload failed: ') + error.message, 'error');
            }
        });
    }

    function appendAnnouncementMedia(form) {
        const select = editorForm.elements.recording_id;
        if (!select) return;
        const section = document.createElement('section');
        section.className = 'canvas-form-section';
        section.innerHTML = `<h3 class="canvas-form-section-head">${isRtl ? 'الملف الصوتي والاستوديو' : 'Audio file & studio'}</h3>
            <div class="canvas-media-row">
                <audio id="canvas-announcement-preview" controls preload="none"></audio>
                <input class="canvas-file-hidden" id="canvas-announcement-upload" type="file" accept=".mp3,.wav,.ogg,.m4a,.flac,.aac">
                <div class="canvas-media-actions">
                    <button type="button" class="canvas-btn ghost" id="canvas-announcement-upload-btn">${isRtl ? 'رفع تسجيل' : 'Upload recording'}</button>
                    <button type="button" class="canvas-btn" id="canvas-announcement-studio">${isRtl ? 'الاستوديو' : 'Studio'}</button>
                </div>
            </div>`;
        editorFields.appendChild(section);
        const audio = section.querySelector('#canvas-announcement-preview');
        const studio = section.querySelector('#canvas-announcement-studio');
        const upload = section.querySelector('#canvas-announcement-upload');
        const sync = () => {
            const id = Number(select.value) || 0;
            audio.src = id ? `/api/config/recordings/audio/${id}` : '';
            studio.disabled = !id;
        };
        select.addEventListener('change', sync);
        studio.addEventListener('click', () => {
            const id = Number(select.value) || 0;
            if (id) openStudio('recording', { id });
        });
        section.querySelector('#canvas-announcement-upload-btn').addEventListener('click', () => upload.click());
        upload.addEventListener('change', async () => {
            if (!upload.files || !upload.files[0]) return;
            const body = new FormData();
            body.append('file', upload.files[0]);
            body.append('name', upload.files[0].name.replace(/\.[^.]+$/, ''));
            try {
                const response = await fetch('/api/settings/recordings/upload', { method: 'POST', credentials: 'same-origin', body });
                const data = await response.json().catch(() => ({}));
                if (!response.ok || data.success === false) throw new Error(data.error || ('HTTP ' + response.status));
                if (data.id) {
                    const option = document.createElement('option');
                    option.value = String(data.id);
                    option.textContent = upload.files[0].name;
                    select.appendChild(option);
                    select.value = String(data.id);
                    select.dispatchEvent(new Event('change', { bubbles: true }));
                }
                state.formOptions = null;
                toast(isRtl ? 'تم رفع التسجيل.' : 'Recording uploaded.', 'success');
            } catch (error) {
                toast((isRtl ? 'تعذر رفع التسجيل: ' : 'Recording upload failed: ') + error.message, 'error');
            }
        });
        sync();
    }

    function appendMohMedia(form) {
        const node = state.editor && state.editor.node;
        if (!node) return;
        const files = Array.isArray(node.data.files) ? node.data.files : [];
        const section = document.createElement('section');
        section.className = 'canvas-form-section';
        section.innerHTML = `<h3 class="canvas-form-section-head">${isRtl ? 'ملفات الموسيقى' : 'Audio tracks'}</h3>
            <div class="canvas-media-section">
                ${files.length ? files.map(file => `<div class="canvas-media-row" data-moh-file="${esc(file.filename)}">
                    <div class="canvas-media-row-main"><strong>${esc(file.filename)}</strong><span>${esc(file.format || '')} · ${esc(file.durationFormatted || '')} · ${esc(file.sizeFormatted || '')}</span></div>
                    <audio controls preload="none" src="${esc(file.streamUrl || `/api/config/moh/stream/${encodeURIComponent(node.refId)}/${encodeURIComponent(file.filename)}`)}"></audio>
                    <div class="canvas-media-actions">
                        <button type="button" class="canvas-btn ghost" data-moh-studio="${esc(file.filename)}">${isRtl ? 'الاستوديو' : 'Studio'}</button>
                        <button type="button" class="canvas-btn danger" data-moh-delete="${esc(file.filename)}">${isRtl ? 'حذف' : 'Delete'}</button>
                    </div>
                </div>`).join('') : `<div class="canvas-form-status">${isRtl ? 'لا توجد ملفات صوتية بعد.' : 'No audio tracks yet.'}</div>`}
                <div class="canvas-media-row">
                    <input class="canvas-file-hidden" id="canvas-moh-upload" type="file" accept=".wav,.mp3,.ogg,.gsm">
                    <div class="canvas-media-actions"><button type="button" class="canvas-btn ghost" id="canvas-moh-upload-btn">${isRtl ? 'رفع ملف صوتي' : 'Upload audio'}</button></div>
                </div>
            </div>`;
        editorFields.appendChild(section);
        const upload = section.querySelector('#canvas-moh-upload');
        section.querySelector('#canvas-moh-upload-btn').addEventListener('click', () => upload.click());
        upload.addEventListener('change', async () => {
            if (!upload.files || !upload.files[0]) return;
            const body = new FormData();
            body.append('audio', upload.files[0]);
            try {
                const response = await fetch(`/api/config/moh/upload?category=${encodeURIComponent(node.refId)}`, { method: 'POST', credentials: 'same-origin', body });
                const data = await response.json().catch(() => ({}));
                if (!response.ok || data.success === false) throw new Error(data.error || ('HTTP ' + response.status));
                toast(isRtl ? 'تم رفع الملف الصوتي.' : 'Audio uploaded.', 'success');
                await refreshCurrentEditor();
            } catch (error) {
                toast((isRtl ? 'تعذر رفع الملف: ' : 'Audio upload failed: ') + error.message, 'error');
            }
        });
        section.querySelectorAll('[data-moh-studio]').forEach(button => {
            button.addEventListener('click', () => openStudio('moh', { category: node.refId, filename: button.dataset.mohStudio }));
        });
        section.querySelectorAll('[data-moh-delete]').forEach(button => {
            button.addEventListener('click', async () => {
                if (!window.confirm(isRtl ? 'حذف هذا الملف الصوتي؟' : 'Delete this audio track?')) return;
                try {
                    const response = await fetch('/api/config/moh/file', {
                        method: 'DELETE', credentials: 'same-origin',
                        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                        body: JSON.stringify({ category: node.refId, filename: button.dataset.mohDelete })
                    });
                    const data = await response.json().catch(() => ({}));
                    if (!response.ok || data.success === false) throw new Error(data.error || ('HTTP ' + response.status));
                    toast(isRtl ? 'تم حذف الملف.' : 'Audio track deleted.', 'success');
                    await refreshCurrentEditor();
                } catch (error) {
                    toast((isRtl ? 'تعذر حذف الملف: ' : 'Delete failed: ') + error.message, 'error');
                }
            });
        });
    }

    function renderNativeForm(form) {
        editorFields.innerHTML = form.sections.map(section => `<section class="canvas-form-section"><h3 class="canvas-form-section-head">${esc(section.title)}</h3><div class="canvas-form-grid">${section.fields.map(field => fieldHtml(field, form.values[field.name])).join('')}</div></section>`).join('');
        editorStatus.textContent = '';
        editorStatus.classList.remove('error');
        editorSubmit.disabled = Boolean(form.readOnly);
        editorSubmit.hidden = Boolean(form.readOnly);
        if (form.type === 'extension') appendExtensionPhoto(form);
        if (form.type === 'announcement') appendAnnouncementMedia(form);
        if (form.type === 'moh') appendMohMedia(form);
        editorLoading.classList.add('hidden');
    }

    function readFormValues(form) {
        const values = { ...(form.values || {}) };
        form.sections.forEach(section => section.fields.forEach(field => {
            if (['patterns', 'rules', 'ivrEntries', 'timeRules'].includes(field.type)) {
                values[field.name] = [...editorFields.querySelectorAll(`[data-repeater="${field.name}"] [data-repeat-row], [data-repeater="${field.name}"] [data-ivr-row]`)].map(row => {
                    const item = {};
                    row.querySelectorAll('[data-key]').forEach(input => { item[input.dataset.key] = input.type === 'checkbox' ? input.checked : input.value; });
                    if (field.type === 'ivrEntries') {
                        const select = row.querySelector('[data-key="dest"]');
                        const custom = row.querySelector('[data-key="destcustom"]');
                        if (select && select.value === '__custom__') item.dest = custom ? custom.value : '';
                    }
                    return item;
                }).filter(item => Object.values(item).some(value => value !== '' && value !== false));
            } else if (field.type === 'sequence') {
                values[field.name] = [...editorFields.querySelectorAll(`[data-sequence="${field.name}"] [data-seq-value]`)].map(select => select.value).filter(Boolean);
            } else if (field.type === 'members') {
                values[field.name] = [...editorFields.querySelectorAll(`[data-members="${field.name}"] input:checked`)].map(input => input.value);
            } else if (field.type === 'destination') {
                const select = editorForm.elements[field.name];
                const custom = editorForm.elements[field.name + '__custom'];
                values[field.name] = select && select.value === '__custom__' ? (custom ? custom.value : '') : (select ? select.value : '');
            } else {
                const element = editorForm.elements[field.name];
                if (element) values[field.name] = element.type === 'checkbox' ? element.checked : element.value;
            }
        }));
        return values;
    }

    async function submitNativeForm(event) {
        event.preventDefault();
        if (!state.editor || !state.editor.form || state.editor.form.readOnly) return;
        const form = state.editor.form;
        const values = readFormValues(form);
        const validation = form.validate(values);
        if (validation) {
            editorStatus.textContent = validation;
            editorStatus.classList.add('error');
            return;
        }
        const endpoint = typeof form.endpoint === 'function' ? form.endpoint(values) : form.endpoint;
        editorSubmit.disabled = true;
        editorStatus.textContent = isRtl ? 'جاري الحفظ…' : 'Saving…';
        editorStatus.classList.remove('error');
        try {
            const response = await fetch(endpoint.url, {
                method: endpoint.method,
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                body: JSON.stringify(form.payload(values))
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok || data.success === false) throw new Error(data.error || ('HTTP ' + response.status));
            const wasAdd = state.editor.mode === 'add';
            closeCanvasEditor(false);
            toast(isRtl ? 'تم حفظ الإعداد.' : 'Configuration saved.', 'success');
            await loadData();
            if (wasAdd) fitView();
        } catch (error) {
            editorStatus.textContent = error.message;
            editorStatus.classList.add('error');
            editorSubmit.disabled = false;
        }
    }

    async function openCanvasEditor(node, type) {
        if (isDirty()) {
            toast(LABELS.draftFirst, 'error');
            return;
        }
        const cardType = node ? node.type : type;
        const supported = ['extension', 'inbound', 'outbound', 'trunk', 'ringgroup', 'queue', 'ivr', 'timecondition', 'timegroup', 'announcement', 'moh'];
        if (!supported.includes(cardType)) return;
        editorTitle.textContent = (node ? (isRtl ? 'تعديل ' : 'Edit ') : (isRtl ? 'إضافة ' : 'Add ')) + typeLabel(cardType) + (node ? ' · ' + node.title : '');
        editorLoading.classList.remove('hidden');
        editorFields.innerHTML = '';
        editorStatus.textContent = '';
        editorOverlay.classList.add('open');
        editorOverlay.setAttribute('aria-hidden', 'false');
        state.editor = { mode: node ? 'edit' : 'add', node, type: cardType, form: null };
        editorSubmit.hidden = false;
        editorDelete.hidden = !node || !Model.deletionForNode(node) || (node.type === 'moh' && ['default', 'none'].includes(String(node.refId)));
        editorClassic.hidden = !node;
        try {
            const options = await loadFormOptions();
            if (!state.editor || state.editor.type !== cardType) return;
            const form = Forms.build(cardType, node, {
                ...options,
                nodes: state.nodes,
                timegroups: state.timegroups
            });
            if (!form) throw new Error(isRtl ? 'هذا النموذج غير مدعوم.' : 'This form is not supported.');
            state.editor.form = form;
            if (form.title) editorTitle.textContent = form.title;
            renderNativeForm(form);
        } catch (error) {
            editorLoading.classList.add('hidden');
            editorStatus.textContent = error.message;
            editorStatus.classList.add('error');
            editorSubmit.disabled = true;
        }
    }

    function removeEdge(id) {
        pushHistory();
        state.draftEdges = state.draftEdges.filter(edge => edge.id !== id);
        state.selectedEdgeId = null;
        renderAll();
    }

    function requestDeleteNode(key) {
        const node = nodeByKey(key);
        if (!node) return;
        const error = Model.nodeDeleteError(node, { nodes: state.nodes, edges: state.draftEdges });
        if (error) {
            toast(LABELS.deleteBlocked + error, 'error');
            return;
        }
        if (!window.confirm((isRtl ? 'حذف ' : 'Delete ') + node.title + '?\n' + LABELS.deleteConfirm)) return;
        pushHistory();
        const keys = [node.key];
        state.deletedKeys = [...new Set([...state.deletedKeys, ...keys])];
        state.draftEdges = state.draftEdges.filter(edge => !keys.includes(edge.source) && !keys.includes(edge.target));
        state.selectedKey = null;
        state.selectedEdgeId = null;
        state.pending = null;
        rebuildActiveNodes();
        toast(LABELS.deleted, 'success');
        renderAll();
        updateDirtyUi();
    }

    function startConnectionDrag(event) {
        if (event.button !== 0) return;
        const output = event.target.closest('[data-output-node]');
        const input = event.target.closest('[data-input-node]');
        if (!output && !input) return;
        event.stopPropagation();
        state.reverseTargetKey = null;
        state.connectionDrag = {
            startX: event.clientX,
            startY: event.clientY,
            lastX: event.clientX,
            lastY: event.clientY,
            direction: output ? 'forward' : 'reverse',
            nodeKey: output ? output.dataset.outputNode : '',
            portId: output ? output.dataset.outputPort : '',
            targetKey: input ? input.dataset.inputNode : '',
            active: false
        };
        window.addEventListener('pointermove', onConnectionDrag);
        window.addEventListener('pointerup', endConnectionDrag, { once: true });
        window.addEventListener('pointercancel', endConnectionDrag, { once: true });
    }

    function onConnectionDrag(event) {
        const drag = state.connectionDrag;
        if (!drag) return;
        if (!drag.active && (Math.abs(event.clientX - drag.startX) > 5 || Math.abs(event.clientY - drag.startY) > 5)) {
            drag.active = true;
            if (drag.direction === 'reverse') {
                state.reverseTargetKey = drag.targetKey;
            } else {
                beginConnection(drag.nodeKey, drag.portId);
            }
        }
        if (!drag.active) return;
        drag.lastX = event.clientX;
        drag.lastY = event.clientY;
        const rect = viewport.getBoundingClientRect();
        state.connectPointer = { x: event.clientX - rect.left, y: event.clientY - rect.top };
        drawEdges();
    }

    function endConnectionDrag(event) {
        const drag = state.connectionDrag;
        state.connectionDrag = null;
        window.removeEventListener('pointermove', onConnectionDrag);
        window.removeEventListener('pointercancel', endConnectionDrag);
        if (!drag || !drag.active) return;
        state.lastConnectDragAt = Date.now();
        const x = Number.isFinite(event.clientX) ? event.clientX : drag.lastX;
        const y = Number.isFinite(event.clientY) ? event.clientY : drag.lastY;
        if (event.type === 'pointercancel') {
            state.pending = null;
            state.connectPointer = null;
            state.reverseTargetKey = null;
            closeConnectionChooser();
            renderAll();
            return;
        }
        let targetKey = '';
        let fallbackTarget = '';
        let sourceKey = '';
        let sourcePort = '';
        const sourceNode = drag.direction === 'forward' ? nodeByKey(drag.nodeKey) : null;
        const sourcePortObj = sourceNode && (sourceNode.ports || []).find(port => port.id === drag.portId);
        const reverseTarget = drag.direction === 'reverse' ? nodeByKey(drag.targetKey) : null;
        const validTarget = node => sourceNode && sourcePortObj && node && Model.canConnect(sourceNode, sourcePortObj, node).ok;
        const validSource = (node, port) => node && port && reverseTarget && Model.canConnect(node, port, reverseTarget).ok;
        for (const element of document.elementsFromPoint(x, y)) {
            const output = element.closest && element.closest('[data-output-node]');
            if (output && drag.direction === 'reverse') {
                const node = nodeByKey(output.dataset.outputNode);
                const port = node && (node.ports || []).find(item => item.id === output.dataset.outputPort);
                if (validSource(node, port)) {
                    sourceKey = node.key;
                    sourcePort = port.id;
                    break;
                }
            }
            const input = element.closest && element.closest('[data-input-node]');
            if (input && drag.direction === 'forward') {
                const node = nodeByKey(input.dataset.inputNode);
                if (!fallbackTarget) fallbackTarget = input.dataset.inputNode;
                if (validTarget(node)) { targetKey = node.key; break; }
            }
            const card = element.closest && element.closest('.canvas-node');
            if (card) {
                const node = nodeByKey(card.dataset.nodeKey);
                if (drag.direction === 'reverse') {
                    if (node && (node.ports || []).length === 1 && validSource(node, node.ports[0])) {
                        sourceKey = node.key;
                        sourcePort = node.ports[0].id;
                        break;
                    }
                } else if (node) {
                    if (!fallbackTarget) fallbackTarget = node.key;
                    if (validTarget(node)) { targetKey = node.key; break; }
                }
            }
        }
        if (drag.direction === 'reverse') {
            state.reverseTargetKey = null;
            if (sourceKey) {
                state.pending = { nodeKey: sourceKey, portId: sourcePort };
                completeConnection(drag.targetKey, { x, y });
            } else {
                state.connectPointer = null;
                renderAll();
                toast(isRtl ? 'اسحب إلى نقطة مصدر أو بطاقة لها مصدر واحد.' : 'Drop on a Source handle or a card with one source.', 'error');
            }
        } else if (targetKey || fallbackTarget) {
            completeConnection(targetKey || fallbackTarget, { x, y });
        } else {
            state.pending = null;
            state.connectPointer = null;
            renderAll();
        }
    }

    function beginConnection(nodeKey, portId) {
        state.pending = { nodeKey, portId };
        state.connectPointer = null;
        state.reverseTargetKey = null;
        const node = nodeByKey(nodeKey);
        const port = node && node.ports.find(p => p.id === portId);
        if (!port) return;
        toast(LABELS.selectTarget, '');
        renderNodes();
        renderInspector();
    }

    function addConnectionCandidate(candidate) {
        const source = nodeByKey(candidate.sourceKey);
        const target = nodeByKey(candidate.targetKey);
        const port = source && (source.ports || []).find(item => item.id === candidate.sourcePort);
        if (!source || !target || !port) return;
        const duplicate = state.draftEdges.some(edge => edge.source === source.key && edge.sourcePort === port.id && edge.target === target.key);
        if (duplicate) {
            toast(LABELS.duplicate, 'error');
            return;
        }
        pushHistory();
        if (!port.multiple && port.kind !== 'trunks') {
            state.draftEdges = state.draftEdges.filter(edge => !(edge.source === source.key && edge.sourcePort === port.id));
        }
        state.draftEdges.push({
            id: 'draft-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
            source: source.key,
            sourcePort: port.id,
            sourceLabel: port.label,
            target: target.key,
            targetType: target.type,
            kind: port.kind,
            raw: port.kind === 'membership' ? target.refId : (port.kind === 'trunks' ? String(target.refId) : Model.encodeDestination(target)),
            label: port.label
        });
        state.pending = null;
        state.connectPointer = null;
        state.reverseTargetKey = null;
        state.selectedKey = source.key;
        state.selectedEdgeId = null;
        toast(isRtl ? 'تمت إضافة الاتصال إلى المسودة.' : 'Connection added to draft.', 'success');
        renderAll();
    }

    function closeConnectionChooser() {
        if (!connectionPopup) return;
        state.connectionChoices = [];
        connectionPopup.hidden = true;
        connectionOptions.innerHTML = '';
    }

    function showConnectionChooser(candidates, point) {
        state.connectionChoices = candidates;
        connectionOptions.innerHTML = candidates.map((candidate, index) =>
            `<button type="button" class="canvas-connection-option" data-choice="${index}">
                <strong>${esc(candidate.label)}</strong>
                <span>${esc(candidate.detail)}</span>
            </button>`).join('');
        connectionPopup.hidden = false;
        requestAnimationFrame(() => {
            const width = connectionPopup.offsetWidth || 300;
            const height = connectionPopup.offsetHeight || 160;
            const x = Math.max(10, Math.min((point && point.x) || window.innerWidth / 2, window.innerWidth - width - 10));
            const y = Math.max(10, Math.min((point && point.y) || window.innerHeight / 2, window.innerHeight - height - 10));
            connectionPopup.style.left = x + 'px';
            connectionPopup.style.top = y + 'px';
        });
    }

    function completeConnection(targetKey, point) {
        const pending = state.pending;
        if (!pending) return selectNode(targetKey);
        const source = nodeByKey(pending.nodeKey);
        const target = nodeByKey(targetKey);
        const selectedPort = source && source.ports.find(p => p.id === pending.portId);
        if (!source || !target || !selectedPort) {
            state.pending = null;
            state.connectPointer = null;
            renderAll();
            return;
        }
        if (source.key === target.key) {
            toast(LABELS.sameNode, 'error');
            state.pending = null;
            state.connectPointer = null;
            renderAll();
            return;
        }
        const candidates = Model.connectionCandidates(source, target).filter(candidate => !state.draftEdges.some(edge =>
            edge.source === candidate.sourceKey && edge.sourcePort === candidate.sourcePort && edge.target === candidate.targetKey
        ));
        state.pending = null;
        state.connectPointer = null;
        state.reverseTargetKey = null;
        if (!candidates.length) {
            toast(LABELS.duplicate, 'error');
            renderAll();
            return;
        }
        if (candidates.length === 1) {
            addConnectionCandidate(candidates[0]);
            return;
        }
        renderAll();
        showConnectionChooser(candidates, point);
    }

    function renderAll() {
        renderNodes();
        renderInspector();
        updateDirtyUi();
    }

    function transform() {
        world.style.transform = `translate(${state.pan.x}px, ${state.pan.y}px) scale(${state.zoom})`;
        document.getElementById('canvas-zoom-reset').textContent = Math.round(state.zoom * 100) + '%';
        requestAnimationFrame(drawEdges);
    }

    function fitView() {
        if (!state.nodes.length) return;
        const minX = Math.min(...state.nodes.map(n => n.x));
        const minY = Math.min(...state.nodes.map(n => n.y));
        const maxX = Math.max(...state.nodes.map(n => n.x + 300));
        const maxY = Math.max(...state.nodes.map(n => n.y + 220));
        const width = viewport.clientWidth;
        const height = viewport.clientHeight;
        const nextZoom = Math.min(1.15, Math.max(0.25, Math.min((width - 80) / Math.max(1, maxX - minX), (height - 80) / Math.max(1, maxY - minY))));
        state.zoom = nextZoom;
        state.pan.x = (width - (maxX - minX) * nextZoom) / 2 - minX * nextZoom;
        state.pan.y = (height - (maxY - minY) * nextZoom) / 2 - minY * nextZoom;
        transform();
        saveLayout();
    }

    // When a large PBX is fitted on first load, cards collapse to postage stamps.
    // Start at a readable scale instead; the Fit control remains the overview.
    function initialView() {
        if (!state.nodes.length) return;
        const minX = Math.min(...state.nodes.map(n => n.x));
        const minY = Math.min(...state.nodes.map(n => n.y));
        const maxX = Math.max(...state.nodes.map(n => n.x + 300));
        const maxY = Math.max(...state.nodes.map(n => n.y + 220));
        const width = viewport.clientWidth;
        const height = viewport.clientHeight;
        const fitZoom = Math.min((width - 80) / Math.max(1, maxX - minX), (height - 80) / Math.max(1, maxY - minY));
        if (fitZoom >= 0.55) {
            fitView();
            return;
        }
        state.zoom = width <= 520 ? 0.55 : 0.8;
        const graphW = (maxX - minX) * state.zoom;
        const graphH = (maxY - minY) * state.zoom;
        if (width > 520) {
            // Open on the dense middle of the graph, not its empty upper-left edge.
            state.pan.x = width / 2 - ((minX + maxX) / 2) * state.zoom;
            state.pan.y = 48 - minY * state.zoom;
        } else {
            state.pan.x = graphW < width - 96
                ? (width - graphW) / 2 - minX * state.zoom
                : 48 - minX * state.zoom;
            state.pan.y = graphH < height - 96
                ? (height - graphH) / 2 - minY * state.zoom
                : 48 - minY * state.zoom;
        }
        transform();
    }

    function autoLayout() {
        Model.autoLayoutNodes(state.nodes);
        localStorage.removeItem(STORAGE_KEY);
        renderAll();
        fitView();
        toast(LABELS.saved, 'success');
    }

    function startNodeDrag(event, node) {
        if (event.button !== 0) return;
        if (event.target.closest('.canvas-port-handle, .canvas-edge-toolbar')) return;
        event.preventDefault();
        event.stopPropagation();
        const start = { x: event.clientX, y: event.clientY, nodeX: node.x, nodeY: node.y };
        state.dragging = { node, start, moved: false };
        const el = event.target.closest('.canvas-node');
        if (el) el.classList.add('dragging');
        selectNode(node.key);
        window.addEventListener('pointermove', onNodeDrag);
        window.addEventListener('pointerup', endNodeDrag, { once: true });
    }

    function onNodeDrag(event) {
        const drag = state.dragging;
        if (!drag) return;
        if (Math.abs(event.clientX - drag.start.x) > 3 || Math.abs(event.clientY - drag.start.y) > 3) drag.moved = true;
        drag.node.x = drag.start.nodeX + (event.clientX - drag.start.x) / state.zoom;
        drag.node.y = drag.start.nodeY + (event.clientY - drag.start.y) / state.zoom;
        const el = nodesLayer.querySelector(`[data-node-key="${cssEscape(drag.node.key)}"]`);
        if (el) {
            el.style.left = Math.round(drag.node.x) + 'px';
            el.style.top = Math.round(drag.node.y) + 'px';
        }
        drawEdges();
        renderMinimap();
    }

    function endNodeDrag() {
        if (!state.dragging) return;
        const drag = state.dragging;
        const el = nodesLayer.querySelector(`[data-node-key="${cssEscape(drag.node.key)}"]`);
        if (el) el.classList.remove('dragging');
        state.dragging = null;
        window.removeEventListener('pointermove', onNodeDrag);
        if (!drag.moved) return;
        state.lastDragAt = Date.now();
        saveLayout();
        toast(LABELS.saved, 'success');
    }

    function startPan(event) {
        if (event.button !== 0) return;
        if (event.target.closest('.canvas-node, .canvas-edge-path, .canvas-btn, .canvas-toolbar, .canvas-minimap')) return;
        event.preventDefault();
        state.panning = { x: event.clientX, y: event.clientY, panX: state.pan.x, panY: state.pan.y };
        viewport.classList.add('panning');
        viewport.setPointerCapture && viewport.setPointerCapture(event.pointerId);
    }

    function onPan(event) {
        if (!state.panning) return;
        state.pan.x = state.panning.panX + (event.clientX - state.panning.x);
        state.pan.y = state.panning.panY + (event.clientY - state.panning.y);
        transform();
    }

    function endPan(event) {
        if (!state.panning) return;
        state.panning = null;
        viewport.classList.remove('panning');
        try { viewport.releasePointerCapture && viewport.releasePointerCapture(event.pointerId); } catch (_) {}
    }

    function zoomAt(factor, clientX, clientY) {
        const rect = viewport.getBoundingClientRect();
        const px = clientX === undefined ? rect.width / 2 : clientX - rect.left;
        const py = clientY === undefined ? rect.height / 2 : clientY - rect.top;
        const old = state.zoom;
        const next = Math.min(1.8, Math.max(0.25, old * factor));
        state.pan.x = px - ((px - state.pan.x) / old) * next;
        state.pan.y = py - ((py - state.pan.y) / old) * next;
        state.zoom = next;
        transform();
    }

    function openAddModal(type) {
        if (isDirty()) {
            toast(LABELS.draftFirst, 'error');
            return;
        }
        state.addType = type;
        const meta = Model.TYPE_META[type] || Model.TYPE_META.extension;
        addTitle.textContent = LABELS.addCard + ' · ' + meta.label;
        addFields.innerHTML = addFormHtml(type);
        addModal.classList.add('open');
        addModal.setAttribute('aria-hidden', 'false');
        const first = addFields.querySelector('input, select, textarea');
        if (first) setTimeout(() => first.focus(), 50);
    }

    function closeAddModal() {
        addModal.classList.remove('open');
        addModal.setAttribute('aria-hidden', 'true');
        state.addType = null;
    }

    function addFormHtml(type) {
        const field = (name, label, options) => {
            const opts = options || {};
            const input = opts.textarea
                ? `<textarea name="${name}" rows="2" ${opts.required ? 'required' : ''}></textarea>`
                : opts.select
                    ? `<select name="${name}" ${opts.required ? 'required' : ''}>${opts.select}</select>`
                    : `<input name="${name}" type="${opts.type || 'text'}" ${opts.required ? 'required' : ''} value="${esc(opts.value || '')}" autocomplete="off">`;
            return `<div class="canvas-field"><label>${esc(label)}</label>${input}</div>`;
        };
        switch (type) {
            case 'extension':
                return field('extension', isRtl ? 'رقم التحويلة' : 'Extension', { required: true }) +
                    field('name', isRtl ? 'الاسم' : 'Name', { required: true }) +
                    field('secret', isRtl ? 'كلمة المرور' : 'Secret', { type: 'password', value: 'Sokrat' + Math.floor(100000 + Math.random() * 899999) });
            case 'inbound':
                return field('description', isRtl ? 'الوصف' : 'Description', { required: true }) +
                    field('extension', isRtl ? 'رقم DID' : 'DID number') +
                    field('cidnum', isRtl ? 'رقم المتصل' : 'Caller ID');
            case 'trunk':
                return field('name', isRtl ? 'اسم الخط' : 'Trunk name', { required: true }) +
                    field('channelid', isRtl ? 'سلسلة الطلب' : 'Dial string', { required: true, value: 'dongle/i:$OUTNUM$' });
            case 'outbound': {
                const trunks = state.nodes.filter(node => node.type === 'trunk' && !node.placeholder);
                const options = trunks.length
                    ? '<option value="">' + (isRtl ? 'اختر خط ربط' : 'Select a trunk') + '</option>' + trunks.map(t => `<option value="${esc(t.refId)}">${esc(t.title)}</option>`).join('')
                    : '<option value="">' + (isRtl ? 'لا توجد خطوط ربط — أنشئ خطاً أولاً' : 'No trunks — create a trunk first') + '</option>';
                return field('name', isRtl ? 'اسم المسار' : 'Route name', { required: true }) +
                    field('trunk_id', isRtl ? 'خط الربط' : 'Trunk', { select: options, required: trunks.length > 0 });
            }
            case 'ringgroup':
                return field('grpnum', isRtl ? 'رقم المجموعة' : 'Group number', { required: true }) +
                    field('description', isRtl ? 'الوصف' : 'Description', { required: true });
            case 'queue':
                return field('extension', isRtl ? 'رقم القائمة' : 'Queue number', { required: true }) +
                    field('descr', isRtl ? 'الوصف' : 'Description', { required: true });
            case 'announcement':
                return field('description', isRtl ? 'الوصف' : 'Description', { required: true }) +
                    field('tts_text', isRtl ? 'نص TTS' : 'TTS text', { required: true, textarea: true });
            case 'ivr':
                return field('name', isRtl ? 'اسم IVR' : 'IVR name', { required: true }) +
                    field('description', isRtl ? 'الوصف' : 'Description');
            case 'timecondition': {
                const options = state.timegroups.length
                    ? '<option value="">' + (isRtl ? 'اختر' : 'Select') + '</option>' + state.timegroups.map(g => `<option value="${esc(g.id)}">${esc(g.description || g.name || g.id)}</option>`).join('')
                    : '<option value="">' + LABELS.noTimegroups + '</option>';
                return field('displayname', isRtl ? 'اسم الشرط' : 'Display name', { required: true }) +
                    field('timegroup_id', LABELS.timegroup, { select: options, required: state.timegroups.length > 0 });
            }
            default:
                return '';
        }
    }

    async function submitAddForm(event) {
        event.preventDefault();
        if (!state.addType) return;
        const submit = document.getElementById('canvas-add-submit');
        const form = new FormData(addForm);
        const value = key => String(form.get(key) || '').trim();
        const type = state.addType;
        let url = '';
        let body = {};
        let method = 'POST';
        if (type === 'extension') {
            url = '/api/config/extensions';
            body = { extension: value('extension'), name: value('name'), secret: value('secret'), tech: 'pjsip' };
        } else if (type === 'inbound') {
            url = '/api/config/routes/inbound';
            body = { description: value('description'), extension: value('extension'), cidnum: value('cidnum'), destination: 'app-blackhole,hangup,1' };
        } else if (type === 'trunk') {
            url = '/api/config/trunks';
            body = { name: value('name'), tech: 'custom', channelid: value('channelid') };
        } else if (type === 'outbound') {
            const trunkId = value('trunk_id');
            if (!trunkId) return toast(isRtl ? 'اختر خط ربط.' : 'Select a trunk.', 'error');
            url = '/api/config/routes/outbound';
            body = { name: value('name'), trunks: [trunkId] };
        } else if (type === 'ringgroup') {
            url = '/api/config/ringgroups';
            body = { grpnum: value('grpnum'), description: value('description'), grplist: '', strategy: 'ringall', grptime: 20, postdest: 'app-blackhole,hangup,1' };
        } else if (type === 'queue') {
            url = '/api/config/queues';
            body = { extension: value('extension'), descr: value('descr') };
        } else if (type === 'announcement') {
            url = '/api/config/announcements';
            body = { description: value('description'), recording_id: 0, tts_text: value('tts_text'), tts_lang: 'en-US', post_dest: 'app-blackhole,hangup,1' };
        } else if (type === 'ivr') {
            url = '/api/config/ivrs';
            body = { name: value('name'), description: value('description') };
        } else if (type === 'timecondition') {
            url = '/api/config/timeconditions';
            body = { displayname: value('displayname'), timegroup_id: value('timegroup_id'), truegoto: 'app-blackhole,hangup,1', falsegoto: 'app-blackhole,hangup,1' };
        }
        if (!url) return;
        submit.disabled = true;
        try {
            const response = await fetch(url, {
                method,
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                body: JSON.stringify(body)
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok || data.success === false) throw new Error(data.error || ('HTTP ' + response.status));
            closeAddModal();
            toast(LABELS.created, 'success');
            await loadData();
            fitView();
        } catch (error) {
            toast(LABELS.createFailed + error.message, 'error');
        } finally {
            submit.disabled = false;
        }
    }

    function buildPlan() {
        const deletedNodes = state.deletedKeys
            .map(key => state.baseNodes.find(node => node.key === key) || nodeByKey(key))
            .filter(node => node && Model.deletionForNode(node));
        return Model.buildUpdatePlan({
            nodes: state.nodes,
            edges: state.draftEdges,
            originalEdges: state.originalEdges,
            deletedNodes,
            nodeMap: state.nodeMap
        });
    }

    function closeReview() {
        reviewModal.classList.remove('open');
        reviewModal.setAttribute('aria-hidden', 'true');
        state.reviewPlan = null;
        reviewStatus.textContent = '';
        reviewStatus.classList.remove('error');
        nodesLayer.querySelectorAll('.canvas-node.has-error').forEach(el => el.classList.remove('has-error'));
    }

    function openReview() {
        if (!isDirty()) return toast(LABELS.noChanges, '');
        const plan = buildPlan();
        state.reviewPlan = plan;
        const changes = plan.updates || [];
        const deletions = plan.deletions || [];
        const errors = plan.errors || [];
        const itemHtml = (item, method) => {
            const rows = (item.changes || []).map(change => `
                <div class="canvas-review-change">
                    <span>${esc(change.field)}</span>
                    <code>${esc(change.from || '-')}</code>
                    <span class="canvas-review-arrow">→</span>
                    <strong>${esc(change.to || '-')}</strong>
                </div>`).join('');
            return `<div class="canvas-review-item">
                <div class="canvas-review-item-head"><span>${esc(item.label)}</span><small>${esc(method)}</small></div>
                ${rows || `<div class="canvas-review-change"><span>Action</span><strong>${esc(method)}</strong></div>`}
            </div>`;
        };
        const sections = [];
        if (errors.length) {
            sections.push(`<div class="canvas-review-section">${LABELS.reviewErrors}</div>`);
            sections.push(`<div class="canvas-review-error">${errors.map(error => '• ' + esc(error)).join('<br>')}</div>`);
        }
        if (changes.length) {
            sections.push(`<div class="canvas-review-section">${LABELS.reviewUpdates}</div>`);
            sections.push(changes.map(item => itemHtml(item, 'UPDATE')).join(''));
        }
        if (deletions.length) {
            sections.push(`<div class="canvas-review-section">${LABELS.reviewDeletions}</div>`);
            sections.push(deletions.map(item => itemHtml(item, 'DELETE')).join(''));
        }
        if (!changes.length && !deletions.length && !errors.length) {
            sections.push(`<div class="canvas-review-empty">${LABELS.reviewNoChanges}</div>`);
        }
        reviewBody.innerHTML = sections.join('');
        reviewStatus.textContent = errors.length ? (isRtl ? `${errors.length} أخطاء تحقق` : `${errors.length} validation error${errors.length === 1 ? '' : 's'}`) : '';
        reviewStatus.classList.toggle('error', errors.length > 0);
        reviewApply.disabled = errors.length > 0 || (!changes.length && !deletions.length);
        const errorTitles = state.nodes.map(node => node.title).filter(title => errors.some(error => error.includes(title)));
        nodesLayer.querySelectorAll('.canvas-node').forEach(el => {
            const node = nodeByKey(el.dataset.nodeKey);
            el.classList.toggle('has-error', Boolean(node && errorTitles.includes(node.title)));
        });
        reviewModal.classList.add('open');
        reviewModal.setAttribute('aria-hidden', 'false');
        setTimeout(() => reviewApply.focus(), 40);
    }

    async function checkConflicts(plan) {
        if (!plan.updates.length) return;
        const { entities, failures } = await fetchEntities();
        if (failures.length) throw new Error(LABELS.loadFailed + failures.join(', '));
        const fresh = Model.buildGraph(entities);
        const conflicts = [];
        plan.updates.filter(update => !update.completed).forEach(update => {
            const previous = state.baseNodes.find(node => node.key === update.nodeKey);
            const current = fresh.nodeMap.get(update.nodeKey);
            if (!previous || !current || Model.entitySignature(previous) !== Model.entitySignature(current)) {
                conflicts.push(update.label);
            }
        });
        if (conflicts.length) throw new Error(LABELS.conflict + ' (' + conflicts.join(', ') + ')');
    }

    async function callApi(operation) {
        const response = await fetch(operation.url, {
            method: operation.method,
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify(operation.body || {})
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.success === false) {
            throw new Error((operation.label || operation.url) + ': ' + (data.error || ('HTTP ' + response.status)));
        }
        return data;
    }

    async function applyPlan(plan) {
        if (!plan || plan.errors.length) return;
        const operations = [...plan.updates, ...plan.deletions];
        let completed = 0;
        reviewApply.disabled = true;
        reviewStatus.textContent = LABELS.reviewApplying;
        reviewStatus.classList.remove('error');
        applyBtn.disabled = true;
        applyLabel.textContent = LABELS.reviewApplying;
        try {
            await checkConflicts(plan);
            for (const operation of operations) {
                if (operation.completed) continue;
                await callApi(operation);
                operation.completed = true;
                completed += 1;
            }
            toast(LABELS.applied, 'success');
            state.selectedEdgeId = null;
            closeReview();
            await loadData();
        } catch (error) {
            const message = completed > 0 && completed < operations.length
                ? LABELS.partialApply + ' ' + error.message
                : LABELS.applyFailed + error.message;
            reviewStatus.textContent = message;
            reviewStatus.classList.add('error');
            toast(message, 'error');
            reviewApply.disabled = false;
        } finally {
            applyLabel.textContent = isRtl ? 'تطبيق التغييرات' : 'Apply Changes';
            updateDirtyUi();
        }
    }

    async function loadTimegroups() {
        try {
            const data = await getJson('/api/config/timegroups');
            state.timegroups = data.timegroups || data.groups || [];
        } catch (_) {
            state.timegroups = [];
        }
    }

    function attachEvents() {
        renderPalette();

        function setMobileActionsOpen(open) {
            if (!topActionsEl || !mobileMenuBtn) return;
            topActionsEl.classList.toggle('open', open);
            mobileMenuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
        }
        if (mobileMenuBtn) {
            mobileMenuBtn.addEventListener('click', event => {
                event.stopPropagation();
                setMobileActionsOpen(!topActionsEl.classList.contains('open'));
            });
        }
        if (topActionsEl) {
            topActionsEl.addEventListener('click', event => {
                if (event.target.closest('.canvas-btn, a.canvas-btn')) setMobileActionsOpen(false);
            });
        }
        document.addEventListener('pointerdown', event => {
            if (!topActionsEl || !topActionsEl.classList.contains('open')) return;
            if (event.target.closest('#canvas-top-actions, #canvas-mobile-menu-btn')) return;
            setMobileActionsOpen(false);
        });

        palette.addEventListener('click', event => {
            const button = event.target.closest('[data-add-type]');
            if (!button) return;
            openCanvasEditor(null, button.dataset.addType);
        });

        viewport.addEventListener('pointerdown', startPan);
        window.addEventListener('pointermove', onPan);
        window.addEventListener('pointerup', endPan);
        viewport.addEventListener('wheel', event => {
            event.preventDefault();
            zoomAt(event.deltaY > 0 ? 0.9 : 1.1, event.clientX, event.clientY);
        }, { passive: false });

        viewport.addEventListener('pointerdown', event => {
            if (event.target.closest('.canvas-node, .canvas-edge-toolbar')) return;
            state.selectedKey = null;
            state.selectedEdgeId = null;
            state.pending = null;
            state.connectPointer = null;
            state.reverseTargetKey = null;
            closeConnectionChooser();
            renderAll();
        });

        nodesLayer.addEventListener('click', event => {
            if (Date.now() - state.lastConnectDragAt < 300) {
                event.preventDefault();
                return;
            }
            const output = event.target.closest('[data-output-node]');
            if (output) {
                event.stopPropagation();
                const key = output.dataset.outputNode;
                const portId = output.dataset.outputPort;
                if (state.pending && state.pending.nodeKey === key && state.pending.portId === portId) {
                    state.pending = null;
                    renderAll();
                } else {
                    beginConnection(key, portId);
                }
                return;
            }
            const input = event.target.closest('[data-input-node]');
            if (input) {
                event.stopPropagation();
                if (state.pending) completeConnection(input.dataset.inputNode, { x: event.clientX, y: event.clientY });
                else selectNode(input.dataset.inputNode);
                return;
            }
            const card = event.target.closest('.canvas-node');
            if (!card) return;
            if (state.pending) {
                completeConnection(card.dataset.nodeKey, { x: event.clientX, y: event.clientY });
                return;
            }
            if (Date.now() - (state.lastDragAt || 0) < 300) return;
            const node = nodeByKey(card.dataset.nodeKey);
            selectNode(card.dataset.nodeKey);
            if (node) openCanvasEditor(node);
        });

        nodesLayer.addEventListener('pointerdown', startConnectionDrag);
        nodesLayer.addEventListener('pointerdown', event => {
            if (event.target.closest('.canvas-port-handle')) return;
            const card = event.target.closest('.canvas-node');
            const node = card && nodeByKey(card.dataset.nodeKey);
            if (node) startNodeDrag(event, node);
        });

        document.getElementById('canvas-refresh-btn').addEventListener('click', async () => {
            if (isDirty()) {
                toast(LABELS.draftFirst, 'error');
                return;
            }
            try {
                await loadData({ fitNew: true });
                toast(isRtl ? 'تم التحديث من المقسم.' : 'Refreshed from PBX.', 'success');
            } catch (error) {
                toast(LABELS.loadFailed + error.message, 'error');
            }
        });
        document.getElementById('canvas-fit-btn').addEventListener('click', fitView);
        document.getElementById('canvas-layout-btn').addEventListener('click', autoLayout);
        document.getElementById('canvas-zoom-in').addEventListener('click', () => zoomAt(1.15));
        document.getElementById('canvas-zoom-out').addEventListener('click', () => zoomAt(0.87));
        document.getElementById('canvas-zoom-reset').addEventListener('click', () => {
            state.zoom = 1;
            state.pan = { x: 70, y: 70 };
            transform();
        });
        applyBtn.addEventListener('click', openReview);
        undoBtn.addEventListener('click', undoDraft);
        redoBtn.addEventListener('click', redoDraft);
        discardBtn.addEventListener('click', () => {
            state.draftEdges = state.originalEdges.map(e => ({ ...e }));
            state.deletedKeys = state.originalDeletedKeys.slice();
            state.history = [];
            state.future = [];
            state.selectedEdgeId = null;
            state.pending = null;
            rebuildActiveNodes();
            renderAll();
            updateDirtyUi();
            toast(isRtl ? 'تم تجاهل المسودة.' : 'Draft discarded.', '');
        });
        document.getElementById('canvas-editor-close').addEventListener('click', () => closeCanvasEditor(false));
        document.getElementById('canvas-form-cancel').addEventListener('click', () => closeCanvasEditor(false));
        editorDelete.addEventListener('click', () => {
            const node = state.editor && state.editor.node;
            if (!node) return;
            requestDeleteNode(node.key);
            if (state.deletedKeys.includes(node.key)) closeCanvasEditor(false);
        });
        editorClassic.addEventListener('click', () => {
            const node = state.editor && state.editor.node;
            if (node) window.open(classicConfigUrl(node), '_blank', 'noopener');
        });
        document.getElementById('canvas-edge-remove').addEventListener('click', () => {
            if (state.selectedEdgeId) removeEdge(state.selectedEdgeId);
        });
        document.getElementById('canvas-connection-cancel').addEventListener('click', closeConnectionChooser);
        document.getElementById('canvas-studio-close').addEventListener('click', closeStudio);
        document.getElementById('canvas-studio-cancel').addEventListener('click', closeStudio);
        studioApply.addEventListener('click', applyStudio);
        studioOverlay.addEventListener('click', event => {
            if (event.target === studioOverlay) closeStudio();
        });
        connectionOptions.addEventListener('click', event => {
            const button = event.target.closest('[data-choice]');
            if (!button) return;
            const candidate = state.connectionChoices[Number(button.dataset.choice)];
            closeConnectionChooser();
            if (candidate) addConnectionCandidate(candidate);
        });
        document.addEventListener('pointerdown', event => {
            if (connectionPopup && !connectionPopup.hidden && !event.target.closest('#canvas-connection-popup')) closeConnectionChooser();
        });
        editorForm.addEventListener('submit', submitNativeForm);
        document.getElementById('canvas-editor-refresh').addEventListener('click', async () => {
            try {
                await loadData();
                toast(isRtl ? 'تم تحديث اللوحة.' : 'Canvas reloaded.', 'success');
            } catch (error) {
                toast(LABELS.loadFailed + error.message, 'error');
            }
        });
        editorOverlay.addEventListener('click', event => {
            if (event.target === editorOverlay) closeCanvasEditor(false);
        });
        editorFields.addEventListener('change', event => {
            const destination = event.target.closest('[data-destination-select]');
            if (destination) {
                const custom = editorForm.elements[destination.name + '__custom'];
                if (custom) custom.hidden = destination.value !== '__custom__';
            }
            const ivrDest = event.target.closest('[data-key="dest"]');
            if (ivrDest) {
                const row = ivrDest.closest('[data-ivr-row]');
                const custom = row && row.querySelector('[data-key="destcustom"]');
                if (custom) custom.hidden = ivrDest.value !== '__custom__';
            }
        });
        editorFields.addEventListener('click', event => {
            const add = event.target.closest('[data-add-row]');
            const addSequence = event.target.closest('[data-add-sequence]');
            const remove = event.target.closest('[data-remove-row]');
            const moveUp = event.target.closest('[data-move-up]');
            const moveDown = event.target.closest('[data-move-down]');
            if (remove) {
                const row = remove.closest('[data-repeat-row], [data-time-rule-row], [data-ivr-row], [data-sequence-row]');
                if (row) row.remove();
                return;
            }
            if (moveUp || moveDown) {
                const row = (moveUp || moveDown).closest('[data-sequence-row]');
                if (!row) return;
                if (moveUp && row.previousElementSibling) row.parentNode.insertBefore(row, row.previousElementSibling);
                if (moveDown && row.nextElementSibling) row.parentNode.insertBefore(row.nextElementSibling, row);
                return;
            }
            if (!add && !addSequence) return;
            const container = add ? add.closest('[data-repeater]') : addSequence.closest('[data-sequence]');
            if (!container || !state.editor || !state.editor.form) return;
            const name = container.dataset.repeater || container.dataset.sequence;
            const field = state.editor.form.sections.flatMap(section => section.fields).find(item => item.name === name);
            if (!field) return;
            const rows = container.querySelector('.canvas-form-rows');
            if (!rows) return;
            if (addSequence) {
                const options = fieldOptions(field);
                const index = rows.querySelectorAll('[data-sequence-row]').length;
                rows.insertAdjacentHTML('beforeend', `<div class="canvas-form-row" data-sequence-row><label class="canvas-form-field"><span>Sequence ${index + 1}</span><select data-seq-value>${optionHtml(options, '', true)}</select></label><div class="canvas-form-row-actions"><button type="button" class="canvas-form-icon-btn" data-move-up title="Move up">↑</button><button type="button" class="canvas-form-icon-btn" data-move-down title="Move down">↓</button><button type="button" class="canvas-form-icon-btn" data-remove-row title="Remove">✕</button></div></div>`);
            } else {
                rows.insertAdjacentHTML('beforeend', repeatRowHtml(field, {}));
            }
        });
        document.getElementById('canvas-review-close').addEventListener('click', closeReview);
        document.getElementById('canvas-review-cancel').addEventListener('click', closeReview);
        reviewApply.addEventListener('click', () => {
            if (state.reviewPlan) applyPlan(state.reviewPlan);
        });
        reviewModal.addEventListener('click', event => {
            if (event.target === reviewModal) closeReview();
        });
        document.addEventListener('keydown', event => {
            const target = event.target;
            const typing = target && (target.matches('input, textarea, select') || target.isContentEditable);
            if ((event.ctrlKey || event.metaKey) && !event.altKey && String(event.key).toLowerCase() === 'z' && !typing) {
                event.preventDefault();
                if (event.shiftKey) redoDraft(); else undoDraft();
                return;
            }
            if (event.key === 'Escape') {
                if (topActionsEl && topActionsEl.classList.contains('open')) setMobileActionsOpen(false);
                else if (studioOverlay && !studioOverlay.hidden) closeStudio();
                else if (connectionPopup && !connectionPopup.hidden) closeConnectionChooser();
                else if (state.editor) closeCanvasEditor(false);
                else if (state.pending) {
                    state.pending = null;
                    renderAll();
                } else if (reviewModal.classList.contains('open')) closeReview();
            }
        });
        let canvasWasHidden = false;
        const refreshAfterReturn = () => {
            if (document.hidden) { canvasWasHidden = true; return; }
            if (!canvasWasHidden) return;
            canvasWasHidden = false;
            if (state.editor || isDirty()) return;
            loadData({ fitNew: true }).catch(error => toast(LABELS.loadFailed + error.message, 'error'));
        };
        document.addEventListener('visibilitychange', refreshAfterReturn);
        window.addEventListener('focus', refreshAfterReturn);
        window.addEventListener('beforeunload', event => {
            if (!isDirty()) return;
            event.preventDefault();
            event.returnValue = '';
        });

        searchInput.addEventListener('input', () => {
            state.filter = searchInput.value.trim().toLowerCase();
            nodesLayer.querySelectorAll('.canvas-node').forEach(el => {
                const node = nodeByKey(el.dataset.nodeKey);
                el.style.opacity = !state.filter || nodeMatches(node, state.filter) ? '' : '0.22';
            });
            drawEdges();
        });

        searchInput.addEventListener('keydown', event => {
            if (event.key !== 'Enter') return;
            const query = searchInput.value.trim().toLowerCase();
            if (!query) return;
            const found = state.nodes.find(node => nodeMatches(node, query));
            if (found) {
                state.zoom = Math.max(state.zoom, 0.8);
                state.pan = {
                    x: viewport.clientWidth / 2 - (found.x + 140) * state.zoom,
                    y: viewport.clientHeight / 2 - (found.y + 100) * state.zoom
                };
                transform();
                selectNode(found.key);
            }
        });
    }

    async function init() {
        attachEvents();
        loadData().then(() => initialView()).catch(error => {
            state.loading = false;
            setStatus(LABELS.loadFailed + error.message, false);
            toast(LABELS.loadFailed + error.message, 'error');
        });
    }

    init();
})();
