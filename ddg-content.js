// HeyGen Gmail Collector — DuckDuckGo Content Script
// 运行在 duckduckgo.com/email/* 页面（ISOLATED world）
// 接收来自 ddg-page-interceptor.js（MAIN world）的 postMessage，
// 把捕获到的 Duck 地址存入 chrome.storage.local
(function () {
  'use strict';

  // ── 监听来自 MAIN world 拦截器的消息 ─────────────────────────
  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data) return;

    // 捕获到 Duck 地址（剪贴板拦截 / fetch响应 / DOM轮询 / postMessage）
    if (event.data.type === 'DDG_ADDRESS_GENERATED') {
      const { address } = event.data;
      if (!address || !address.includes('@duck.com')) return;
      _saveAddress(address);
    }

    // 捕获到 token（fetch/XHR 拦截，或许有也或许没有）
    if (event.data.type === 'DDG_TOKEN_CAPTURED') {
      const { token } = event.data;
      if (!token || token.length < 10) return;
      chrome.storage.local.get(['ddgToken'], (r) => {
        if (r.ddgToken === token) return;
        chrome.storage.local.set({ ddgToken: token, ddgTokenAt: Date.now() });
        chrome.runtime.sendMessage({ type: 'DDG_TOKEN_UPDATED' }).catch(() => {});
      });
    }
  });

  // ── 保存地址到历史 ─────────────────────────────────────────────
  function _saveAddress(address) {
    chrome.storage.local.get(['ddgAddresses'], (r) => {
      const list = r.ddgAddresses || [];
      if (list.some(a => a.address === address)) return; // 去重
      list.unshift({ address, createdAt: new Date().toISOString(), source: 'ddg-page' });
      chrome.storage.local.set({ ddgAddresses: list.slice(0, 100) });
      // 通知 popup 更新列表
      chrome.runtime.sendMessage({ type: 'DDG_ADDRESS_CAPTURED', address }).catch(() => {});
      console.log('[HeyGen Collector] Duck 地址已保存:', address);
    });
  }

  // ── 在 DDG 页面右下角显示提示横幅 ─────────────────────────────
  function injectBanner() {
    if (document.getElementById('hgc-ddg-banner')) return;

    const banner = document.createElement('div');
    banner.id = 'hgc-ddg-banner';
    banner.style.cssText = `
      position:fixed;bottom:20px;right:20px;
      background:#ffffff;border:1px solid rgba(0,0,0,0.10);
      border-radius:10px;padding:10px 15px;
      font-family:-apple-system,BlinkMacSystemFont,sans-serif;
      font-size:12px;color:#1d1d1f;
      box-shadow:0 4px 16px rgba(0,0,0,0.12);
      display:flex;align-items:center;gap:8px;
      z-index:99999;max-width:300px;
      animation:hgcIn 0.3s ease;
    `;
    const style = document.createElement('style');
    style.textContent = `@keyframes hgcIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}`;
    document.head.appendChild(style);

    banner.innerHTML = `
      <span style="width:7px;height:7px;border-radius:50%;background:#007AFF;flex-shrink:0"></span>
      <span>HeyGen 插件已就绪：点击「Copy」后地址会自动记录</span>
    `;
    document.body.appendChild(banner);
    setTimeout(() => {
      banner.style.transition = 'opacity 0.3s';
      banner.style.opacity = '0';
      setTimeout(() => banner.remove(), 300);
    }, 4000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(injectBanner, 600));
  } else {
    setTimeout(injectBanner, 600);
  }
})();
