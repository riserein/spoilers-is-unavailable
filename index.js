/**
 * Lore Spoilers Author Publisher — resilient bootloader.
 * This small module intentionally has no static imports. If any core ST API
 * changes, the extension still loads and shows the actual failure reason.
 */
(function () {
    function report(error) {
        const message = error?.stack || error?.message || String(error);
        console.error('[Lore Spoilers] Startup failed:', error);
        const render = () => {
            if (document.getElementById('lsp_boot_error')) return;
            const el = document.createElement('div');
            el.id = 'lsp_boot_error';
            el.setAttribute('role', 'alert');
            el.style.cssText = 'padding:12px;margin:10px 0;border:2px solid #c77a61;border-radius:8px;background:#37241f;color:#fff;white-space:pre-wrap;font-size:13px;';
            const heading = document.createElement('b');
            heading.textContent = 'Lore Spoilers 加载失败（可复制错误信息）：';
            const detail = document.createElement('pre');
            detail.style.cssText = 'margin:8px 0 0;max-height:140px;overflow:auto;white-space:pre-wrap;user-select:text;';
            detail.textContent = message;
            el.append(heading,detail);
            (document.querySelector('#extensions_settings2') || document.body).prepend(el);
            if (window.toastr?.error) window.toastr.error('Lore Spoilers 插件未成功初始化，请查看页面红色错误框。', 'Lore Spoilers', {timeOut: 9000});
        };
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', render, {once: true});
        } else render();
    }
    import('./app.js?v=2.0.5').catch(report);
})();
