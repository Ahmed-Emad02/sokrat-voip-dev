const test = require('node:test');
const assert = require('node:assert/strict');
const ejs = require('ejs');
const fs = require('fs');
const path = require('path');

test('Queue failover destination parsing and formatting helper logic', () => {
    const loadedExtensionsList = [{ extension: '101', name: 'Sales Agent 1' }, { extension: '102', name: 'Support Agent 2' }];
    const loadedRingGroupsList = [{ grpnum: '600', description: 'Main Sales Group' }];
    const loadedQueuesList = [{ extension: '300', descr: 'Support Queue' }];
    const loadedTimeConditionsList = [{ timeconditions_id: '1', displayname: 'Working Hours' }];
    const loadedAnnouncementsList = [{ announcement_id: '2', description: 'Welcome Message' }];
    const loadedIvrsList = [{ id: '1', name: 'Main Menu' }];
    const loadedTrunksList = [{ trunkid: '1', name: 'Primary SIP Trunk', tech: 'pjsip' }];

    function formatDestination(dest, isRtl = false) {
        if (!dest) return '-';
        
        if (dest.startsWith('from-did-direct,')) {
            const parts = dest.split(',');
            const extNum = parts[1];
            const extMatch = loadedExtensionsList.find(e => String(e.extension) === String(extNum));
            const nameStr = extMatch ? ` - ${extMatch.name}` : '';
            return `Extension: ${extNum}${nameStr}`;
        }
        
        if (dest.startsWith('ext-group,')) {
            const parts = dest.split(',');
            const grpNum = parts[1];
            const rgMatch = loadedRingGroupsList.find(rg => String(rg.grpnum) === String(grpNum));
            const descStr = rgMatch ? ` - ${rgMatch.description}` : '';
            return `Ring Group: ${grpNum}${descStr}`;
        }
        
        if (dest.startsWith('ext-queues,')) {
            const parts = dest.split(',');
            const qNum = parts[1];
            const qMatch = loadedQueuesList.find(q => String(q.extension) === String(qNum));
            const descStr = qMatch ? ` - ${qMatch.descr}` : '';
            return `Queue: ${qNum}${descStr}`;
        }

        if (dest.startsWith('timeconditions,') || dest.startsWith('ext-timeconditions,')) {
            const parts = dest.split(',');
            const conditionId = parts[1];
            const condition = loadedTimeConditionsList.find(tc => String(tc.timeconditions_id) === String(conditionId));
            const name = condition ? condition.displayname : conditionId;
            return `${isRtl ? 'شرط زمني' : 'Time Condition'}: ${name}`;
        }

        if (dest.startsWith('app-announcement-')) {
            const parts = dest.split(',');
            const annId = parts[0].replace('app-announcement-', '');
            const ann = loadedAnnouncementsList.find(a => String(a.announcement_id) === String(annId));
            const name = ann ? ann.description : annId;
            return `${isRtl ? 'إعلان' : 'Announcement'}: ${name}`;
        }

        if (dest.startsWith('ivr-')) {
            const parts = dest.split(',');
            const ivrId = parts[0].replace('ivr-', '');
            const ivr = loadedIvrsList.find(i => String(i.id) === String(ivrId));
            const name = ivr ? ivr.name : ivrId;
            return `IVR: ${name}`;
        }

        if (dest.startsWith('ext-local,vmu')) {
            const ext = dest.substring(13).split(',')[0];
            return `Voicemail: ${ext}`;
        }

        if (dest.startsWith('musiconhold,') || dest.startsWith('ext-moh,')) {
            const parts = dest.split(',');
            const catName = parts[1] || 'default';
            return `Music on Hold: ${catName}`;
        }

        if (dest.startsWith('ext-trunk,')) {
            const parts = dest.split(',');
            const trunkId = parts[1];
            const trunk = loadedTrunksList.find(t => String(t.trunkid) === String(trunkId));
            const name = trunk ? `${trunk.name} (${trunk.tech})` : trunkId;
            return `Trunk: ${name}`;
        }

        if (dest.startsWith('app-blackhole,hangup') || dest === 'app-blackhole,hangup,1') return isRtl ? 'إنهاء المكالمة (Hangup)' : 'Terminate Call (Hangup)';
        if (dest.startsWith('app-blackhole,congestion')) return isRtl ? 'نغمة ازدحام (Congestion)' : 'Play Congestion';
        if (dest.startsWith('app-blackhole,busy')) return isRtl ? 'نغمة مشغول (Busy)' : 'Play Busy';
        if (dest.startsWith('app-blackhole,zapateller')) return isRtl ? 'نغمة SIT (Zapateller)' : 'Play SIT Tone (Zapateller)';
        if (dest.startsWith('app-blackhole,musiconhold')) return isRtl ? 'الموسيقى في الانتظار (MoH)' : 'Hold Forever (MoH)';
        if (dest.startsWith('app-blackhole,ringing')) return isRtl ? 'رنين دائم' : 'Ring Forever';

        return dest;
    }

    // Assert formatDestination outputs for all failover possibilities
    assert.strictEqual(formatDestination('from-did-direct,101,1'), 'Extension: 101 - Sales Agent 1');
    assert.strictEqual(formatDestination('ext-group,600,1'), 'Ring Group: 600 - Main Sales Group');
    assert.strictEqual(formatDestination('ext-queues,300,1'), 'Queue: 300 - Support Queue');
    assert.strictEqual(formatDestination('ivr-1,s,1'), 'IVR: Main Menu');
    assert.strictEqual(formatDestination('app-announcement-2,s,1'), 'Announcement: Welcome Message');
    assert.strictEqual(formatDestination('ext-local,vmu101,1'), 'Voicemail: 101');
    assert.strictEqual(formatDestination('ext-moh,rock,1'), 'Music on Hold: rock');
    assert.strictEqual(formatDestination('ext-trunk,1,1'), 'Trunk: Primary SIP Trunk (pjsip)');
    assert.strictEqual(formatDestination('app-blackhole,hangup,1'), 'Terminate Call (Hangup)');
    assert.strictEqual(formatDestination('app-blackhole,congestion,1'), 'Play Congestion');
    assert.strictEqual(formatDestination('app-blackhole,busy,1'), 'Play Busy');
    assert.strictEqual(formatDestination('app-blackhole,zapateller,1'), 'Play SIT Tone (Zapateller)');
    assert.strictEqual(formatDestination('app-blackhole,ringing,1'), 'Ring Forever');
    assert.strictEqual(formatDestination('custom-app,s,1'), 'custom-app,s,1');
    assert.strictEqual(formatDestination(''), '-');
    assert.strictEqual(formatDestination(null), '-');
});

test('views/config.ejs template renders Queue Failover Destination elements and modal without errors', async () => {
    const configPath = path.join(__dirname, '..', 'views', 'config.ejs');

    // Render in English
    const htmlEn = await ejs.renderFile(configPath, {
        currentPage: '/config',
        currentLang: 'en',
        lang: 'en',
        isRtl: false,
        theme: 'dark',
        activeTab: 'config',
        currentUser: 'root',
        isRoot: true,
        userGroup: 'super admins',
        userPermissions: ['config', 'config-queues'],
        isTabAllowed: (tab) => true
    });
    assert.ok(htmlEn.includes('Fail Over Destination') || htmlEn.includes('Failover Destination'));
    assert.ok(htmlEn.includes('Queue Continue Destination') || htmlEn.includes('Continue Destination'));
    assert.ok(htmlEn.includes('queueDestination'));
    assert.ok(htmlEn.includes('queueContinueDestination'));
    assert.ok(htmlEn.includes('queueDestComponentContainer'));
    assert.ok(htmlEn.includes('queueContinueDestComponentContainer'));

    // Render in Arabic
    const htmlAr = await ejs.renderFile(configPath, {
        currentPage: '/config',
        currentLang: 'ar',
        lang: 'ar',
        isRtl: true,
        theme: 'dark',
        activeTab: 'config',
        currentUser: 'root',
        isRoot: true,
        userGroup: 'super admins',
        userPermissions: ['config', 'config-queues'],
        isTabAllowed: (tab) => true
    });

    assert.ok(htmlAr.includes('الوجهة عند الإخفاق'));
    assert.ok(htmlAr.includes('الوجهة عند مواصلة الطابور') || htmlAr.includes('الوجهة عند المواصلة'));
    assert.ok(htmlAr.includes('queueDestination'));
    assert.ok(htmlAr.includes('queueContinueDestination'));
    assert.ok(htmlAr.includes('queueDestComponentContainer'));
    assert.ok(htmlAr.includes('queueContinueDestComponentContainer'));
});

test('Queue Backend CRUD simulation with Failover Destination', async () => {
    // In-memory mock database store replicating queues_config and queues_details tables
    const queuesConfigStore = new Map();
    const queuesDetailsStore = [];

    // Helper functions simulating server.js queue routes
    async function createQueue(body) {
        const {
            extension, descr, static_members, dynmembers, musicclass,
            joinannounce_id, recording, maxwait, timeout, retry, dest, failover,
            strategy, autofill, skip_busy
        } = body;

        const num = String(extension || '').trim();
        if (!num || !/^\d+$/.test(num)) throw new Error('Valid numeric Queue number is required.');
        const name = String(descr || '').trim();
        if (!name) throw new Error('Queue Name is required.');
        if (queuesConfigStore.has(num)) throw new Error(`Queue ${num} already exists.`);

        const ringStrategy = strategy || 'rrmemory';
        const isAutofill = autofill === 'no' ? 'no' : 'yes';
        const skipBusy = skip_busy === 'no' ? 'no' : 'yes';
        const cwignoreVal = skipBusy === 'yes' ? 1 : 0;
        const ringInUseVal = skipBusy === 'yes' ? 'no' : 'yes';
        const isRecording = recording === 'no' ? 'no' : 'yes';
        const monitorTypeVal = isRecording === 'yes' ? 'bgrnd' : '';
        const mohClass = musicclass || 'default';
        const annId = parseInt(joinannounce_id, 10) || 0;
        const maxWaitVal = String(maxwait !== undefined && maxwait !== null ? maxwait : '0');
        const agentTimeoutVal = String(timeout || '15');
        const retryVal = String(retry || '5');
        const failDest = String(dest || failover || body.goto || '').trim() || 'app-blackhole,hangup,1';
        const continueDest = String(body.destcontinue || body.continue_dest || '').trim() || 'app-blackhole,hangup,1';

        queuesConfigStore.set(num, {
            extension: num,
            descr: name,
            joinannounce_id: annId,
            maxwait: maxWaitVal,
            dest: failDest,
            destcontinue: continueDest,
            cwignore: cwignoreVal,
            monitor_type: monitorTypeVal
        });

        const details = [
            [num, 'strategy', ringStrategy, 0],
            [num, 'autofill', isAutofill, 0],
            [num, 'ringinuse', ringInUseVal, 0],
            [num, 'musicclass', mohClass, 0],
            [num, 'timeout', agentTimeoutVal, 0],
            [num, 'retry', retryVal, 0],
            [num, 'maxwait', maxWaitVal, 0],
            [num, 'goto', failDest, 0]
        ];

        for (const row of details) {
            queuesDetailsStore.push({ id: row[0], keyword: row[1], data: row[2], flags: row[3] });
        }

        return { success: true, message: `Queue ${num} created successfully.` };
    }

    async function getQueues() {
        const queues = [];
        for (const [ext, q] of queuesConfigStore.entries()) {
            const dList = queuesDetailsStore.filter(d => d.id === ext);
            const dMap = {};
            dList.forEach(d => { dMap[d.keyword] = d.data; });
            queues.push({
                extension: q.extension,
                descr: q.descr,
                maxwait: q.maxwait,
                dest: q.dest || dMap.goto || 'app-blackhole,hangup,1',
                destcontinue: q.destcontinue || 'app-blackhole,hangup,1',
                strategy: dMap.strategy || 'rrmemory'
            });
        }
        return { success: true, queues };
    }

    async function updateQueue(extNum, body) {
        const num = String(extNum).trim();
        if (!queuesConfigStore.has(num)) throw new Error(`Queue ${num} not found.`);

        const { descr, joinannounce_id, recording, maxwait, timeout, retry, dest, failover, strategy } = body;
        const name = String(descr || '').trim();
        if (!name) throw new Error('Queue Name is required.');

        const failDest = String(dest || failover || body.goto || '').trim() || 'app-blackhole,hangup,1';
        const continueDest = String(body.destcontinue || body.continue_dest || '').trim() || 'app-blackhole,hangup,1';
        const q = queuesConfigStore.get(num);
        q.descr = name;
        q.dest = failDest;
        q.destcontinue = continueDest;
        // Clear and rewrite details
        const remaining = queuesDetailsStore.filter(d => d.id !== num);
        queuesDetailsStore.length = 0;
        queuesDetailsStore.push(...remaining);

        queuesDetailsStore.push({ id: num, keyword: 'strategy', data: strategy || 'rrmemory', flags: 0 });
        queuesDetailsStore.push({ id: num, keyword: 'goto', data: failDest, flags: 0 });

        return { success: true, message: `Queue ${num} updated successfully.` };
    }

    async function deleteQueue(extNum) {
        const num = String(extNum).trim();
        queuesConfigStore.delete(num);
        const remaining = queuesDetailsStore.filter(d => d.id !== num);
        queuesDetailsStore.length = 0;
        queuesDetailsStore.push(...remaining);
        return { success: true, message: `Queue ${num} deleted successfully.` };
    }

    // 1. CREATE Queue with failover to Extension 101 and continue destination to Ring Group 600
    const createRes = await createQueue({
        extension: '888',
        descr: 'VIP Call Queue',
        dest: 'from-did-direct,101,1',
        destcontinue: 'ext-group,600,1',
        maxwait: '45',
        strategy: 'leastrecent'
    });
    assert.strictEqual(createRes.success, true);

    // 2. READ Queues and verify both destinations
    const listRes = await getQueues();
    const created = listRes.queues.find(q => q.extension === '888');
    assert.ok(created);
    assert.strictEqual(created.dest, 'from-did-direct,101,1');
    assert.strictEqual(created.destcontinue, 'ext-group,600,1');
    assert.strictEqual(created.strategy, 'leastrecent');

    // 3. UPDATE Queue failover to Ring Group 600 and continue to IVR 1
    const updateRes = await updateQueue('888', {
        descr: 'VIP Call Queue Updated',
        dest: 'ext-group,600,1',
        destcontinue: 'ivr-1,s,1',
        strategy: 'ringall'
    });
    assert.strictEqual(updateRes.success, true);

    const updatedListRes = await getQueues();
    const updated = updatedListRes.queues.find(q => q.extension === '888');
    assert.strictEqual(updated.dest, 'ext-group,600,1');
    assert.strictEqual(updated.destcontinue, 'ivr-1,s,1');
    assert.strictEqual(updated.strategy, 'ringall');
    // 4. DELETE Queue and verify cleanup
    const deleteRes = await deleteQueue('888');
    assert.strictEqual(deleteRes.success, true);

    const postDeleteRes = await getQueues();
    assert.strictEqual(postDeleteRes.queues.find(q => q.extension === '888'), undefined);
    assert.strictEqual(queuesDetailsStore.find(d => d.id === '888'), undefined);
});
