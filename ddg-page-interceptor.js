// Duck邮箱接码 — DuckDuckGo Page Context Interceptor
// 运行在 duckduckgo.com/email/* 页面的 MAIN world（manifest world:MAIN 注入）
// 策略：token 存在 DDG 扩展隔离存储中无法直接读取，改用三种捕获手段：
//   1. 拦截剪贴板写入（用户点 Copy 时捕获地址）
//   2. 拦截 fetch/XHR（如果 DDG 在页面上下文发请求，顺便捕获 token）
//   3. 监听 DDG 扩展通过 postMessage 发回的生成结果
(function () {
  'use strict';

  function broadcastAddress(address) {
    if (!address || !address.includes('duck.com')) return;
    const full = address.includes('@') ? address : address + '@duck.com';
    window.postMessage({ type: 'DDG_ADDRESS_GENERATED', address: full }, '*');
  }

  function broadcastToken(token) {
    if (!token || token.length < 10) return;
    window.postMessage({ type: 'DDG_TOKEN_CAPTURED', token }, '*');
  }

  // ── 策略 1：拦截 navigator.clipboard.writeText ────────────────
  // 用户点 DDG 页面上的「Copy」按钮时触发，直接捕获 duck.com 地址
  try {
    const _writeText = navigator.clipboard.writeText.bind(navigator.clipboard);
    navigator.clipboard.writeText = function (text) {
      if (text && text.toLowerCase().includes('@duck.com')) {
        broadcastAddress(text.trim());
      }
      return _writeText(text);
    };
  } catch (_) {}

  // ── 策略 2：监听 DDG 扩展的 postMessage 回调 ─────────────────
  // DDG 扩展与页面通过 postMessage 通信，生成地址时会把结果发回页面
  window.addEventListener('message', (event) => {
    if (!event.data) return;
    const d = event.data;

    // DDG autofill 扩展的消息格式（多版本兼容）
    const addr = d.address || d.privateAddress || d.generatedAddress ||
                 (d.type === 'ddgUserReply' && d.address) ||
                 (d.emailAddress) || '';
    if (addr && addr.includes('duck.com')) broadcastAddress(addr);

    // 尝试提取 token（部分旧版 DDG 会在消息中携带）
    const token = d.token || d.accessToken || d.userToken || '';
    if (token) broadcastToken(token);
  });

  // ── 策略 3：拦截 fetch（万一 DDG 在 MAIN world 发请求）────────
  const DDG_API = 'quack.duckduckgo.com';
  const _fetch = window.fetch;
  window.fetch = function (input, init) {
    const url = input instanceof Request ? input.url : String(input || '');
    if (!url.includes(DDG_API)) return _fetch.apply(this, arguments);

    // 尝试从请求头提取 token
    const headers = (init && init.headers) || (input instanceof Request ? input.headers : null);
    if (headers) {
      try {
        const auth = headers instanceof Headers
          ? (headers.get('Authorization') || headers.get('authorization'))
          : (headers['Authorization'] || headers['authorization'] || '');
        if (auth && auth.startsWith('Bearer ')) broadcastToken(auth.slice(7));
      } catch (_) {}
    }

    const promise = _fetch.apply(this, arguments);
    promise
      .then(r => r.clone().json()
        .then(data => { if (data && data.address) broadcastAddress(data.address); })
        .catch(() => {}))
      .catch(() => {});
    return promise;
  };

  // ── 策略 4：轮询 DOM，监听地址输入框的值变化 ─────────────────
  // DDG 页面里生成的地址会出现在一个 input 框中
  let _lastSeen = '';
  function pollDom() {
    try {
      // 找页面上所有可能显示 duck.com 地址的输入框
      const inputs = document.querySelectorAll('input[type="text"], input[type="email"], input[readonly]');
      for (const el of inputs) {
        const v = (el.value || el.getAttribute('value') || '').trim();
        if (v && v.includes('@duck.com') && v !== _lastSeen) {
          _lastSeen = v;
          broadcastAddress(v);
        }
      }
      // 也扫描静态文本节点（部分版本用 span/p 展示地址）
      document.querySelectorAll('[data-testid], .email-address, .duck-address').forEach(el => {
        const t = (el.textContent || '').trim();
        if (t.includes('@duck.com') && t !== _lastSeen) {
          _lastSeen = t;
          broadcastAddress(t);
        }
      });
    } catch (_) {}
  }
  setInterval(pollDom, 800);

  console.log('[Duck邮箱接码] DDG page interceptor ready (clipboard + postMessage + DOM poll)');
})();
