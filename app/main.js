import {
  applyOperation, archiveAccount, compareEntriesNewestFirst, createAccount, createLedger, deriveLedger, formatRM, householdTotals,
  monthlySummary, moveToRecycleBin, permanentlyDelete, reconcile, restoreFromRecycleBin,
  serialiseLedger, updateAccount, updateTransaction
} from './ledger.js';

const STORE = 'family-wallet-v2-local-demo';
const ENTRY_PREFS_STORE = 'family-wallet-v2-entry-preferences';
const ENTRY_CATEGORIES = ['薪水', '购物', '医疗', '房贷', '电费', '税费', '打油', '汽车'];
const accountDetailPageSize = () => innerWidth < 600 ? 6 : 10;
const $ = selector => document.querySelector(selector);
const today = () => new Date().toISOString().slice(0, 10);
const uid = prefix => `${prefix}-${Date.now()}-${crypto.getRandomValues(new Uint32Array(1))[0].toString(36)}`;
const seed = () => createLedger({ accounts: [
  { id:'maybank', name:'Maybank', kind:'asset', openingBalanceMinor:520000, balanceMinor:520000, includeInTotal:true, archivedAt:null },
  { id:'pbb', name:'Public Bank', kind:'asset', openingBalanceMinor:30000, balanceMinor:30000, includeInTotal:false, archivedAt:null },
  { id:'card', name:'信用卡', kind:'liability', openingBalanceMinor:12500, balanceMinor:12500, includeInTotal:true, archivedAt:null }
], transactions: [], appliedOperationIds: [] });

const viewTitles = { overview:'概览', entries:'账目', accounts:'账户' };
const walletIcon = '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M17 8v-3a1 1 0 0 0 -1 -1h-10a2 2 0 0 0 0 4h12a1 1 0 0 1 1 1v3M19 16v3a1 1 0 0 1 -1 1h-12a2 2 0 0 1 -2 -2v-12M20 12v4h-4a2 2 0 0 1 0 -4h4"/></svg>';
const chevronIcon = '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M9 6l6 6l-6 6"/></svg>';

let ledger = hydrate();
let saveLocked = false;
let pendingOperationId = uid('op');
let toastTimer;
let selectedMonth = today().slice(0, 7);
let activeView = 'overview';
let entryPreferences = hydrateEntryPreferences();
let selectedAccountDetailId = null;
let accountDetailPage = 1;
let pendingAccountPhotoDataUrl = null;
let runtimeMode = 'starting';
let cloud = null;
let cloudUser = null;
let cloudProfile = null;
let currentHousehold = null;
let pendingInvite = null;
let stopUserWatch = null;
let stopHouseholdWatch = null;
let stopInviteWatch = null;

function hydrate() {
  try {
    const raw = localStorage.getItem(STORE);
    return raw ? createLedger(JSON.parse(raw)) : seed();
  } catch {
    return seed();
  }
}

function hydrateEntryPreferences() {
  const fallback = { lastKind:'expense', byKind:{ expense:{}, income:{}, transfer:{} } };
  try {
    const parsed = JSON.parse(localStorage.getItem(ENTRY_PREFS_STORE) || 'null');
    if (!parsed || !['expense', 'income', 'transfer'].includes(parsed.lastKind)) return fallback;
    for (const kind of ['expense', 'income', 'transfer']) {
      const preference = parsed.byKind?.[kind] || {};
      fallback.byKind[kind] = {
        accountId:typeof preference.accountId === 'string' ? preference.accountId : null,
        targetAccountId:typeof preference.targetAccountId === 'string' ? preference.targetAccountId : null
      };
    }
    fallback.lastKind = parsed.lastKind;
    return fallback;
  } catch {
    return fallback;
  }
}

function persist() {
  if (runtimeMode === 'local') localStorage.setItem(STORE, JSON.stringify(serialiseLedger(ledger)));
}

function showApp() {
  $('#authGate').hidden = true;
  $('#appShell').hidden = false;
  $('#bottomNav').hidden = false;
}

function showAuth(message) {
  $('#authMessage').textContent = message;
  $('#authGate').hidden = false;
  $('#appShell').hidden = true;
  $('#bottomNav').hidden = true;
}

function setSyncState(message, bad = false) {
  $('#syncBadge').textContent = message;
  $('#syncBadge').classList.toggle('bad', bad);
}

function showDialog(dialog) {
  dialog.classList.remove('is-closing');
  dialog.showModal();
}

function dismissDialog(dialog, afterClose) {
  if (!dialog?.open || dialog.classList.contains('is-closing')) return;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    dialog.close();
    afterClose?.();
    return;
  }
  dialog.classList.add('is-closing');
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    dialog.classList.remove('is-closing');
    dialog.close();
    afterClose?.();
  };
  dialog.addEventListener('animationend', finish, { once:true });
  setTimeout(finish, 190);
}

function usesCloudStore() { return runtimeMode === 'cloud' || runtimeMode === 'emulator'; }

async function saveAccountRecord(nextLedger, accountId) {
  const account = nextLedger.accounts.find(item => item.id === accountId);
  if (usesCloudStore()) await cloud.saveAccount(currentHousehold.id, account);
}

async function saveTransactionRecord(nextLedger, transactionId) {
  const entry = nextLedger.transactions.find(item => item.id === transactionId);
  if (usesCloudStore()) await cloud.saveTransaction(currentHousehold.id, entry, cloudUser.uid);
}

async function applyLedgerChange(nextLedger, cloudWrite) {
  const previous = ledger;
  try {
    if (usesCloudStore()) {
      setSyncState('保存中');
      await cloudWrite(nextLedger);
      setSyncState('已同步');
    }
    ledger = nextLedger;
    persist();
    render();
  } catch (error) {
    ledger = previous;
    setSyncState('同步失败', true);
    throw error;
  }
}
function activeAccounts() { return ledger.accounts.filter(account => !account.archivedAt); }
function accountById(id) { return ledger.accounts.find(account => account.id === id) || null; }
function liveEntries() { return ledger.transactions.filter(entry => !entry.deletedAt && !entry.purgedAt); }
function selectedEntries() { return liveEntries().filter(entry => entry.occurredAt.slice(0, 7) === selectedMonth); }

function accountAvatarMarkup(account) {
  return account?.photoDataUrl
    ? `<img src="${escapeHtml(account.photoDataUrl)}" alt="">`
    : walletIcon;
}

function accountFlowLabel(entry) {
  const source = accountById(entry.accountId)?.name || '未知账户';
  if (entry.kind !== 'transfer') return source;
  const target = accountById(entry.targetAccountId)?.name || '未知账户';
  return `${source} → ${target}`;
}

function rememberEntryPreferences(kind, accountId, targetAccountId) {
  entryPreferences.lastKind = kind;
  entryPreferences.byKind[kind] = {
    accountId,
    targetAccountId:kind === 'transfer' ? targetAccountId : null
  };
  localStorage.setItem(ENTRY_PREFS_STORE, JSON.stringify(entryPreferences));
}

function applyRememberedAccounts(kind) {
  const accounts = activeAccounts();
  if (!accounts.length) return;
  const remembered = entryPreferences.byKind[kind] || {};
  const sourceId = accounts.some(account => account.id === remembered.accountId) ? remembered.accountId : accounts[0].id;
  $('#sourceAccount').value = sourceId;
  if (kind !== 'transfer') return;
  const fallbackTarget = accounts.find(account => account.id !== sourceId)?.id || sourceId;
  const targetId = accounts.some(account => account.id === remembered.targetAccountId && account.id !== sourceId)
    ? remembered.targetAccountId
    : fallbackTarget;
  $('#targetAccount').value = targetId;
}

function amountToSen(value, allowNegative = false) {
  const text = String(value).trim().replace(/,/g, '');
  if (!/^[-+]?\d+(\.\d{1,2})?$/.test(text)) throw new Error('请输入有效的 RM 金额');
  const amount = Math.round(Number(text) * 100);
  if (!Number.isSafeInteger(amount) || (!allowNegative && amount <= 0)) throw new Error('金额必须大于零');
  return amount;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]));
}

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2800);
}

function dateLabel(value) {
  return new Intl.DateTimeFormat('zh-CN', { month:'short', day:'numeric' }).format(new Date(value));
}

function monthLabel(value) {
  return new Intl.DateTimeFormat('zh-CN', { year:'numeric', month:'long' }).format(new Date(`${value}-01T00:00:00`));
}

function typeLabel(kind) { return ({ income:'收入', expense:'支出', transfer:'转账' })[kind] || kind; }
function senToAmount(value) { return (value / 100).toFixed(2); }

function setView(view, scroll = true) {
  if (!viewTitles[view]) return;
  activeView = view;
  document.querySelectorAll('[data-view]').forEach(section => { section.hidden = section.dataset.view !== view; });
  document.querySelectorAll('[data-view-target]').forEach(button => {
    const current = button.dataset.viewTarget === view;
    button.classList.toggle('active', current);
    if (current) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  $('#viewTitle').textContent = viewTitles[view];
  if (scroll) window.scrollTo({ top:0, behavior:'smooth' });
}

function renderTransactionRows(entries, emptyTitle, emptyBody, contextAccountId = null) {
  if (!entries.length) {
    return `<div class="empty-state"><b>${escapeHtml(emptyTitle)}</b><p>${escapeHtml(emptyBody)}</p><button class="secondary-button" type="button" data-add-entry>记录第一笔</button></div>`;
  }
  return entries.map(entry => {
    const sign = entry.kind === 'expense' ? '−' : entry.kind === 'income' ? '＋' : '↔';
    let amountClass = entry.kind === 'expense' ? 'expense' : '';
    let amount = entry.kind === 'transfer' ? '转账' : `${entry.kind === 'expense' ? '−' : '＋'}${formatRM(entry.amountMinor)}`;
    if (entry.kind === 'transfer' && contextAccountId) {
      const outgoing = entry.accountId === contextAccountId;
      amountClass = outgoing ? 'expense' : '';
      amount = `${outgoing ? '−' : '＋'}${formatRM(entry.amountMinor)}`;
    }
    const metadata = `${dateLabel(entry.occurredAt)} · ${accountFlowLabel(entry)} · ${entry.note || '无备注'}`;
    return `<button class="transaction-row" data-transaction-id="${escapeHtml(entry.id)}" aria-label="编辑 ${typeLabel(entry.kind)} ${formatRM(entry.amountMinor)}"><span class="transaction-icon ${entry.kind}">${sign}</span><span class="transaction-main"><b>${escapeHtml(entry.category || typeLabel(entry.kind))}</b><small>${escapeHtml(metadata)}</small></span><span class="transaction-value ${amountClass}">${amount}</span></button>`;
  }).join('');
}

function spendingCategories(entries) {
  const totals = new Map();
  for (const entry of entries) {
    if (entry.kind !== 'expense') continue;
    const category = String(entry.category || '其他').trim() || '其他';
    totals.set(category, (totals.get(category) || 0) + entry.amountMinor);
  }
  const rows = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  const total = rows.reduce((sum, [, amount]) => sum + amount, 0);
  return rows.slice(0, 3).map(([category, amount], index) => ({
    category,
    amount,
    rank:index + 1,
    percent:total ? Math.round((amount / total) * 100) : 0
  }));
}

function renderCategoryInsights(entries) {
  const categories = spendingCategories(entries);
  if (!categories.length) {
    return '<div class="empty-state"><b>还没有本月支出</b><p>记录第一笔支出后，这里会显示钱主要花在哪里。</p><button class="secondary-button" type="button" data-add-entry>新增支出</button></div>';
  }
  return categories.map(item => `<div class="category-row"><span class="category-rank">${item.rank}</span><span class="category-main"><b>${escapeHtml(item.category)}</b><small>本月支出分类</small></span><span class="category-value"><b>${formatRM(item.amount)}</b><small>${item.percent}%</small></span></div>`).join('');
}

function renderAccountDetail() {
  const account = accountById(selectedAccountDetailId);
  if (!account) return;
  const entries = liveEntries()
    .filter(entry => entry.occurredAt.slice(0, 7) === selectedMonth)
    .filter(entry => entry.accountId === account.id || entry.targetAccountId === account.id)
    .sort(compareEntriesNewestFirst);
  const pageSize = accountDetailPageSize();
  const totalPages = Math.max(1, Math.ceil(entries.length / pageSize));
  accountDetailPage = Math.min(Math.max(1, accountDetailPage), totalPages);
  const pageStart = (accountDetailPage - 1) * pageSize;
  const visibleEntries = entries.slice(pageStart, pageStart + pageSize);
  $('#accountDetailName').textContent = account.name;
  $('#accountDetailKind').textContent = account.kind === 'liability' ? '负债账户' : '资产账户';
  $('#accountDetailBalance').textContent = formatRM(account.balanceMinor);
  $('#accountDetailAvatar').innerHTML = accountAvatarMarkup(account);
  $('#accountDetailMonthLabel').textContent = `${monthLabel(selectedMonth)}账目`;
  $('#accountDetailCount').textContent = `${entries.length} 笔记录`;
  $('#accountDetailTransactionList').innerHTML = renderTransactionRows(visibleEntries, '这个月没有相关账目', '此账户在所选月份没有收入、支出或转账。', account.id);
  const pagination = $('#accountDetailPagination');
  pagination.hidden = totalPages <= 1;
  $('#accountDetailPageLabel').textContent = `第 ${accountDetailPage} / ${totalPages} 页`;
  $('#accountDetailPrevPage').disabled = accountDetailPage === 1;
  $('#accountDetailNextPage').disabled = accountDetailPage === totalPages;
  bindRenderedControls($('#accountDetailTransactionList'));
}

function openAccountDetail(accountId) {
  const account = accountById(accountId);
  if (!account || account.archivedAt) return;
  selectedAccountDetailId = accountId;
  accountDetailPage = 1;
  renderAccountDetail();
  showDialog($('#accountDetailDialog'));
}

function bindRenderedControls(root = document) {
  root.querySelectorAll('[data-account-id]').forEach(button => button.addEventListener('click', () => openAccountDetail(button.dataset.accountId)));
  root.querySelectorAll('[data-transaction-id]').forEach(button => button.addEventListener('click', () => {
    if ($('#accountDetailDialog').open) dismissDialog($('#accountDetailDialog'), () => openEntry(button.dataset.transactionId));
    else openEntry(button.dataset.transactionId);
  }));
  root.querySelectorAll('[data-add-entry]').forEach(button => button.addEventListener('click', () => openEntry()));
}

function render() {
  const totals = householdTotals(ledger);
  const summary = monthlySummary(ledger, selectedMonth);
  const check = reconcile(ledger);
  const monthText = monthLabel(selectedMonth);

  $('#netTotal').textContent = formatRM(totals.netMinor);
  $('#assetTotal').textContent = formatRM(totals.assetsMinor);
  $('#liabilityTotal').textContent = formatRM(totals.liabilitiesMinor);
  $('#incomeTotal').textContent = formatRM(summary.incomeMinor);
  $('#expenseTotal').textContent = formatRM(summary.expenseMinor);
  $('#ledgerIncomeTotal').textContent = formatRM(summary.incomeMinor);
  $('#ledgerExpenseTotal').textContent = formatRM(summary.expenseMinor);
  $('#monthLabel').textContent = monthText;
  $('#monthPicker').value = selectedMonth;

  const status = $('#reconcileStatus');
  status.textContent = check.ok ? '余额已核对' : `发现 ${check.mismatches.length} 项差异`;
  status.classList.toggle('bad', !check.ok);

  const accounts = activeAccounts();
  $('#accountList').innerHTML = accounts.length ? accounts.map(account => `<button class="account-row ${account.includeInTotal ? '' : 'excluded'}" data-account-id="${escapeHtml(account.id)}" aria-label="查看 ${escapeHtml(account.name)} 当月明细"><span class="account-mark ${account.kind === 'liability' ? 'liability' : ''}">${accountAvatarMarkup(account)}</span><span class="account-main"><b>${escapeHtml(account.name)}</b><small>${account.kind === 'liability' ? '负债' : '资产'} · ${account.includeInTotal ? '计入家庭净额' : '不计入总额'}</small></span><span class="account-value"><b>${formatRM(account.balanceMinor)}</b><small>查看当月明细</small></span><span class="row-chevron">${chevronIcon}</span></button>`).join('') : '<div class="empty-state"><b>还没有账户</b><p>新增现金、银行或信用卡账户，开始建立家庭账本。</p><button class="secondary-button" type="button" data-new-account>新增账户</button></div>';

  const entries = selectedEntries().sort(compareEntriesNewestFirst);
  $('#transactionList').innerHTML = renderTransactionRows(entries, '这个月还没有账目', '新增一笔收入、支出或转账后，会在这里显示。');

  const recent = liveEntries().sort(compareEntriesNewestFirst).slice(0, 4);
  $('#recentTransactionList').innerHTML = renderTransactionRows(recent, '还没有最近账目', '记录第一笔支出后，首页会保留最常查看的最近记录。');
  $('#categoryInsightList').innerHTML = renderCategoryInsights(entries);

  bindRenderedControls();
  if (selectedAccountDetailId && $('#accountDetailDialog').open) renderAccountDetail();
  document.querySelectorAll('[data-new-account]').forEach(button => button.addEventListener('click', () => openAccount()));
}

function populateAccounts() {
  const options = activeAccounts().map(account => `<option value="${escapeHtml(account.id)}">${escapeHtml(account.name)} · ${formatRM(account.balanceMinor)}</option>`).join('');
  $('#sourceAccount').innerHTML = options;
  $('#targetAccount').innerHTML = options;
}

function selectCategory(value = '', focusCustom = false) {
  const normalized = String(value || '').trim();
  const directCategory = ENTRY_CATEGORIES.includes(normalized);
  const selectedCategory = directCategory ? normalized : normalized ? '其它' : '';
  document.querySelectorAll('[data-category]').forEach(button => {
    const selected = button.dataset.category === selectedCategory;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-checked', String(selected));
  });
  const customField = $('#customCategoryField');
  customField.hidden = selectedCategory !== '其它';
  if (directCategory) {
    $('#customCategoryInput').value = '';
    $('#categoryInput').value = normalized;
  } else if (selectedCategory === '其它') {
    $('#customCategoryInput').value = normalized === '其它' ? '' : normalized;
    $('#categoryInput').value = $('#customCategoryInput').value.trim();
    if (focusCustom) setTimeout(() => $('#customCategoryInput').focus(), 30);
  } else {
    $('#customCategoryInput').value = '';
    $('#categoryInput').value = '';
  }
}

function updateKindState() {
  const transfer = document.querySelector('input[name="kind"]:checked').value === 'transfer';
  $('#targetRow').hidden = !transfer;
  $('#categoryRow').hidden = transfer;
}

function openEntry(id = null) {
  const entryId = typeof id === 'string' ? id : null;
  if (!activeAccounts().length) {
    showToast('请先新增一个可用账户。');
    openAccount();
    return;
  }
  const entry = entryId ? ledger.transactions.find(item => item.id === entryId && !item.deletedAt) : null;
  if (entryId && !entry) {
    showToast('该账目已不在可编辑列表。');
    return;
  }

  pendingOperationId = uid(entry ? 'edit' : 'op');
  saveLocked = false;
  $('#saveEntryButton').disabled = false;
  $('#entryMessage').textContent = '';
  $('#entryForm').reset();
  populateAccounts();
  $('#editingTransactionId').value = entry?.id || '';
  $('#entryDialogTitle').textContent = entry ? '编辑账目' : '新增账目';
  $('#saveEntryButton').textContent = entry ? '保存修改' : '保存账目';
  $('#archiveTransactionButton').hidden = !entry;

  if (entry) {
    document.querySelector(`input[name="kind"][value="${entry.kind}"]`).checked = true;
    $('#amountInput').value = senToAmount(entry.amountMinor);
    $('#sourceAccount').value = entry.accountId;
    $('#targetAccount').value = entry.targetAccountId || '';
    selectCategory(entry.category || '');
    $('#noteInput').value = entry.note || '';
    $('#dateInput').value = entry.occurredAt.slice(0, 10);
  } else {
    document.querySelector(`input[name="kind"][value="${entryPreferences.lastKind}"]`).checked = true;
    applyRememberedAccounts(entryPreferences.lastKind);
    selectCategory('');
    $('#dateInput').value = today();
  }

  updateKindState();
  showDialog($('#entryDialog'));
  setTimeout(() => $('#amountInput').focus(), 30);
}

function renderAccountPhotoPreview() {
  const preview = $('#accountPhotoPreview');
  preview.innerHTML = pendingAccountPhotoDataUrl
    ? `<img src="${escapeHtml(pendingAccountPhotoDataUrl)}" alt="账户照片预览">`
    : walletIcon;
  preview.classList.toggle('has-photo', Boolean(pendingAccountPhotoDataUrl));
  $('#removeAccountPhotoButton').hidden = !pendingAccountPhotoDataUrl;
}

function readImageFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('无法读取这张照片'));
    reader.readAsDataURL(file);
  });
}

function decodeImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('无法解析这张照片'));
    image.src = dataUrl;
  });
}

function drawSquarePhoto(image, size, quality) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, size, size);
  const scale = Math.max(size / image.naturalWidth, size / image.naturalHeight);
  const width = image.naturalWidth * scale;
  const height = image.naturalHeight * scale;
  context.drawImage(image, (size - width) / 2, (size - height) / 2, width, height);
  return canvas.toDataURL('image/jpeg', quality);
}

async function compressAccountPhoto(file) {
  if (!file?.type?.startsWith('image/')) throw new Error('请选择 JPG、PNG 或 WebP 照片');
  if (file.size > 8 * 1024 * 1024) throw new Error('原图不能超过 8MB');
  const image = await decodeImage(await readImageFile(file));
  let photo = drawSquarePhoto(image, 256, 0.82);
  if (photo.length > 300000) photo = drawSquarePhoto(image, 192, 0.72);
  if (photo.length > 300000) throw new Error('照片压缩后仍然过大');
  return photo;
}

function openAccount(id = null) {
  const account = id ? ledger.accounts.find(item => item.id === id) : null;
  $('#accountForm').reset();
  $('#accountMessage').textContent = '';
  $('#accountPhotoInput').value = '';
  $('#editingAccountId').value = account?.id || '';
  $('#accountDialogTitle').textContent = account ? '编辑账户' : '新增账户';
  $('#openingBalanceRow').hidden = Boolean(account);
  $('#archiveAccountButton').hidden = !account;
  $('#accountName').value = account?.name || '';
  $('#openingBalance').value = '0.00';
  $('#includeInTotal').checked = account ? account.includeInTotal !== false : true;
  pendingAccountPhotoDataUrl = account?.photoDataUrl || null;
  renderAccountPhotoPreview();
  document.querySelector(`input[name="accountKind"][value="${account?.kind || 'asset'}"]`).checked = true;
  showDialog($('#accountDialog'));
  setTimeout(() => $('#accountName').focus(), 30);
}

function renderRecycle() {
  const deleted = ledger.transactions.filter(entry => entry.deletedAt).sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
  $('#recycleList').innerHTML = deleted.length ? deleted.map(entry => `<div class="recycle-row"><span class="transaction-icon expense">−</span><div class="transaction-main"><b>${escapeHtml(entry.category || typeLabel(entry.kind))} · ${formatRM(entry.amountMinor)}</b><small>${dateLabel(entry.deletedAt)} 移入 · ${escapeHtml(entry.note || '无备注')}</small><div class="recycle-actions"><button class="minor-button" data-restore="${escapeHtml(entry.id)}">恢复</button><button class="minor-button delete" data-delete="${escapeHtml(entry.id)}">永久删除</button></div></div></div>`).join('') : '<div class="empty-state"><b>回收站是空的</b><p>移除的账目会先放在这里，方便恢复。</p></div>';

  document.querySelectorAll('[data-restore]').forEach(button => button.addEventListener('click', async () => {
    const result = restoreFromRecycleBin(ledger, button.dataset.restore, uid('restore'));
    await applyLedgerChange(result.ledger, next => saveTransactionRecord(next, button.dataset.restore));
    renderRecycle();
    showToast(result.duplicate ? '重复恢复已阻止。' : '已恢复账目并重新核对余额。');
  }));
  document.querySelectorAll('[data-delete]').forEach(button => button.addEventListener('click', async () => {
    const operationId = uid('delete');
    const result = permanentlyDelete(ledger, button.dataset.delete, operationId);
    await applyLedgerChange(result.ledger, async () => {
      if (usesCloudStore()) await cloud.purgeTransaction(currentHousehold.id, button.dataset.delete, operationId);
    });
    renderRecycle();
    showToast(result.duplicate ? '重复删除已阻止。' : '已永久移除这笔账目。');
  }));
}

function exportLocal() {
  const payload = { exportedAt:new Date().toISOString(), scope:'local-demo-only', ledger:serialiseLedger(ledger) };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type:'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `family-wallet-local-export-${today()}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
  showToast('已导出本地 JSON；不会上传任何数据。');
}

document.querySelectorAll('[data-view-target]').forEach(button => button.addEventListener('click', () => setView(button.dataset.viewTarget)));
document.querySelectorAll('[data-close-dialog]').forEach(button => button.addEventListener('click', () => dismissDialog($(`#${button.dataset.closeDialog}`))));
document.querySelectorAll('dialog').forEach(dialog => {
  dialog.addEventListener('click', event => {
    if (event.target === dialog) dismissDialog(dialog);
  });
  dialog.addEventListener('cancel', event => {
    event.preventDefault();
    dismissDialog(dialog);
  });
});
$('#newEntryButton').addEventListener('click', () => openEntry());
$('#newAccountButton').addEventListener('click', () => openAccount());
$('#editAccountFromDetailButton').addEventListener('click', () => {
  if (!selectedAccountDetailId) return;
  dismissDialog($('#accountDetailDialog'), () => openAccount(selectedAccountDetailId));
});
$('#accountDetailPrevPage').addEventListener('click', () => {
  accountDetailPage -= 1;
  renderAccountDetail();
});
$('#accountDetailNextPage').addEventListener('click', () => {
  accountDetailPage += 1;
  renderAccountDetail();
});
document.querySelectorAll('[data-category]').forEach(button => button.addEventListener('click', () => {
  selectCategory(button.dataset.category, button.dataset.category === '其它');
}));
$('#customCategoryInput').addEventListener('input', event => {
  $('#categoryInput').value = event.target.value.trim();
});
$('#accountPhotoInput').addEventListener('change', async event => {
  const [file] = event.target.files || [];
  if (!file) return;
  $('#accountMessage').textContent = '';
  try {
    pendingAccountPhotoDataUrl = await compressAccountPhoto(file);
    renderAccountPhotoPreview();
  } catch (error) {
    $('#accountMessage').textContent = error.message;
  } finally {
    event.target.value = '';
  }
});
$('#removeAccountPhotoButton').addEventListener('click', () => {
  pendingAccountPhotoDataUrl = null;
  renderAccountPhotoPreview();
});
$('#viewAllEntriesButton').addEventListener('click', () => setView('entries'));
$('#exportButton').addEventListener('click', exportLocal);
$('#recycleButton').addEventListener('click', () => { renderRecycle(); showDialog($('#recycleDialog')); });
$('#closeRecycleButton').addEventListener('click', () => dismissDialog($('#recycleDialog')));
$('#monthFilterButton').addEventListener('click', () => showDialog($('#monthDialog')));
$('#overviewMonthButton').addEventListener('click', () => showDialog($('#monthDialog')));
$('#monthPicker').addEventListener('change', event => {
  if (!event.target.value) return;
  selectedMonth = event.target.value;
  render();
});
$('#monthForm').addEventListener('submit', event => {
  event.preventDefault();
  dismissDialog($('#monthDialog'));
  setView('entries');
});
document.querySelectorAll('input[name="kind"]').forEach(input => input.addEventListener('change', () => {
  updateKindState();
  if (!$('#editingTransactionId').value) applyRememberedAccounts(input.value);
}));

$('#entryForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (saveLocked) return;
  saveLocked = true;
  const button = $('#saveEntryButton');
  button.disabled = true;
  $('#entryMessage').textContent = '';
  try {
    const form = new FormData(event.currentTarget);
    const kind = form.get('kind');
    const category = kind === 'transfer' ? null : String(form.get('category') || '').trim();
    if (kind !== 'transfer' && !category) throw new Error('请选择分类，或在“其它”填写自定义分类');
    const editingTransactionId = $('#editingTransactionId').value;
    const changes = {
      kind,
      amountMinor:amountToSen(form.get('amount')),
      accountId:form.get('accountId'),
      targetAccountId:kind === 'transfer' ? form.get('targetAccountId') : null,
      category,
      note:form.get('note'),
      occurredAt:`${form.get('occurredAt')}T12:00:00.000Z`
    };
    const result = editingTransactionId
      ? updateTransaction(ledger, editingTransactionId, changes, pendingOperationId)
      : applyOperation(ledger, { id:pendingOperationId, ...changes });
    await applyLedgerChange(result.ledger, next => saveTransactionRecord(next, editingTransactionId || pendingOperationId));
    rememberEntryPreferences(kind, changes.accountId, changes.targetAccountId);
    dismissDialog($('#entryDialog'));
    if (!editingTransactionId) setView('entries');
    showToast(result.duplicate ? '重复保存已阻止。' : editingTransactionId ? '修改已保存，余额已重新核对。' : '已保存，余额已重新核对。');
  } catch (error) {
    $('#entryMessage').textContent = error.message;
    button.disabled = false;
    saveLocked = false;
  }
});

$('#archiveTransactionButton').addEventListener('click', async () => {
  const editingTransactionId = $('#editingTransactionId').value;
  if (!editingTransactionId) return;
  const result = moveToRecycleBin(ledger, editingTransactionId, uid('recycle'));
  await applyLedgerChange(result.ledger, next => saveTransactionRecord(next, editingTransactionId));
  dismissDialog($('#entryDialog'));
  setView('entries');
  showToast(result.duplicate ? '重复回收已阻止。' : '已移入回收站，余额已重新核对。');
});

$('#accountForm').addEventListener('submit', async event => {
  event.preventDefault();
  $('#accountMessage').textContent = '';
  try {
    const id = $('#editingAccountId').value;
    const name = $('#accountName').value;
    const includeInTotal = $('#includeInTotal').checked;
    const nextLedger = id ? updateAccount(ledger, id, { name, includeInTotal, photoDataUrl:pendingAccountPhotoDataUrl }) : createAccount(ledger, {
      id:uid('account'),
      name,
      kind:document.querySelector('input[name="accountKind"]:checked').value,
      openingBalanceMinor:amountToSen($('#openingBalance').value, true),
      includeInTotal,
      photoDataUrl:pendingAccountPhotoDataUrl
    });
    const accountId = id || nextLedger.accounts.at(-1).id;
    await applyLedgerChange(nextLedger, next => saveAccountRecord(next, accountId));
    dismissDialog($('#accountDialog'));
    setView('accounts');
    showToast(id ? '账户设置已保存。' : '新账户已加入当前账本。');
  } catch (error) {
    $('#accountMessage').textContent = error.message;
  }
});

$('#archiveAccountButton').addEventListener('click', async () => {
  const id = $('#editingAccountId').value;
  if (!id) return;
  const nextLedger = archiveAccount(ledger, id);
  await applyLedgerChange(nextLedger, next => saveAccountRecord(next, id));
  dismissDialog($('#accountDialog'));
  setView('accounts');
  showToast('账户已归档，并从家庭净额排除。');
});

async function openCloudHousehold(householdId) {
  stopHouseholdWatch?.();
  currentHousehold = null;
  setSyncState('同步中');
  stopHouseholdWatch = cloud.subscribeHousehold(householdId, state => {
    currentHousehold = state.household;
    ledger = deriveLedger({ accounts: state.accounts, transactions: state.transactions });
    $('#inviteMemberButton').hidden = currentHousehold.ownerId !== cloudUser.uid;
    $('#privacyNote').textContent = `资料已同步到你的个人 Firebase · ${currentHousehold.name}`;
    $('#accountPhotoHelp').textContent = '照片会在浏览器内裁切压缩，并同步给这个账本的家庭成员。';
    setSyncState('已同步');
    if (!pendingInvite) showApp();
    render();
    setView(activeView, false);
  }, error => {
    setSyncState('同步失败', true);
    showAuth(`无法读取这个账本：${error.message}`);
  });
}

async function applyCloudProfile(profile) {
  if (!profile) return;
  cloudProfile = profile;
  const options = await cloud.householdOptions(profile.householdIds || []);
  const selected = options.some(option => option.id === profile.selectedHouseholdId)
    ? profile.selectedHouseholdId
    : options[0]?.id;
  $('#workspaceSelect').innerHTML = options.map(option => `<option value="${escapeHtml(option.id)}">${escapeHtml(option.name)}</option>`).join('');
  $('#workspaceSelect').value = selected || '';
  if (selected && currentHousehold?.id !== selected) await openCloudHousehold(selected);
}

async function handleCloudUser(user) {
  stopUserWatch?.();
  stopInviteWatch?.();
  stopHouseholdWatch?.();
  stopUserWatch = stopInviteWatch = stopHouseholdWatch = null;
  currentHousehold = null;
  cloudUser = user;
  pendingInvite = null;
  $('#pendingInvitePanel').hidden = true;
  if (!user) {
    showAuth(runtimeMode === 'emulator' ? '请使用测试帐号登录。' : '使用你自己的 Google 帐号登录。');
    return;
  }
  showAuth('正在打开你的账本…');
  const profile = await cloud.ensureWorkspace(user);
  stopUserWatch = cloud.watchUser(user.uid, value => applyCloudProfile(value).catch(error => showAuth(error.message)), error => showAuth(error.message));
  stopInviteWatch = cloud.watchInvite(user.email, invite => {
    pendingInvite = invite;
    if (invite) {
      $('#pendingInviteTitle').textContent = '收到家庭邀请';
      $('#pendingInviteMessage').textContent = `加入「${invite.householdName}」，与家人一起记账。`;
      $('#pendingInvitePanel').hidden = false;
      showAuth(`你已使用 ${user.email} 登录。`);
    }
  }, error => showAuth(error.message));
  await applyCloudProfile(profile);
}

$('#googleSignInButton').addEventListener('click', async () => {
  $('#googleSignInButton').disabled = true;
  try { await cloud.signInGoogle(); }
  catch (error) { showAuth(`Google 登录失败：${error.message}`); }
  finally { $('#googleSignInButton').disabled = false; }
});

$('#testRegisterButton').addEventListener('click', async () => {
  try { await cloud.registerTestUser($('#testEmail').value, $('#testPassword').value); }
  catch (error) { showAuth(`测试注册失败：${error.message}`); }
});

$('#testLoginButton').addEventListener('click', async () => {
  try { await cloud.signInTestUser($('#testEmail').value, $('#testPassword').value); }
  catch (error) { showAuth(`测试登录失败：${error.message}`); }
});

$('#signOutButton').addEventListener('click', () => cloud?.logout());
$('#workspaceSelect').addEventListener('change', event => {
  if (cloudUser && event.target.value) cloud.selectHousehold(cloudUser.uid, event.target.value).catch(error => showToast(error.message));
});
$('#inviteMemberButton').addEventListener('click', () => {
  $('#inviteForm').reset();
  $('#inviteMessage').textContent = '';
  showDialog($('#inviteDialog'));
});
$('#inviteForm').addEventListener('submit', async event => {
  event.preventDefault();
  $('#inviteMessage').textContent = '';
  $('#sendInviteButton').disabled = true;
  try {
    await cloud.inviteMember({
      householdId: currentHousehold.id,
      email: $('#inviteEmail').value,
      ownerUid: cloudUser.uid,
      ownerEmail: cloudUser.email,
      ownerDisplayName: cloudUser.displayName
    });
    dismissDialog($('#inviteDialog'));
    showToast('邀请已建立。对方使用该 Gmail 登录后即可加入家庭账本。');
  } catch (error) {
    $('#inviteMessage').textContent = error.message;
  } finally {
    $('#sendInviteButton').disabled = false;
  }
});
$('#acceptInviteButton').addEventListener('click', async () => {
  if (!pendingInvite || !cloudUser) return;
  $('#acceptInviteButton').disabled = true;
  try {
    await cloud.acceptInvite({ invite: pendingInvite, user: cloudUser });
    pendingInvite = null;
    $('#pendingInvitePanel').hidden = true;
    showAuth('正在打开家庭账本…');
  } catch (error) {
    showAuth(`无法加入家庭账本：${error.message}`);
  } finally {
    $('#acceptInviteButton').disabled = false;
  }
});

async function startRuntime() {
  const params = new URLSearchParams(location.search);
  if (params.get('local') === '1') {
    runtimeMode = 'local';
    $('#workspaceSelect').innerHTML = '<option>本机账本</option>';
    $('#workspaceSelect').disabled = true;
    $('#inviteMemberButton').hidden = true;
    $('#signOutButton').hidden = true;
    $('#privacyNote').textContent = '本机模式：资料只保存在这台设备，不会上传。';
    $('#accountPhotoHelp').textContent = '照片会在浏览器内裁切压缩，只保存在本机账本。';
    setSyncState('本机');
    showApp();
    render();
    setView(activeView, false);
    return;
  }

  const useEmulators = params.get('emulator') === '1';
  const { firebaseConfig, firebaseConfigured } = await import('./firebase-config.js');
  if (!useEmulators && !firebaseConfigured) {
    showAuth('尚未连接你的个人 Firebase。这里不会要求或保存 Firebase Token。');
    return;
  }
  const { createFirebaseWallet } = await import('./firebase-client.js');
  runtimeMode = useEmulators ? 'emulator' : 'cloud';
  if (useEmulators) {
    $('#testAuthControls').hidden = false;
    showAuth('本机 Firebase Emulator：只使用合成测试资料。');
  } else {
    runtimeMode = 'cloud';
    $('#googleSignInButton').hidden = false;
    showAuth('使用你自己的 Google 帐号登录。');
  }
  cloud = await createFirebaseWallet({ config: firebaseConfig, useEmulators });
  cloud.onAuthChanged(user => handleCloudUser(user).catch(error => showAuth(error.message)));
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('./service-worker.js').catch(() => {});
startRuntime().catch(error => showAuth(`无法启动：${error.message}`));
