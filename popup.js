// Duck邮箱接码 - Popup Script

const DEFAULT_LINK_KEYWORD = 'auth.heygen.com/magic-web/';
let _linkKeyword = DEFAULT_LINK_KEYWORD;

let allData = [];
let allAccounts = [];
let isMonitoring = false;
let currentTab = null;
let searchQuery = '';
let accSearchQuery = '';

// filter state
let filterMode = 'none';   // 'none' | 'older' | 'range'
let filterOlderMs = 0;     // computed threshold timestamp
let filterRangeStart = 0;
let filterRangeEnd = 0;

// selection state
let selectedEmails = new Set();

// unread links (highlighted until copied or successfully dragged)
let readLinks = new Set();   // IDs of links already interacted with

function loadReadLinks() {
  chrome.storage.local.get(['readLinks'], r => {
    readLinks = new Set(r.readLinks || []);
  });
}
function markLinkRead(id) {
  if (!id || readLinks.has(id)) return;
  readLinks.add(id);
  chrome.storage.local.set({ readLinks: [...readLinks] });
  // re-render to drop highlight
  renderTable(allData);
}

// rotation state
let rotationQueue = [];
let rotationIdx = 0;
let rotationActive = false;
let rotationAutoAdvance = true;

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

// ─── HTML 转义（防止邮箱/链接中特殊字符破坏 innerHTML 属性）────
function escHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

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
    el.statusText.textContent = '监控中';
    el.btnStart.style.display = 'none';
    el.btnStop.style.display = '';
  } else {
    el.statusBadge.className = 'status-badge inactive';
    el.statusText.textContent = '已停止';
    el.btnStart.style.display = '';
    el.btnStop.style.display = 'none';
  }
}

// ─── Sort state ──────────────────────────────────────────────
let sortCol = 'time';   // 'time' | 'account'
let sortDir = 'desc';   // 'asc' | 'desc'

function initSortHeaders() {
  document.querySelectorAll('.col-sort').forEach(el => {
    el.addEventListener('click', () => {
      const col = el.dataset.col;
      if (sortCol === col) {
        sortDir = sortDir === 'desc' ? 'asc' : 'desc';
      } else {
        sortCol = col;
        sortDir = col === 'time' ? 'desc' : 'asc';
      }
      // Update header visuals
      document.querySelectorAll('.col-sort').forEach(h => {
        h.classList.remove('active');
        h.querySelector('.sort-arrow').textContent = '↕';
      });
      el.classList.add('active');
      el.querySelector('.sort-arrow').textContent = sortDir === 'desc' ? '↓' : '↑';
      renderTable(allData);
    });
  });
}

// ─── Render Table ────────────────────────────────────────────
function renderTable(data) {
  // 只显示带有效验证链接的条目
  const tsOf = d => new Date(d.receivedAt || d.capturedAt || 0).getTime() || 0;
  const withLinks = (data || []).filter(d => d.verifyLink);

  // 按当前排序列排序
  withLinks.sort((a, b) => {
    if (sortCol === 'account') {
      const cmp = (a.account || '').localeCompare(b.account || '');
      return sortDir === 'asc' ? cmp : -cmp;
    }
    // default: time
    const cmp = tsOf(a) - tsOf(b);
    return sortDir === 'asc' ? cmp : -cmp;
  });
  const filtered = searchQuery
    ? withLinks.filter(d =>
        (d.account || '').toLowerCase().includes(searchQuery) ||
        (d.verifyLink || '').toLowerCase().includes(searchQuery)
      )
    : withLinks;

  el.countDisplay.textContent = withLinks.length;
  el.footerInfo.textContent = `v1.5.0 · Duck邮箱接码`;

  // Clear existing rows (keep header intact)
  const existingRows = el.tableContainer.querySelectorAll('.email-row');
  existingRows.forEach(r => r.remove());

  if (filtered.length === 0) {
    el.emptyState.style.display = 'flex';
    return;
  }

  el.emptyState.style.display = 'none';

  filtered.forEach((item) => {
    const isUnread = item.id && !readLinks.has(item.id);
    const row = document.createElement('div');
    row.className = 'email-row' + (isUnread ? ' new-row' : '');
    row.dataset.id = item.id;

    const timeSrc = item.receivedAt || item.capturedAt;
    const timeStr = timeSrc
      ? new Date(timeSrc).toLocaleString('zh-CN', {
          month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', second: '2-digit'
        })
      : item.timestamp || '--';

    const shortLink = item.verifyLink
      ? (item.verifyLink.length > 50 ? item.verifyLink.substring(0, 50) + '…' : item.verifyLink)
      : '未提取到链接';

    const tid = item.gmailThreadId || '';
    const acc = item.account || '';
    const eAcc  = escHtml(acc);
    const eLink = escHtml(item.verifyLink || '');
    const eTid  = escHtml(tid);
    row.innerHTML = `
      <div class="cell-account" title="${eAcc || '未识别'}">
        ${eAcc || '<span style="color:var(--text-muted)">未识别</span>'}
      </div>
      <div class="cell-link">
        <div class="link-display ${item.verifyLink ? '' : 'no-link'}"
             title="${item.verifyLink ? '点击复制 · 可拖拽到其他浏览器' : '未提取到链接'}"
             data-link="${eLink}"
             data-id="${escHtml(item.id || '')}"
             data-thread-id="${eTid}"
             data-account="${eAcc}"
             draggable="${item.verifyLink ? 'true' : 'false'}">
          ${escHtml(shortLink)}
        </div>
      </div>
      <div class="cell-time">${timeStr}</div>
      <div class="cell-actions" style="position:relative">
        <button class="action-btn btn-open-link" title="在新标签页打开链接" data-link="${eLink}" data-id="${escHtml(item.id || '')}" data-thread-id="${eTid}" data-account="${eAcc}" ${!item.verifyLink ? 'disabled' : ''}><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg></button>
        <button class="action-btn btn-row-more" title="更多操作" data-link="${eLink}" data-id="${escHtml(item.id || '')}" data-thread-id="${eTid}" data-account="${eAcc}"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="12" cy="19" r="1.2"/></svg></button>
        <div class="row-more-menu" style="display:none;position:absolute;right:0;top:calc(100% + 2px);z-index:200;background:var(--bg-secondary);border:1px solid var(--border);border-radius:8px;padding:4px;min-width:130px;box-shadow:var(--shadow-md)">
          <button class="more-item btn-copy-link" title="复制链接" data-link="${eLink}" data-id="${escHtml(item.id || '')}" data-thread-id="${eTid}" data-account="${eAcc}" ${!item.verifyLink ? 'disabled' : ''}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            复制链接
          </button>
          <button class="more-item btn-copy-row" title="复制整行（账号 + 链接）" data-account="${eAcc}" data-link="${eLink}" data-id="${escHtml(item.id || '')}" data-thread-id="${eTid}">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
            复制整行
          </button>
        </div>
      </div>
    `;

    el.tableContainer.appendChild(row);
  });

  // Event delegation for row actions
  const SVG_COPY = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
  const SVG_ROWS = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>`;
  const SVG_CHECK = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;

  el.tableContainer.querySelectorAll('.btn-copy-link').forEach(btn => {
    btn.onclick = async (e) => {
      const { link, id, threadId, account } = e.currentTarget.dataset;
      if (!link) return;
      await copyText(link);
      markLinkRead(id);
      markGmailRead(threadId, account);
      e.currentTarget.classList.add('copied');
      e.currentTarget.innerHTML = SVG_CHECK;
      setTimeout(() => {
        e.currentTarget.classList.remove('copied');
        e.currentTarget.innerHTML = SVG_COPY;
      }, 1500);
      showToast('✓ 链接已复制');
    };
  });

  el.tableContainer.querySelectorAll('.btn-copy-row').forEach(btn => {
    btn.onclick = async (e) => {
      const { account, link, id, threadId } = e.currentTarget.dataset;
      const text = `账号: ${account || '未识别'}\n链接: ${link || '无'}`;
      await copyText(text);
      markLinkRead(id);
      markGmailRead(threadId, account);
      e.currentTarget.classList.add('copied');
      e.currentTarget.innerHTML = SVG_CHECK;
      setTimeout(() => {
        e.currentTarget.classList.remove('copied');
        e.currentTarget.innerHTML = SVG_ROWS;
      }, 1500);
      showToast('✓ 行数据已复制');
    };
  });

  el.tableContainer.querySelectorAll('.btn-open-link').forEach(btn => {
    btn.onclick = (e) => {
      const { link, id, threadId, account } = e.currentTarget.dataset;
      if (link) {
        markLinkRead(id);
        markGmailRead(threadId, account);
        chrome.tabs.create({ url: link });
      }
    };
  });

  // Row more-menu toggle
  el.tableContainer.querySelectorAll('.btn-row-more').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const menu = btn.nextElementSibling;
      const isVisible = menu.style.display !== 'none';
      // Close all other open row menus
      el.tableContainer.querySelectorAll('.row-more-menu').forEach(m => { m.style.display = 'none'; });
      if (!isVisible) {
        menu.style.display = 'block';
        // Reposition if near bottom
        const rect = menu.getBoundingClientRect();
        if (rect.bottom > window.innerHeight - 8) {
          menu.style.top = 'auto';
          menu.style.bottom = 'calc(100% + 2px)';
        }
      }
    };
  });

  el.tableContainer.querySelectorAll('.link-display:not(.no-link)').forEach(el_ => {
    // 点击复制
    el_.onclick = async () => {
      const { link, id, threadId, account } = el_.dataset;
      if (link) {
        await copyText(link);
        markLinkRead(id);
        markGmailRead(threadId, account);
        showToast('✓ 链接已复制');
      }
    };
    // 拖拽：把链接设置为 drag data
    el_.addEventListener('dragstart', e => {
      const { link } = el_.dataset;
      if (!link) return;
      e.dataTransfer.setData('text/uri-list', link);
      e.dataTransfer.setData('text/plain', link);
      e.dataTransfer.effectAllowed = 'copyLink';
    });
    // 拖拽结束：dropEffect 不为 none 说明成功放下 → 标记已读 + Gmail 已读
    el_.addEventListener('dragend', e => {
      if (e.dataTransfer.dropEffect !== 'none') {
        const { id, threadId, account } = el_.dataset;
        markLinkRead(id);
        markGmailRead(threadId, account);
      }
    });
  });
}

// ─── Load Data ───────────────────────────────────────────────
function loadData() {
  chrome.storage.local.get(['heygenData', 'heygenAccounts'], (result) => {
    allData = result.heygenData || [];
    allAccounts = result.heygenAccounts || [];
    renderTable(allData);
    renderAccounts(allAccounts);
  });
}

// ─── Render Accounts Table ───────────────────────────────────
function formatRelTime(ms) {
  if (!ms) return '--';
  const diff = Date.now() - ms;
  const min = 60 * 1000, hr = 60 * min, day = 24 * hr;
  if (diff < min) return '刚刚';
  if (diff < hr) return Math.floor(diff / min) + ' 分钟前';
  if (diff < day) return Math.floor(diff / hr) + ' 小时前';
  if (diff < 30 * day) return Math.floor(diff / day) + ' 天前';
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function applyAccountFilter(accounts) {
  // 只保留抓到过 magic-web 验证链接的账号
  let list = [...accounts]
    .filter(a => (a.latestLink || '').includes(_linkKeyword))
    .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
  if (accSearchQuery) list = list.filter(a => (a.email||'').toLowerCase().includes(accSearchQuery));
  if (filterMode === 'older' && filterOlderMs > 0) {
    list = list.filter(a => (a.lastSeen || 0) < filterOlderMs);
  } else if (filterMode === 'range' && filterRangeStart > 0) {
    const end = filterRangeEnd > 0 ? filterRangeEnd : Date.now();
    list = list.filter(a => (a.lastSeen||0) >= filterRangeStart && (a.lastSeen||0) <= end);
  }
  return list;
}

function renderAccounts(accounts) {
  const container = document.getElementById('accTableContainer');
  const emptyEl = document.getElementById('accEmptyState');
  const countEl = document.getElementById('accCountDisplay');
  if (!container) return;

  const validAccounts = accounts.filter(a => (a.latestLink || '').includes(_linkKeyword));
  countEl.textContent = validAccounts.length;
  const filtered = applyAccountFilter(accounts);
  container.querySelectorAll('.acc-row').forEach(r => r.remove());

  if (filtered.length === 0) { emptyEl.style.display = 'flex'; return; }
  emptyEl.style.display = 'none';

  filtered.forEach(acc => {
    const checked = selectedEmails.has(acc.email);
    const row = document.createElement('div');
    row.className = 'acc-row' + (checked ? ' selected-row' : '');
    row.dataset.email = acc.email;
    row.innerHTML = `
      <div class="acc-cb"><input type="checkbox" class="acc-checkbox" data-email="${acc.email}" ${checked ? 'checked' : ''}></div>
      <div class="acc-email" title="${acc.email}">${acc.email}</div>
      <div class="acc-time" title="${new Date(acc.lastSeen).toLocaleString('zh-CN')}">${formatRelTime(acc.lastSeen)}</div>
      <div class="acc-count">${acc.count || 1}</div>
      <div class="acc-actions">
        <button class="action-btn acc-copy" title="复制邮箱" data-email="${acc.email}"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>
        <button class="action-btn acc-open" title="打开最新链接" data-link="${acc.latestLink||''}" ${!acc.latestLink?'disabled':''}><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg></button>
      </div>`;
    container.appendChild(row);
  });

  container.querySelectorAll('.acc-checkbox').forEach(cb => {
    cb.onchange = () => {
      const email = cb.dataset.email;
      cb.checked ? selectedEmails.add(email) : selectedEmails.delete(email);
      cb.closest('.acc-row').classList.toggle('selected-row', cb.checked);
      updateSelToolbar();
    };
  });
  const _SVG_COPY = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
  const _SVG_CHECK = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
  container.querySelectorAll('.acc-copy').forEach(btn => {
    btn.onclick = async (e) => {
      await copyText(e.currentTarget.dataset.email);
      e.currentTarget.classList.add('copied');
      e.currentTarget.innerHTML = _SVG_CHECK;
      setTimeout(() => { e.currentTarget.classList.remove('copied'); e.currentTarget.innerHTML = _SVG_COPY; }, 1500);
      showToast('✓ 邮箱已复制');
    };
  });
  container.querySelectorAll('.acc-open').forEach(btn => {
    btn.onclick = (e) => { const l = e.currentTarget.dataset.link; if (l) chrome.tabs.create({ url: l }); };
  });

  // sync select-all checkbox
  const allCb = document.getElementById('accSelectAll');
  if (allCb) allCb.checked = filtered.length > 0 && filtered.every(a => selectedEmails.has(a.email));
}

function updateSelToolbar() {
  const n = selectedEmails.size;
  const toolbar = document.getElementById('selToolbar');
  document.getElementById('selCount').textContent = n;
  toolbar.classList.toggle('visible', n > 0);
}

// ─── View Switching ──────────────────────────────────────────
let currentViewId = 'mainDuckView';
let currentRecordsViewId = 'recordsLinksView';

function showView(viewId) {
  document.querySelectorAll('.view-container').forEach(view => {
    view.classList.toggle('active', view.id === viewId);
  });
  currentViewId = viewId;
  if (viewId === 'mainDuckView') renderDuckTab();
}

function showRecordsView(viewId) {
  document.querySelectorAll('.record-subview').forEach(view => {
    view.classList.toggle('active', view.id === viewId);
  });
  document.querySelectorAll('.record-subtab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.recordView === viewId);
  });
  currentRecordsViewId = viewId;
}

function initViewSwitching() {
  document.getElementById('btnOpenRecords').onclick = () => {
    showView('recordsView');
    showRecordsView(currentRecordsViewId);
  };
  document.getElementById('btnOpenSettings').onclick = () => {
    showView('settingsView');
  };
  document.getElementById('btnBackFromRecords').onclick = () => {
    showView('mainDuckView');
  };
  document.getElementById('btnBackFromSettings').onclick = () => {
    showView('mainDuckView');
  };
  document.querySelectorAll('.record-subtab-btn').forEach(btn => {
    btn.onclick = () => showRecordsView(btn.dataset.recordView);
  });
  showView('mainDuckView');
  showRecordsView(currentRecordsViewId);
}

// ─── Accounts Tab Events ─────────────────────────────────────
document.getElementById('accSearchInput').oninput = (e) => {
  accSearchQuery = e.target.value.toLowerCase().trim();
  renderAccounts(allAccounts);
};

// Filter mode toggle
document.getElementById('filterMode').onchange = (e) => {
  filterMode = e.target.value;
  document.getElementById('filterOlderGroup').style.display  = filterMode === 'older' ? '' : 'none';
  document.getElementById('filterRangeGroup').style.display  = filterMode === 'range' ? '' : 'none';
  document.getElementById('filterRangeGroup2').style.display = filterMode === 'range' ? '' : 'none';
};

document.getElementById('btnFilterApply').onclick = () => {
  filterMode = document.getElementById('filterMode').value;
  if (filterMode === 'older') {
    const num  = parseInt(document.getElementById('filterOlderNum').value) || 30;
    const unit = document.getElementById('filterOlderUnit').value;
    const msMap = { day: 86400000, week: 604800000, month: 2592000000 };
    filterOlderMs = Date.now() - num * (msMap[unit] || msMap.day);
  } else if (filterMode === 'range') {
    const s = document.getElementById('filterStart').value;
    const en = document.getElementById('filterEnd').value;
    filterRangeStart = s  ? new Date(s).getTime()  : 0;
    filterRangeEnd   = en ? new Date(en).getTime() + 86400000 : 0;
  }
  renderAccounts(allAccounts);
};

document.getElementById('btnFilterReset').onclick = () => {
  filterMode = 'none'; filterOlderMs = 0; filterRangeStart = 0; filterRangeEnd = 0;
  document.getElementById('filterMode').value = 'none';
  document.getElementById('filterOlderGroup').style.display  = 'none';
  document.getElementById('filterRangeGroup').style.display  = 'none';
  document.getElementById('filterRangeGroup2').style.display = 'none';
  renderAccounts(allAccounts);
};

// Select all
document.getElementById('accSelectAll').onchange = (e) => {
  const filtered = applyAccountFilter(allAccounts);
  filtered.forEach(a => e.target.checked ? selectedEmails.add(a.email) : selectedEmails.delete(a.email));
  renderAccounts(allAccounts);
  updateSelToolbar();
};

document.getElementById('btnClearSel').onclick = () => {
  selectedEmails.clear();
  renderAccounts(allAccounts);
  updateSelToolbar();
};

// ─── Clipboard Rotator ───────────────────────────────────────
document.getElementById('btnStartRotation').onclick = () => {
  if (selectedEmails.size === 0) return;
  rotationQueue = [...selectedEmails];
  rotationIdx = 0;
  rotationActive = true;
  rotationAdvanceTo(0);
  document.getElementById('rotationBar').classList.add('visible');
  document.getElementById('selToolbar').classList.remove('visible');
};

document.getElementById('btnRotationNext').onclick = () => rotationAdvance();
document.getElementById('btnRotationStop').onclick = () => stopRotation();

function rotationAdvanceTo(idx) {
  if (!rotationActive || idx >= rotationQueue.length) { stopRotation(); return; }
  rotationIdx = idx;
  const email = rotationQueue[idx];
  copyText(email);
  document.getElementById('rotationEmail').textContent = email;
  document.getElementById('rotationProg').textContent = `(${idx + 1}/${rotationQueue.length})`;
  showToast(`已复制 ${idx + 1}/${rotationQueue.length}: ${email.split('@')[0]}…`);
}

function rotationAdvance() {
  rotationAdvanceTo(rotationIdx + 1);
}

function stopRotation() {
  rotationActive = false;
  document.getElementById('rotationBar').classList.remove('visible');
  showToast('轮转已完成或已停止');
}

// Focus/blur auto-advance (accounts rotation)
let _blurred = false;
window.addEventListener('blur', () => { if (rotationActive) _blurred = true; });
window.addEventListener('focus', () => {
  if (rotationActive && _blurred) { _blurred = false; rotationAdvance(); }
});

// ─── P4: Link Auto-Rotation ──────────────────────────────────
let linkRotationEnabled = false;
let linkRotationQueue  = [];   // pending links not yet copied
let linkRotationActive = false;
let _linkBlurred = false;

// restore toggle state
chrome.storage.local.get(['linkRotationEnabled'], r => {
  linkRotationEnabled = !!r.linkRotationEnabled;
  document.getElementById('toggleLinkRotation').checked = linkRotationEnabled;
});

document.getElementById('toggleLinkRotation').onchange = (e) => {
  linkRotationEnabled = e.target.checked;
  chrome.storage.local.set({ linkRotationEnabled });
  if (!linkRotationEnabled) stopLinkRotation();
};

document.getElementById('btnLinkRotationNext').onclick = () => linkRotationAdvance();
document.getElementById('btnLinkRotationStop').onclick = () => stopLinkRotation();

function pushLinkToRotation(link) {
  if (!link || linkRotationQueue.includes(link)) return;
  linkRotationQueue.push(link);
  if (!linkRotationActive) {
    linkRotationActive = true;
    linkRotationCopyNext();
  } else {
    updateLinkRotationBar();
  }
}

function linkRotationCopyNext() {
  if (linkRotationQueue.length === 0) { stopLinkRotation(); return; }
  const link = linkRotationQueue[0];
  copyText(link);
  linkRotationActive = true;
  document.getElementById('linkRotationBar').classList.add('visible');
  const short = link.length > 48 ? link.substring(0, 48) + '…' : link;
  document.getElementById('linkRotationCurrent').textContent = short;
  document.getElementById('linkRotationCurrent').title = link;
  updateLinkRotationBar();
}

function linkRotationAdvance() {
  linkRotationQueue.shift();
  if (linkRotationQueue.length === 0) { stopLinkRotation(); showToast('✓ 所有链接已复制完毕'); return; }
  linkRotationCopyNext();
}

function stopLinkRotation() {
  linkRotationActive = false;
  linkRotationQueue = [];
  document.getElementById('linkRotationBar').classList.remove('visible');
}

function updateLinkRotationBar() {
  const n = linkRotationQueue.length;
  document.getElementById('linkRotationProg').textContent = n > 1 ? `(队列还剩 ${n} 个)` : '';
}

// Focus/blur auto-advance (link rotation)
window.addEventListener('blur', () => { if (linkRotationActive) _linkBlurred = true; });
window.addEventListener('focus', () => {
  if (linkRotationActive && _linkBlurred) { _linkBlurred = false; linkRotationAdvance(); }
});
document.getElementById('btnAccClear').onclick = async () => {
  if (confirm('清空所有链接和账号记录，并重新扫描收件箱？')) {
    chrome.storage.local.set({ heygenData: [], heygenAccounts: [] }, async () => {
      allData = [];
      allAccounts = [];
      renderTable([]);
      renderAccounts([]);
      chrome.action.setBadgeText({ text: '' });
      showToast('已清空，正在重新扫描…');
      const isGmail = await checkCurrentTab();
      if (isGmail) await sendToContent('RESET_AND_SCAN');
    });
  }
};
document.getElementById('btnAccExport').onclick = () => {
  if (allAccounts.length === 0) { showToast('没有账号可导出'); return; }
  const header = '邮箱,最后收件时间,首次收件时间,收件次数,最新链接\n';
  const rows = allAccounts.map(a =>
    `"${a.email}","${new Date(a.lastSeen).toISOString()}","${new Date(a.firstSeen || a.lastSeen).toISOString()}",${a.count || 1},"${a.latestLink || ''}"`
  ).join('\n');
  const csv = '\uFEFF' + header + rows;
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `heygen_accounts_${new Date().toISOString().split('T')[0]}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('✓ 账号 CSV 已导出');
};

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
    const trySend = () => {
      chrome.tabs.sendMessage(currentTab.id, { type, ...data }, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ success: false, error: chrome.runtime.lastError.message });
        } else {
          resolve(response || { success: true });
        }
      });
    };
    // 首次尝试；若没有接收方（扩展更新后 Gmail 旧页未刷新），自动注入 content.js 再重试
    chrome.tabs.sendMessage(currentTab.id, { type: 'GET_STATUS' }, () => {
      if (chrome.runtime.lastError) {
        chrome.scripting.executeScript(
          { target: { tabId: currentTab.id }, files: ['content.js'] },
          () => {
            if (chrome.runtime.lastError) {
              resolve({ success: false, error: chrome.runtime.lastError.message });
            } else {
              setTimeout(trySend, 300);
            }
          }
        );
      } else {
        trySend();
      }
    });
  });
}

// ─── 静默标记 Gmail 邮件已读（fire-and-forget，不阻塞 UI）───────
function markGmailRead(gmailThreadId, account) {
  if (!currentTab) return;
  // 直接发送，不等待响应，失败也无所谓
  chrome.tabs.sendMessage(currentTab.id, {
    type: 'MARK_GMAIL_READ',
    gmailThreadId: gmailThreadId || '',
    account: account || ''
  }, () => { void chrome.runtime.lastError; }); // 吞掉找不到 content.js 的错误
}

// ─── Expand to Tab ───────────────────────────────────────────
const _isFloat  = new URLSearchParams(location.search).get('float')  === '1';
const _isPopout = new URLSearchParams(location.search).get('popout') === '1';

// 浮窗/独立窗口模式下隐藏弹出和展开按钮（已无意义）
if (_isFloat || _isPopout) {
  document.getElementById('btnExpand')?.style.setProperty('display', 'none');
  document.getElementById('btnPopout')?.style.setProperty('display', 'none');
}

document.getElementById('btnExpand').onclick = () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') });
};

// 浮窗模式：独立 Chrome 小窗口，不受 popup 失焦自动关闭限制
const btnPopout = document.getElementById('btnPopout');
if (btnPopout) {
  btnPopout.onclick = () => {
    chrome.storage.local.get(['popoutBounds'], (r) => {
      const b = r.popoutBounds || {};
      chrome.windows.create({
        url: chrome.runtime.getURL('popup.html?popout=1'),
        type: 'popup',
        width: b.width || 720,
        height: b.height || 800,
        left: b.left,
        top: b.top,
        focused: true
      }, (win) => {
        // 关窗前记录位置，下次打开保持
        if (win) {
          chrome.windows.onBoundsChanged?.addListener(function onChg(w) {
            if (w.id === win.id) {
              chrome.storage.local.set({ popoutBounds: { left: w.left, top: w.top, width: w.width, height: w.height } });
            }
          });
        }
        window.close();
      });
    });
  };
}

// ─── Button Handlers ─────────────────────────────────────────

// Global: close any open dropdowns when clicking outside
document.addEventListener('click', (e) => {
  if (!e.target.closest('#ctrlMoreWrap')) {
    const m = document.getElementById('ctrlMoreMenu');
    if (m) m.style.display = 'none';
  }
  if (!e.target.closest('.cell-actions')) {
    document.querySelectorAll('.row-more-menu').forEach(m => { m.style.display = 'none'; });
  }
});

// Ctrl-bar more menu toggle
const ctrlMoreBtn = document.getElementById('btnCtrlMore');
const ctrlMoreMenu = document.getElementById('ctrlMoreMenu');
if (ctrlMoreBtn && ctrlMoreMenu) {
  ctrlMoreBtn.onclick = (e) => {
    e.stopPropagation();
    ctrlMoreMenu.style.display = ctrlMoreMenu.style.display === 'none' ? 'block' : 'none';
  };
  // Close menu when any item inside is clicked
  ctrlMoreMenu.addEventListener('click', () => {
    ctrlMoreMenu.style.display = 'none';
  });
}

el.statusBadge.style.cursor = 'pointer';
el.statusBadge.onclick = () => {
  if (el.statusBadge.classList.contains('active')) {
    el.btnStop.onclick();
  } else {
    el.btnStart.onclick();
  }
};

el.btnStart.onclick = async () => {
  const isGmail = await checkCurrentTab();
  if (!isGmail) {
    showToast('请先打开 Gmail 页面');
    return;
  }
  const res = await sendToContent('START_MONITORING');
  if (res.success) {
    setStatus(true);
    chrome.storage.local.set({ autoStart: true });
    showToast('监控已启动');
  } else {
    showToast('启动失败，请刷新 Gmail 页面');
  }
};

el.btnStop.onclick = async () => {
  const res = await sendToContent('STOP_MONITORING');
  setStatus(false);
  chrome.storage.local.set({ autoStart: false });
  showToast('监控已停止');
};

el.btnScan.onclick = async () => {
  const isGmail = await checkCurrentTab();
  if (!isGmail) { showToast('请先打开 Gmail 页面'); return; }
  await sendToContent('MANUAL_SCAN');
  showToast('正在扫描...');
  setTimeout(loadData, 2000);
};

el.btnClear.onclick = async () => {
  if (confirm('清空所有链接和账号记录，并重新扫描收件箱？')) {
    chrome.storage.local.set({ heygenData: [], heygenAccounts: [], readLinks: [] }, async () => {
      allData = [];
      allAccounts = [];
      readLinks = new Set();
      renderTable([]);
      renderAccounts([]);
      chrome.action.setBadgeText({ text: '' });
      showToast('已清空，正在重新扫描…');
      const isGmail = await checkCurrentTab();
      if (isGmail) await sendToContent('RESET_AND_SCAN');
    });
  }
};

el.btnCopyAll.onclick = async () => {
  if (allData.length === 0) { showToast('没有数据可复制'); return; }
  const lines = allData.map((d, i) =>
    `${i + 1}\t${d.account || '未识别'}\t${d.verifyLink || '无链接'}\t${d.receivedAt || d.capturedAt || ''}`
  );
  const header = '#\t账号\t验证链接\t收件时间';
  await copyText([header, ...lines].join('\n'));
  showToast(`✓ 已复制 ${allData.length} 条数据`);
};

el.btnExportCSV.onclick = () => {
  if (allData.length === 0) { showToast('没有数据可导出'); return; }
  const header = '序号,注册账号,验证链接,收件时间\n';
  const rows = allData.map((d, i) =>
    `${i + 1},"${d.account || ''}","${d.verifyLink || ''}","${d.receivedAt || d.capturedAt || ''}"`
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
    const hasLink = message.data && message.data.verifyLink &&
      message.data.verifyLink.includes(_linkKeyword);
    if (hasLink) {
      showToast('新验证链接已捕获！');
      renderDuckTab(); // 刷新 Duck tab，点亮对应行的链接按钮
    }
    if (linkRotationEnabled && message.data && message.data.verifyLink) {
      pushLinkToRotation(message.data.verifyLink);
    }
  }
  if (message.type === 'SCAN_PROGRESS') {
    showScanProgress(message.text);
  }
  if (message.type === 'SCAN_DONE') {
    hideScanProgress();
    loadData();
    showToast(`全量扫描完成，共处理 ${message.count || 0} 封邮件`, 3000);
  }
});

// 兜底：storage 变化时自动刷新（tab-mode 下长时间打开不漏数据）
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.customLinkKeyword) {
    _linkKeyword = changes.customLinkKeyword.newValue || DEFAULT_LINK_KEYWORD;
  }
  if (changes.heygenData || changes.heygenAccounts) loadData();
});

// ─── Storage change listener ─────────────────────────────────
chrome.storage.onChanged.addListener((changes) => {
  if (changes.heygenData) {
    allData = changes.heygenData.newValue || [];
    renderTable(allData);
  }
  if (changes.heygenAccounts) {
    allAccounts = changes.heygenAccounts.newValue || [];
    renderAccounts(allAccounts);
  }
});

// ─── Full Scan Modal ─────────────────────────────────────────
let selectedScanMode = 'simple';

document.getElementById('btnFullScan').onclick = async () => {
  const isGmail = await checkCurrentTab();
  if (!isGmail) { showToast('请先打开 Gmail 页面'); return; }
  // restore saved client id
  chrome.storage.local.get(['oauthClientId'], r => {
    if (r.oauthClientId) document.getElementById('oauthClientId').value = r.oauthClientId;
  });
  document.getElementById('scanModal').classList.remove('hidden');
};

document.getElementById('btnScanCancel').onclick = () => {
  document.getElementById('scanModal').classList.add('hidden');
};

// mode card selection
document.querySelectorAll('.mode-card').forEach(card => {
  card.onclick = () => {
    document.querySelectorAll('.mode-card').forEach(c => c.classList.remove('selected'));
    card.classList.add('selected');
    selectedScanMode = card.dataset.mode;
    document.getElementById('clientIdWrap').classList.toggle('visible', selectedScanMode === 'api');
  };
});

document.getElementById('btnScanStart').onclick = async () => {
  document.getElementById('scanModal').classList.add('hidden');

  if (selectedScanMode === 'api') {
    const clientId = document.getElementById('oauthClientId').value.trim();
    if (!clientId) { showToast('请填写 OAuth Client ID'); return; }
    chrome.storage.local.set({ oauthClientId: clientId });
    showToast('Gmail API 模式开发中，请先使用简单模式');
    return;
  }

  // Simple mode
  showScanProgress('正在跳转 Gmail 搜索…');
  const res = await sendToContent('FULL_SCAN_SIMPLE');
  if (!res || !res.success) {
    hideScanProgress();
    showToast('启动失败，请刷新 Gmail 页面');
  }
};

document.getElementById('btnStopScan').onclick = async () => {
  await sendToContent('STOP_FULL_SCAN');
  hideScanProgress();
  showToast('已停止全量扫描');
};

function showScanProgress(text) {
  const el = document.getElementById('scanProgress');
  document.getElementById('scanProgressText').textContent = text || '正在全量扫描…';
  el.classList.add('visible');
}
function hideScanProgress() {
  document.getElementById('scanProgress').classList.remove('visible');
}

// ─── P5: Settings Tab ────────────────────────────────────────
function initSettingsTab() {
  // restore custom link keyword + trash keywords + strip prefixes
  chrome.storage.local.get(['customLinkKeyword', 'trashKeywords', 'stripLinkPrefixes'], (r) => {
    const kwEl = document.getElementById('customLinkKeywordInput');
    if (kwEl) kwEl.value = r.customLinkKeyword || '';
    const tkEl = document.getElementById('trashKeywordsInput');
    if (tkEl) tkEl.value = (r.trashKeywords || []).join('\n');
    const spEl = document.getElementById('stripPrefixesInput');
    if (spEl) spEl.value = (r.stripLinkPrefixes || []).join('\n');
  });

  document.getElementById('btnSaveLinkKeyword').onclick = () => {
    const val = (document.getElementById('customLinkKeywordInput').value || '').trim();
    const kw = val || DEFAULT_LINK_KEYWORD;
    chrome.storage.local.set({ customLinkKeyword: kw });
    _linkKeyword = kw;
    showToast('✓ 激活链接关键词已保存，请重新扫描收件箱');
  };

  document.getElementById('btnResetLinkKeyword').onclick = () => {
    document.getElementById('customLinkKeywordInput').value = '';
    chrome.storage.local.set({ customLinkKeyword: DEFAULT_LINK_KEYWORD });
    _linkKeyword = DEFAULT_LINK_KEYWORD;
    showToast('✓ 已恢复默认链接关键词');
  };

  document.getElementById('btnSaveStripPrefixes').onclick = () => {
    const lines = (document.getElementById('stripPrefixesInput').value || '')
      .split('\n').map(s => s.trim()).filter(Boolean);
    chrome.storage.local.set({ stripLinkPrefixes: lines });
    showToast(`✓ 链接前缀已保存（${lines.length} 条）`);
  };

  document.getElementById('btnClearStripPrefixes').onclick = () => {
    document.getElementById('stripPrefixesInput').value = '';
    chrome.storage.local.set({ stripLinkPrefixes: [] });
    showToast('✓ 链接前缀已清空');
  };

  document.getElementById('btnSaveTrashKeywords').onclick = () => {
    const lines = (document.getElementById('trashKeywordsInput').value || '')
      .split('\n').map(s => s.trim()).filter(Boolean);
    chrome.storage.local.set({ trashKeywords: lines });
    showToast(`✓ 垃圾邮件关键词已保存（${lines.length} 条）`);
  };

  // restore saved settings
  chrome.storage.local.get(['sheetsSyncConfig', 'savedClientId', 'lastSyncAt', 'autoTrashNonVerify', 'monitorScope'], (r) => {
    const scope = r.monitorScope || { mode: 'any', labels: [] };
    const modeRadio = document.querySelector(`input[name="scopeMode"][value="${scope.mode}"]`);
    if (modeRadio) modeRadio.checked = true;
    const labelsInput = document.getElementById('scopeLabels');
    if (labelsInput) labelsInput.value = (scope.labels || []).join(', ');
    const persistScope = () => {
      const mode = (document.querySelector('input[name="scopeMode"]:checked') || {}).value || 'any';
      const labels = (document.getElementById('scopeLabels').value || '')
        .split(',').map(s => s.trim()).filter(Boolean);
      chrome.storage.local.set({ monitorScope: { mode, labels } });
    };
    document.querySelectorAll('input[name="scopeMode"]').forEach(r => r.onchange = persistScope);
    if (labelsInput) labelsInput.oninput = persistScope;
  });

  chrome.storage.local.get(['sheetsSyncConfig', 'savedClientId', 'lastSyncAt', 'autoTrashNonVerify'], (r) => {
    const cfg = r.sheetsSyncConfig || {};
    if (cfg.spreadsheetId) {
      document.getElementById('sheetUrlInput').value =
        `https://docs.google.com/spreadsheets/d/${cfg.spreadsheetId}`;
    }
    document.getElementById('toggleSheetsSync').checked = !!cfg.enabled;
    if (r.savedClientId) document.getElementById('savedClientId').value = r.savedClientId;
    if (r.lastSyncAt) updateSyncStatus('ok', `上次同步: ${formatRelTime(r.lastSyncAt)}`);
    const trashBox = document.getElementById('toggleAutoTrash');
    if (trashBox) {
      trashBox.checked = !!r.autoTrashNonVerify;
      trashBox.onchange = (e) => {
        chrome.storage.local.set({ autoTrashNonVerify: e.target.checked });
      };
    }
  });

  // check if already authed
  chrome.identity.getAuthToken({ interactive: false }, (token) => {
    const err = chrome.runtime.lastError; // 必须读取，否则触发 "Unchecked lastError"
    if (token && !err) setGoogleAuthed(true);
  });
}

function setGoogleAuthed(authed) {
  document.getElementById('googleAuthStatus').textContent = authed ? '✓ 已连接' : '未连接';
  document.getElementById('googleAuthStatus').style.color = authed ? 'var(--accent-green)' : 'var(--text-muted)';
  document.getElementById('btnGoogleAuth').style.display   = authed ? 'none' : '';
  document.getElementById('btnGoogleSignout').style.display = authed ? '' : 'none';
}

function updateSyncStatus(state, text) {
  const dot = document.getElementById('syncDot');
  dot.className = 'sync-dot ' + state;
  document.getElementById('syncStatusText').textContent = text || state;
}

function extractSheetId(urlOrId) {
  if (!urlOrId) return '';
  const m = urlOrId.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : urlOrId.trim();
}

document.getElementById('btnGoogleAuth').onclick = () => {
  chrome.identity.getAuthToken({ interactive: true }, (token) => {
    if (chrome.runtime.lastError || !token) {
      showToast('授权失败: ' + (chrome.runtime.lastError?.message || '未知错误'));
      return;
    }
    setGoogleAuthed(true);
    showToast('✓ Google 账号已连接');
  });
};

document.getElementById('btnGoogleSignout').onclick = () => {
  chrome.identity.getAuthToken({ interactive: false }, (token) => {
    void chrome.runtime.lastError; // 防止 Unchecked lastError
    if (token) chrome.identity.removeCachedAuthToken({ token }, () => {});
  });
  setGoogleAuthed(false);
  showToast('已断开 Google 连接');
};

document.getElementById('toggleSheetsSync').onchange = (e) => {
  const urlVal = document.getElementById('sheetUrlInput').value.trim();
  const sheetId = extractSheetId(urlVal);
  chrome.storage.local.get(['sheetsSyncConfig'], (r) => {
    const cfg = Object.assign({}, r.sheetsSyncConfig || {}, {
      enabled: e.target.checked,
      spreadsheetId: sheetId || (r.sheetsSyncConfig || {}).spreadsheetId || '',
      sheetName: 'Duck邮箱接码'
    });
    chrome.storage.local.set({ sheetsSyncConfig: cfg });
  });
};

document.getElementById('btnSyncNow').onclick = async () => {
  const urlVal = document.getElementById('sheetUrlInput').value.trim();
  const sheetId = extractSheetId(urlVal);

  updateSyncStatus('syncing', '同步中…');

  // if no sheet id, create one
  if (!sheetId) {
    chrome.identity.getAuthToken({ interactive: true }, async (token) => {
      if (!token) { updateSyncStatus('error', '授权失败'); return; }
      try {
        const res = await fetch('https://sheets.googleapis.com/v4/spreadsheets', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            properties: { title: 'Duck邮箱接码备份' },
            sheets: [{ properties: { title: 'Duck邮箱接码' } }]
          })
        });
        const data = await res.json();
        const newId = data.spreadsheetId;
        document.getElementById('sheetUrlInput').value = `https://docs.google.com/spreadsheets/d/${newId}`;
        saveSheetsConfig(newId);
        triggerSync();
      } catch (e) { updateSyncStatus('error', '创建失败: ' + e.message); }
    });
  } else {
    saveSheetsConfig(sheetId);
    triggerSync();
  }
};

function saveSheetsConfig(sheetId) {
  const cfg = { enabled: document.getElementById('toggleSheetsSync').checked, spreadsheetId: sheetId, sheetName: 'Duck邮箱接码' };
  chrome.storage.local.set({ sheetsSyncConfig: cfg });
}

function triggerSync() {
  updateSyncStatus('syncing', '同步中…');
  chrome.runtime.sendMessage({ type: 'SHEETS_SYNC_NOW' }, (res) => {
    if (res && res.success) {
      updateSyncStatus('ok', `同步完成 · ${formatRelTime(Date.now())}`);
      showToast('✓ 已同步到 Google Sheets');
    } else {
      updateSyncStatus('error', '同步失败');
      showToast('同步失败: ' + (res && res.error || '未知'));
    }
  });
}

document.getElementById('btnImportSheets').onclick = () => {
  updateSyncStatus('syncing', '导入中…');
  chrome.runtime.sendMessage({ type: 'SHEETS_IMPORT' }, (res) => {
    if (!res || !res.success) {
      updateSyncStatus('error', '导入失败');
      showToast('导入失败: ' + (res && res.error || '未知'));
      return;
    }
    const imported = res.data || [];
    chrome.storage.local.get(['heygenAccounts'], (r) => {
      const existing = r.heygenAccounts || [];
      // merge: keep newer lastSeen
      imported.forEach(imp => {
        const idx = existing.findIndex(e => e.email.toLowerCase() === imp.email.toLowerCase());
        if (idx >= 0) {
          if ((imp.lastSeen || 0) > (existing[idx].lastSeen || 0)) existing[idx] = { ...existing[idx], ...imp };
        } else {
          existing.push(imp);
        }
      });
      chrome.storage.local.set({ heygenAccounts: existing }, () => {
        allAccounts = existing;
        renderAccounts(allAccounts);
        updateSyncStatus('ok', `导入完成 · ${imported.length} 条`);
        showToast(`✓ 导入 ${imported.length} 条账号`);
      });
    });
  });
};

document.getElementById('btnSaveClientId').onclick = () => {
  const id = document.getElementById('savedClientId').value.trim();
  chrome.storage.local.set({ savedClientId: id });
  showToast('✓ Client ID 已保存');
};

// listen for sync status updates from background
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'SYNC_STATUS') {
    if (msg.status === 'ok') updateSyncStatus('ok', `上次同步: ${formatRelTime(msg.ts)}`);
    if (msg.status === 'error') updateSyncStatus('error', '同步失败: ' + msg.msg);
  }
});

// ══════════════════════════════════════════════════════════════
// ─── Duck Tab ────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════

const DDG_API_BASE = 'https://quack.duckduckgo.com';
let _ddgToken = '';          // 内存中的 token（页面生命周期内有效）
let _ddgLatestAddr = '';     // 本次最新生成的地址

// ── SVG 常量（Duck 面板用）────────────────────────────────────
const DUCK_SVG_COPY  = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
const DUCK_SVG_CHECK = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;

// ── 从 heygenData 扫描 @duck.com 账号，合并到 ddgAddresses ──────
// 调用后 fire-and-forget：如有新地址才写 storage，触发 onChanged 二次渲染
function _mergeDuckFromHeygenData(heygenData, existingAddresses) {
  const existingSet = new Set((existingAddresses || []).map(d => (d.address || '').toLowerCase()));
  const toAdd = [];

  (heygenData || []).forEach(item => {
    const acc = (item.account || '');
    if (!acc.toLowerCase().includes('@duck.com')) return;
    if (existingSet.has(acc.toLowerCase())) return;
    existingSet.add(acc.toLowerCase());
    toAdd.push({
      address: acc,
      createdAt: item.receivedAt || item.capturedAt || new Date().toISOString(),
      source: 'scanned'
    });
  });

  if (toAdd.length === 0) return;

  const merged = [...toAdd, ...(existingAddresses || [])]
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
    .slice(0, 500);

  chrome.storage.local.set({ ddgAddresses: merged });
}

// ── 导出 Duck 地址 CSV ────────────────────────────────────────
function exportDuckCSV() {
  chrome.storage.local.get(['ddgAddresses'], r => {
    const list = r.ddgAddresses || [];
    if (list.length === 0) { showToast('没有 Duck 地址可导出'); return; }
    const srcLabel = { generated: 'API生成', 'ddg-page': 'DDG页面', scanned: 'Gmail扫描' };
    const header = 'Duck地址,来源,时间\n';
    const rows = list.map(d =>
      `"${d.address || ''}","${srcLabel[d.source] || d.source || ''}","${d.createdAt || ''}"`
    ).join('\n');
    const blob = new Blob(['\uFEFF' + header + rows], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `duck_addresses_${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    showToast(`✓ 已导出 ${list.length} 条 Duck 地址`);
  });
}

// ── 为 Duck 地址匹配验证链接 ──────────────────────────────────
// 优先：精确账号匹配（link.account === duck 地址，来自 magic-link base64 解码）
// 兜底：时间区间匹配（账号解码失败或为空时）
function _findLinkForDuck(duckItem, allDuckAddresses, allLinks) {
  if (!allLinks || allLinks.length === 0) return null;

  const addr = (duckItem.address || '').toLowerCase();

  // ── 精确匹配：link.account 就是注册 HeyGen 用的邮箱 ──────────
  const exact = allLinks.filter(link =>
    link.verifyLink && (link.account || '').toLowerCase() === addr
  );
  if (exact.length > 0) {
    // 多条时取最新的
    exact.sort((a, b) =>
      new Date(b.capturedAt || b.receivedAt || 0) - new Date(a.capturedAt || a.receivedAt || 0)
    );
    return exact[0];
  }

  // ── 兜底：时间区间（account 为空或非 duck 地址时）────────────
  if (!duckItem.createdAt) return null;
  const t0 = new Date(duckItem.createdAt).getTime();

  const sortedDuck = [...allDuckAddresses]
    .filter(d => d.createdAt)
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  const idx = sortedDuck.findIndex(d => d.address === duckItem.address);
  const nextDuck = sortedDuck[idx + 1];
  const t1 = nextDuck ? new Date(nextDuck.createdAt).getTime() : Date.now() + 1;

  const window_ = allLinks.filter(link => {
    if (!link.verifyLink || link.account) return false; // account 有值时跳过（已被精确匹配覆盖）
    const lt = new Date(link.capturedAt || link.receivedAt || 0).getTime();
    return lt >= t0 && lt <= t1;
  });
  if (window_.length === 0) return null;

  window_.sort((a, b) =>
    new Date(b.capturedAt || b.receivedAt || 0) - new Date(a.capturedAt || a.receivedAt || 0)
  );
  return window_[0];
}

// ── 渲染 Duck Tab ─────────────────────────────────────────────
async function renderDuckTab() {
  const stored = await new Promise(r =>
    chrome.storage.local.get(['ddgToken', 'ddgTokenAt', 'ddgAddresses', 'heygenData'], r)
  );

  _ddgToken = stored.ddgToken || '';
  const allLinks = stored.heygenData || [];
  // 扫描 heygenData，把 @duck.com 账号合并进来（fire-and-forget）
  _mergeDuckFromHeygenData(allLinks, stored.ddgAddresses || []);
  const history = stored.ddgAddresses || [];

  // 有 token → 直接生成升为主按钮；无 token → 一键自动生成为主按钮
  const btnAutoGen = document.getElementById('btnDuckAutoGenerate');
  const btnGen     = document.getElementById('btnDuckGenerate');
  if (btnAutoGen && btnGen) {
    if (_ddgToken) {
      btnGen.className     = 'btn btn-primary';
      btnGen.style.display = '';
      btnAutoGen.style.display = 'none';
    } else {
      btnAutoGen.className     = 'btn btn-primary';
      btnAutoGen.style.display = '';
      btnGen.style.display     = 'none';
    }
  }

  // 更新 token 已保存提示区
  const savedEl = document.getElementById('duckTokenSaved');
  const infoEl  = document.getElementById('duckTokenInfo');
  if (savedEl) {
    if (_ddgToken) {
      savedEl.style.display = 'flex';
      if (infoEl) {
        const ago = stored.ddgTokenAt ? formatRelTime(stored.ddgTokenAt) + ' 保存' : '';
        infoEl.textContent = `Token: ${_ddgToken.substring(0, 8)}…${ago ? '  ·  ' + ago : ''}`;
      }
    } else {
      savedEl.style.display = 'none';
    }
  }

  // 更新历史计数标题
  const countEl = document.getElementById('duckHistoryCount');
  if (countEl) countEl.textContent = `历史地址（${history.length} 条）`;

  // 渲染历史（传入验证链接列表，用于匹配）
  _renderDuckHistory(history, allLinks);
}

function _renderDuckHistory(history, allLinks) {
  const listEl = document.getElementById('duckHistoryList');
  if (!listEl) return;
  listEl.innerHTML = '';

  if (!history || history.length === 0) {
    listEl.innerHTML = `
      <div class="duck-empty">
        <div class="duck-empty-icon">
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
        </div>
        <div class="duck-empty-text">还没有生成过地址</div>
      </div>`;
    return;
  }

  const links = allLinks || [];

  // 按生成时间降序（最新在最上）
  const sorted = [...history].sort((a, b) =>
    new Date(b.createdAt || 0) - new Date(a.createdAt || 0)
  );

  sorted.forEach((item, idx) => {
    // 查找匹配的验证链接
    const matchedLink = _findLinkForDuck(item, history, links);
    const linkUsed = !!(matchedLink && matchedLink.id && readLinks.has(matchedLink.id));
    const hasLink = !!(matchedLink && matchedLink.verifyLink) && !linkUsed;

    const row = document.createElement('div');
    const isNew = idx === 0 && item.address === _ddgLatestAddr;
    row.className = 'duck-row' + (isNew ? ' duck-row-new' : '');

    const d = item.createdAt ? new Date(item.createdAt) : null;
    const timeStr = d
      ? d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      : '';

    // 来源角标
    const srcMap = { generated: { label: '生成', color: 'var(--accent-cyan)' },
                     'ddg-page': { label: 'DDG',  color: 'var(--text-muted)' },
                      scanned:   { label: '扫描', color: 'var(--accent-green)' } };
    const srcInfo = srcMap[item.source || ''] || { label: '', color: 'var(--text-muted)' };
    const srcBadge = srcInfo.label
      ? `<span style="font-size:10px;padding:1px 5px;border-radius:4px;border:1px solid ${srcInfo.color};color:${srcInfo.color};opacity:0.8;flex-shrink:0">${srcInfo.label}</span>`
      : '';

    // 链接按钮 SVG
    const SVG_LINK = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`;

    row.innerHTML = `
      <span class="duck-row-addr" title="${item.address}">${item.address}</span>
      ${srcBadge}
      <span class="duck-row-time">${timeStr}</span>
      <button class="duck-link-btn ${hasLink ? 'has-link' : linkUsed ? 'link-used' : ''}"
              title="${hasLink ? '点击复制验证链接：' + matchedLink.verifyLink.substring(0, 60) + '…' : (linkUsed ? '已使用（点击可再次复制）' : '等待验证邮件到达…')}"
              data-link="${matchedLink ? escHtml(matchedLink.verifyLink || '') : ''}"
              data-id="${matchedLink ? escHtml(matchedLink.id || '') : ''}"
              ${!matchedLink || !matchedLink.verifyLink ? 'disabled' : ''}>
        ${SVG_LINK} 链接
      </button>
      <button class="action-btn duck-copy-btn" title="复制 Duck 地址" data-addr="${item.address}">${DUCK_SVG_COPY}</button>
    `;
    listEl.appendChild(row);
  });

  // 绑定「复制 / 拖拽验证链接」按钮
  const SVG_LINK_ICON = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`;
  const SVG_CHECK_ICON = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;

  listEl.querySelectorAll('.duck-link-btn[data-link]:not([data-link=""])').forEach(btn => {
    // 点击复制
    btn.onclick = async (e) => {
      const { link, id } = e.currentTarget.dataset;
      if (!link) return;
      await copyText(link);
      markLinkRead(id);
      _duckMarkLinkUsed(e.currentTarget);
      showToast('✓ 验证链接已复制');
    };

    // 拖拽：把链接设为 drag data，可拖到浏览器地址栏或其他标签页
    btn.setAttribute('draggable', 'true');
    btn.addEventListener('dragstart', e => {
      const link = btn.dataset.link;
      if (!link) return;
      e.dataTransfer.setData('text/uri-list', link);
      e.dataTransfer.setData('text/plain', link);
      e.dataTransfer.effectAllowed = 'copyLink';
    });
    btn.addEventListener('dragend', e => {
      if (e.dataTransfer.dropEffect !== 'none') {
        markLinkRead(btn.dataset.id);
        _duckMarkLinkUsed(btn);
        showToast('✓ 验证链接已拖出');
      }
    });
  });

  function _duckMarkLinkUsed(btn) {
    btn.classList.remove('has-link');
    btn.classList.add('copied');
    btn.innerHTML = SVG_CHECK_ICON + ' 已复制';
    setTimeout(() => { btn.innerHTML = SVG_LINK_ICON + ' 链接'; }, 1500);
  }

  // 绑定「复制 Duck 地址」按钮
  listEl.querySelectorAll('.duck-copy-btn').forEach(btn => {
    btn.onclick = async (e) => {
      const addr = e.currentTarget.dataset.addr;
      if (!addr) return;
      await copyText(addr);
      e.currentTarget.innerHTML = DUCK_SVG_CHECK;
      e.currentTarget.classList.add('copied');
      setTimeout(() => {
        e.currentTarget.innerHTML = DUCK_SVG_COPY;
        e.currentTarget.classList.remove('copied');
      }, 1500);
      showToast('✓ Duck 地址已复制');
    };
  });
}

// ── 调用 DDG API 生成新地址 ───────────────────────────────────
async function duckGenerateAddress() {
  if (!_ddgToken) {
    showToast('请先连接 DuckDuckGo 邮箱');
    return;
  }

  const btn = document.getElementById('btnDuckGenerate');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `
      <svg class="spin" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
      生成中…`;
  }

  try {
    const resp = await fetch(`${DDG_API_BASE}/api/email/addresses`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${_ddgToken}`,
        'Content-Type': 'application/json'
      }
    });

    if (resp.status === 401) {
      // token 失效
      chrome.storage.local.remove(['ddgToken', 'ddgTokenAt']);
      _ddgToken = '';
      showToast('DDG 凭证已过期，请重新访问设置页');
      renderDuckTab();
      return;
    }

    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

    const data = await resp.json();
    if (!data || !data.address) throw new Error('响应格式异常');

    const address = data.address.includes('@')
      ? data.address
      : data.address + '@duck.com';

    _ddgLatestAddr = address;

    // 保存到历史
    const stored = await new Promise(r => chrome.storage.local.get(['ddgAddresses'], r));
    const history = stored.ddgAddresses || [];
    if (!history.some(a => a.address === address)) {
      history.unshift({ address, createdAt: new Date().toISOString(), source: 'generated' });
      chrome.storage.local.set({ ddgAddresses: history.slice(0, 200) });
    }

    // 显示结果
    const resultBox  = document.getElementById('duckResultBox');
    const resultAddr = document.getElementById('duckResultAddr');
    if (resultBox && resultAddr) {
      resultAddr.textContent = address;
      resultBox.classList.add('visible');
    }

    // 自动复制到剪贴板
    await copyText(address);
    showToast('✓ Duck 地址已生成并复制');

    // 刷新历史列表
    const updatedStored = await new Promise(r => chrome.storage.local.get(['ddgAddresses'], r));
    _renderDuckHistory(updatedStored.ddgAddresses || []);

  } catch (err) {
    showToast('生成失败：' + (err.message || '未知错误'));
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        生成新 Duck 地址`;
    }
  }
}

// ── 一键自动生成 ──────────────────────────────────────────────
// 有 token → 直接调用 DDG API（即时，无需打开任何页面）
// 无 token → 后台打开 DDG 页面，模拟点击 Generate + Copy
async function duckOneClickGenerate() {
  // ── 快速路径：token 已配置，直接用 API ──────────────────────
  if (_ddgToken) {
    return duckGenerateAddress();
  }

  // ── 慢速路径：无 token，自动化页面操作 ──────────────────────
  const btn = document.getElementById('btnDuckAutoGenerate');
  const originalHTML = btn ? btn.innerHTML : '';
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<svg class="spin" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg> 正在打开 DDG 页面…`;
  }

  let tabId = null;
  try {
    // 1. 后台静默打开 DDG 生成页面（active: false 不抢焦点）
    const tab = await new Promise(resolve =>
      chrome.tabs.create({ url: 'https://duckduckgo.com/email/settings/autofill', active: false }, resolve)
    );
    tabId = tab.id;

    // 2. 等待页面加载完成（最多 15 秒）
    await new Promise(resolve => {
      const listener = (id, info) => {
        if (id === tabId && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
      setTimeout(resolve, 15000);
    });

    // 3. 额外等待 3 秒让 React/动态内容及 DDG 扩展注入完成
    await new Promise(r => setTimeout(r, 3000));

    // 4. 查找并点击 Generate 按钮（宽泛匹配）
    const genResult = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const allBtns = Array.from(document.querySelectorAll('button, [role="button"], a'));
        // 收集所有按钮文字，方便调试
        const btnTexts = allBtns.map(b => ({
          text: b.textContent.trim().substring(0, 60),
          id: b.id || '',
          cls: (b.className || '').toString().substring(0, 60),
          testId: b.getAttribute('data-testid') || '',
          label: b.getAttribute('aria-label') || ''
        }));

        // 文字匹配：Generate 相关
        const genBtn = allBtns.find(b => {
          const t = (b.textContent.trim() + ' ' +
                     (b.getAttribute('aria-label') || '') + ' ' +
                     (b.getAttribute('data-testid') || '')).toLowerCase();
          return /\bgenerate\b/.test(t) || /new.{0,10}address/i.test(t) ||
                 /get.{0,10}address/i.test(t);
        });
        if (genBtn) { genBtn.click(); return { found: true, text: genBtn.textContent.trim(), btnTexts }; }

        // 属性匹配
        const attrBtn = document.querySelector(
          '[data-testid*="generate" i],[data-id*="generate" i],[class*="generate" i]'
        );
        if (attrBtn) { attrBtn.click(); return { found: true, fallback: 'attr', btnTexts }; }

        return { found: false, btnTexts };
      }
    });

    const genRes = genResult[0]?.result;

    if (!genRes?.found) {
      // 找不到按钮 → 把 tab 切到前台让用户手动操作，并把按钮列表存到 console 供调试
      console.warn('[Duck邮箱接码] DDG Generate 按钮未找到，已有按钮：', genRes?.btnTexts);
      await chrome.tabs.update(tabId, { active: true });
      tabId = null;
      showToast('未找到 Generate 按钮，已打开页面，请手动操作');
      return;
    }

    // 5. 等待新地址出现（2 秒）
    await new Promise(r => setTimeout(r, 2000));

    // 6. 点击 Copy 按钮
    const copyResult = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const allBtns = Array.from(document.querySelectorAll('button, [role="button"]'));
        const copyBtn = allBtns.find(b => {
          const t = (b.textContent.trim() + ' ' +
                     (b.getAttribute('aria-label') || '') + ' ' +
                     (b.getAttribute('data-testid') || '')).toLowerCase();
          return /\bcopy\b/.test(t);
        });
        if (copyBtn) { copyBtn.click(); return { found: true, text: copyBtn.textContent.trim() }; }
        const attrBtn = document.querySelector(
          '[data-testid*="copy" i],[class*="copy-btn" i],[class*="copyBtn" i]'
        );
        if (attrBtn) { attrBtn.click(); return { found: true, fallback: 'attr' }; }
        return { found: false };
      }
    });

    // 7. 等待剪贴板拦截器 → postMessage → ddg-content.js → storage 完成
    await new Promise(r => setTimeout(r, 1200));

    // 8. 关闭后台标签页
    chrome.tabs.remove(tabId);
    tabId = null;

    const copyRes = copyResult[0]?.result;
    if (copyRes?.found) {
      showToast('✓ 已自动生成，地址已加入下方列表');
    } else {
      showToast('Generate 已点击，等待 DOM 轮询捕获地址（Copy 未找到）');
    }

  } catch (err) {
    showToast('自动生成失败：' + (err.message || '未知错误'));
    if (tabId) { try { chrome.tabs.remove(tabId); } catch (_) {} }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = originalHTML;
    }
  }
}

// ── 初始化 Duck Tab 事件 ──────────────────────────────────────
function initDuckTab() {
  // 一键自动生成
  const btnAutoGen = document.getElementById('btnDuckAutoGenerate');
  if (btnAutoGen) btnAutoGen.onclick = duckOneClickGenerate;

  // 手动打开 DDG 页面
  const btnOpenPage = document.getElementById('btnDuckOpenPage');
  if (btnOpenPage) {
    btnOpenPage.onclick = () => {
      chrome.tabs.create({ url: 'https://duckduckgo.com/email/settings/autofill' });
    };
  }

  // 直接生成（需要 token）
  const btnGen = document.getElementById('btnDuckGenerate');
  if (btnGen) btnGen.onclick = duckGenerateAddress;

  // 复制最新结果
  const btnCopyResult = document.getElementById('btnDuckCopyResult');
  if (btnCopyResult) {
    btnCopyResult.onclick = async () => {
      const addr = document.getElementById('duckResultAddr')?.textContent || '';
      if (!addr) return;
      await copyText(addr);
      btnCopyResult.innerHTML = DUCK_SVG_CHECK;
      btnCopyResult.classList.add('copied');
      setTimeout(() => {
        btnCopyResult.innerHTML = DUCK_SVG_COPY;
        btnCopyResult.classList.remove('copied');
      }, 1500);
      showToast('✓ Duck 地址已复制');
    };
  }

  // 手动保存 token
  const btnManualSave = document.getElementById('btnDuckManualSave');
  const manualInput   = document.getElementById('duckManualToken');
  if (btnManualSave && manualInput) {
    btnManualSave.onclick = () => {
      const token = (manualInput.value || '').trim();
      if (!token || token.length < 10) { showToast('请粘贴有效的 token'); return; }
      chrome.storage.local.set({ ddgToken: token, ddgTokenAt: Date.now() });
      _ddgToken = token;
      manualInput.value = '';
      renderDuckTab();
      showToast('✓ Token 已保存');
    };
    manualInput.onkeydown = (e) => { if (e.key === 'Enter') btnManualSave.click(); };
  }

  // 移除 token
  const btnRemoveToken = document.getElementById('btnDuckRemoveToken');
  if (btnRemoveToken) {
    btnRemoveToken.onclick = () => {
      chrome.storage.local.remove(['ddgToken', 'ddgTokenAt']);
      _ddgToken = '';
      renderDuckTab();
      showToast('Token 已移除');
    };
  }

  // 导出 CSV
  const btnExportDuck = document.getElementById('btnDuckExportCSV');
  if (btnExportDuck) btnExportDuck.onclick = exportDuckCSV;

  // 同步到 Google Sheets
  const btnSyncDuck = document.getElementById('btnDuckSyncSheets');
  if (btnSyncDuck) {
    btnSyncDuck.onclick = () => {
      chrome.runtime.sendMessage({ type: 'SHEETS_SYNC_DUCK_NOW' }, (res) => {
        void chrome.runtime.lastError;
        if (res && res.success) showToast('✓ Duck 地址已同步到 Sheets');
        else showToast('同步失败（请先在设置页配置 Google Sheets）');
      });
    };
  }

  // 清空历史
  const btnClearHist = document.getElementById('btnDuckClearHistory');
  if (btnClearHist) {
    btnClearHist.onclick = () => {
      chrome.storage.local.remove(['ddgAddresses']);
      _ddgLatestAddr = '';
      _renderDuckHistory([]);
      showToast('历史已清空');
    };
  }

  // Storage 变化时实时刷新（DDG 地址/token 更新 or 新验证链接到达）
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.ddgToken || changes.ddgAddresses || changes.heygenData) renderDuckTab();
  });

  // 监听 content/background 消息
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'DDG_ADDRESS_CAPTURED') {
      _ddgLatestAddr = msg.address || '';
      // 在结果框显示刚捕获到的地址
      const resultBox  = document.getElementById('duckResultBox');
      const resultAddr = document.getElementById('duckResultAddr');
      if (resultBox && resultAddr && _ddgLatestAddr) {
        resultAddr.textContent = _ddgLatestAddr;
        resultBox.classList.add('visible');
      }
      renderDuckTab();
    }
    if (msg.type === 'DDG_TOKEN_UPDATED') {
      renderDuckTab();
    }
  });

  // 初始渲染
  renderDuckTab();
}

// 添加旋转动画 CSS
(function addSpinCss() {
  if (document.getElementById('hgc-spin-style')) return;
  const s = document.createElement('style');
  s.id = 'hgc-spin-style';
  s.textContent = `.spin{animation:spin 0.7s linear infinite}`;
  document.head.appendChild(s);
})();

// ─── Init ────────────────────────────────────────────────────
async function init() {
  // 如果在独立标签页打开，切换为全屏模式
  if (window.innerWidth > 700) document.body.classList.add('tab-mode');
  // 先加载链接关键词，确保渲染时已正确过滤
  await new Promise(resolve => chrome.storage.local.get(['customLinkKeyword'], r => {
    _linkKeyword = r.customLinkKeyword || DEFAULT_LINK_KEYWORD;
    resolve();
  }));
  loadReadLinks();
  initSortHeaders();
  initViewSwitching();
  initSettingsTab();
  initDuckTab();
  const isGmail = await checkCurrentTab();

  if (!isGmail) {
    // Show warning but still show data
    // Don't hide main content, just show toast
    showToast('当前页面不是 Gmail');
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
