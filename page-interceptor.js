// HeyGen Gmail Collector — Page Context Interceptor
// 注入到 Gmail 页面主上下文（Main World），拦截 XHR/fetch 响应，
// 从 Gmail 的 JSON API 响应中直接提取 HeyGen 验证链接
// 通过 window.postMessage 与 content.js 通信
(function () {
  'use strict';

  // ── 正则：匹配 HeyGen magic link URL（含 Unicode 转义变体）─────
  // ⚠️ HeyGen 已将域名从 app.heygen.com 迁移至 auth.heygen.com，两者都要匹配
  // 使用否定字符类 [^\s"'<>\\] 避免遗漏 %、+ 等 URL 字符
  const MAGIC_RE = /https:\/\/auth\.heygen\.com\/magic-web\/[^\s"'<>\\]+/g;

  // ── 反转义 Gmail JSON 中的 Unicode 转义序列 ──────────────────
  function unescapeJson(text) {
    return text
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\\//g, '/');
  }

  // ── 从 magic link URL 解码收件人邮箱（base64 编码在 path 中）──
  // URL 格式：magic-web/UUID:BASE64(email)?r=%2Fhome
  function decodeAccount(link) {
    try {
      const m = link.match(/magic-web\/[^:?#]+:([A-Za-z0-9+/=]+)/);
      if (m && m[1]) return atob(m[1]);
    } catch (_) {}
    return '';
  }

  // ── 从 Gmail JSON 响应中提取邮件时间戳 ──────────────────────
  // Gmail API 响应体里常带 "internalDate":"1745123456789" 字段
  function extractInternalDate(text) {
    const m = text.match(/"internalDate"\s*:\s*"?(\d{10,13})"?/);
    if (m) {
      const ts = parseInt(m[1]);
      // internalDate 单位可能是秒(10位)或毫秒(13位)
      return ts > 1e12 ? ts : ts * 1000;
    }
    return 0;
  }

  // ── 从 Gmail JSON 响应中提取线程/邮件 ID（靠近 magic link 的位置）──
  // 优先 threadId，其次 message id（均为 16 位 16 进制字符串）
  // pos 为 magic-web 链接在文本中的起始位置，取前后 3000 字符范围匹配
  function extractThreadId(text, pos) {
    const start = Math.max(0, pos - 3000);
    const end   = Math.min(text.length, pos + 3000);
    const excerpt = text.slice(start, end);
    // "threadId":"hexstring" — 优先
    const mt = excerpt.match(/"threadId"\s*:\s*"([a-f0-9]{8,20})"/);
    if (mt) return mt[1];
    // "id":"hexstring" — 次选（message ID）
    const mi = excerpt.match(/"id"\s*:\s*"([a-f0-9]{8,20})"/);
    if (mi) return mi[1];
    return '';
  }

  // ── 扫描响应文本并通过 postMessage 上报捕获到的链接 ───────────
  function scanAndPost(rawText, source) {
    if (!rawText || !rawText.includes('heygen')) return;

    // 先反转义，让 URL 还原为正常形式再匹配
    const text = unescapeJson(rawText);
    const matches = text.match(MAGIC_RE);
    if (!matches || matches.length === 0) return;

    // 尝试从同一响应中提取邮件真实收件时间
    const internalDate = extractInternalDate(rawText) || extractInternalDate(text);

    const seen = new Set();
    matches.forEach(rawLink => {
      // 去掉末尾可能混入的引号/空白/转义字符
      const link = rawLink.replace(/["'\s\\><]+$/, '');
      if (!link.includes('magic-web/')) return;
      if (seen.has(link)) return;
      seen.add(link);

      // 找到这条链接在处理后文本中的位置，用于在附近搜索 threadId
      const linkPos = text.indexOf(link);
      // 先在处理后文本里找，找不到再从原始文本里找
      const rawPos  = linkPos >= 0 ? linkPos : rawText.indexOf(rawLink);
      const gmailThreadId = extractThreadId(text, linkPos >= 0 ? linkPos : 0) ||
                            extractThreadId(rawText, rawPos >= 0 ? rawPos : 0);

      window.postMessage({
        type: 'HGC_LINK_CAPTURED',
        link,
        account: decodeAccount(link),
        receivedTs: internalDate || 0,
        gmailThreadId,
        source
      }, '*');
    });
  }

  // ── 拦截 XMLHttpRequest ───────────────────────────────────────
  const _xOpen = XMLHttpRequest.prototype.open;
  const _xSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__hgcUrl = typeof url === 'string' ? url : String(url);
    return _xOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    if (this.__hgcUrl) {
      const url = this.__hgcUrl;
      this.addEventListener('load', function () {
        try { scanAndPost(this.responseText, url); } catch (_) {}
      });
    }
    return _xSend.apply(this, arguments);
  };

  // ── 拦截 fetch ────────────────────────────────────────────────
  const _fetch = window.fetch;
  window.fetch = function (input) {
    const url = (input instanceof Request ? input.url : String(input || ''));
    const promise = _fetch.apply(window, arguments);
    // 只监听 Gmail 域名的响应（性能优化）
    if (url.includes('mail.google.com') || url.includes('googleapis.com')) {
      promise
        .then(response => response.clone().text()
          .then(text => scanAndPost(text, url))
          .catch(() => {}))
        .catch(() => {});
    }
    return promise;
  };

  console.log('[HeyGen Collector] page interceptor ready — XHR & fetch hooked');
})();
