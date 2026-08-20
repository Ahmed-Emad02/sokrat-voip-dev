const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const configEjsPath = path.join(__dirname, '../views/config.ejs');

test('views/config.ejs does not contain any hardcoded untranslated action buttons', () => {
    const content = fs.readFileSync(configEjsPath, 'utf8');

    // Ensure no bare '>Edit<' or '>Delete<' in buttons
    assert.equal(/>Edit<\/button>/.test(content), false, 'Should not contain bare >Edit</button>');
    assert.equal(/>Delete<\/button>/.test(content), false, 'Should not contain bare >Delete</button>');
    assert.equal(/>Remove<\/button>/.test(content), false, 'Should not contain bare >Remove</button>');
    assert.equal(/>\s*<span>Edit<\/span>\s*<\/button>/.test(content), false, 'Should not contain bare <span>Edit</span> in button');
    assert.equal(/>\s*<span>Delete<\/span>\s*<\/button>/.test(content), false, 'Should not contain bare <span>Delete</span> in button');
});

test('views/config.ejs includes Arabic translations for all table action buttons', () => {
    const content = fs.readFileSync(configEjsPath, 'utf8');

    // Check presence of bilingual button templates across all sub-tab tables
    assert.ok(content.includes("${isRtl ? 'تعديل' : 'Edit'}"), 'Should contain bilingual Edit button template');
    assert.ok(content.includes("${isRtl ? 'حذف' : 'Delete'}"), 'Should contain bilingual Delete button template');
    assert.ok(content.includes("${isRtl ? 'حذف' : 'Remove'}"), 'Should contain bilingual Remove button template');
});

test('views/config.ejs confirmation dialogs and empty table states are fully translated in Arabic', async () => {
    const content = fs.readFileSync(configEjsPath, 'utf8');

    // Ring group delete confirm
    assert.ok(content.includes("isRtl ? `حذف مجموعة الاتصال ${grpnum}؟` : `Delete ring group ${grpnum}?`"));
    // Queue delete confirm
    assert.ok(content.includes("isRtl ? `حذف طابور الانتظار ${extension}؟` : `Delete Queue ${extension}?`"));
    // Trunk delete confirm
    assert.ok(content.includes("isRtl ? `حذف خط الربط ${trunkid}؟` : `Delete trunk ID ${trunkid}?`"));
    // Inbound delete confirm
    assert.ok(content.includes("isRtl ? `حذف المسار الوارد '${label}'؟` : `Delete inbound route '${label}'?`"));
    // Outbound delete confirm
    assert.ok(content.includes("isRtl ? `حذف المسار الصادر #${routeId}؟` : `Delete outbound route ID ${routeId}?`"));
    // IVR delete confirm
    assert.ok(content.includes("isRtl ? `هل أنت متأكد من حذف قائمة الرد الآلي #${id}؟` : `Are you sure you want to delete IVR #${id}?`"));

    // Render in Arabic and verify no English action headers or empty state regressions
    const arHtml = await ejs.renderFile(configEjsPath, {
        currentPage: '/config',
        currentLang: 'ar',
        isRtl: true,
        isSuperAdmin: true,
        isRoot: true
    });

    assert.ok(arHtml.includes('الإجراءات'), 'Arabic render should include Arabic Actions table header');
    assert.ok(arHtml.includes('تطبيق التغييرات'), 'Arabic render should include Apply Changes in Arabic');
    assert.ok(arHtml.includes('إضافة تحويلة جديدة'), 'Arabic render should include Add Extension in Arabic');
    assert.ok(arHtml.includes('إضافة خط ربط جديد'), 'Arabic render should include Add Trunk in Arabic');
});
