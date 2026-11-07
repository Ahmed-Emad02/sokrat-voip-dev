/* Sokrat Cloud Tenants — embeddable call button. */
(function () {
    'use strict';

    if (window.__sokratCallWidgetLoaded) return;
    window.__sokratCallWidgetLoaded = true;

    var script = document.currentScript || document.querySelector('script[data-sokrat-call]');
    if (!script) return;

    var tenant = script.getAttribute('data-tenant') || '';
    var link = script.getAttribute('data-link') || '';
    var label = script.getAttribute('data-label') || 'Call us';
    var color = script.getAttribute('data-color') || '#e11d48';
    var position = (script.getAttribute('data-position') || 'right').toLowerCase();
    var mode = (script.getAttribute('data-mode') || 'modal').toLowerCase();
    var lang = (script.getAttribute('data-lang') || document.documentElement.lang || 'en').toLowerCase().indexOf('ar') === 0 ? 'ar' : 'en';
    var target = link || tenant;

    if (!target) return;
    if (!/^#[0-9a-fA-F]{3,8}$/.test(color)) color = '#e11d48';

    // The widget runs on the business's website, so a relative /c/... URL would
    // point at that website. Always build the call URL from the Sokrat origin
    // that served this script.
    var scriptUrl = script.src ? new URL(script.src, window.location.href) : null;
    var baseOrigin = (scriptUrl && scriptUrl.origin)
        || script.getAttribute('data-base-url')
        || window.location.origin;
    var callPath = String(baseOrigin).replace(/\/+$/, '') + '/c/' + encodeURIComponent(target)
        + '?embed=1&autostart=1&lang=' + encodeURIComponent(lang);

    var button = document.createElement('button');
    button.type = 'button';
    button.id = 'sokrat-call-widget-button';
    button.setAttribute('aria-label', label);
    button.textContent = label;
    Object.assign(button.style, {
        position: 'fixed',
        bottom: '22px',
        right: position === 'left' ? 'auto' : '22px',
        left: position === 'left' ? '22px' : 'auto',
        zIndex: '2147483000',
        border: '0',
        borderRadius: '999px',
        padding: '14px 20px',
        background: color,
        color: '#fff',
        fontFamily: 'Segoe UI, Tahoma, Arial, sans-serif',
        fontSize: '15px',
        fontWeight: '800',
        cursor: 'pointer',
        boxShadow: '0 12px 34px rgba(0,0,0,.28)',
        lineHeight: '1.1'
    });

    if (mode === 'link') {
        button.addEventListener('click', function () {
            window.location.href = callPath;
        });
        document.body.appendChild(button);
        return;
    }

    var overlay = document.createElement('div');
    overlay.id = 'sokrat-call-widget-overlay';
    Object.assign(overlay.style, {
        position: 'fixed',
        inset: '0',
        zIndex: '2147483001',
        display: 'none',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0,0,0,.72)',
        padding: '16px',
        backdropFilter: 'blur(6px)'
    });

    var panel = document.createElement('div');
    Object.assign(panel.style, {
        position: 'relative',
        width: 'min(430px, 94vw)',
        height: 'min(660px, 90vh)',
        borderRadius: '24px',
        overflow: 'hidden',
        background: '#0b0b0f',
        boxShadow: '0 30px 100px rgba(0,0,0,.55)'
    });

    var close = document.createElement('button');
    close.type = 'button';
    close.setAttribute('aria-label', lang === 'ar' ? 'إغلاق' : 'Close');
    close.textContent = '×';
    Object.assign(close.style, {
        position: 'absolute',
        top: '10px',
        right: '10px',
        zIndex: '2',
        width: '34px',
        height: '34px',
        border: '1px solid rgba(255,255,255,.18)',
        borderRadius: '50%',
        background: 'rgba(0,0,0,.45)',
        color: '#fff',
        fontSize: '22px',
        lineHeight: '30px',
        cursor: 'pointer'
    });

    var iframe = document.createElement('iframe');
    iframe.title = label;
    iframe.setAttribute('allow', 'microphone; autoplay; clipboard-write');
    iframe.setAttribute('allowtransparency', 'true');
    Object.assign(iframe.style, {
        width: '100%',
        height: '100%',
        border: '0',
        background: 'transparent'
    });

    function open() {
        if (!iframe.src) iframe.src = callPath;
        overlay.style.display = 'flex';
    }

    function closeWidget() {
        overlay.style.display = 'none';
    }

    close.addEventListener('click', closeWidget);
    overlay.addEventListener('click', function (event) {
        if (event.target === overlay) closeWidget();
    });
    button.addEventListener('click', open);

    panel.appendChild(close);
    panel.appendChild(iframe);
    overlay.appendChild(panel);
    document.body.appendChild(button);
    document.body.appendChild(overlay);

    window.addEventListener('message', function (event) {
        if (!event || event.origin !== window.location.origin) return;
        if (event.data && event.data.type === 'sokrat-call-ended') {
            // Keep the panel open so the visitor can see the final state and retry.
        }
    });
})();
