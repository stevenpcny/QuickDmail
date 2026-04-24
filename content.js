// HeyGen Gmail Collector - Content Script
// 监听 Gmail 页面，自动检测并收集 HeyGen 验证邮件

(function () {
    'use strict';

    let isMonitoring = false;
    let processedEmails = new Set();
    let _processedRows = new WeakSet(); // track DOM elements directly (no ID needed)
    let observer = null;
    let urlObserver = null;
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
        if (!isMonitoring) return;
        if (!_isScopeAllowed()) return;
        const { link, account, receivedTs, gmailThreadId } = event.data;
        if (!link || !link.includes('auth.heygen.com/magic-web/')) return;
        _saveXhrCapturedLink(link, account || '', receivedTs || 0, gmailThreadId || '');
    });

    // ─── 账号去重更新：同邮箱合并，保留最新时间 + count ─────────────
    // heygenAccounts: [{ email, lastSeen, firstSeen, count, latestLink }]
    function _upsertAccount(email, link, receivedTs) {
        if (!email || !email.includes('@')) return;
        // 仅当包含 magic-web 验证链接时才计入账号表 / 计数
        if (!link || !link.includes('auth.heygen.com/magic-web/')) return;
        const normalized = email.trim().toLowerCase();
        // 优先用邮件真实收件时间，缺省才退回当前时间
        const ts = (receivedTs && receivedTs > 0) ? receivedTs : Date.now();
        chrome.storage.local.get(['heygenAccounts'], (res) => {
            const list = res.heygenAccounts || [];
            const idx = list.findIndex(a => (a.email || '').toLowerCase() === normalized);
            if (idx >= 0) {
                const old = list[idx];
                list[idx] = {
                    ...old,
                    email: old.email || email.trim(),
                    lastSeen: Math.max(old.lastSeen || 0, ts),
                    firstSeen: Math.min(old.firstSeen || ts, ts),
                    count: (old.count || 1) + 1,
                    latestLink: link || old.latestLink || ''
                };
            } else {
                list.push({
                    email: email.trim(),
                    lastSeen: ts,
                    firstSeen: ts,
                    count: 1,
                    latestLink: link || ''
                });
            }
            chrome.storage.local.set({ heygenAccounts: list });
        });
    }

    // 保存 XHR 拦截到的链接（去重 + 写 storage + 刷新侧边栏）
    function _saveXhrCapturedLink(link, account, receivedTs, gmailThreadId) {
        // 以链接路径部分做稳定 ID，避免不同 session 重复
        const emailId = 'xhr_' + link.replace(/^https?:\/\/[^/]+/, '').replace(/[^A-Za-z0-9]/g, '').substring(0, 64);
        if (processedEmails.has(emailId)) return;
        processedEmails.add(emailId);

        log('XHR 拦截到验证链接', { account, link, receivedTs, gmailThreadId });

        const item = {
            id: emailId, account, verifyLink: link,
            receivedAt: (receivedTs && receivedTs > 0) ? new Date(receivedTs).toISOString() : '',
            capturedAt: new Date().toISOString(),
            gmailThreadId: gmailThreadId || ''
        };
        chrome.storage.local.get(['heygenData'], (res) => {
            const existing = res.heygenData || [];
            // 精确去重：同一 link 不重复存储
            if (existing.some(e => e.verifyLink === link)) return;
            existing.unshift(item);
            chrome.storage.local.set({ heygenData: existing.slice(0, 500) });
        });
        _upsertAccount(account, link, receivedTs);
        chrome.runtime.sendMessage({ type: 'NEW_HEYGEN_DATA', data: item }).catch(() => { });
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

        // 只匹配有效的激活链接
        const linkPatterns = [
            /https:\/\/auth\.heygen\.com\/magic-web\/[^\s"'<>\\]+/g,
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
                            const checkUrl = (url) => {
                                if (!url) return null;
                                if (url.includes('auth.heygen.com/magic-web/')) return url;
                                // Google 重定向包装：google.com/url?q=REAL_URL
                                if (url.includes('google.com/url')) {
                                    try {
                                        const q = new URL(url).searchParams.get('q') || '';
                                        if (q.includes('auth.heygen.com/magic-web/')) return q;
                                    } catch (_) {}
                                }
                                return null;
                            };
                            return checkUrl(a.href)
                                || checkUrl(a.getAttribute('href'))
                                || checkUrl((() => { try { return new URL(a.getAttribute('data-saferedirecturl') || '').searchParams.get('q'); } catch(_){} return ''; })())
                                || null;
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
            if (!isMonitoring && !_fullScanActive) { _emailQueue = []; break; }
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

    function _isTrashView() {
        const h = (location.hash || '').toLowerCase();
        return h.includes('#trash') || h.includes('in%3atrash') || h.includes('in:trash');
    }

    // 监控范围配置（popup 设置页写入 storage.monitorScope）
    let _monitorScope = { mode: 'any', labels: [] };
    chrome.storage.local.get(['monitorScope'], r => {
        if (r.monitorScope) _monitorScope = r.monitorScope;
    });
    chrome.storage.onChanged.addListener(changes => {
        if (changes.monitorScope) _monitorScope = changes.monitorScope.newValue || { mode: 'any', labels: [] };
    });

    function _isScopeAllowed() {
        // 全量扫描时绕过 scope 限制（由用户主动触发）
        if (_fullScanActive) return true;
        if (_isTrashView()) return false;
        const mode = _monitorScope.mode || 'any';
        if (mode === 'any') return true;

        // Gmail URL hash 格式多样：#inbox、#label/xxx、#search/label%3Axxx 等
        // 用原始 hash + 解码后双重匹配，兼容空格、大小写、URL 编码
        const rawHash = (location.hash || '').toLowerCase();
        const decodedHash = decodeURIComponent(rawHash);

        if (mode === 'inbox') {
            return rawHash.startsWith('#inbox') || rawHash === '' || rawHash === '#';
        }
        if (mode === 'custom') {
            const labels = (_monitorScope.labels || []).map(s => s.toLowerCase().trim());
            if (labels.length === 0) return false;
            return labels.some(label => {
                const enc = encodeURIComponent(label).toLowerCase();
                // #label/magic-link  或  #label/magic%20link
                if (decodedHash.includes('#label/' + label)) return true;
                if (rawHash.includes('#label/' + enc)) return true;
                if (rawHash.includes('#label/' + label.replace(/\s+/g, '-'))) return true;
                if (rawHash.includes('#label/' + label.replace(/\s+/g, ''))) return true;
                // search URL 也能包含 label 名
                if (decodedHash.includes('label:' + label)) return true;
                return false;
            });
        }
        return true;
    }

    function enqueueHeygenRow(row) {
        if (!isMonitoring && !_fullScanActive) return;
        if (!_isScopeAllowed()) return;
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

    // 从邮件行读取真实的收件时间（Gmail 的 td.xW span[title] 含完整日期）
    function _extractRowReceivedTime(row) {
        try {
            const cands = row.querySelectorAll('td.xW span[title], .xW span[title], [title]');
            for (const el of cands) {
                const t = el.getAttribute('title');
                if (!t) continue;
                const ts = new Date(t).getTime();
                if (!isNaN(ts) && ts > 0 && ts < Date.now() + 86400000) return ts;
            }
        } catch (_) {}
        return 0;
    }

    async function _processRowInternal(row) {
        const emailId = getEmailId(row) || `row_${Date.now()}`;
        log('处理 HeyGen 邮件...', emailId);
        // 先从列表行读取收件时间（点击后行会脱离 DOM）
        const receivedAt = _extractRowReceivedTime(row);
        try {
            const data = await clickAndReadEmail(row);

            if (data && data.verifyLink && data.verifyLink.includes('auth.heygen.com/magic-web/')) {
                log('成功提取数据', data);
                // 点开邮件后从详情页再试一次（更准确的完整时间）
                const detailTs = (() => {
                    try {
                        const el = document.querySelector('.g3[title], .g2[title], span.g3, span[data-tooltip^="20"]');
                        const t = el?.getAttribute('title') || el?.getAttribute('data-tooltip');
                        const ts = t ? new Date(t).getTime() : 0;
                        return (!isNaN(ts) && ts > 0) ? ts : 0;
                    } catch (_) { return 0; }
                })();
                const receivedTime = detailTs || receivedAt || 0;
                const item = {
                    id: emailId,
                    ...data,
                    receivedAt: receivedTime ? new Date(receivedTime).toISOString() : '',
                    capturedAt: new Date().toISOString(),
                    // DOM 路径：emailId 本身就来自 data-legacy-thread-id 等属性，可直接用于 DOM 查找
                    gmailThreadId: emailId
                };
                chrome.storage.local.get(['heygenData'], (res) => {
                    const existing = res.heygenData || [];
                    existing.unshift(item);
                    chrome.storage.local.set({ heygenData: existing.slice(0, 500) });
                });
                _upsertAccount(data.account, data.verifyLink, receivedTime);
                chrome.runtime.sendMessage({ type: 'NEW_HEYGEN_DATA', data: item }).catch(() => { });
            }

            // 读完后短暂等待
            await new Promise(r => setTimeout(r, 400));

            // 若该邮件不含有效 magic-web 链接且用户启用了自动丢垃圾箱 → 直接删除
            const hasLink = !!(data && data.verifyLink);
            const shouldTrash = !hasLink && await _getAutoTrashFlag();
            if (shouldTrash) {
                const trashed = _clickTrashButton();
                if (trashed) {
                    log('已将非验证链接邮件移至垃圾箱');
                    await new Promise(r => setTimeout(r, 1200));
                    return;
                }
            }

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

    // ─── 非验证链接邮件：自动移至垃圾箱 ──────────────────────────
    function _getAutoTrashFlag() {
        return new Promise(resolve => {
            chrome.storage.local.get(['autoTrashNonVerify'], r => resolve(!!r.autoTrashNonVerify));
        });
    }

    function _clickTrashButton() {
        // Gmail 打开邮件详情后，工具栏上的「删除」按钮
        const selectors = [
            'div[aria-label="删除"][role="button"]',
            'div[aria-label="Delete"][role="button"]',
            'div[data-tooltip="删除"]',
            'div[data-tooltip="Delete"]',
            '[aria-label="移至回收站"][role="button"]',
            '[aria-label="Move to trash"][role="button"]',
        ];
        for (const sel of selectors) {
            const btns = document.querySelectorAll(sel);
            for (const btn of btns) {
                const rect = btn.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0 && btn.getAttribute('aria-disabled') !== 'true') {
                    btn.click();
                    return true;
                }
            }
        }
        return false;
    }

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
        if (!isMonitoring && !_fullScanActive) return;
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
            const saved = res.heygenData || [];
            saved.forEach(item => { if (item.id) processedEmails.add(item.id); });
            log(`已从存储加载 ${processedEmails.size} 条已处理记录`);
            scanInboxForHeygen(); // 初始扫描在记录加载后执行
        });

        startObserver();

        checkInterval = setInterval(scanInboxForHeygen, 5000);

        let lastUrl = location.href;
        if (urlObserver) urlObserver.disconnect();
        urlObserver = new MutationObserver(() => {
            if (!isMonitoring) return;
            if (location.href !== lastUrl) {
                lastUrl = location.href;
                setTimeout(() => {
                    if (!isMonitoring) return;
                    scanInboxForHeygen();
                    startObserver();
                }, 1500);
            }
        });
        urlObserver.observe(document, { subtree: true, childList: true });
    }

    function stopMonitoring() {
        isMonitoring = false;
        if (observer) { observer.disconnect(); observer = null; }
        if (urlObserver) { urlObserver.disconnect(); urlObserver = null; }
        if (checkInterval) { clearInterval(checkInterval); checkInterval = null; }
        _emailQueue = [];
        log('监控已停止');
    }

    // ─── 将 Gmail 邮件标记为已读 ──────────────────────────────────
    // 当用户在面板中复制/拖拽/打开链接后，静默把对应 Gmail 邮件设为已读
    // gmailThreadId: data-legacy-thread-id 属性值（来自 DOM 捕获或 XHR 响应解析）
    // account: 收件人邮箱（找不到 threadId 时的兜底匹配依据）
    async function _markGmailEmailRead(gmailThreadId, account) {
        // ── 1. 在当前 Gmail 列表 DOM 里找到对应的邮件行 ───────────
        let row = null;

        if (gmailThreadId) {
            for (const attr of ['data-legacy-thread-id', 'data-thread-id',
                                 'data-legacy-message-id', 'data-message-id']) {
                row = document.querySelector(`[${attr}="${gmailThreadId}"]`);
                if (row) break;
            }
        }

        // 如果 thread ID 找不到行，尝试用收件人邮箱在行的 sender email 属性里匹配
        if (!row && account) {
            const accountLow = account.toLowerCase();
            for (const r of document.querySelectorAll('tr.zA, tr[role="row"]')) {
                if (!isHeygenEmailRow(r)) continue;
                const senderEl = r.querySelector('[email*="heygen"]');
                if (!senderEl) continue;
                const senderAttr = (senderEl.getAttribute('email') || '').toLowerCase();
                // HeyGen sender 属性格式：no_reply_at_email.heygen.com_<recipient>
                // 用完整邮箱匹配，避免前缀相似账号（abc vs abc123）误标
                if (senderAttr.includes(accountLow)) {
                    row = r;
                    break;
                }
            }
        }

        if (!row) {
            log('MARK_GMAIL_READ: 当前视图中找不到对应邮件行，跳过');
            return;
        }

        // ── 2. 检查行是否真的处于未读状态 ───────────────────────
        // Gmail 未读行通常有 class zE 或者其 sender span 有 class yO（加粗）
        const isUnread = row.classList.contains('zE') ||
                         !!row.querySelector('.yO, .bqe');
        if (!isUnread) {
            log('MARK_GMAIL_READ: 邮件已是已读状态');
            return;
        }

        // ── 3. 策略 A：点击行内"标为已读"快捷操作按钮 ──────────
        // Gmail 列表行里有隐藏的快捷操作区，即使 display:none 也可以直接 click
        const readBtnSelectors = [
            '[data-tooltip="标为已读"]',
            '[data-tooltip="Mark as read"]',
            '[aria-label="标为已读"]',
            '[aria-label="Mark as read"]',
            '[data-tooltip="标记为已读"]',
            '[aria-label="标记为已读"]',
        ];
        for (const sel of readBtnSelectors) {
            const btn = row.querySelector(sel);
            if (btn) {
                btn.click();
                log('MARK_GMAIL_READ: 已点击快捷操作「标为已读」');
                return;
            }
        }

        // ── 策略 B：mouseenter 唤出快捷操作后再试 ────────────────
        row.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, cancelable: true }));
        await new Promise(r => setTimeout(r, 180));
        for (const sel of readBtnSelectors) {
            const btn = row.querySelector(sel);
            if (btn) {
                btn.click();
                log('MARK_GMAIL_READ: hover 后点击快捷操作「标为已读」');
                return;
            }
        }

        // ── 策略 C：选中复选框 → 工具栏"更多"→"标为已读" ────────
        const checkbox = row.querySelector('input[type="checkbox"], [role="checkbox"]');
        if (checkbox) {
            checkbox.click(); // 选中
            await new Promise(r => setTimeout(r, 200));

            // 工具栏里的「标为已读」按钮（Gmail 工具栏全局选择器）
            const toolbarSelectors = [
                '[data-tooltip="标为已读"]',
                '[data-tooltip="Mark as read"]',
                '[aria-label="标为已读"]',
                '[aria-label="Mark as read"]',
                '[data-tooltip*="已读"]',
            ];
            let clicked = false;
            for (const sel of toolbarSelectors) {
                const btn = document.querySelector(sel);
                if (btn) { btn.click(); clicked = true; break; }
            }
            if (clicked) {
                log('MARK_GMAIL_READ: 工具栏点击标为已读');
                return;
            }
            // 未找到工具栏按钮时取消选中，避免误操作
            setTimeout(() => checkbox.click(), 200);
        }

        log('MARK_GMAIL_READ: 所有策略均未能找到标为已读按钮（Gmail 版本不兼容）');
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
        } else if (message.type === 'FULL_SCAN_SIMPLE') {
            startFullScanSimple();
            sendResponse({ success: true });
        } else if (message.type === 'STOP_FULL_SCAN') {
            stopFullScan();
            sendResponse({ success: true });
        } else if (message.type === 'RESET_AND_SCAN') {
            // 清空内存中的已处理集合，确保重新扫描能重新处理所有邮件
            processedEmails.clear();
            _processedRows = new WeakSet();
            _emailQueue = [];
            _isProcessing = false;
            scanInboxForHeygen();
            sendResponse({ success: true });
        } else if (message.type === 'MARK_GMAIL_READ') {
            // 用户在面板里复制/拖拽/打开了链接，静默标记对应 Gmail 邮件为已读
            _markGmailEmailRead(message.gmailThreadId || '', message.account || '');
            sendResponse({ success: true });
        }
        return true;
    });

    // ─── 浮窗 UI：可拖拽 iframe，嵌入完整 popup.html ─────────────
    function initSidebar() {
        if (document.getElementById('hgc-float-host')) return;

        const POPUP_URL = chrome.runtime.getURL('popup.html') + '?float=1';
        const DEFAULT_W = 760, DEFAULT_H = 700;

        // 读取上次位置
        chrome.storage.local.get(['floatPos'], (r) => {
            const pos = r.floatPos || {};
            const initRight = pos.right !== undefined ? pos.right : 16;
            const initTop   = pos.top  !== undefined ? pos.top  : 80;
            const initW     = pos.w    || DEFAULT_W;
            const initH     = pos.h    || DEFAULT_H;
            const hidden    = !!pos.hidden;

            const host = document.createElement('div');
            host.id = 'hgc-float-host';
            const shadow = host.attachShadow({ mode: 'open' });

            shadow.innerHTML = `<style>
*{margin:0;padding:0;box-sizing:border-box}
#fab{
  position:fixed;
  bottom:80px;right:0;
  width:36px;height:88px;
  background:#1a73e8;
  border-radius:12px 0 0 12px;
  cursor:pointer;
  z-index:2147483645;
  display:flex;align-items:center;justify-content:center;
  writing-mode:vertical-rl;
  color:#fff;font-size:11px;font-weight:700;letter-spacing:1.5px;
  box-shadow:-3px 0 12px rgba(26,115,232,.45);
  transition:width .15s,background .15s;
  user-select:none;
}
#fab:hover{background:#1557b0;width:42px}
#panel{
  position:fixed;
  z-index:2147483646;
  border-radius:12px;
  overflow:hidden;
  box-shadow:0 8px 40px rgba(0,0,0,.45),0 0 0 1px rgba(255,255,255,.06);
  display:flex;flex-direction:column;
  resize:both;
  min-width:400px;min-height:300px;
}
#drag-bar{
  height:28px;
  background:#0a0f1a;
  display:flex;align-items:center;justify-content:space-between;
  padding:0 10px;
  cursor:grab;
  flex-shrink:0;
  user-select:none;
  border-bottom:1px solid rgba(255,255,255,.08);
}
#drag-bar:active{cursor:grabbing}
.drag-title{font-size:11px;color:rgba(255,255,255,.4);font-family:monospace;letter-spacing:.5px}
.drag-btns{display:flex;gap:6px}
.drag-btn{width:12px;height:12px;border-radius:50%;border:none;cursor:pointer;flex-shrink:0}
#btn-hide{background:#f59e0b}
#btn-close{background:#ef4444}
#panel iframe{
  flex:1;
  border:none;
  width:100%;
  display:block;
  background:#0d1117;
}
</style>
<div id="fab" title="展开 HeyGen Collector 浮窗">HGC</div>
<div id="panel">
  <div id="drag-bar">
    <span class="drag-title">HeyGen Collector · 拖动移动 / 右下角调整大小</span>
    <div class="drag-btns">
      <button class="drag-btn" id="btn-hide" title="最小化"></button>
      <button class="drag-btn" id="btn-close" title="关闭浮窗"></button>
    </div>
  </div>
  <iframe src="${POPUP_URL}" allow="clipboard-read; clipboard-write"></iframe>
</div>`;

            document.documentElement.appendChild(host);

            const panel = shadow.getElementById('panel');
            const fab   = shadow.getElementById('fab');

            // 初始位置尺寸
            const applyPos = () => {
                const vw = window.innerWidth, vh = window.innerHeight;
                const w = Math.min(initW, vw - 32), h = Math.min(initH, vh - 32);
                panel.style.width  = w + 'px';
                panel.style.height = h + 'px';
                const left = Math.max(0, vw - initRight - w);
                panel.style.left = left + 'px';
                panel.style.top  = Math.max(0, Math.min(initTop, vh - h)) + 'px';
            };
            applyPos();

            if (hidden) {
                panel.style.display = 'none';
                fab.style.display = 'flex';
            } else {
                panel.style.display = 'flex';
                fab.style.display = 'none';
            }

            // 保存位置
            const savePos = () => {
                const left = parseFloat(panel.style.left) || 0;
                const w    = panel.offsetWidth, h = panel.offsetHeight;
                chrome.storage.local.set({ floatPos: {
                    right: window.innerWidth - left - w,
                    top:   parseFloat(panel.style.top) || 0,
                    w, h,
                    hidden: panel.style.display === 'none'
                }});
            };

            // 拖拽移动
            const dragBar = shadow.getElementById('drag-bar');
            let dragging = false, dx = 0, dy = 0;
            dragBar.addEventListener('mousedown', e => {
                if (e.target.classList.contains('drag-btn')) return;
                dragging = true;
                dx = e.clientX - panel.getBoundingClientRect().left;
                dy = e.clientY - panel.getBoundingClientRect().top;
                document.addEventListener('mousemove', onMove);
                document.addEventListener('mouseup', onUp);
            });
            const onMove = e => {
                if (!dragging) return;
                panel.style.left = Math.max(0, Math.min(e.clientX - dx, window.innerWidth  - panel.offsetWidth))  + 'px';
                panel.style.top  = Math.max(0, Math.min(e.clientY - dy, window.innerHeight - panel.offsetHeight)) + 'px';
            };
            const onUp = () => { dragging = false; savePos(); document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };

            // 最小化 / 还原
            shadow.getElementById('btn-hide').addEventListener('click', () => {
                panel.style.display = 'none';
                fab.style.display = 'flex';
                savePos();
            });
            fab.addEventListener('click', () => {
                panel.style.display = 'flex';
                fab.style.display = 'none';
                savePos();
            });

            // 关闭
            shadow.getElementById('btn-close').addEventListener('click', () => {
                panel.style.display = 'none';
                fab.style.display = 'none';
                savePos();
            });

            // 调整尺寸结束后保存
            const ro = new ResizeObserver(() => savePos());
            ro.observe(panel);

            log('浮窗已初始化');
        });
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

    // ─── 全量扫描（简单模式）────────────────────────────────────
    let _fullScanActive = false;
    let _fullScanCount = 0;

    function _sendScanProgress(text) {
        chrome.runtime.sendMessage({ type: 'SCAN_PROGRESS', text }).catch(() => {});
    }

    function stopFullScan() {
        _fullScanActive = false;
    }

    async function startFullScanSimple() {
        if (_fullScanActive) return;
        _fullScanActive = true;
        _fullScanCount = 0;

        log('全量扫描启动');
        _sendScanProgress('正在跳转到 HeyGen 邮件搜索…');

        // 跳转到 Gmail 搜索 HeyGen 邮件（排除垃圾箱）
        window.location.hash = '#search/from%3A(heygen.com)+-in%3Atrash';
        await _wait(2000);

        let pageNum = 1;

        while (_fullScanActive) {
            _sendScanProgress(`第 ${pageNum} 页：扫描中…（已处理 ${_fullScanCount} 封）`);

            // 等待邮件列表渲染
            await _waitForRows(3000);

            // 收集当前页所有邮件行（已读 + 未读）
            const rows = Array.from(document.querySelectorAll('tr.zA, tr.zE'));
            if (rows.length === 0) break;

            // 过滤 HeyGen 邮件行，入处理队列
            let added = 0;
            for (const row of rows) {
                if (!_processedRows.has(row) && isHeygenEmailRow(row)) {
                    enqueueHeygenRow(row);
                    added++;
                }
            }

            _fullScanCount += added;
            _sendScanProgress(`第 ${pageNum} 页：${added} 封加入队列，等待处理…（累计 ${_fullScanCount} 封）`);

            // 等待队列处理完毕再翻页，避免 history.back 冲突
            await _waitForQueueDrain(60000);

            if (!_fullScanActive) break;

            // 尝试点击"下一页"（older）
            const nextBtn = _findNextPageBtn();
            if (!nextBtn) break;

            nextBtn.click();
            pageNum++;
            await _wait(2000);
        }

        _fullScanActive = false;
        log(`全量扫描完成，共处理 ${_fullScanCount} 封`);
        chrome.runtime.sendMessage({ type: 'SCAN_DONE', count: _fullScanCount }).catch(() => {});

        // 回到收件箱
        window.location.hash = '#inbox';
    }

    function _wait(ms) {
        return new Promise(r => setTimeout(r, ms));
    }

    function _waitForRows(timeout) {
        return new Promise(resolve => {
            const deadline = Date.now() + timeout;
            const check = () => {
                const rows = document.querySelectorAll('tr.zA, tr.zE');
                if (rows.length > 0 || Date.now() > deadline) resolve();
                else setTimeout(check, 300);
            };
            check();
        });
    }

    function _waitForQueueDrain(timeout) {
        return new Promise(resolve => {
            const deadline = Date.now() + timeout;
            const check = () => {
                if ((!_isProcessing && _emailQueue.length === 0) || Date.now() > deadline) resolve();
                else setTimeout(check, 500);
            };
            check();
        });
    }

    function _findNextPageBtn() {
        // Gmail "下一页" 按钮的多种选择器
        const selectors = [
            'div[aria-label="下一页"]',
            'div[aria-label="Older"]',
            'div[aria-label="Next page"]',
            'button[aria-label="下一页"]',
            'button[aria-label="Older"]',
            '[data-tooltip="下一页"]',
            '[data-tooltip="Older"]',
        ];
        for (const sel of selectors) {
            const btn = document.querySelector(sel);
            if (btn && !btn.hasAttribute('disabled') && btn.getAttribute('aria-disabled') !== 'true') {
                return btn;
            }
        }
        return null;
    }

    log('Content script 已加载');
})();
