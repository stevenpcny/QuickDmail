// HeyGen Gmail Collector - Background Service Worker

chrome.runtime.onInstalled.addListener(() => {
  console.log('[HeyGen Collector] 插件已安装');
  chrome.storage.local.set({ autoStart: true, heygenData: [] });
});

// 转发消息给 popup（如果打开着）
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'NEW_HEYGEN_DATA') {
    // 广播给所有打开的 popup
    chrome.runtime.sendMessage(message).catch(() => {});
  } else if (message.type === 'OPEN_TAB' && message.url) {
    chrome.tabs.create({ url: message.url });
  }
  return true;
});
