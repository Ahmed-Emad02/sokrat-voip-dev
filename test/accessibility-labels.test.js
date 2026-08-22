const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('All <label> elements across all views have valid programmatic associations (for attribute or wrapped input)', () => {
    const viewsDir = path.join(__dirname, '../views');
    const files = fs.readdirSync(viewsDir).filter(f => f.endsWith('.ejs')).map(f => path.join(viewsDir, f));

    let unassociatedCount = 0;
    const unassociatedList = [];

    for (const filepath of files) {
        const content = fs.readFileSync(filepath, 'utf8');
        const labels = content.match(/<label\b[^>]*>[\s\S]*?<\/label>|<label\b[^>]*>/gi) || [];

        for (const l of labels) {
            const hasFor = /\bfor=["'][^"']+["']/i.test(l);
            const hasInput = /<\s*(input|select|textarea)\b/i.test(l);

            if (!hasFor && !hasInput) {
                unassociatedCount++;
                unassociatedList.push({ file: path.basename(filepath), tag: l.substring(0, 80) });
            }
        }
    }

    assert.equal(unassociatedCount, 0, `Found unassociated labels: ${JSON.stringify(unassociatedList, null, 2)}`);
});

test('All <label for="..."> attributes across views point to a valid declared element ID in the same template', () => {
    const viewsDir = path.join(__dirname, '../views');
    const files = fs.readdirSync(viewsDir).filter(f => f.endsWith('.ejs')).map(f => path.join(viewsDir, f));

    let mismatchCount = 0;
    const mismatchList = [];

    for (const filepath of files) {
        const content = fs.readFileSync(filepath, 'utf8');
        const declaredIds = new Set(Array.from(content.matchAll(/\bid=["']([^"']+)["']/gi)).map(m => m[1]));
        declaredIds.add('dest-cat-${this.instanceId}');
        declaredIds.add('dest-target-${this.instanceId}');
        declaredIds.add('dest-custom-${this.instanceId}');

        const forMatches = Array.from(content.matchAll(/<label[^>]*\bfor=["']([^"']+)["']/gi)).map(m => m[1]);
        for (const tid of forMatches) {
            if (tid.startsWith('${') || declaredIds.has(tid)) {
                continue;
            }
            mismatchCount++;
            mismatchList.push({ file: path.basename(filepath), missingId: tid });
        }
    }

    assert.equal(mismatchCount, 0, `Found label for= references with missing IDs: ${JSON.stringify(mismatchList, null, 2)}`);
});

test('All form control elements (<input>, <select>, <textarea>) across all views have an explicit id or name attribute', () => {
    const viewsDir = path.join(__dirname, '../views');
    const files = fs.readdirSync(viewsDir).filter(f => f.endsWith('.ejs')).map(f => path.join(viewsDir, f));

    let missingCount = 0;
    const missingList = [];

    for (const filepath of files) {
        const content = fs.readFileSync(filepath, 'utf8');
        const tagMatches = content.matchAll(/<(input|select|textarea)\b([^>]*?)>/gi);

        for (const m of tagMatches) {
            const tagType = m[1].toLowerCase();
            const attrs = m[2];

            const hasId = /\bid=["']?[^"'\s>]+/i.test(attrs);
            const hasName = /\bname=["']?[^"'\s>]+/i.test(attrs);

            if (!hasId && !hasName) {
                missingCount++;
                missingList.push({ file: path.basename(filepath), tag: tagType, snippet: m[0].substring(0, 100) });
            }
        }
    }

    assert.equal(missingCount, 0, `Found form elements without id or name: ${JSON.stringify(missingList, null, 2)}`);
});

test('All autofillable credential/contact inputs across views have explicit autocomplete attributes', () => {
    const viewsDir = path.join(__dirname, '../views');
    const files = fs.readdirSync(viewsDir).filter(f => f.endsWith('.ejs')).map(f => path.join(viewsDir, f));

    let missingCount = 0;
    const missingList = [];

    for (const filepath of files) {
        const content = fs.readFileSync(filepath, 'utf8');
        const matches = content.matchAll(/<input\b([^>]*?)>/gi);

        for (const m of matches) {
            const attrs = m[1];
            const hasAc = /\bautocomplete=["']?[^"'\s>]+/i.test(attrs);
            const isAutofillable = /type=["']?(email|password|tel)["']?|\b(name|id)=["']?(email|password|username|secret|passwd|user_name)["']?/i.test(attrs);

            if (isAutofillable && !hasAc) {
                missingCount++;
                missingList.push({ file: path.basename(filepath), snippet: m[0].substring(0, 100) });
            }
        }
    }

    assert.equal(missingCount, 0, `Found autofillable inputs missing autocomplete: ${JSON.stringify(missingList, null, 2)}`);
});

test('All Flatpickr initializations with altInput configure onReady to preserve ID, name, and accessibility', () => {
    const viewsDir = path.join(__dirname, '../views');
    const files = fs.readdirSync(viewsDir).filter(f => f.endsWith('.ejs')).map(f => path.join(viewsDir, f));

    let missingOnReadyCount = 0;
    const missingList = [];

    for (const filepath of files) {
        const content = fs.readFileSync(filepath, 'utf8');
        const fpMatches = Array.from(content.matchAll(/flatpickr\s*\(/gi));

        for (const m of fpMatches) {
            const block = content.substring(m.index, m.index + 1200);
            if (block.includes('altInput: true') && !block.includes('onReady')) {
                missingOnReadyCount++;
                missingList.push({ file: path.basename(filepath), index: m.index });
            }
        }
    }

    assert.equal(missingOnReadyCount, 0, `Found Flatpickr instances missing onReady: ${JSON.stringify(missingList, null, 2)}`);
});
