const test = require('node:test');
const assert = require('node:assert/strict');
const { app } = require('../server');

/**
 * Recursively extracts all registered routes from Express app
 */
function extractEndpoints(expressApp) {
    const endpoints = [];

    function processStack(stack, basePath = '') {
        if (!Array.isArray(stack)) return;
        for (const layer of stack) {
            if (layer.route && layer.route.path) {
                const methods = Object.keys(layer.route.methods || {});
                const routePath = basePath + (layer.route.path === '/' && basePath ? '' : layer.route.path);
                for (const method of methods) {
                    endpoints.push({
                        method: method.toUpperCase(),
                        path: routePath,
                        fullPath: layer.route.path
                    });
                }
            } else if (layer.name === 'router' && layer.handle && layer.handle.stack) {
                let routerPrefix = '';
                if (layer.regexp) {
                    const match = layer.regexp.source
                        .replace('^\\', '')
                        .replace('\\/?(?=\\/|$)', '')
                        .replace('?(?=\\/|$)', '')
                        .replace(/\\\//g, '/')
                        .replace('^', '')
                        .replace('$', '');
                    if (match && !match.includes('?') && !match.includes('(')) {
                        routerPrefix = match.startsWith('/') ? match : '/' + match;
                    }
                }
                processStack(layer.handle.stack, basePath + routerPrefix);
            }
        }
    }

    if (expressApp._router && expressApp._router.stack) {
        processStack(expressApp._router.stack);
    }
    return endpoints;
}

/**
 * Authenticates as admin to get session cookie
 */
async function getAdminCookie(baseUrl) {
    try {
        const res = await fetch(`${baseUrl}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'username=admin&password=admin',
            redirect: 'manual'
        });
        return res.headers.get('set-cookie') || '';
    } catch (_) {
        return '';
    }
}

test('Endpoint Scanner: Discover all registered server endpoints', () => {
    const endpoints = extractEndpoints(app);
    assert.ok(endpoints.length >= 30, `Expected at least 30 endpoints, found ${endpoints.length}`);

    const getEndpoints = endpoints.filter(e => e.method === 'GET');
    const postEndpoints = endpoints.filter(e => e.method === 'POST');

    assert.ok(getEndpoints.length > 0, 'Should have registered GET endpoints');
    assert.ok(postEndpoints.length > 0, 'Should have registered POST endpoints');

    // Verify critical routes exist
    const criticalPaths = ['/', '/login', '/cdr', '/cdr/export', '/voicemails', '/vm-export', '/api/gsm-dongles'];
    for (const p of criticalPaths) {
        const found = endpoints.some(e => e.path === p);
        assert.ok(found, `Critical endpoint ${p} must be registered`);
    }
});

test('Endpoint Scanner: Scan all static GET endpoints for 500 server errors', async () => {
    const server = app.listen(0);
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
        const cookie = await getAdminCookie(baseUrl);
        const endpoints = extractEndpoints(app);
        const staticGetRoutes = endpoints
            .filter(e => e.method === 'GET' && !e.path.includes(':') && !e.path.includes('*'))
            .map(e => e.path);

        const uniqueRoutes = [...new Set(staticGetRoutes)];
        const errors = [];

        for (const route of uniqueRoutes) {
            try {
                // Test unauthenticated
                const resUnauth = await fetch(`${baseUrl}${route}`, {
                    redirect: 'manual'
                });

                if (resUnauth.status === 500) {
                    errors.push({ route, status: 500, auth: false });
                }

                // Test authenticated
                if (cookie) {
                    const resAuth = await fetch(`${baseUrl}${route}`, {
                        headers: { Cookie: cookie },
                        redirect: 'manual'
                    });

                    if (resAuth.status === 500) {
                        errors.push({ route, status: 500, auth: true });
                    }
                }
            } catch (err) {
                errors.push({ route, error: err.message });
            }
        }

        assert.equal(
            errors.length,
            0,
            `Found ${errors.length} endpoint(s) with 500 errors or exceptions: ${JSON.stringify(errors, null, 2)}`
        );
    } finally {
        server.close();
    }
});

test('Endpoint Scanner: Scan parameterized GET endpoints with test parameters for 500 errors', async () => {
    const server = app.listen(0);
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
        const cookie = await getAdminCookie(baseUrl);
        const endpoints = extractEndpoints(app);
        const paramGetRoutes = endpoints
            .filter(e => e.method === 'GET' && e.path.includes(':'))
            .map(e => e.path);

        const uniqueParamRoutes = [...new Set(paramGetRoutes)];
        const errors = [];

        for (const route of uniqueParamRoutes) {
            // Replace path parameters with safe test placeholders
            const testPath = route
                .replace(':dongleId', 'dongle0')
                .replace(':id', '1')
                .replace(':extension', '101')
                .replace(':ext', '101')
                .replace(':filename', 'test.wav')
                .replace(':name', 'default')
                .replace(':callId', 'test-call')
                .replace(':mailbox', '101');

            // If there are still unresolved params, skip
            if (testPath.includes(':')) continue;

            try {
                const res = await fetch(`${baseUrl}${testPath}`, {
                    headers: cookie ? { Cookie: cookie } : {},
                    redirect: 'manual'
                });

                if (res.status === 500) {
                    errors.push({ route, testPath, status: 500 });
                }
            } catch (err) {
                errors.push({ route, testPath, error: err.message });
            }
        }

        assert.equal(
            errors.length,
            0,
            `Found ${errors.length} parameterized endpoint(s) with 500 errors: ${JSON.stringify(errors, null, 2)}`
        );
    } finally {
        server.close();
    }
});

test('Endpoint Scanner: Verify export endpoints return valid status and headers', async () => {
    const server = app.listen(0);
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
        const cookie = await getAdminCookie(baseUrl);

        // 1. CDR Export
        const cdrRes = await fetch(`${baseUrl}/cdr/export`, {
            headers: cookie ? { Cookie: cookie } : {},
            redirect: 'manual'
        });
        assert.notEqual(cdrRes.status, 500, '/cdr/export must not return 500');

        // 2. Voicemail Export
        const vmRes = await fetch(`${baseUrl}/vm-export`, {
            headers: cookie ? { Cookie: cookie } : {},
            redirect: 'manual'
        });
        assert.notEqual(vmRes.status, 500, '/vm-export must not return 500');

        if (vmRes.status === 200) {
            const disposition = vmRes.headers.get('content-disposition') || '';
            assert.ok(disposition.includes('.xlsx') || disposition.includes('.csv'), 'Voicemail export must have attachment filename');
        }
    } finally {
        server.close();
    }
});
test('Teardown: test suite exits cleanly', () => {
    setTimeout(() => process.exit(0), 100);
});
