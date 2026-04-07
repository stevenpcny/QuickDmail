// HeyGen Gmail Collector - Popup Script

let allData = [];
let isMonitoring = false;
let currentTab = null;
let searchQuery = '';

// ─── DOM Elements ────────────────────────────────────────────
const el = {
  statusBadge: document.getElementById('statusBadge'),
  statusText: document.getElementById('statusText'),
  btnStart: document.getElementById('btnStart'),
  btnStop: document.getElementById('btnStop'),
  btnScan: document.getElementById('btnScan'),
  btnClear: document.getElementById('btnClear'),
  btnCopyAll: document.getElementById('btnCopyAll'),
  btnExportCSV: document.getElementById('btnExportCSV'),
  countDisplay: document.getElementById('countDisplay'),
  tableContainer: document.getElementById('tableContainer'),
  emptyState: document.getElementById('emptyState'),
  searchInput: document.getElementById('searchInput'),
  footerInfo: document.getElementById('footerInfo'),
  toast: document.getElementById('toast'),
  mainContent: document.getElementById('mainContent'),
  notGmailWarning: document.getElementById('notGmailWarning'),
};

// ─── Toast ───────────────────────────────────────────────────
function showToast(msg, duration = 2000) {
  el.toast.textContent = msg;
  el.toast.classList.add('show');
  setTimeout(() => el.toast.classList.remove('show'), duration);
}

// ─── Copy to clipboard ───────────────────────────────────────
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    return true;
  }
}

// ─── Status UI ───────────────────────────────────────────────
function setStatus(monitoring) {
  isMonitoring = monitoring;
  if (monitoring) {
    el.statusBadge.className = 'status-badge active';
    el.statusText.textContent = 'MONITORING';
    el.btnStart.disabled = true;
    el.btnStop.disabled = false;
  } else {
    el.statusBadge.className = 'status-badge inactive';
    el.statusText.textContent = 'STOPPED';
    el.btnStart.disabled = false;
    el.btnStop.disabled = true;
  }
}

// ─── Render Table ────────────────────────────────────────────
function renderTable(data) {
  const filtered = searchQuery
    ? data.filter(d =>
        (d.account || '').toLowerCase().includes(searchQuery) ||
        (d.verifyLink || '').toLowerCase().includes(searchQuery)
      )
    : data;

  el.countDisplay.textContent = data.length;
  el.footerInfo.textContent = `v1.0.8 · 共 ${data.length} 条 · 显示 ${filtered.length} 条`;

  // Clear existing rows (keep header intact)
  const existingRows = el.tableContainer.querySelectorAll('.email-row');
  existingRows.forEach(r => r.remove());

  if (filtered.length === 0) {
    el.emptyState.style.display = 'flex';
    return;
  }

  el.emptyState.style.display = 'none';

  filtered.forEach((item, index) => {
    const row = document.createElement('div');
    row.className = 'email-row' + (index === 0 && !searchQuery ? ' new-row' : '');
    row.dataset.id = item.id;

    const timeStr = item.capturedAt
      ? new Date(item.capturedAt).toLocaleString('zh-CN', {
          month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', second: '2-digit'
        })
      : item.timestamp || '--';

    const shortLink = item.verifyLink
      ? (item.verifyLink.length > 50 ? item.verifyLink.substring(0, 50) + '…' : item.verifyLink)
      : '未提取到链接';

    row.innerHTML = `
      <div class="cell-account" title="${item.account || '未识别'}">
        ${item.account || '<span style="color:var(--text-muted)">未识别</span>'}
      </div>
      <div class="cell-link">
        <div class="link-display ${item.verifyLink ? '' : 'no-link'}"
             title="${item.verifyLink || '未提取到链接'}"
             data-link="${item.verifyLink || ''}">
          ${shortLink}
        </div>
      </div>
      <div class="cell-time">${timeStr}</div>
      <div class="cell-actions">
        <button class="action-btn btn-copy-link" title="复制链接" data-link="${item.verifyLink || ''}" ${!item.verifyLink ? 'disabled' : ''}>⎘</button>
        <button class="action-btn btn-copy-row" title="复制整行" data-account="${item.account || ''}" data-link="${item.verifyLink || ''}">≡</button>
        <button class="action-btn btn-open-link" title="打开链接" data-link="${item.verifyLink || ''}" ${!item.verifyLink ? 'disabled' : ''}>↗</button>
      </div>
    `;

    el.tableContainer.appendChild(row);
  });

  // Event delegation for row actions
  el.tableContainer.querySelectorAll('.btn-copy-link').forEach(btn => {
    btn.onclick = async (e) => {
      const link = e.currentTarget.dataset.link;
      if (!link) return;
      await copyText(link);
      e.currentTarget.classList.add('copied');
      e.currentTarget.textContent = '✓';
      setTimeout(() => {
        e.currentTarget.classList.remove('copied');
        e.currentTarget.textContent = '⎘';
      }, 1500);
      showToast('✓ 链接已复制');
    };
  });

  el.tableContainer.querySelectorAll('.btn-copy-row').forEach(btn => {
    btn.onclick = async (e) => {
      const { account, link } = e.currentTarget.dataset;
      const text = `账号: ${account || '未识别'}\n链接: ${link || '无'}`;
      await copyText(text);
      e.currentTarget.classList.add('copied');
      e.currentTarget.textContent = '✓';
      setTimeout(() => {
        e.currentTarget.classList.remove('copied');
        e.currentTarget.textContent = '≡';
      }, 1500);
      showToast('✓ 行数据已复制');
    };
  });

  el.tableContainer.querySelectorAll('.btn-open-link').forEach(btn => {
    btn.onclick = (e) => {
      const link = e.currentTarget.dataset.link;
      if (link) chrome.tabs.create({ url: link });
    };
  });

  el.tableContainer.querySelectorAll('.link-display:not(.no-link)').forEach(el_ => {
    el_.onclick = async () => {
      const link = el_.dataset.link;
      if (link) {
        await copyText(link);
        showToast('✓ 链接已复制');
      }
    };
  });
}

// ─── Load Data ───────────────────────────────────────────────
function loadData() {
  chrome.storage.local.get(['heygenData'], (result) => {
    allData = result.heygenData || [];
    renderTable(allData);
  });
}

// ─── Check if current tab is Gmail ───────────────────────────
async function checkCurrentTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs && tabs[0]) {
        currentTab = tabs[0];
        const isGmail = currentTab.url && currentTab.url.includes('mail.google.com');
        resolve(isGmail);
      } else {
        resolve(false);
      }
    });
  });
}

// ─── Send message to content script ─────────────────────────
function sendToContent(type, data = {}) {
  return new Promise((resolve) => {
    if (!currentTab) { resolve({ success: false }); return; }
    chrome.tabs.sendMessage(currentTab.id, { type, ...data }, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ success: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(response || { success: true });
      }
    });
  });
}

// ─── Button Handlers ─────────────────────────────────────────
el.btnStart.onclick = async () => {
  const isGmail = await checkCurrentTab();
  if (!isGmail) {
    showToast('⚠ 请先打开 Gmail 页面');
    return;
  }
  const res = await sendToContent('START_MONITORING');
  if (res.success) {
    setStatus(true);
    chrome.storage.local.set({ autoStart: true });
    showToast('▶ 监控已启动');
  } else {
    showToast('⚠ 启动失败，请刷新 Gmail 页面');
  }
};

el.btnStop.onclick = async () => {
  const res = await sendToContent('STOP_MONITORING');
  setStatus(false);
  chrome.storage.local.set({ autoStart: false });
  showToast('■ 监控已停止');
};

el.btnScan.onclick = async () => {
  const isGmail = await checkCurrentTab();
  if (!isGmail) { showToast('⚠ 请先打开 Gmail 页面'); return; }
  await sendToContent('MANUAL_SCAN');
  showToast('⟳ 正在扫描...');
  setTimeout(loadData, 2000);
};

el.btnClear.onclick = () => {
  if (confirm('确定清空所有已收集的数据？')) {
    chrome.storage.local.set({ heygenData: [] }, () => {
      allData = [];
      renderTable([]);
      showToast('已清空所有数据');
    });
  }
};

el.btnCopyAll.onclick = async () => {
  if (allData.length === 0) { showToast('没有数据可复制'); return; }
  const lines = allData.map((d, i) =>
    `${i + 1}\t${d.account || '未识别'}\t${d.verifyLink || '无链接'}\t${d.capturedAt || ''}`
  );
  const header = '#\t账号\t验证链接\t捕获时间';
  await copyText([header, ...lines].join('\n'));
  showToast(`✓ 已复制 ${allData.length} 条数据`);
};

el.btnExportCSV.onclick = () => {
  if (allData.length === 0) { showToast('没有数据可导出'); return; }
  const header = '序号,HeyGen账号,验证链接,捕获时间\n';
  const rows = allData.map((d, i) =>
    `${i + 1},"${d.account || ''}","${d.verifyLink || ''}","${d.capturedAt || ''}"`
  ).join('\n');
  const csv = '\uFEFF' + header + rows; // BOM for Excel UTF-8
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `heygen_links_${new Date().toISOString().split('T')[0]}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('✓ CSV 已导出');
};

// ─── Search ──────────────────────────────────────────────────
el.searchInput.oninput = (e) => {
  searchQuery = e.target.value.toLowerCase().trim();
  renderTable(allData);
};

// ─── Listen for new data from content script ─────────────────
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'NEW_HEYGEN_DATA') {
    loadData();
    showToast('🎯 新验证链接已捕获！');
  }
});

// ─── Storage change listener ─────────────────────────────────
chrome.storage.onChanged.addListener((changes) => {
  if (changes.heygenData) {
    allData = changes.heygenData.newValue || [];
    renderTable(allData);
  }
});

// ─── Init ────────────────────────────────────────────────────
async function init() {
  const isGmail = await checkCurrentTab();

  if (!isGmail) {
    // Show warning but still show data
    // Don't hide main content, just show toast
    showToast('⚠ 当前页面不是 Gmail');
  }

  // Check monitoring status
  if (currentTab && isGmail) {
    sendToContent('GET_STATUS').then(res => {
      if (res && res.isMonitoring) setStatus(true);
    });
  }

  loadData();
}

init();
