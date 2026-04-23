// HeyGen Gmail Collector - Background Service Worker

chrome.runtime.onInstalled.addListener(() => {
  console.log('[HeyGen Collector] 插件已安装');
  chrome.storage.local.set({ autoStart: true, heygenData: [] });
  chrome.alarms.create('sheetsSync', { periodInMinutes: 15 });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create('sheetsSync', { periodInMinutes: 15 });
  // 启动时冲刷待同步队列
  syncPendingToSheets();
  updateBadge();
});

// 15 分钟定时同步
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'sheetsSync') syncPendingToSheets();
});

// Gmail 标签页关闭时立即同步
chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError) {
      // tab already gone — check via stored gmail tab id
      chrome.storage.local.get(['gmailTabId'], (r) => {
        if (r.gmailTabId === tabId) syncPendingToSheets();
      });
      return;
    }
    if (tab && tab.url && tab.url.includes('mail.google.com')) {
      syncPendingToSheets();
    }
  });
});

// 转发消息给 popup（如果打开着）
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'NEW_HEYGEN_DATA') {
    chrome.runtime.sendMessage(message).catch(() => {});
    enqueuePending(message.data);
    updateBadge();
  } else if (message.type === 'OPEN_TAB' && message.url) {
    chrome.tabs.create({ url: message.url });
  } else if (message.type === 'SHEETS_SYNC_NOW') {
    syncPendingToSheets().then(() => sendResponse({ success: true })).catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  } else if (message.type === 'SHEETS_SYNC_DUCK_NOW') {
    syncDuckToSheets().then(() => sendResponse({ success: true })).catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  } else if (message.type === 'SHEETS_IMPORT') {
    importFromSheets().then(data => sendResponse({ success: true, data })).catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }
  return true;
});

// ─── Badge ───────────────────────────────────────────────────
function updateBadge() {
  chrome.storage.local.get(['heygenAccounts'], (r) => {
    const valid = (r.heygenAccounts || []).filter(a =>
      (a.latestLink || '').includes('auth.heygen.com/magic-web/')
    );
    const count = valid.length;
    const label = count === 0 ? '' : (count > 99 ? '99+' : String(count));
    chrome.action.setBadgeText({ text: label });
    chrome.action.setBadgeBackgroundColor({ color: '#00d4ff' });
  });
}

// 账号列表变化时同步刷新徽章
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.heygenAccounts) updateBadge();
});

// ─── Pending Queue ───────────────────────────────────────────
function enqueuePending(item) {
  if (!item) return;
  chrome.storage.local.get(['sheetsSyncConfig', 'pendingSync'], (r) => {
    if (!r.sheetsSyncConfig || !r.sheetsSyncConfig.enabled) return;
    const pending = r.pendingSync || [];
    // avoid duplicate pending items
    if (!pending.some(p => p.id === item.id)) {
      pending.push({ op: 'upsert', data: item, ts: Date.now() });
      chrome.storage.local.set({ pendingSync: pending });
    }
  });
}

// ─── Sheets Sync ─────────────────────────────────────────────
async function syncPendingToSheets() {
  const { sheetsSyncConfig, pendingSync, heygenAccounts } = await storageGet(['sheetsSyncConfig', 'pendingSync', 'heygenAccounts']);
  if (!sheetsSyncConfig || !sheetsSyncConfig.enabled || !sheetsSyncConfig.spreadsheetId) return;
  if (!pendingSync || pendingSync.length === 0) return;

  try {
    const token = await getAuthToken(false);
    if (!token) return;

    const sheetId = sheetsSyncConfig.spreadsheetId;
    const sheetName = sheetsSyncConfig.sheetName || 'HeyGen Accounts';

    // batch upsert: write all heygenAccounts to sheet (simpler than row-level diff)
    const accounts = heygenAccounts || [];
    const values = [
      ['邮箱', '最后收件时间', '首次收件时间', '收件次数', '最新链接'],
      ...accounts.map(a => [
        a.email || '',
        a.lastSeen ? new Date(a.lastSeen).toISOString() : '',
        a.firstSeen ? new Date(a.firstSeen).toISOString() : '',
        a.count || 1,
        a.latestLink || ''
      ])
    ];

    await sheetsRequest(token, 'PUT',
      `/values/${encodeURIComponent(sheetName + '!A1')}?valueInputOption=RAW`,
      sheetId, { values }
    );

    chrome.storage.local.set({ pendingSync: [], lastSyncAt: Date.now() });
    chrome.runtime.sendMessage({ type: 'SYNC_STATUS', status: 'ok', ts: Date.now() }).catch(() => {});
  } catch (e) {
    console.warn('[HeyGen] Sheets sync failed', e);
    chrome.runtime.sendMessage({ type: 'SYNC_STATUS', status: 'error', msg: e.message }).catch(() => {});
  }
}

async function importFromSheets() {
  const { sheetsSyncConfig } = await storageGet(['sheetsSyncConfig']);
  if (!sheetsSyncConfig || !sheetsSyncConfig.spreadsheetId) throw new Error('未配置 Spreadsheet');

  const token = await getAuthToken(true);
  const sheetName = sheetsSyncConfig.sheetName || 'HeyGen Accounts';
  const res = await sheetsRequest(token, 'GET',
    `/values/${encodeURIComponent(sheetName + '!A2:E')}`, sheetsSyncConfig.spreadsheetId
  );
  const rows = (res.values || []).filter(r => r[0] && r[0].includes('@'));
  const imported = rows.map(r => ({
    email: r[0] || '',
    lastSeen: r[1] ? new Date(r[1]).getTime() : 0,
    firstSeen: r[2] ? new Date(r[2]).getTime() : 0,
    count: parseInt(r[3]) || 1,
    latestLink: r[4] || ''
  }));
  return imported;
}

// ─── Create Sheet if needed ──────────────────────────────────
async function ensureSheet(token, sheetName) {
  // create a new spreadsheet
  const res = await fetch('https://sheets.googleapis.com/v4/spreadsheets', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ properties: { title: 'HeyGen Collector 备份' }, sheets: [{ properties: { title: sheetName } }] })
  });
  if (!res.ok) throw new Error('创建 Sheet 失败: ' + res.status);
  return (await res.json()).spreadsheetId;
}

// ─── Sheets API helper ───────────────────────────────────────
async function sheetsRequest(token, method, path, spreadsheetId, body) {
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}`;
  const res = await fetch(base + path, {
    method,
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Sheets API ${method} failed ${res.status}: ${txt}`);
  }
  return method === 'PUT' || res.status === 204 ? {} : res.json();
}

// ─── OAuth token ─────────────────────────────────────────────
function getAuthToken(interactive) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(token);
    });
  });
}

// ─── Duck 地址同步到 Sheets ────────────────────────────────────
async function syncDuckToSheets() {
  const { sheetsSyncConfig, ddgAddresses } = await storageGet(['sheetsSyncConfig', 'ddgAddresses']);
  if (!sheetsSyncConfig || !sheetsSyncConfig.spreadsheetId) {
    throw new Error('请先在设置页配置 Google Sheets');
  }

  const token = await getAuthToken(true);
  const sheetId  = sheetsSyncConfig.spreadsheetId;
  const tabName  = 'Duck 地址';

  // 确保 "Duck 地址" tab 存在
  await ensureSheetTab(token, sheetId, tabName);

  const srcLabel = { generated: 'API生成', 'ddg-page': 'DDG页面', scanned: 'Gmail扫描' };
  const list = ddgAddresses || [];

  const values = [
    ['Duck地址', '来源', '生成时间'],
    ...list.map(d => [
      d.address  || '',
      srcLabel[d.source] || d.source || '',
      d.createdAt || ''
    ])
  ];

  await sheetsRequest(token, 'PUT',
    `/values/${encodeURIComponent(tabName + '!A1')}?valueInputOption=RAW`,
    sheetId, { values }
  );

  chrome.runtime.sendMessage({ type: 'SYNC_STATUS', status: 'ok', ts: Date.now() }).catch(() => {});
}

// 也在常规 syncPendingToSheets 后自动写入 Duck 地址（同步一并完成）
const _origSyncPending = syncPendingToSheets;
// (在 syncPendingToSheets 成功后追加调用 — 不改原函数以保持独立性)

// ─── 确保 Sheet tab 存在（不存在则创建）─────────────────────────
async function ensureSheetTab(token, spreadsheetId, tabName) {
  const meta = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties.title`,
    { headers: { 'Authorization': 'Bearer ' + token } }
  ).then(r => r.json());

  const exists = (meta.sheets || []).some(s => s.properties.title === tabName);
  if (exists) return;

  await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests: [{ addSheet: { properties: { title: tabName } } }] })
  });
}

// ─── Storage helper ──────────────────────────────────────────
function storageGet(keys) {
  return new Promise(resolve => chrome.storage.local.get(keys, resolve));
}
