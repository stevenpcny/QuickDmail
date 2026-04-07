// HeyGen Gmail Collector - Content Script
// 监听 Gmail 页面，自动检测并收集 HeyGen 验证邮件

(function () {
    'use strict';

    let isMonitoring = false;
    let processedEmails = new Set();
    let _processedRows = new WeakSet(); // track DOM elements directly (no ID needed)
    let observer = null;
    let checkInterval = null;
    let _emailQueue = [];
    let _isProcessing = false;

    // ─── ① 尽早注入页面拦截器（在 Gmail JS 执行前） ─────────────
    // page-interceptor.js 运行在 Gmail 主上下文，可拦截 XHR/fetch 响应，
    // 直接从 Gmail JSON API 中提取 HeyGen 验证链接，无需点击打开邮件。
    (function injectPageInterceptor() {
        try {
            const s = document.createElement('script');
            s.src = chrome.runtime.getURL('page-interceptor.js');
            (document.head || document.documentElement).appendChild(s);
            s.onload = () => s.remove();
        } catch (e) {
            console.warn('[HeyGen Collector] 拦截器注入失败', e);
        }
    })();

    // ─── ② 监听页面拦截器通过 postMessage 上报的链接 ─────────────
    window.addEventListener('message', function (event) {
        if (event.source !== window) return;
        if (!event.data || event.data.type !== 'HGC_LINK_CAPTURED') return;
        const { link, account } = event.data;
        if (!link || !link.includes('magic-web/')) return;
        _saveXhrCapturedLink(link, account || '');
    });

    // ─── 数据过期清理：自动移除超过1小时的捕获记录 ────────────────
    function pruneOldData(list) {
        const oneHourAgo = Date.now() - 60 * 60 * 1000;
        return (list || []).filter(item =>
            new Date(item.capturedAt || 0).getTime() > oneHourAgo
        );
    }

    // 保存 XHR 拦截到的链接（去重 + 写 storage + 刷新侧边栏）
    function _saveXhrCapturedLink(link, account) {
        // 以链接路径部分做稳定 ID，避免不同 session 重复
        const emailId = 'xhr_' + link.replace(/^https?:\/\/[^/]+/, '').replace(/[^A-Za-z0-9]/g, '').substring(0, 64);
        if (processedEmails.has(emailId)) return;
        processedEmails.add(emailId);

        log('XHR 拦截到验证链接', { account, link });

        const item = { id: emailId, account, verifyLink: link, capturedAt: new Date().toISOString() };
        chrome.storage.local.get(['heygenData'], (res) => {
            const existing = pruneOldData(res.heygenData); // 先清除超时记录
            // 精确去重：同一 link 不重复存储
            if (existing.some(e => e.verifyLink === link)) return;
            existing.unshift(item);
            chrome.storage.local.set({ heygenData: existing.slice(0, 500) });
        });
        chrome.runtime.sendMessage({ type: 'NEW_HEYGEN_DATA', data: item }).catch(() => { });
        showNotification(item);
    }

    // ─── 工具函数 ───────────────────────────────────────────────
    function log(msg, data) {
        console.log(`[HeyGen Collector] ${msg}`, data || '');
    }

    function isGmailInbox() {
        return window.location.href.includes('mail.google.com');
    }

    // 从邮件行中提取唯一标识（多种 Gmail 属性兼容）
    function getEmailId(row) {
        // 直接属性
        for (const attr of ['data-legacy-message-id', 'data-message-id',
            'data-legacy-thread-id', 'data-thread-id', 'id']) {
            const v = row.getAttribute(attr);
            if (v) return v;
        }
        // 子元素
        const child = row.querySelector('[data-legacy-message-id], [data-thread-id]');
        if (child) {
            return child.getAttribute('data-legacy-message-id') ||
                child.getAttribute('data-thread-id');
        }
        // HeyGen 发件人 email 属性编码了收件人（唯一），如：
        // no_reply_at_email.heygen.com_RECIPIENT@DOMAIN
        const senderEl = row.querySelector('[email*="heygen"]');
        if (senderEl) return senderEl.getAttribute('email') || null;
        return null;
    }

    // 判断是否是 HeyGen 邮件行
    function isHeygenEmailRow(row) {
        const text = row.innerText || row.textContent || '';
        const lowerText = text.toLowerCase();
        return lowerText.includes('heygen') || lowerText.includes('hey gen');
    }

    // ─── 解析邮件内容 ────────────────────────────────────────────
    function parseHeygenEmail(emailBody, senderInfo) {
        const result = {
            account: '',
            verifyLink: '',
            rawLink: '',
            subject: '',
            timestamp: new Date().toLocaleString('zh-CN'),
            sender: senderInfo || ''
        };

        // 提取验证链接 - 多种模式匹配
        const linkPatterns = [
            /https?:\/\/[a-z0-9.-]*heygen\.com\/[^\s"'<>]+verify[^\s"'<>]*/gi,
            /https?:\/\/[a-z0-9.-]*heygen\.com\/[^\s"'<>]+confirm[^\s"'<>]*/gi,
            /https?:\/\/[a-z0-9.-]*heygen\.com\/[^\s"'<>]+activate[^\s"'<>]*/gi,
            /https?:\/\/[a-z0-9.-]*heygen\.com\/[^\s"'<>]+token[^\s"'<>]*/gi,
            /https?:\/\/[a-z0-9.-]*heygen\.com\/[^\s"'<>\u4e00-\u9fa5]{10,}/gi,
            /https?:\/\/[^\s"'<>]*[?&]url=https?[^&"'<>\s]*heygen[^\s"'<>]*/gi,
        ];

        let foundLink = null;
        for (const pattern of linkPatterns) {
            const matches = emailBody.match(pattern);
            if (matches && matches.length > 0) {
                foundLink = matches.reduce((a, b) => a.length > b.length ? a : b);
                break;
            }
        }

        if (foundLink) {
            result.verifyLink = foundLink.replace(/[.,;!?)]+$/, '').trim();
            result.rawLink = result.verifyLink;
        }

        // 提取 HeyGen 账号
        const accountPatterns = [
            /for\s+([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/i,
            /to\s+([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/i,
            /(?:account|email|邮箱|账号)[：:]\s*([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/i,
            /[Hh]i[,\s]+([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/i,
            /([a-zA-Z0-9._%+\-]+@(?!heygen)[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/gi,
        ];

        for (const pattern of accountPatterns) {
            const match = emailBody.match(pattern);
            if (match) {
                const email = match[1] || match[0];
                if (email && !email.toLowerCase().includes('heygen') &&
                    !email.toLowerCase().includes('noreply') &&
                    !email.toLowerCase().includes('no-reply')) {
                    result.account = email.trim();
                    break;
                }
            }
        }

        if (!result.account && senderInfo) {
            // 优先处理 Gmail email 属性格式：
            // no_reply_at_email.heygen.com_RECIPIENT@DOMAIN
            const heygenSplit = senderInfo.split('heygen.com_');
            if (heygenSplit.length >= 2) {
                const candidate = heygenSplit[heygenSplit.length - 1].trim();
                if (candidate.includes('@') && !candidate.toLowerCase().includes('heygen')) {
                    result.account = candidate;
                }
            }
            // 通用邮箱匹配
            if (!result.account) {
                const emailMatch = senderInfo.match(/([a-zA-Z0-9._%+\-]+@(?!heygen)[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/);
                if (emailMatch) result.account = emailMatch[1];
            }
        }

        return result;
    }

    // ─── 点击并读取邮件 ──────────────────────────────────────────
    async function clickAndReadEmail(emailRow) {
        return new Promise((resolve) => {
            emailRow.click();

            let attempts = 0;
            const maxAttempts = 30;

            const waitForContent = setInterval(() => {
                attempts++;

                // 多级 fallback 选择器，兼容不同 Gmail 版本
                const emailBody = document.querySelector([
                    'div.a3s.aiL',
                    'div.a3s',
                    'div[data-message-id] .a3s',
                    '[data-legacy-message-id] .a3s',
                    '.ii.gt div',
                    'div.gs .a3s',
                    '.adP.adO',
                    'div.Am.Al.editable',
                    'div[role="main"] .a3s',
                    'div[role="main"] .ii',
                    '.nH .a3s',
                    '.nH .ii'
                ].join(', '));

                if (emailBody || attempts >= maxAttempts) {
                    clearInterval(waitForContent);

                    if (emailBody) {
                        const bodyText = emailBody.innerText || emailBody.textContent || '';

                        const allLinks = [];

                        // 从锚标签提取 heygen 链接，含 Gmail 的 data-saferedirecturl 备用属性
                        function extractHeygenHref(a) {
                            // 1. 直接 href
                            const raw = a.getAttribute('href') || '';
                            const href = a.href || raw; // a.href 是绝对化后的 URL
                            if (href && href !== '#' && !href.startsWith('javascript:')) {
                                if (href.toLowerCase().includes('heygen')) return href;
                                // href 是 Google 重定向：google.com/url?q=REAL_URL
                                if (href.includes('google.com/url')) {
                                    try {
                                        const q = new URL(href).searchParams.get('q') || '';
                                        if (q.toLowerCase().includes('heygen')) return q;
                                    } catch (e) { }
                                }
                            }
                            // 2. data-saferedirecturl（Gmail 内嵌的原始 URL，格式同 Google 重定向）
                            const safe = a.getAttribute('data-saferedirecturl') || '';
                            if (safe) {
                                try {
                                    const q = new URL(safe).searchParams.get('q') || '';
                                    if (q.toLowerCase().includes('heygen')) return q;
                                } catch (e) { }
                                if (safe.toLowerCase().includes('heygen')) return safe;
                            }
                            // 3. 按 CTA 文字判断（"Log in with magic link" / "Verify" 等）
                            const txt = (a.textContent || a.innerText || '').toLowerCase().trim();
                            if (href && href.startsWith('http') && (
                                txt.includes('magic') || txt.includes('log in') ||
                                txt.includes('verify') || txt.includes('login') ||
                                txt.includes('sign in')
                            )) return href;
                            return null;
                        }

                        emailBody.querySelectorAll('a').forEach(a => {
                            const link = extractHeygenHref(a);
                            if (link && !allLinks.includes(link)) allLinks.push(link);
                        });

                        // 若邮件体内没找到，扩大到整个 role=main / .nH 区域
                        if (allLinks.length === 0) {
                            document.querySelectorAll('[role="main"] a, .nH a').forEach(a => {
                                const link = extractHeygenHref(a);
                                if (link && !allLinks.includes(link)) allLinks.push(link);
                            });
                        }

                        // 从 email 属性提取真实收件人（格式：no_reply_at_email.heygen.com_RECIPIENT@DOMAIN）
                        let recipientFromAttr = '';
                        document.querySelectorAll('[email]').forEach(el => {
                            const attr = el.getAttribute('email') || '';
                            const parts = attr.split('heygen.com_');
                            if (parts.length >= 2) {
                                const candidate = parts[parts.length - 1];
                                if (candidate.includes('@') && !candidate.toLowerCase().includes('heygen')) {
                                    recipientFromAttr = candidate;
                                }
                            }
                        });

                        const senderEl = document.querySelector('.gD, .go, [email]');
                        const senderEmail = recipientFromAttr || senderEl?.getAttribute('email') || senderEl?.innerText || '';

                        const subjectEl = document.querySelector('h2.hP, .bog');
                        const subject = subjectEl?.innerText || subjectEl?.textContent || '';

                        let parsed = parseHeygenEmail(bodyText, senderEmail);
                        parsed.subject = subject;

                        // 优先用 DOM 链接
                        if (allLinks.length > 0) {
                            parsed.verifyLink = allLinks[0];
                            parsed.rawLink = allLinks[0];
                        }

                        // 补充：若账号还没识别到，用 email 属性中提取的收件人
                        if (!parsed.account && recipientFromAttr) {
                            parsed.account = recipientFromAttr;
                        }

                        resolve(parsed);
                    } else {
                        resolve(null);
                    }
                }
            }, 300);
        });
    }

    // ─── 邮件处理队列（逐条处理，避免并发点击冲突）───────────────
    async function _drainQueue() {
        if (_isProcessing) return;
        _isProcessing = true;
        while (_emailQueue.length > 0) {
            const row = _emailQueue.shift();
            // 跳过已脱离 DOM 的失效元素（history.back 后 Gmail 可能重建行元素）
            if (!document.contains(row)) {
                log('行元素已脱离 DOM，跳过，重新扫描');
                setTimeout(scanInboxForHeygen, 200);
                continue;
            }
            await _processRowInternal(row);
            // 每封邮件处理完毕后短暂等待，让 Gmail UI 恢复
            await new Promise(r => setTimeout(r, 600));
        }
        _isProcessing = false;
        // drain 期间若有新条目被加入，立即继续处理
        if (_emailQueue.length > 0) _drainQueue();
    }

    function enqueueHeygenRow(row) {
        if (_processedRows.has(row)) return; // 已处理过该 DOM 元素
        _processedRows.add(row);
        // 稳定 ID 兜底去重
        const emailId = getEmailId(row);
        if (emailId) {
            if (processedEmails.has(emailId)) return;
            processedEmails.add(emailId);
        }
        _emailQueue.push(row);
        _drainQueue();
    }

    async function _processRowInternal(row) {
        const emailId = getEmailId(row) || `row_${Date.now()}`;
        log('处理 HeyGen 邮件...', emailId);
        try {
            const data = await clickAndReadEmail(row);

            if (data && (data.verifyLink || data.account)) {
                log('成功提取数据', data);
                const item = { id: emailId, ...data, capturedAt: new Date().toISOString() };
                chrome.storage.local.get(['heygenData'], (res) => {
                    const existing = pruneOldData(res.heygenData); // 先清除超时记录
                    existing.unshift(item);
                    chrome.storage.local.set({ heygenData: existing.slice(0, 500) });
                });
                chrome.runtime.sendMessage({ type: 'NEW_HEYGEN_DATA', data: item }).catch(() => { });
                showNotification(data);
            }

            // 读完后返回收件箱，再等 Gmail 渲染完毕
            await new Promise(r => setTimeout(r, 400));
            history.back();
            await new Promise(r => setTimeout(r, 1200));
        } catch (err) {
            log('处理邮件出错', err);
            try { history.back(); } catch (_) { }
            await new Promise(r => setTimeout(r, 1000));
        }
    }

    // 保留兼容旧调用（实际内部已改用队列）
    function processHeygenRow(row) { enqueueHeygenRow(row); }

    // ─── 通知 ────────────────────────────────────────────────────
    function showNotification(data) {
        const toast = document.createElement('div');
        toast.style.cssText = `
      position: fixed;
      top: 20px;
      right: 480px;
      z-index: 99999;
      background: linear-gradient(135deg, #0f172a, #1e293b);
      border: 1px solid #22d3ee;
      border-radius: 12px;
      padding: 16px 20px;
      color: #f0f9ff;
      font-family: 'SF Pro Display', -apple-system, sans-serif;
      font-size: 13px;
      max-width: 360px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.5), 0 0 30px rgba(34,211,238,0.15);
      animation: slideIn 0.3s ease;
    `;

        const style = document.createElement('style');
        style.textContent = `
      @keyframes slideIn {
        from { transform: translateX(120%); opacity: 0; }
        to { transform: translateX(0); opacity: 1; }
      }
      @keyframes slideOut {
        from { transform: translateX(0); opacity: 1; }
        to { transform: translateX(120%); opacity: 0; }
      }
    `;
        document.head.appendChild(style);

        toast.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">
        <div style="width:8px;height:8px;border-radius:50%;background:#22d3ee;box-shadow:0 0 8px #22d3ee;"></div>
        <strong style="color:#22d3ee;letter-spacing:0.5px;">HeyGen 验证链接已捕获</strong>
      </div>
      <div style="color:#94a3b8;margin-bottom:6px;">账号：<span style="color:#e2e8f0">${data.account || '未识别'}</span></div>
      <div style="color:#94a3b8;font-size:11px;word-break:break-all;">
        ${data.verifyLink ? data.verifyLink.substring(0, 60) + '...' : '链接提取中'}
      </div>
    `;

        document.body.appendChild(toast);

        setTimeout(() => {
            toast.style.animation = 'slideOut 0.3s ease forwards';
            setTimeout(() => toast.remove(), 300);
        }, 4000);
    }

    // ─── 扫描收件箱列表 ──────────────────────────────────────────
    // 只扫描未读行（tr.zA），避免刷新后把所有已读邮件重新抓一遍
    function scanInboxForHeygen() {
        const rowSelectors = [
            'tr.zA',                       // Gmail 未读行（优先）
            'div[data-legacy-message-id]', // 其他视图兜底
            'div[jscontroller][data-message-id]',
            'li[data-item-id]',
        ];

        let rows = [];
        for (const sel of rowSelectors) {
            const found = document.querySelectorAll(sel);
            if (found.length > 0) {
                rows = Array.from(found);
                break;
            }
        }

        rows.forEach(row => {
            if (isHeygenEmailRow(row)) {
                enqueueHeygenRow(row);
            }
        });
    }

    // ─── MutationObserver 监听新邮件 ─────────────────────────────
    function startObserver() {
        if (observer) observer.disconnect();

        observer = new MutationObserver((mutations) => {
            let shouldScan = false;

            mutations.forEach(mutation => {
                // ① class 属性变化：Gmail 收到新邮件时，会将行 class 变为 tr.zA（未读）
                if (mutation.type === 'attributes' && mutation.attributeName === 'class') {
                    const node = mutation.target;
                    if (node.matches?.('tr.zA') && isHeygenEmailRow(node)) {
                        enqueueHeygenRow(node);
                        shouldScan = true;
                    }
                    return;
                }

                // ② 子节点新增
                mutation.addedNodes.forEach(node => {
                    if (node.nodeType !== Node.ELEMENT_NODE || !node.matches) return;

                    if (node.matches('tr.zA, tr.zE, div[data-legacy-message-id]')) {
                        // 直接是邮件行
                        if (isHeygenEmailRow(node)) enqueueHeygenRow(node);
                        shouldScan = true;
                    } else {
                        // 容器节点：找出其中的邮件行逐条入队（避免 enqueue 了容器导致 click 无效）
                        const innerRows = node.querySelectorAll('tr.zA, tr.zE, div[data-legacy-message-id]');
                        if (innerRows.length > 0) {
                            innerRows.forEach(r => { if (isHeygenEmailRow(r)) enqueueHeygenRow(r); });
                            shouldScan = true;
                        }
                    }
                });
            });

            if (shouldScan) {
                setTimeout(scanInboxForHeygen, 500);
            }
        });

        const target = document.querySelector('[role="main"]') || document.body;
        observer.observe(target, {
            childList: true,
            subtree: true,
            attributes: true,          // 监听属性变化
            attributeFilter: ['class'] // 只关注 class（性能优化）
        });

        log('MutationObserver 已启动');
    }

    // ─── 主启动逻辑 ──────────────────────────────────────────────
    function startMonitoring() {
        if (isMonitoring) return;
        isMonitoring = true;

        log('开始监控 Gmail...');

        // 先从已存储的抓取记录恢复"已处理 ID"集合，再扫描
        // 这样刷新页面后不会重复打开已经捕获过的邮件
        chrome.storage.local.get(['heygenData'], res => {
            const saved = pruneOldData(res.heygenData); // 清除超时记录
            // 如有数据被清理，回写 storage
            if (saved.length !== (res.heygenData || []).length) {
                chrome.storage.local.set({ heygenData: saved });
            }
            saved.forEach(item => { if (item.id) processedEmails.add(item.id); });
            log(`已从存储加载 ${processedEmails.size} 条已处理记录`);
            scanInboxForHeygen(); // 初始扫描在记录加载后执行
        });

        startObserver();

        checkInterval = setInterval(scanInboxForHeygen, 5000);

        let lastUrl = location.href;
        new MutationObserver(() => {
            if (location.href !== lastUrl) {
                lastUrl = location.href;
                setTimeout(() => {
                    scanInboxForHeygen();
                    startObserver();
                }, 1500);
            }
        }).observe(document, { subtree: true, childList: true });
    }

    function stopMonitoring() {
        isMonitoring = false;
        if (observer) { observer.disconnect(); observer = null; }
        if (checkInterval) { clearInterval(checkInterval); checkInterval = null; }
        log('监控已停止');
    }

    // ─── 接收来自 popup 的消息 ────────────────────────────────────
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.type === 'START_MONITORING') {
            startMonitoring();
            sendResponse({ success: true, status: 'monitoring' });
        } else if (message.type === 'STOP_MONITORING') {
            stopMonitoring();
            sendResponse({ success: true, status: 'stopped' });
        } else if (message.type === 'GET_STATUS') {
            sendResponse({ isMonitoring, processedCount: processedEmails.size });
        } else if (message.type === 'MANUAL_SCAN') {
            scanInboxForHeygen();
            sendResponse({ success: true });
        }
        return true;
    });

    // ─── Sidebar UI (注入到 Gmail 页面右侧) ──────────────────────
    let _sidebarRows = [];      // 用户粘贴的数据（email + number）
    let _allCapturedData = []; // 从 storage 加载的全部已抓取链接
    let _linksMap = {};
    let _sidebarShadow = null;

    function _updateLinksMap(data) {
        _linksMap = {};
        (data || []).forEach(item => {
            if (item.account && item.verifyLink) {
                _linksMap[item.account.toLowerCase()] = item.verifyLink;
            }
        });
    }

    function _parsePasteData(text) {
        return text.split('\n')
            .map(line => line.trim())
            .filter(Boolean)
            .map(line => {
                const parts = line.split('\t');
                const email = (parts[0] || '').trim();
                const number = (parts[1] || '').trim();
                return { email, number, verifyLink: _linksMap[email.toLowerCase()] || '' };
            })
            .filter(r => r.email.includes('@'));
    }

    function _makeLinkBtn(url, el) {
        const btn = el.querySelector('.s-btn');
        if (!btn) return;
        btn.addEventListener('dragstart', e => {
            e.dataTransfer.setData('text/uri-list', url);
            e.dataTransfer.setData('text/plain', url);
            e.dataTransfer.effectAllowed = 'copyLink';
        });
        btn.addEventListener('click', () => {
            chrome.runtime.sendMessage({ type: 'OPEN_TAB', url });
        });
    }

    function _renderSidebarRows() {
        if (!_sidebarShadow) return;
        const tbody = _sidebarShadow.getElementById('s-tbody');
        const head = _sidebarShadow.getElementById('t-head');
        const countEl = _sidebarShadow.getElementById('s-count');
        if (!tbody) return;

        tbody.innerHTML = '';

        // ── 模式 A：没有粘贴数据 → 显示近10分钟自动抓取的链接（2列）
        if (_sidebarRows.length === 0) {
            const TEN_MIN = 10 * 60 * 1000;
            const recent = _allCapturedData.filter(item =>
                Date.now() - new Date(item.capturedAt || 0).getTime() <= TEN_MIN
            );

            if (head) {
                head.style.gridTemplateColumns = 'minmax(0,1fr) 170px';
                head.innerHTML = '<div>邮箱</div><div>验证链接</div>';
            }

            if (recent.length === 0) {
                tbody.innerHTML = '<div class="s-empty">正在监控 HeyGen 验证邮件…<br>链接将自动出现在这里</div>';
                if (countEl) countEl.style.display = 'none';
                return;
            }

            recent.forEach(item => {
                const rowEl = document.createElement('div');
                rowEl.className = item.verifyLink ? 's-row s-row-ok' : 's-row';
                rowEl.style.gridTemplateColumns = 'minmax(0,1fr) 170px';
                rowEl.innerHTML = `
          <div class="s-email" title="${item.account || ''}">${item.account || '（未识别）'}</div>
          <div class="s-link">${item.verifyLink
                        ? `<span class="s-btn" draggable="true" data-url="${item.verifyLink}">HeyGen Email</span>`
                        : '<span class="s-pending">等待中…</span>'
                    }</div>
        `;
                if (item.verifyLink) _makeLinkBtn(item.verifyLink, rowEl);
                tbody.appendChild(rowEl);
            });

            if (countEl) {
                countEl.textContent = `近10分钟 · 共 ${recent.length} 条`;
                countEl.style.display = 'block';
            }
            return;
        }

        // ── 模式 B：有粘贴数据 → 3列（邮箱 | 编号 | 验证链接）
        if (head) {
            head.style.gridTemplateColumns = 'minmax(0,1fr) 64px 160px';
            head.innerHTML = '<div>邮箱</div><div>编号</div><div>验证链接</div>';
        }

        _sidebarRows.forEach(row => {
            const rowEl = document.createElement('div');
            rowEl.className = row.verifyLink ? 's-row s-row-ok' : 's-row';
            rowEl.style.gridTemplateColumns = 'minmax(0,1fr) 64px 160px';

            rowEl.innerHTML = `
        <div class="s-email" title="${row.email}">${row.email}</div>
        <div class="s-num">${row.number}</div>
        <div class="s-link">${row.verifyLink
                    ? `<span class="s-btn" draggable="true" data-url="${row.verifyLink}">HeyGen Email</span>`
                    : '<span class="s-pending">等待中…</span>'
                }</div>
      `;

            if (row.verifyLink) _makeLinkBtn(row.verifyLink, rowEl);
            tbody.appendChild(rowEl);
        });

        if (countEl) {
            const linked = _sidebarRows.filter(r => r.verifyLink).length;
            countEl.textContent = `共 ${_sidebarRows.length} 行 · 已匹配 ${linked} 个链接`;
            countEl.style.display = 'block';
        }
    }

    function initSidebar() {
        if (document.getElementById('hgc-host')) return;

        const host = document.createElement('div');
        host.id = 'hgc-host';
        _sidebarShadow = host.attachShadow({ mode: 'open' });

        _sidebarShadow.innerHTML = `<style>
*{margin:0;padding:0;box-sizing:border-box}
#wrap{position:fixed;top:0;right:0;width:560px;height:100vh;background:#ffffff;border-left:1px solid #dadce0;display:flex;flex-direction:column;z-index:2147483646;box-shadow:-2px 0 12px rgba(0,0,0,.12);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#202124;transition:transform .3s cubic-bezier(.4,0,.2,1)}
#wrap.off{transform:translateX(560px)}
#hd{padding:12px 16px;background:#f8f9fa;border-bottom:1px solid #e8eaed;display:flex;align-items:center;justify-content:space-between;flex-shrink:0}
.hd-left{display:flex;align-items:center;gap:8px;font-size:15px;font-weight:700;letter-spacing:.2px;color:#1a73e8}
.hd-ver{font-size:11px;font-weight:400;color:#80868b;margin-left:4px;letter-spacing:0;align-self:center}
.dot{width:8px;height:8px;border-radius:50%;background:#34a853;box-shadow:0 0 5px rgba(52,168,83,.5);animation:p 2s infinite}
@keyframes p{0%,100%{opacity:1}50%{opacity:.4}}
#s-toggle{position:fixed;top:50%;right:0;transform:translateY(-50%);background:#1a73e8;border:none;border-radius:12px 0 0 12px;width:38px;padding:26px 0;cursor:pointer;z-index:2147483647;display:flex;align-items:center;justify-content:center;color:#fff;font-size:22px;font-weight:300;line-height:1;box-shadow:-3px 0 12px rgba(26,115,232,.35);transition:background .15s,width .15s;user-select:none}
#s-toggle:hover{background:#1557b0;width:42px}
#paste-area{padding:12px 16px;border-bottom:1px solid #e8eaed;flex-shrink:0;background:#fff}
.lbl{font-size:12px;font-weight:600;letter-spacing:.5px;text-transform:uppercase;color:#9aa0a6;margin-bottom:8px}
#s-input{width:100%;height:150px;background:#f8f9fa;border:1px solid #dadce0;border-radius:8px;padding:8px 12px;color:#202124;font-family:'JetBrains Mono','Consolas',monospace;font-size:14px;line-height:1.6;resize:none;outline:none;transition:border-color .2s}
#s-input:focus{border-color:#1a73e8;background:#fff;box-shadow:0 0 0 2px rgba(26,115,232,.15)}
#s-input::placeholder{color:#bdc1c6}
.pa{display:flex;align-items:center;gap:8px;margin-top:8px}
#btn-clear{padding:5px 12px;border-radius:6px;border:1px solid #dadce0;background:#fff;color:#5f6368;font-size:13px;font-weight:500;cursor:pointer;transition:all .15s;flex-shrink:0}
#btn-clear:hover{border-color:#ea4335;color:#ea4335;background:#fff8f7}
.hint{font-size:12px;color:#9aa0a6}
#tbl-wrap{flex:1;display:flex;flex-direction:column;overflow:hidden;min-height:0}
#t-head{display:grid;grid-template-columns:minmax(0,1fr) 64px 160px;padding:8px 16px;background:#f8f9fa;border-bottom:1px solid #e8eaed;font-size:12px;font-weight:600;letter-spacing:.5px;text-transform:uppercase;color:#9aa0a6;flex-shrink:0}
#s-tbody{flex:1;overflow-y:auto}
#s-tbody::-webkit-scrollbar{width:4px}
#s-tbody::-webkit-scrollbar-track{background:transparent}
#s-tbody::-webkit-scrollbar-thumb{background:#dadce0;border-radius:2px}
.s-empty{padding:32px 18px;text-align:center;color:#9aa0a6;font-size:14px;line-height:1.7}
.s-row{height:60px;display:grid;grid-template-columns:minmax(0,1fr) 64px 160px;padding:9px 16px;border-bottom:1px solid #f1f3f4;align-items:center;transition:background .15s}
.s-row:hover{background:#f8f9fa}
.s-row.s-row-ok{border-left:3px solid #1a73e8;padding-left:13px}
.s-email{font-size:14px;color:#3c4043;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding-right:8px;font-family:'JetBrains Mono','Consolas',monospace}
.s-num{font-size:14px;color:#5f6368;font-family:'JetBrains Mono','Consolas',monospace;padding-right:6px}
.s-link{display:flex;align-items:center}
.s-btn{display:inline-flex;align-items:center;gap:4px;padding:13px 11px;background:#1a73e8;color:#fff;font-size:13px;font-weight:600;border-radius:6px;cursor:grab;white-space:nowrap;box-shadow:0 1px 4px rgba(26,115,232,.35);transition:all .15s;user-select:none;letter-spacing:.2px;border:none;outline:none}
.s-btn:hover{background:#1557b0;box-shadow:0 2px 8px rgba(26,115,232,.45);transform:translateY(-1px)}
.s-btn:active{cursor:grabbing;transform:none}
.s-pending{font-size:13px;color:#bdc1c6}
#s-count{padding:6px 16px;border-top:1px solid #e8eaed;font-size:12px;color:#9aa0a6;flex-shrink:0;background:#f8f9fa;display:none}
</style>
<div id="s-toggle" title="展开 / 收起">‹</div>
<div id="wrap">
  <div id="hd">
    <div class="hd-left"><div class="dot"></div>HeyGen Gmail Collector<span class="hd-ver">v1.0.8</span></div>
  </div>
  <div id="paste-area">
    <div class="lbl">粘贴账号数据</div>
    <textarea id="s-input" placeholder="从 Excel/表格粘贴&#10;格式：邮箱[Tab]编号（每行一条）"></textarea>
    <div class="pa">
      <button id="btn-clear">清空</button>
      <span class="hint">Tab 分隔两列数据，粘贴后自动解析</span>
    </div>
  </div>
  <div id="tbl-wrap">
    <div id="t-head"><div>邮箱</div><div>编号</div><div>验证链接</div></div>
    <div id="s-tbody"><div class="s-empty">粘贴账号数据后<br>系统自动匹配验证链接</div></div>
    <div id="s-count"></div>
  </div>
</div>`;

        document.documentElement.appendChild(host);

        const wrap = _sidebarShadow.getElementById('wrap');
        const toggleBtn = _sidebarShadow.getElementById('s-toggle');
        const sInput = _sidebarShadow.getElementById('s-input');
        const btnClear = _sidebarShadow.getElementById('btn-clear');

        toggleBtn.addEventListener('click', () => {
            const isOff = wrap.classList.toggle('off');
            toggleBtn.textContent = isOff ? '›' : '‹';
            toggleBtn.title = isOff ? '展开面板' : '收起面板';
        });

        const doParse = () => {
            const text = sInput.value;
            if (!text.trim()) return;
            _sidebarRows = _parsePasteData(text);
            // 持久化粘贴内容及时间戳，刷新页面后自动恢复（1小时内有效）
            chrome.storage.local.set({ pasteText: text, pasteTime: Date.now() });
            _renderSidebarRows();
        };

        // 清空按钮：清除输入、解析结果及存储
        btnClear.addEventListener('click', () => {
            sInput.value = '';
            _sidebarRows = [];
            chrome.storage.local.remove(['pasteText', 'pasteTime']);
            _renderSidebarRows();
        });

        sInput.addEventListener('paste', () => setTimeout(doParse, 30));
        sInput.addEventListener('input', () => { if (!sInput.value.trim()) { _sidebarRows = []; _renderSidebarRows(); } });

        // 初始加载：已捕获链接 + 上次粘贴的数据（同时恢复，一次渲染）
        chrome.storage.local.get(['heygenData', 'pasteText', 'pasteTime'], result => {
            _allCapturedData = pruneOldData(result.heygenData);
            _updateLinksMap(_allCapturedData);
            // 恢复粘贴数据：超过1小时则不恢复（当次不清空，但下次打开不恢复）
            const pasteAge = Date.now() - (result.pasteTime || 0);
            if (result.pasteText && pasteAge <= 60 * 60 * 1000) {
                sInput.value = result.pasteText;
                _sidebarRows = _parsePasteData(result.pasteText);
            }
            _renderSidebarRows();
        });

        // 监听新捕获的链接，实时更新（两种模式均刷新）
        chrome.storage.onChanged.addListener(changes => {
            if (changes.heygenData) {
                _allCapturedData = changes.heygenData.newValue || [];
                _updateLinksMap(_allCapturedData);
                if (_sidebarRows.length) {
                    _sidebarRows = _sidebarRows.map(r => ({
                        ...r,
                        verifyLink: _linksMap[r.email.toLowerCase()] || r.verifyLink
                    }));
                }
                _renderSidebarRows();
            }
        });

        log('Sidebar 已初始化');
    }

    // ─── 自动启动 ────────────────────────────────────────────────
    chrome.storage.local.get(['autoStart'], (result) => {
        if (result.autoStart !== false) {
            if (document.readyState === 'complete') {
                setTimeout(startMonitoring, 2000);
            } else {
                window.addEventListener('load', () => setTimeout(startMonitoring, 2000));
            }
        }
    });

    // 初始化 Sidebar（始终显示）
    if (document.readyState === 'complete') {
        setTimeout(initSidebar, 1500);
    } else {
        window.addEventListener('load', () => setTimeout(initSidebar, 1500));
    }

    log('Content script 已加载');
})();
