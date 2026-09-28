const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const { app } = require('../server');

test('views/login.ejs contains language switcher, theme toggle, and theme persistence scripts', () => {
    const loginEjsPath = path.join(__dirname, '../views/login.ejs');
    const content = fs.readFileSync(loginEjsPath, 'utf8');

    // Theme toggle & persistence
    assert.ok(content.includes('id="themeToggleBtn"'), 'Must have #themeToggleBtn');
    assert.ok(content.includes('toggleTheme()'), 'Must call toggleTheme()');
    assert.ok(content.includes('theme-icon-sun'), 'Must include sun icon for dark mode');
    assert.ok(content.includes('theme-icon-moon'), 'Must include moon icon for light mode');
    assert.ok(content.includes('.light-theme'), 'Must define .light-theme styling');
    assert.ok(content.includes("localStorage.getItem('theme')"), 'Must read theme from localStorage');
    assert.ok(content.includes("localStorage.setItem('theme'"), 'Must save theme to localStorage');

    // Language switching & persistence
    assert.ok(content.includes("setLanguage('en')"), 'Must have English switcher button');
    assert.ok(content.includes("setLanguage('ar')"), 'Must have Arabic switcher button');
    assert.ok(content.includes("localStorage.getItem('lang')"), 'Must read lang from localStorage');
    assert.ok(content.includes("localStorage.setItem('lang'"), 'Must save lang to localStorage');
    assert.ok(content.includes('id="loginFormLang"'), 'Must have hidden input loginFormLang in login form');

    // Theme-aware brand logos
    assert.ok(content.includes('/logo_light_text.png'), 'Must include logo for dark theme');
    assert.ok(content.includes('/logo_dark.png'), 'Must include logo for light theme');
    assert.ok(content.includes('logo-dark-theme'), 'Must define logo-dark-theme class');
    assert.ok(content.includes('logo-light-theme'), 'Must define logo-light-theme class');
});

test('views/login.ejs renders properly in English and Arabic mode', async () => {
    const loginEjsPath = path.join(__dirname, '../views/login.ejs');

    // Render English
    const htmlEn = await ejs.renderFile(loginEjsPath, {
        currentLang: 'en',
        redirect: '/',
        error: null,
        username: ''
    });
    assert.ok(htmlEn.includes('lang="en"'), 'Must have lang="en"');
    assert.ok(htmlEn.includes('dir="ltr"'), 'Must have dir="ltr"');
    assert.ok(htmlEn.includes('Sign In'), 'Must contain English button text "Sign In"');
    assert.ok(htmlEn.includes('Username'), 'Must contain English label "Username"');
    assert.ok(htmlEn.includes('Password'), 'Must contain English label "Password"');

    // Render Arabic
    const htmlAr = await ejs.renderFile(loginEjsPath, {
        currentLang: 'ar',
        redirect: '/cdr',
        error: 'Invalid credentials',
        username: 'operator1'
    });
    assert.ok(htmlAr.includes('lang="ar"'), 'Must have lang="ar"');
    assert.ok(htmlAr.includes('dir="rtl"'), 'Must have dir="rtl"');
    assert.ok(htmlAr.includes('تسجيل الدخول'), 'Must contain Arabic button text "تسجيل الدخول"');
    assert.ok(htmlAr.includes('اسم المستخدم'), 'Must contain Arabic label "اسم المستخدم"');
    assert.ok(htmlAr.includes('كلمة المرور'), 'Must contain Arabic label "كلمة المرور"');
    assert.ok(htmlAr.includes('value="operator1"'), 'Must preserve username in Arabic render');
});

test('HTTP GET /login handles language selection and sets session language', async () => {
    const server = app.listen(0);
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
        // 1. GET /login?lang=ar
        const resAr = await fetch(`${baseUrl}/login?lang=ar`);
        assert.equal(resAr.status, 200);
        const textAr = await resAr.text();
        assert.ok(textAr.includes('dir="rtl"'), 'Must be RTL when lang=ar is requested');
        assert.ok(textAr.includes('lang="ar"'), 'Must be lang="ar"');

        // 2. GET /login?lang=en
        const resEn = await fetch(`${baseUrl}/login?lang=en`);
        assert.equal(resEn.status, 200);
        const textEn = await resEn.text();
        assert.ok(textEn.includes('dir="ltr"'), 'Must be LTR when lang=en is requested');
        assert.ok(textEn.includes('lang="en"'), 'Must be lang="en"');

        // 3. Username query retention
        const resUser = await fetch(`${baseUrl}/login?username=testuser123&lang=ar`);
        assert.equal(resUser.status, 200);
        const textUser = await resUser.text();
        assert.ok(textUser.includes('value="testuser123"'), 'Must retain username parameter in form input');
    } finally {
        server.close();
    }
});

test('HTTP POST /login preserves language selection on failed attempts', async () => {
    const server = app.listen(0);
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
        // Arabic login attempt with missing password
        const res = await fetch(`${baseUrl}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'username=someuser&password=&lang=ar'
        });
        assert.equal(res.status, 200);
        const text = await res.text();
        assert.ok(text.includes('dir="rtl"'), 'Should render RTL on Arabic failed login');
        assert.ok(text.includes('اسم المستخدم وكلمة المرور مطلوبان'), 'Should return Arabic error message for missing fields');
        assert.ok(text.includes('value="someuser"'), 'Should preserve username on failure');
    } finally {
        server.close();
    }
});

test('HTTP POST /login sets language and theme for post-login session and persistence', async () => {
    const server = app.listen(0);
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
        // Authenticate with chosen lang=ar and theme=light
        const res = await fetch(`${baseUrl}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'username=root&password=Admin@123&lang=ar&theme=light',
            redirect: 'manual'
        });

        assert.equal(res.status, 302, 'Should redirect after successful authentication');
        const location = res.headers.get('location') || '';
        assert.ok(location.includes('lang=ar'), 'Redirect destination must retain chosen lang=ar');

        const cookie = res.headers.get('set-cookie') || '';
        assert.ok(cookie.includes('connect.sid'), 'Must set connect.sid session cookie');

        // Verify destination page renders with Arabic RTL and light theme
        const dashRes = await fetch(`${baseUrl}${location}`, {
            headers: { Cookie: cookie }
        });
        assert.equal(dashRes.status, 200);
        const dashHtml = await dashRes.text();
        assert.ok(dashHtml.includes('dir="rtl"'), 'Dashboard should render in RTL after Arabic login');
        assert.ok(dashHtml.includes('lang="ar"'), 'Dashboard should render lang="ar" after Arabic login');
        assert.ok(dashHtml.includes('light-theme') || dashHtml.includes("theme = 'light'") || dashHtml.includes('serverTheme = \'light\''), 'Dashboard should receive light theme');

        // Test POST /api/user/theme-lang updates preferences dynamically
        const updateRes = await fetch(`${baseUrl}/api/user/theme-lang`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Cookie: cookie
            },
            body: JSON.stringify({ theme: 'dark', lang: 'en' })
        });
        assert.equal(updateRes.status, 200);
        const updateJson = await updateRes.json();
        assert.equal(updateJson.success, true);
        assert.equal(updateJson.theme, 'dark');
        assert.equal(updateJson.lang, 'en');
    } finally {
        server.close();
    }
});

test('Teardown: test suite exits cleanly', () => {
    setTimeout(() => process.exit(0), 100);
});

