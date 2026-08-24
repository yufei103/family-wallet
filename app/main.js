import {
  accountSubtype, applyOperation as applyLedgerOperation, archiveAccount, compareEntriesNewestFirst, createAccount, createLedger, deriveLedger, estimatedMonthlyInterestMinor, formatRM, householdTotals,
  loanCalculationMode, monthlySummary, moveToRecycleBin, permanentlyDelete, reconcile, repaymentBreakdown, restoreFromRecycleBin,
  remainingPayoffMonths, serialiseLedger, suggestedRepayment, updateAccount, updateTransaction
} from './ledger.js';
import {
  archiveItem as archiveLocalItem, createItem as createLocalItem, createItemsState, editItem as editLocalItem,
  recordItemPayment as recordLocalItemPayment, restoreItem as restoreLocalItem,
  restoreItemPayment as restoreLocalItemPayment, serialiseItemsState, voidItemPayment as voidLocalItemPayment
} from './items.js';
import { compressItemMedia } from './item-media.js';
import { createSyncCoordinator } from './cloud-sync.js';
import {
  describeEtaDate, displayItemsFromLocal, hydrateLocalEnvelope, mergePendingLedgerPatch, normaliseDisplayItem,
  rawSnapshotHasOperation, renderItemCards, serialiseLocalEnvelope, withoutMediaDataUrls
} from './items-view.js';

const STORE = 'family-wallet-v2-local-demo';
const ENTRY_PREFS_STORE = 'family-wallet-v2-entry-preferences';
const THEME_STORE = 'family-wallet-v2-theme';
const THEMES = new Set(['teal', 'maybank', 'cimb', 'ocean']);
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

const viewTitles = { overview:'概览', entries:'账目', accounts:'账户', items:'物品' };
const walletIcon = '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M17 8v-3a1 1 0 0 0 -1 -1h-10a2 2 0 0 0 0 4h12a1 1 0 0 1 1 1v3M19 16v3a1 1 0 0 1 -1 1h-12a2 2 0 0 1 -2 -2v-12M20 12v4h-4a2 2 0 0 1 0 -4h4"/></svg>';
const chevronIcon = '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M9 6l6 6l-6 6"/></svg>';

const hydratedLocal = hydrate();
let ledger = hydratedLocal.ledger;
let itemsState = hydratedLocal.itemsState;
let localItemMedia = new Map(hydratedLocal.itemMedia.map(media => [media.id, media]));
let saveLocked = false;
let pendingOperationId = uid('op');
let pendingAccountOperationId = uid('account');
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
let stopItemsWatch = null;
let stopItemPaymentsWatch = null;
let cloudSessionToken = null;
let currentListenerToken = null;
let desiredHouseholdId = null;
let householdSwitchPreviousId = null;
let householdSwitchHasSnapshot = false;
let cloudRawState = null;
let itemRecords = displayItemsFromLocal(itemsState);
let currentItemPayments = [];
let selectedItemId = null;
let itemFilter = 'active';
let itemListenerError = null;
let mediaCache = new Map(hydratedLocal.itemMedia.map(media => [`local/${media.id}`, media]));
let coverObserver = null;
let pendingItemCreate = null;
let pendingPayment = null;
let pendingItemEdit = null;
let pendingRepayment = null;
let repaymentReturnAccountId = null;
let requestedPaymentId = null;
const mediaLoads = new Map();
const itemActionOperations = new Map();

const syncCoordinator = createSyncCoordinator({
  applyOperation:mergePendingLedgerPatch,
  hasOperation:rawSnapshotHasOperation,
  recover:async ({ listenerToken }) => {
    if (!desiredHouseholdId || listenerToken !== currentListenerToken) return;
    restartHouseholdListener(listenerToken, desiredHouseholdId);
    restartItemsListener(desiredHouseholdId);
    if (selectedItemId && $('#itemDetailDialog').open) restartItemPaymentsListener(desiredHouseholdId, selectedItemId);
  },
  onChange:applyCoordinatorState
});

function hydrate() {
  return hydrateLocalEnvelope(localStorage.getItem(STORE), seed());
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

function applyTheme(theme, { persist = true } = {}) {
  const selected = THEMES.has(theme) ? theme : 'teal';
  document.documentElement.dataset.theme = selected;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#f3f7f6');
  document.querySelectorAll('input[name="appTheme"]').forEach(input => { input.checked = input.value === selected; });
  if (persist) localStorage.setItem(THEME_STORE, selected);
  return selected;
}

function persist() {
  if (runtimeMode === 'local') {
    localStorage.setItem(STORE, JSON.stringify(serialiseLocalEnvelope(ledger, itemsState, [...localItemMedia.values()])));
  }
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

function setSyncState(message, bad = false, state = '') {
  const badge = $('#syncBadge');
  badge.textContent = message;
  badge.classList.toggle('bad', bad);
  badge.dataset.state = state;
}

function renderSyncStatus(state = syncCoordinator.getState()) {
  if (runtimeMode === 'local') return setSyncState('本机', false, 'local');
  const status = state.status === 'offline' ? 'offline' : itemListenerError ? 'error' : state.status;
  const labels = {
    loading:'载入中', cached:'已缓存', pending:state.pendingCount ? `${state.pendingCount} 项待同步` : '待同步',
    synced:'已同步', offline:state.pendingCount ? `离线 · ${state.pendingCount} 项排队` : '离线',
    recovering:'恢复中', error:'同步错误 · 重试'
  };
  setSyncState(labels[status] ?? '准备中', status === 'error', status);
  $('#syncBadge').title = status === 'error' ? (itemListenerError || state.error || '点按重试') : labels[status];
}

function setSwitching(value) {
  document.body.classList.toggle('is-switching', value);
  for (const control of document.querySelectorAll('[data-mutation], #newEntryButton, #newAccountButton, #archiveTransactionButton, #archiveAccountButton')) {
    control.disabled = Boolean(value);
  }
  $('#workspaceSelect').setAttribute('aria-busy', String(Boolean(value)));
}

function applyCoordinatorState(state) {
  renderSyncStatus(state);
  const raw = state.data;
  if (!raw?.household || raw.household.id !== state.householdId) return;
  cloudRawState = raw;
  currentHousehold = raw.household;
  ledger = deriveLedger({ accounts:raw.accounts, transactions:raw.transactions });
  const firstForSwitch = !householdSwitchHasSnapshot && desiredHouseholdId === currentHousehold.id;
  if (firstForSwitch) {
    householdSwitchHasSnapshot = true;
    householdSwitchPreviousId = null;
    setSwitching(false);
    itemRecords = [];
    currentItemPayments = [];
    renderItemsView();
    restartItemsListener(currentHousehold.id);
  }
  $('#inviteMemberButton').hidden = currentHousehold.ownerId !== cloudUser?.uid;
  $('#privacyNote').textContent = `资料已同步到你的个人 Firebase · ${currentHousehold.name}`;
  $('#accountPhotoHelp').textContent = '照片会在浏览器内裁切压缩，并同步给这个账本的家庭成员。';
  if (!pendingInvite) showApp();
  render();
  setView(activeView, false);
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

function pendingLedgerPatch(nextLedger, kind, recordId, operationId, override = null) {
  const record = override ?? (kind === 'accountPatch'
    ? nextLedger.accounts.find(item => item.id === recordId)
    : nextLedger.transactions.find(item => item.id === recordId));
  if (!record) throw new Error('无法建立待同步记录');
  return { kind, record:structuredClone(record), operationId };
}

async function applyLedgerChange(nextLedger, cloudWrite, pendingPatch = null) {
  if (!usesCloudStore()) {
    ledger = nextLedger;
    persist();
    render();
    return;
  }
  if (!pendingPatch?.operationId) throw new Error('云端写入缺少稳定 operationId');
  const token = syncCoordinator.registerWrite(pendingPatch.operationId, pendingPatch, { householdId:currentHousehold.id });
  let writePromise;
  try {
    // Start Firestore immediately, but do not await its server acknowledgement before local echo.
    writePromise = cloudWrite(nextLedger);
  } catch (error) {
    syncCoordinator.rejectWrite(token, error);
    throw error;
  }
  ledger = nextLedger;
  render();
  Promise.resolve(writePromise).then(
    () => syncCoordinator.acknowledgeWrite(token),
    error => {
      if (syncCoordinator.rejectWrite(token, error)) showToast(`未能同步：${error.message}`);
    }
  );
}
function activeAccounts() { return ledger.accounts.filter(account => !account.archivedAt); }
function accountById(id) { return ledger.accounts.find(account => account.id === id) || null; }
function itemById(id) { return itemRecords.find(item => item.id === id) || null; }
function liveEntries() { return ledger.transactions.filter(entry => !entry.deletedAt && !entry.purgedAt); }
function selectedEntries() { return liveEntries().filter(entry => entry.occurredAt.slice(0, 7) === selectedMonth); }
function assetAccounts() { return activeAccounts().filter(account => accountSubtype(account) === 'asset'); }
function entryAccounts(kind) {
  if (kind === 'income' || kind === 'transfer') return assetAccounts();
  return activeAccounts().filter(account => ['asset', 'credit_card', 'generic_liability'].includes(accountSubtype(account)));
}
function itemPaymentAccounts() {
  return activeAccounts().filter(account => ['asset', 'credit_card'].includes(accountSubtype(account)));
}
function accountSubtypeLabel(account) {
  return ({ asset:'可用资金', credit_card:'信用卡', loan:'贷款', generic_liability:'其他负债' })[accountSubtype(account)];
}

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
  const accounts = entryAccounts(kind);
  if (!accounts.length) return;
  const remembered = entryPreferences.byKind[kind] || {};
  const sourceId = accounts.some(account => account.id === remembered.accountId) ? remembered.accountId : accounts[0].id;
  $('#sourceAccount').value = sourceId;
  if (kind !== 'transfer') return;
  const targets = assetAccounts();
  const fallbackTarget = targets.find(account => account.id !== sourceId)?.id || sourceId;
  const targetId = targets.some(account => account.id === remembered.targetAccountId && account.id !== sourceId)
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

function currentMediaHouseholdId() {
  return usesCloudStore() ? (currentHousehold?.id ?? desiredHouseholdId) : 'local';
}

function mediaKey(householdId, mediaId) { return `${householdId}/${mediaId}`; }
function paymentMode(payment) { return payment?.ledgerMode ?? payment?.mode ?? 'independent'; }
function paymentIsVoided(payment) { return payment?.status === 'voided' || Boolean(payment?.voidedAt); }

function normalisePayment(payment) {
  return {
    ...payment,
    mode:paymentMode(payment),
    status:paymentIsVoided(payment) ? 'voided' : 'active'
  };
}

async function loadMediaOnce(householdId, mediaId) {
  if (!householdId || !mediaId) return null;
  const key = mediaKey(householdId, mediaId);
  if (mediaCache.has(key)) return mediaCache.get(key);
  if (mediaLoads.has(key)) return mediaLoads.get(key);
  const request = Promise.resolve().then(() => householdId === 'local'
    ? (localItemMedia.get(mediaId) ?? null)
    : cloud.loadItemMedia(householdId, mediaId)
  ).then(media => {
    mediaCache.set(key, media);
    return media;
  }).finally(() => mediaLoads.delete(key));
  mediaLoads.set(key, request);
  return request;
}

function observeLazyCovers() {
  coverObserver?.disconnect();
  coverObserver = null;
  const householdId = currentMediaHouseholdId();
  const targets = [...$('#itemsGrid').querySelectorAll('[data-cover-media-id]')]
    .filter(target => !mediaCache.has(mediaKey(householdId, target.dataset.coverMediaId)));
  if (!targets.length) return;
  const loadTargets = targetsToLoad => Promise.allSettled(targetsToLoad.map(target =>
    loadMediaOnce(householdId, target.dataset.coverMediaId)
  )).then(results => {
    if (householdId !== currentMediaHouseholdId()) return;
    const failure = results.find(result => result.status === 'rejected');
    if (failure) $('#itemsMessage').textContent = `封面载入失败：${failure.reason.message}`;
    renderItemsView();
  });
  if (!('IntersectionObserver' in window)) {
    loadTargets(targets);
    return;
  }
  coverObserver = new IntersectionObserver(entries => {
    const visible = entries.filter(entry => entry.isIntersecting).map(entry => entry.target);
    if (!visible.length) return;
    visible.forEach(target => coverObserver?.unobserve(target));
    loadTargets(visible);
  }, { rootMargin:'180px 0px' });
  targets.forEach(target => coverObserver.observe(target));
}

function renderItemsView() {
  if (runtimeMode === 'local') itemRecords = displayItemsFromLocal(itemsState);
  const visible = itemRecords.filter(item => itemFilter === 'archived'
    ? item.status === 'archived' || Boolean(item.archivedAt)
    : item.status !== 'archived' && !item.archivedAt
  ).sort((a, b) => String(b.updatedAt ?? b.createdAt ?? '').localeCompare(String(a.updatedAt ?? a.createdAt ?? '')));
  $('#itemsMessage').textContent = itemListenerError ? `物品实时更新中断：${itemListenerError}` : '';
  $('#itemsGrid').innerHTML = renderItemCards(visible, {
    formatMoney:formatRM,
    mediaCache,
    householdId:currentMediaHouseholdId()
  });
  $('#itemsGrid').querySelectorAll('[data-item-id]').forEach(button => {
    button.addEventListener('click', () => openItemDetail(button.dataset.itemId));
  });
  $('#itemsGrid').querySelectorAll('[data-new-item]').forEach(button => {
    button.addEventListener('click', openNewItem);
  });
  observeLazyCovers();
}

function clearReceiptViewer() {
  $('#receiptViewerImage').removeAttribute('src');
  $('#receiptViewerMeta').textContent = '凭证详情';
  $('#saveReceiptButton').removeAttribute('href');
  $('#saveReceiptButton').hidden = true;
}

function closeReceiptViewer() {
  dismissDialog($('#receiptViewerDialog'), clearReceiptViewer);
}

async function showReceipt(payment, button) {
  if (!payment?.receiptMediaId) return;
  const original = button.textContent;
  button.disabled = true;
  button.textContent = '载入中…';
  $('#itemDetailMessage').textContent = '';
  try {
    const media = await loadMediaOnce(currentMediaHouseholdId(), payment.receiptMediaId);
    if (!media?.dataUrl) throw new Error('找不到付款凭证');
    const item = itemById(payment.itemId ?? selectedItemId);
    const label = payment.type === 'deposit' ? '订金凭证' : '付款凭证';
    $('#receiptViewerTitle').textContent = item?.name ? `${item.name} · ${label}` : label;
    $('#receiptViewerMeta').textContent = [formatRM(payment.amountMinor), dateLabel(payment.occurredAt ?? payment.createdAt), payment.note].filter(Boolean).join(' · ');
    $('#receiptViewerImage').src = media.dataUrl;
    $('#receiptViewerImage').alt = `${item?.name ?? '物品'}${label}`;
    const saveLink = $('#saveReceiptButton');
    saveLink.href = media.dataUrl;
    saveLink.download = `family-wallet-${payment.type === 'deposit' ? 'deposit' : 'payment'}-${String(payment.occurredAt ?? today()).slice(0, 10)}.jpg`;
    saveLink.hidden = false;
    if (!$('#receiptViewerDialog').open) showDialog($('#receiptViewerDialog'));
  } catch (error) {
    $('#itemDetailMessage').textContent = `无法读取凭证：${error.message}`;
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

function paymentTimelineMarkup(payments) {
  if (!payments.length) return '<div class="empty-state"><b>还没有付款</b><p>记录订金或第一期后会显示在这里。</p></div>';
  return [...payments].sort((a, b) => String(b.occurredAt ?? b.createdAt ?? '').localeCompare(String(a.occurredAt ?? a.createdAt ?? '')))
    .map(raw => {
      const payment = normalisePayment(raw);
      const voided = payment.status === 'voided';
      const linked = payment.mode === 'linked';
      const label = payment.type === 'deposit' ? '订金' : '付款';
      const receipt = payment.receiptMediaId
        ? `<button class="minor-button" type="button" data-view-receipt="${escapeHtml(payment.id)}">查看凭证</button>` : '';
      const correction = voided
        ? `<button class="minor-button" data-restore-payment="${escapeHtml(payment.id)}" type="button">恢复付款</button>`
        : `<button class="minor-button delete" data-void-payment="${escapeHtml(payment.id)}" type="button">作废付款</button>`;
      const menu = `<details class="payment-menu"><summary class="minor-button" aria-label="付款更正菜单">⋯</summary><div class="payment-menu-popover">${correction}</div></details>`;
      return `<div class="payment-row ${voided ? 'voided' : ''}" data-payment-id="${escapeHtml(payment.id)}"><div><b>${label} · ${formatRM(payment.amountMinor)}</b><small><span class="payment-badge">${linked ? '已联动账目' : '独立付款'}</span>${dateLabel(payment.occurredAt ?? payment.createdAt)}${payment.note ? ` · ${escapeHtml(payment.note)}` : ''}${voided ? ' · 已作废' : ''}</small></div><div class="payment-row-actions">${receipt}${menu}</div></div>`;
    }).join('');
}

function renderItemDetail() {
  const item = normaliseDisplayItem(itemById(selectedItemId));
  if (!item) {
    $('#itemDetailMessage').textContent = '物品已不存在或尚未同步。';
    return;
  }
  $('#itemDetailName').textContent = item.name;
  $('#itemDetailState').textContent = item.status === 'archived' ? '已归档' : item.status === 'completed' ? '已付清' : '收藏中';
  $('#itemDetailBalance').textContent = formatRM(item.balanceMinor);
  $('#itemDetailPaid').textContent = `已付 ${formatRM(item.paidMinor)} / ${formatRM(item.fullPriceMinor)}`;
  $('#itemDetailProgress').style.width = `${item.progress}%`;
  const etaDescription = item.etaDate ? describeEtaDate(item.etaDate, today()) : '';
  $('#itemDetailEta').textContent = etaDescription;
  $('#itemDetailEta').hidden = !etaDescription;
  $('#itemDetailNote').textContent = item.note || '暂无备注';
  $('#itemDetailMessage').textContent = '';
  const archived = item.status === 'archived';
  $('#payItemFullButton').disabled = archived || item.balanceMinor <= 0;
  $('#payItemPartButton').disabled = archived || item.balanceMinor <= 0;
  $('#editItemButton').disabled = archived;
  $('#archiveItemButton').hidden = archived || item.status !== 'completed';
  $('#restoreItemButton').hidden = !archived;
  $('#itemPaymentCount').textContent = `${currentItemPayments.length} 笔记录`;
  $('#itemPaymentTimeline').innerHTML = paymentTimelineMarkup(currentItemPayments);
  const householdId = currentMediaHouseholdId();
  const cover = item.coverMediaId ? mediaCache.get(mediaKey(householdId, item.coverMediaId)) : null;
  $('#itemDetailCover').innerHTML = cover?.dataUrl
    ? `<img src="${escapeHtml(cover.dataUrl)}" alt="${escapeHtml(item.name)} 封面">`
    : '<div class="item-cover-placeholder"><span aria-hidden="true">FW</span><small>暂无封面</small></div>';
  $('#itemPaymentTimeline').querySelectorAll('[data-view-receipt]').forEach(button => {
    button.addEventListener('click', () => showReceipt(currentItemPayments.find(payment => payment.id === button.dataset.viewReceipt), button));
  });
  $('#itemPaymentTimeline').querySelectorAll('[data-void-payment]').forEach(button => {
    button.addEventListener('click', () => correctItemPayment('void', button.dataset.voidPayment, button));
  });
  $('#itemPaymentTimeline').querySelectorAll('[data-restore-payment]').forEach(button => {
    button.addEventListener('click', () => correctItemPayment('restore', button.dataset.restorePayment, button));
  });
  if (requestedPaymentId) {
    const paymentId = requestedPaymentId;
    requestedPaymentId = null;
    setTimeout(() => $('#itemPaymentTimeline').querySelector(`[data-payment-id="${CSS.escape(paymentId)}"]`)?.scrollIntoView({ behavior:'smooth', block:'center' }), 40);
  }
}

function restartItemPaymentsListener(householdId, itemId) {
  stopItemPaymentsWatch?.();
  stopItemPaymentsWatch = null;
  if (!usesCloudStore() || !householdId || !itemId || !$('#itemDetailDialog').open) return;
  stopItemPaymentsWatch = cloud.subscribeItemPayments(householdId, itemId, state => {
    if (selectedItemId !== itemId || currentMediaHouseholdId() !== householdId || !$('#itemDetailDialog').open) return;
    currentItemPayments = state.payments.map(normalisePayment);
    renderItemDetail();
  }, error => {
    if (selectedItemId === itemId && $('#itemDetailDialog').open) $('#itemDetailMessage').textContent = `付款时间线更新中断：${error.message}`;
  });
}

function cleanupItemDetail() {
  stopItemPaymentsWatch?.();
  stopItemPaymentsWatch = null;
  selectedItemId = null;
  requestedPaymentId = null;
  currentItemPayments = [];
  clearReceiptViewer();
}

function closeItemDetail(afterClose) {
  cleanupItemDetail();
  dismissDialog($('#itemDetailDialog'), afterClose);
}

function openItemDetail(itemId, paymentId = null) {
  const item = itemById(itemId);
  if (!item) {
    showToast('物品尚未同步或已被移除。');
    return;
  }
  stopItemPaymentsWatch?.();
  stopItemPaymentsWatch = null;
  selectedItemId = itemId;
  requestedPaymentId = paymentId;
  clearReceiptViewer();
  currentItemPayments = runtimeMode === 'local'
    ? itemsState.itemPayments.filter(payment => payment.itemId === itemId).map(normalisePayment)
    : [];
  renderItemDetail();
  if (!$('#itemDetailDialog').open) showDialog($('#itemDetailDialog'));
  if (usesCloudStore()) restartItemPaymentsListener(currentHousehold.id, itemId);
  if (item.coverMediaId) {
    const householdId = currentMediaHouseholdId();
    loadMediaOnce(householdId, item.coverMediaId).then(() => {
      if (selectedItemId === itemId && $('#itemDetailDialog').open && householdId === currentMediaHouseholdId()) renderItemDetail();
    }).catch(error => {
      if (selectedItemId === itemId) $('#itemDetailMessage').textContent = `封面载入失败：${error.message}`;
    });
  }
}

function openItemFromLedger(itemId, paymentId) {
  setView('items');
  openItemDetail(itemId, paymentId);
}

function upsertItemRecord(raw) {
  if (!raw) return;
  const item = normaliseDisplayItem(raw);
  const index = itemRecords.findIndex(candidate => candidate.id === item.id);
  if (index >= 0) itemRecords[index] = item;
  else itemRecords.push(item);
}

function upsertCurrentPayment(raw) {
  if (!raw || raw.itemId !== selectedItemId) return;
  const payment = normalisePayment(raw);
  const index = currentItemPayments.findIndex(candidate => candidate.id === payment.id);
  if (index >= 0) currentItemPayments[index] = payment;
  else currentItemPayments.push(payment);
}

function applyLinkedExpenseSpec(baseLedger, spec, correctionAt = undefined) {
  if (!spec) return baseLedger;
  if (spec.action === 'void') return moveToRecycleBin(baseLedger, spec.transactionId, spec.operationId, correctionAt).ledger;
  if (spec.action === 'restore') return restoreFromRecycleBin(baseLedger, spec.transactionId, spec.operationId).ledger;
  return applyLedgerOperation(baseLedger, { ...spec, id:spec.operationId }).ledger;
}

function commitLocalItemMutation(nextLedger, nextItemsState, nextMedia) {
  const envelope = serialiseLocalEnvelope(nextLedger, nextItemsState, [...nextMedia.values()]);
  localStorage.setItem(STORE, JSON.stringify(envelope));
  ledger = nextLedger;
  itemsState = nextItemsState;
  localItemMedia = nextMedia;
  itemRecords = displayItemsFromLocal(itemsState);
  mediaCache = new Map([...mediaCache].filter(([key]) => !key.startsWith('local/')));
  for (const media of localItemMedia.values()) mediaCache.set(mediaKey('local', media.id), media);
  currentItemPayments = selectedItemId
    ? itemsState.itemPayments.filter(payment => payment.itemId === selectedItemId).map(normalisePayment)
    : [];
  render();
  if (selectedItemId && $('#itemDetailDialog').open) renderItemDetail();
}

async function prepareFormMedia(input, kind, pending, slot, statusElement) {
  const file = input.files?.[0] ?? null;
  if (!file) return null;
  if (pending[`${slot}File`] === file && pending[slot]) return pending[slot];
  statusElement.textContent = kind === 'cover' ? '正在压缩封面…' : '正在压缩凭证…';
  const compressed = await compressItemMedia(file, kind);
  const media = { id:pending[`${slot}Id`], ...compressed };
  pending[`${slot}File`] = file;
  pending[slot] = media;
  statusElement.textContent = `已压缩 · ${media.width} × ${media.height}`;
  return media;
}

function updateNewItemDepositControls() {
  const hasDeposit = $('#newItemDepositAmount').value.trim() !== '';
  $('#newItemLinkControls').hidden = !hasDeposit;
  $('#newItemAccountRow').hidden = !$('#newItemLinked').checked;
}

function openNewItem() {
  if (usesCloudStore() && !navigator.onLine) {
    showToast('新增物品需要联网。');
    return;
  }
  pendingItemCreate = {
    itemId:uid('item'), operationId:uid('item-create'), depositPaymentId:uid('item-payment'),
    depositOperationId:uid('item-deposit'), coverId:uid('item-cover'), receiptId:uid('item-receipt'),
    createdAt:new Date().toISOString()
  };
  $('#newItemForm').reset();
  populateAccounts();
  $('#newItemDepositDate').value = today();
  $('#newItemLinked').checked = true;
  $('#newItemMessage').textContent = '';
  $('#newItemCoverStatus').textContent = '浏览器内压缩为独立 JPEG 资料';
  $('#newItemReceiptStatus').textContent = '仅在请求时读取';
  $('#saveNewItemButton').disabled = false;
  updateNewItemDepositControls();
  showDialog($('#newItemDialog'));
  setTimeout(() => $('#newItemName').focus(), 30);
}

function updatePaymentAccountRow() { $('#paymentAccountRow').hidden = !$('#paymentLinked').checked; }

function openPaymentDialog(full = false) {
  const item = normaliseDisplayItem(itemById(selectedItemId));
  if (!item || item.status === 'archived' || item.balanceMinor <= 0) return;
  if (usesCloudStore() && !navigator.onLine) {
    $('#itemDetailMessage').textContent = '记录付款需要联网。';
    return;
  }
  pendingPayment = {
    paymentId:uid('item-payment'), operationId:uid('item-payment-op'), receiptId:uid('item-receipt'),
    createdAt:new Date().toISOString(), full
  };
  $('#paymentForm').reset();
  populateAccounts();
  $('#paymentDialogTitle').textContent = full ? '一次付清' : '记录一期';
  $('#paymentBalanceCopy').textContent = `当前余额 ${formatRM(item.balanceMinor)}`;
  $('#paymentAmount').value = full ? senToAmount(item.balanceMinor) : '';
  $('#paymentAmount').readOnly = full;
  $('#paymentDate').value = today();
  $('#paymentLinked').checked = true;
  $('#paymentMessage').textContent = '';
  $('#paymentReceiptStatus').textContent = '会压缩并独立保存';
  updatePaymentAccountRow();
  showDialog($('#paymentDialog'));
  setTimeout(() => (full ? $('#paymentDate') : $('#paymentAmount')).focus(), 30);
}

function openEditItem() {
  const item = itemById(selectedItemId);
  if (!item || item.archivedAt || item.status === 'archived') return;
  if (usesCloudStore() && !navigator.onLine) {
    $('#itemDetailMessage').textContent = '编辑物品需要联网。';
    return;
  }
  pendingItemEdit = { operationId:uid('item-edit'), coverId:uid('item-cover'), updatedAt:new Date().toISOString(), originalCoverMediaId:item.coverMediaId ?? null };
  $('#editItemForm').reset();
  $('#editItemName').value = item.name;
  $('#editItemFullPrice').value = senToAmount(item.fullPriceMinor);
  $('#editItemEtaDate').value = item.etaDate || '';
  $('#editItemNote').value = item.note || '';
  $('#editItemMessage').textContent = '';
  $('#editItemCoverStatus').textContent = '不选择会保留现有封面';
  showDialog($('#editItemDialog'));
}

function actionOperationId(key, prefix) {
  if (!itemActionOperations.has(key)) itemActionOperations.set(key, uid(prefix));
  return itemActionOperations.get(key);
}

async function runItemLifecycle(action, button) {
  const item = itemById(selectedItemId);
  if (!item) return;
  if (usesCloudStore() && !navigator.onLine) {
    $('#itemDetailMessage').textContent = '此操作需要联网。';
    return;
  }
  const key = `${currentMediaHouseholdId()}:${action}:item:${item.id}`;
  const operationId = actionOperationId(key, `item-${action}`);
  const original = button.textContent;
  button.disabled = true;
  button.textContent = '处理中…';
  $('#itemDetailMessage').textContent = '';
  try {
    if (usesCloudStore()) {
      const result = await cloud[action === 'archive' ? 'archiveItem' : 'restoreItem']({
        householdId:currentHousehold.id, itemId:item.id, operationId,
        expectedRevision:item.revision, actorUid:cloudUser.uid
      });
      upsertItemRecord(result.item);
    } else {
      const result = action === 'archive'
        ? archiveLocalItem(itemsState, item.id, { operationId, expectedRevision:itemsState.revision, actor:'local' })
        : restoreLocalItem(itemsState, item.id, { operationId, expectedRevision:itemsState.revision, actor:'local' });
      commitLocalItemMutation(ledger, result.state, new Map(localItemMedia));
    }
    itemActionOperations.delete(key);
    renderItemsView();
    renderItemDetail();
    showToast(action === 'archive' ? '物品已归档。' : '物品已恢复到收藏。');
  } catch (error) {
    $('#itemDetailMessage').textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

async function correctItemPayment(action, paymentId, button) {
  const item = itemById(selectedItemId);
  const payment = currentItemPayments.find(candidate => candidate.id === paymentId);
  if (!item || !payment) return;
  if (usesCloudStore() && !navigator.onLine) {
    $('#itemDetailMessage').textContent = '更正付款需要联网。';
    return;
  }
  const key = `${currentMediaHouseholdId()}:${action}:payment:${paymentId}`;
  const operationId = actionOperationId(key, `payment-${action}`);
  const original = button.textContent;
  button.disabled = true;
  button.textContent = '处理中…';
  $('#itemDetailMessage').textContent = '';
  try {
    if (usesCloudStore()) {
      const result = await cloud[action === 'void' ? 'voidItemPayment' : 'restoreItemPayment']({
        householdId:currentHousehold.id, itemId:item.id, paymentId, operationId,
        expectedRevision:item.revision, actorUid:cloudUser.uid
      });
      upsertItemRecord(result.item);
      upsertCurrentPayment(result.payment);
    } else {
      const result = action === 'void'
        ? voidLocalItemPayment(itemsState, item.id, paymentId, { operationId, expectedRevision:itemsState.revision, actor:'local' })
        : restoreLocalItemPayment(itemsState, item.id, paymentId, { operationId, expectedRevision:itemsState.revision, actor:'local' });
      const nextLedger = applyLinkedExpenseSpec(ledger, result.expenseSpec, result.payment?.voidedAt ?? result.payment?.restoredAt);
      commitLocalItemMutation(nextLedger, result.state, new Map(localItemMedia));
    }
    itemActionOperations.delete(key);
    render();
    renderItemDetail();
    showToast(action === 'void' ? '付款已作废，相关账目已同步更正。' : '付款与相关账目已恢复。');
  } catch (error) {
    $('#itemDetailMessage').textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

function renderTransactionRows(entries, emptyTitle, emptyBody, contextAccountId = null) {
  if (!entries.length) {
    return `<div class="empty-state"><b>${escapeHtml(emptyTitle)}</b><p>${escapeHtml(emptyBody)}</p><button class="secondary-button" type="button" data-add-entry>记录第一笔</button></div>`;
  }
  return entries.map(entry => {
    if (entry.kind === 'repayment') {
      const target = accountById(entry.targetAccountId);
      const source = accountById(entry.accountId);
      const targetContext = contextAccountId === entry.targetAccountId;
      const shownMinor = targetContext ? entry.principalMinor : entry.amountMinor;
      const metadata = `${dateLabel(entry.occurredAt)} · ${source?.name ?? '账外资金'} → ${target?.name ?? '负债账户'}${entry.interestMinor ? ` · 含利息 ${formatRM(entry.interestMinor)}` : ''}${entry.note ? ` · ${entry.note}` : ''}`;
      const amountClass = targetContext ? '' : 'expense';
      const amountText = targetContext ? `−欠款 ${formatRM(shownMinor)}` : `−${formatRM(shownMinor)}`;
      return `<button class="transaction-row" data-transaction-id="${escapeHtml(entry.id)}" aria-label="查看还款 ${formatRM(entry.amountMinor)}"><span class="transaction-icon repayment">还</span><span class="transaction-main"><b>还款 · ${escapeHtml(target?.name ?? '负债账户')}</b><small>${escapeHtml(metadata)}</small></span><span class="transaction-value ${amountClass}">${amountText}</span></button>`;
    }
    const isLinkedItemPayment = entry.sourceType === 'itemPayment';
    const linkedItem = isLinkedItemPayment ? itemById(entry.sourceItemId) : null;
    const sign = entry.kind === 'expense' ? '−' : entry.kind === 'income' ? '＋' : '↔';
    let amountClass = entry.kind === 'expense' ? 'expense' : '';
    let amount = entry.kind === 'transfer' ? '转账' : `${entry.kind === 'expense' ? '−' : '＋'}${formatRM(entry.amountMinor)}`;
    if (entry.kind === 'transfer' && contextAccountId) {
      const outgoing = entry.accountId === contextAccountId;
      amountClass = outgoing ? 'expense' : '';
      amount = `${outgoing ? '−' : '＋'}${formatRM(entry.amountMinor)}`;
    }
    const metadata = `${dateLabel(entry.occurredAt)} · ${accountFlowLabel(entry)} · ${entry.note || linkedItem?.name || '无备注'}`;
    const title = isLinkedItemPayment ? `物品付款${linkedItem ? ` · ${linkedItem.name}` : ''}` : (entry.category || typeLabel(entry.kind));
    const route = isLinkedItemPayment ? ` data-linked-item-id="${escapeHtml(entry.sourceItemId)}" data-linked-payment-id="${escapeHtml(entry.sourcePaymentId)}"` : '';
    const aria = isLinkedItemPayment ? `查看物品付款 ${linkedItem?.name ?? ''}` : `编辑 ${typeLabel(entry.kind)} ${formatRM(entry.amountMinor)}`;
    return `<button class="transaction-row" data-transaction-id="${escapeHtml(entry.id)}"${route} aria-label="${escapeHtml(aria)}"><span class="transaction-icon ${entry.kind}">${sign}</span><span class="transaction-main"><b>${escapeHtml(title)}</b><small>${escapeHtml(metadata)}</small></span><span class="transaction-value ${amountClass}">${amount}</span></button>`;
  }).join('');
}

const CATEGORY_COLORS = ['#0b5f5b', '#d28a27', '#4f759b', '#8a6a9f', '#7d8986'];

function spendingCategories(entries) {
  const totals = new Map();
  for (const entry of entries) {
    let category = null;
    let amount = 0;
    if (entry.kind === 'expense') {
      category = String(entry.category || '其他').trim() || '其他';
      amount = entry.amountMinor;
    } else if (entry.kind === 'repayment' && Number.isSafeInteger(entry.interestMinor) && entry.interestMinor > 0) {
      category = '贷款利息与费用';
      amount = entry.interestMinor;
    }
    if (!category || amount <= 0) continue;
    totals.set(category, (totals.get(category) || 0) + amount);
  }
  const sorted = [...totals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN'));
  const total = sorted.reduce((sum, [, amount]) => sum + amount, 0);
  const visible = sorted.slice(0, 4).map(([category, amount]) => [category, amount]);
  if (sorted.length > 4) {
    const remainder = sorted.slice(4).reduce((sum, [, amount]) => sum + amount, 0);
    const existingOther = visible.findIndex(([category]) => category === '其他');
    if (existingOther >= 0) visible[existingOther][1] += remainder;
    else visible.push(['其他', remainder]);
  }
  return {
    total,
    rows:visible.map(([category, amount], index) => ({
      category,
      amount,
      color:CATEGORY_COLORS[index],
      percent:total ? Math.round((amount / total) * 100) : 0
    }))
  };
}

function renderCategoryOverview(entries) {
  const breakdown = spendingCategories(entries);
  const donut = $('#categoryDonut');
  $('#categoryDonutTotal').textContent = formatRM(breakdown.total);
  if (!breakdown.rows.length) {
    donut.style.background = 'conic-gradient(var(--surface-soft) 0 100%)';
    donut.setAttribute('aria-label', '本月还没有支出');
    $('#categoryInsightList').innerHTML = '<div class="donut-empty-state"><b>还没有本月支出</b><p>记录支出后，这里会显示各分类占比。</p></div>';
    return;
  }
  let cursor = 0;
  const segments = breakdown.rows.map(row => {
    const start = cursor;
    cursor += (row.amount / breakdown.total) * 100;
    return `${row.color} ${start.toFixed(2)}% ${cursor.toFixed(2)}%`;
  });
  donut.style.background = `conic-gradient(${segments.join(', ')})`;
  donut.setAttribute('aria-label', `本月分类支出分布，总计 ${formatRM(breakdown.total)}`);
  $('#categoryInsightList').innerHTML = breakdown.rows.map(row => `<div class="category-row"><span class="category-swatch" style="--category-color:${row.color}" aria-hidden="true"></span><span class="category-main"><b>${escapeHtml(row.category)}</b><small>本月支出分类</small></span><span class="category-value"><b>${formatRM(row.amount)}</b><small>${row.percent}%</small></span></div>`).join('');
}

function daysInUtcMonth(year, monthIndex) {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

function nextMonthlyDate(day, baseDate = today()) {
  const [year, month, date] = baseDate.split('-').map(Number);
  const candidate = (targetYear, targetMonth) => {
    const clampedDay = Math.min(day, daysInUtcMonth(targetYear, targetMonth));
    return `${String(targetYear).padStart(4, '0')}-${String(targetMonth + 1).padStart(2, '0')}-${String(clampedDay).padStart(2, '0')}`;
  };
  const current = candidate(year, month - 1);
  if (current >= baseDate && day >= date) return current;
  const nextMonth = month === 12 ? 0 : month;
  const nextYear = month === 12 ? year + 1 : year;
  return candidate(nextYear, nextMonth);
}

function renderUpcomingActions() {
  const actions = [];
  for (const account of activeAccounts()) {
    const subtype = accountSubtype(account);
    if (subtype === 'credit_card' && account.balanceMinor > 0 && account.dueDay) {
      const dueDate = nextMonthlyDate(account.dueDay);
      actions.push({ type:'account', id:account.id, sortDate:dueDate, icon:'卡', iconClass:'repayment', title:`${account.name} 还款日`, detail:`当前欠款 ${formatRM(account.balanceMinor)}`, value:describeEtaDate(dueDate, today()).replace(/^预计/, '') });
    } else if (subtype === 'loan' && account.balanceMinor > 0 && account.scheduledPaymentMinor) {
      actions.push({ type:'account', id:account.id, sortDate:account.expectedPayoffDate || '9999-12-31', icon:'贷', iconClass:'repayment', title:`${account.name} 每期还款`, detail:`剩余本金 ${formatRM(account.balanceMinor)}`, value:formatRM(account.scheduledPaymentMinor), meta:account.expectedPayoffDate ? `预计 ${account.expectedPayoffDate} 还清` : '按计划还款' });
    }
  }
  for (const item of itemRecords) {
    if (!item.etaDate || item.archivedAt || item.status === 'archived') continue;
    actions.push({ type:'item', id:item.id, sortDate:item.etaDate, icon:'物', iconClass:'eta', title:`${item.name} 预计到货`, detail:item.balanceMinor > 0 ? `待付 ${formatRM(item.balanceMinor)}` : '已付清', value:describeEtaDate(item.etaDate, today()) });
  }
  actions.sort((a, b) => a.sortDate.localeCompare(b.sortDate) || a.title.localeCompare(b.title, 'zh-CN'));
  const visible = actions.slice(0, 5);
  const list = $('#upcomingActionList');
  if (!visible.length) {
    list.innerHTML = '<div class="empty-state upcoming-empty-state"><b>近期没有待处理事项</b><p>信用卡还款、贷款计划和物品预计到货会显示在这里。</p></div>';
    return;
  }
  list.innerHTML = visible.map(action => `<button class="upcoming-action-row" type="button" data-upcoming-type="${action.type}" data-upcoming-id="${escapeHtml(action.id)}"><span class="upcoming-action-icon ${action.iconClass}" aria-hidden="true">${action.icon}</span><span class="upcoming-action-main"><b>${escapeHtml(action.title)}</b><small>${escapeHtml(action.detail)}</small></span><span class="upcoming-action-value">${escapeHtml(action.value)}${action.meta ? `<small>${escapeHtml(action.meta)}</small>` : ''}</span></button>`).join('');
  list.querySelectorAll('[data-upcoming-type]').forEach(button => button.addEventListener('click', () => {
    if (button.dataset.upcomingType === 'item') openItemDetail(button.dataset.upcomingId);
    else openAccountDetail(button.dataset.upcomingId);
  }));
}

function loanTypeLabel(account) {
  return account.loanType === 'home' ? '房贷' : account.loanType === 'car' ? '车贷' : '其他贷款';
}

function loanModeLabel(account) {
  const mode = loanCalculationMode(account);
  return mode === 'fixed_instalment' ? '固定月供' : mode === 'reducing_balance' ? '递减余额' : '手动金额';
}

function accountBalanceMeaning(account) {
  const subtype = accountSubtype(account);
  if (subtype === 'credit_card') return '当前欠款';
  if (subtype === 'loan') return loanCalculationMode(account) === 'fixed_instalment' ? '剩余应付总额' : '剩余本金';
  return account.kind === 'liability' ? '当前欠款' : '当前余额';
}

function accountRowMarkup(account) {
  const subtype = accountSubtype(account);
  const debt = account.kind === 'liability';
  const subtypeClass = subtype.replace('_', '-');
  const totalStatus = account.includeInTotal
    ? '<span class="account-total-status">计入家庭净额</span>'
    : '<span class="account-total-status excluded">不计入总额</span>';
  const type = subtype === 'loan' ? loanTypeLabel(account) : accountSubtypeLabel(account);
  return `<button class="account-row ${debt ? 'liability' : ''} ${subtypeClass} ${account.includeInTotal ? '' : 'excluded'}" data-account-id="${escapeHtml(account.id)}" data-account-subtype="${subtype}" aria-label="查看 ${escapeHtml(account.name)} 明细"><span class="account-mark ${debt ? 'liability' : ''}">${accountAvatarMarkup(account)}</span><span class="account-main"><b>${escapeHtml(account.name)}</b><small>${escapeHtml(type)} ${totalStatus}</small></span><span class="account-value"><b>${formatRM(account.balanceMinor)}</b><small>${accountBalanceMeaning(account)}</small></span><span class="row-chevron">${chevronIcon}</span></button>`;
}

function renderAccountGroups(accounts) {
  const groups = [
    ['可用资金', accounts.filter(account => accountSubtype(account) === 'asset')],
    ['信用卡', accounts.filter(account => accountSubtype(account) === 'credit_card')],
    ['贷款与其他负债', accounts.filter(account => ['loan', 'generic_liability'].includes(accountSubtype(account)))]
  ];
  return `<div class="account-groups">${groups.filter(([, rows]) => rows.length).map(([title, rows]) => `<section class="account-group"><div class="account-group-heading"><h3>${title}</h3><span>${rows.length} 个账户</span></div><div class="account-group-list">${rows.map(accountRowMarkup).join('')}</div></section>`).join('')}</div>`;
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
  const subtype = accountSubtype(account);
  const detailType = subtype === 'loan' ? `${loanTypeLabel(account)} · ${loanModeLabel(account)}` : accountSubtypeLabel(account);
  $('#accountDetailKind').textContent = `${detailType} · ${accountBalanceMeaning(account)}`;
  $('#accountDetailBalance').textContent = formatRM(account.balanceMinor);
  $('#accountDetailAvatar').innerHTML = accountAvatarMarkup(account);
  $('#accountDetailMonthLabel').textContent = `${monthLabel(selectedMonth)}账目`;
  $('#accountDetailCount').textContent = `${entries.length} 笔记录`;
  const metrics = $('#accountDetailMetrics');
  const metricRows = [];
  if (subtype === 'credit_card') {
    if (account.creditLimitMinor) metricRows.push(['信用额度', formatRM(account.creditLimitMinor)], ['可用额度', formatRM(Math.max(0, account.creditLimitMinor - account.balanceMinor))]);
    if (account.statementDay) metricRows.push(['账单日', `每月 ${account.statementDay} 日`]);
    if (account.dueDay) metricRows.push(['还款日', `每月 ${account.dueDay} 日`]);
  } else if (subtype === 'loan') {
    if (account.scheduledPaymentMinor) metricRows.push(['每月还款', formatRM(account.scheduledPaymentMinor)]);
    if (loanCalculationMode(account) === 'reducing_balance' && account.annualInterestRateBps) {
      metricRows.push(['目前年利率', `${(account.annualInterestRateBps / 100).toFixed(2)}%`], ['本月利息估算', formatRM(estimatedMonthlyInterestMinor(account))]);
    } else metricRows.push(['计算方式', loanModeLabel(account)]);
    if (account.originalPrincipalMinor) metricRows.push(['原始融资额', formatRM(account.originalPrincipalMinor)], ['已偿还进度', `${Math.round(Math.max(0, Math.min(1, 1 - account.balanceMinor / account.originalPrincipalMinor)) * 100)}%`]);
    if (account.expectedPayoffDate) metricRows.push(['预计还清', `${account.expectedPayoffDate}（剩余 ${remainingPayoffMonths(account)} 个月）`]);
  }
  metrics.innerHTML = metricRows.map(([label, value]) => `<div class="account-detail-metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join('');
  metrics.hidden = !metricRows.length;
  $('#openRepaymentButton').hidden = account.kind !== 'liability';
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

function updateRepaymentFunding() {
  const assetFunding = document.querySelector('input[name="repaymentFunding"]:checked')?.value === 'asset';
  $('#repaymentSourceRow').hidden = !assetFunding;
  $('#repaymentSourceAccount').required = assetFunding;
}

function currentRepaymentBreakdown(account) {
  const suggested = suggestedRepayment(account);
  const amountText = $('#repaymentAmount').value.trim();
  const amountMinor = amountText ? amountToSen(amountText) : suggested.amountMinor;
  const interestText = $('#repaymentInterest').value.trim();
  const interestOverrideMinor = interestText ? amountToSen(interestText, true) : undefined;
  return repaymentBreakdown(account, amountMinor, interestOverrideMinor);
}

function renderRepaymentBreakdown() {
  const account = accountById(pendingRepayment?.accountId);
  if (!account || pendingRepayment?.transactionId) return;
  try {
    const breakdown = currentRepaymentBreakdown(account);
    $('#repaymentPrincipalPreview').textContent = formatRM(breakdown.principalMinor);
    $('#repaymentInterestPreview').textContent = formatRM(breakdown.interestMinor);
    $('#repaymentInterestPreviewRow').hidden = breakdown.interestMinor === 0 && loanCalculationMode(account) !== 'reducing_balance';
    $('#repaymentBreakdown').hidden = false;
    $('#repaymentMessage').textContent = '';
  } catch (error) {
    $('#repaymentBreakdown').hidden = true;
    $('#repaymentMessage').textContent = error.message;
  }
}

function openRepayment(accountId, transactionId = null, returnAccountId = null) {
  const account = accountById(accountId);
  const entry = transactionId ? ledger.transactions.find(candidate => candidate.id === transactionId && !candidate.deletedAt) : null;
  if (!account || account.kind !== 'liability') return;
  if (!navigator.onLine) {
    showToast('记录还款需要联网。');
    return;
  }
  const reviewing = Boolean(entry);
  repaymentReturnAccountId = typeof returnAccountId === 'string' ? returnAccountId : null;
  const subtype = accountSubtype(account);
  const mode = subtype === 'loan' ? loanCalculationMode(account) : null;
  const suggestion = suggestedRepayment(account);
  pendingRepayment = { accountId, transactionId:entry?.id ?? null, operationId:uid('repayment') };
  const form = $('#repaymentForm');
  form.reset();
  form.querySelectorAll('input, select').forEach(control => { control.disabled = false; });
  populateAccounts();
  $('#repaymentAccountName').textContent = reviewing ? `查看 ${account.name} 还款` : account.name;
  if (reviewing) {
    $('#repaymentBalanceCopy').textContent = `这笔还款总额 ${formatRM(entry.amountMinor)}，其中减少欠款 ${formatRM(entry.principalMinor)}${entry.interestMinor ? `，利息 ${formatRM(entry.interestMinor)}` : ''}。如需更正，请移入回收站后重新记录。`;
  } else if (subtype === 'credit_card') {
    $('#repaymentBalanceCopy').textContent = `当前欠款 ${formatRM(account.balanceMinor)}。默认一次还清；你可以直接改成本次要还的金额。`;
  } else if (mode === 'fixed_instalment') {
    $('#repaymentBalanceCopy').textContent = `剩余应付总额 ${formatRM(account.balanceMinor)}。默认月供 ${formatRM(suggestion.amountMinor)}，已包含固定利息。`;
  } else if (mode === 'reducing_balance') {
    const rate = account.annualInterestRateBps ? `${(account.annualInterestRateBps / 100).toFixed(2)}%` : '未设置';
    $('#repaymentBalanceCopy').textContent = `剩余本金 ${formatRM(account.balanceMinor)}，目前年利率 ${rate}。默认还款 ${formatRM(suggestion.amountMinor)}，系统会估算本期利息。`;
  } else {
    $('#repaymentBalanceCopy').textContent = `当前欠款 ${formatRM(account.balanceMinor)}。默认还款 ${formatRM(suggestion.amountMinor)}，仍可修改。`;
  }
  $('#repaymentAmountLabel').textContent = mode === 'fixed_instalment' ? '本期还款总额' : '本次还款总额';
  $('#repaymentAmount').value = reviewing ? senToAmount(entry.amountMinor) : suggestion.amountMinor ? senToAmount(suggestion.amountMinor) : '';
  $('#repaymentInterest').value = reviewing ? senToAmount(entry.interestMinor || 0) : suggestion.interestMinor ? senToAmount(suggestion.interestMinor) : '';
  $('#repaymentInterestRow').hidden = mode !== 'reducing_balance';
  document.querySelector(`input[name="repaymentFunding"][value="${entry?.accountId ? 'asset' : reviewing ? 'off_ledger' : 'asset'}"]`).checked = true;
  $('#repaymentSourceAccount').value = entry?.accountId ?? assetAccounts()[0]?.id ?? '';
  $('#repaymentDate').value = entry?.occurredAt?.slice(0, 10) ?? today();
  $('#repaymentNote').value = entry?.note ?? '';
  $('#repaymentMessage').textContent = '';
  $('#repaymentFullButton').hidden = reviewing;
  $('#saveRepaymentButton').hidden = reviewing;
  const archive = $('#archiveRepaymentButton');
  if (archive) archive.hidden = !reviewing;
  updateRepaymentFunding();
  if (reviewing) {
    $('#repaymentPrincipalPreview').textContent = formatRM(entry.principalMinor);
    $('#repaymentInterestPreview').textContent = formatRM(entry.interestMinor || 0);
    $('#repaymentInterestPreviewRow').hidden = !entry.interestMinor;
    $('#repaymentBreakdown').hidden = false;
    form.querySelectorAll('input, select').forEach(control => { control.disabled = true; });
  } else renderRepaymentBreakdown();
  showDialog($('#repaymentDialog'));
}

function ensureRepaymentArchiveButton() {
  if ($('#archiveRepaymentButton')) return;
  const button = document.createElement('button');
  button.id = 'archiveRepaymentButton';
  button.type = 'button';
  button.className = 'danger-button';
  button.textContent = '移入回收站';
  button.hidden = true;
  $('#saveRepaymentButton').insertAdjacentElement('afterend', button);
  button.addEventListener('click', async () => {
    if (!pendingRepayment?.transactionId || !navigator.onLine) return;
    const operationId = uid('repayment-recycle');
    try {
      const result = moveToRecycleBin(ledger, pendingRepayment.transactionId, operationId);
      await applyLedgerChange(result.ledger, next => saveTransactionRecord(next, pendingRepayment.transactionId), pendingLedgerPatch(result.ledger, 'transactionPatch', pendingRepayment.transactionId, operationId));
      closeRepayment({ returnToDetail:true });
      showToast('还款已移入回收站。');
    } catch (error) { $('#repaymentMessage').textContent = error.message; }
  });
}

function bindRenderedControls(root = document) {
  root.querySelectorAll('[data-account-id]').forEach(button => button.addEventListener('click', () => openAccountDetail(button.dataset.accountId)));
  root.querySelectorAll('[data-transaction-id]').forEach(button => button.addEventListener('click', () => {
    const entry = ledger.transactions.find(candidate => candidate.id === button.dataset.transactionId);
    const fromAccountDetail = $('#accountDetailDialog').open;
    const open = () => entry?.kind === 'repayment'
      ? openRepayment(entry.targetAccountId, entry.id, fromAccountDetail ? selectedAccountDetailId : null)
      : button.dataset.linkedItemId ? openItemFromLedger(button.dataset.linkedItemId, button.dataset.linkedPaymentId) : openEntry(button.dataset.transactionId);
    if (fromAccountDetail) dismissDialog($('#accountDetailDialog'), open);
    else open();
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
  $('#accountList').innerHTML = accounts.length ? renderAccountGroups(accounts) : '<div class="empty-state"><b>还没有账户</b><p>新增现金、银行或信用卡账户，开始建立家庭账本。</p><button class="secondary-button" type="button" data-new-account>新增账户</button></div>';

  const entries = selectedEntries().sort(compareEntriesNewestFirst);
  $('#transactionList').innerHTML = renderTransactionRows(entries, '这个月还没有账目', '新增一笔收入、支出或转账后，会在这里显示。');

  renderCategoryOverview(entries);
  renderItemsView();
  renderUpcomingActions();

  bindRenderedControls();
  if (selectedAccountDetailId && $('#accountDetailDialog').open) renderAccountDetail();
  document.querySelectorAll('[data-new-account]').forEach(button => button.addEventListener('click', () => openAccount()));
}

function accountOptions(accounts) {
  return accounts.map(account => {
    const subtype = accountSubtype(account);
    const type = subtype === 'loan' ? loanTypeLabel(account) : accountSubtypeLabel(account);
    const balance = account.kind === 'liability' ? `欠款 ${formatRM(account.balanceMinor)}` : `余额 ${formatRM(account.balanceMinor)}`;
    return `<option value="${escapeHtml(account.id)}">${escapeHtml(account.name)} ｜ ${escapeHtml(type)} ｜ ${escapeHtml(balance)}</option>`;
  }).join('');
}

function populateEntryAccounts(kind, sourceId = null, targetId = null) {
  $('#sourceAccount').innerHTML = accountOptions(entryAccounts(kind));
  $('#targetAccount').innerHTML = accountOptions(assetAccounts());
  if (sourceId && entryAccounts(kind).some(account => account.id === sourceId)) $('#sourceAccount').value = sourceId;
  if (targetId && assetAccounts().some(account => account.id === targetId)) $('#targetAccount').value = targetId;
}

function populateAccounts() {
  const kind = document.querySelector('input[name="kind"]:checked')?.value ?? 'expense';
  populateEntryAccounts(kind);
  const itemOptions = accountOptions(itemPaymentAccounts());
  $('#newItemAccount').innerHTML = itemOptions;
  $('#paymentAccount').innerHTML = itemOptions;
  $('#repaymentSourceAccount').innerHTML = accountOptions(assetAccounts());
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
  const kind = document.querySelector('input[name="kind"]:checked').value;
  const transfer = kind === 'transfer';
  $('#targetRow').hidden = !transfer;
  $('#categoryRow').hidden = transfer;
  populateEntryAccounts(kind, $('#sourceAccount').value, $('#targetAccount').value);
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
  if (entry?.sourceType === 'itemPayment') {
    openItemFromLedger(entry.sourceItemId, entry.sourcePaymentId);
    return;
  }
  if (entry?.kind === 'repayment') {
    openRepayment(entry.targetAccountId, entry.id);
    return;
  }

  pendingOperationId = uid(entry ? 'edit' : 'op');
  saveLocked = false;
  $('#saveEntryButton').disabled = false;
  $('#entryMessage').textContent = '';
  $('#entryForm').reset();
  $('#editingTransactionId').value = entry?.id || '';
  $('#entryDialogTitle').textContent = entry ? '编辑账目' : '新增账目';
  $('#saveEntryButton').textContent = entry ? '保存修改' : '保存账目';
  $('#archiveTransactionButton').hidden = !entry;

  if (entry) {
    document.querySelector(`input[name="kind"][value="${entry.kind}"]`).checked = true;
    updateKindState();
    $('#amountInput').value = senToAmount(entry.amountMinor);
    $('#sourceAccount').value = entry.accountId;
    $('#targetAccount').value = entry.targetAccountId || '';
    selectCategory(entry.category || '');
    $('#noteInput').value = entry.note || '';
    $('#dateInput').value = entry.occurredAt.slice(0, 10);
  } else {
    document.querySelector(`input[name="kind"][value="${entryPreferences.lastKind}"]`).checked = true;
    updateKindState();
    applyRememberedAccounts(entryPreferences.lastKind);
    selectCategory('');
    $('#dateInput').value = today();
  }

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

function optionalMoney(input, label) {
  const value = input.value.trim();
  if (!value) return null;
  try { return amountToSen(value); } catch { throw new Error(`${label}必须大于零`); }
}

function optionalDay(input) {
  if (!input.value) return null;
  const value = Number(input.value);
  if (!Number.isInteger(value) || value < 1 || value > 31) throw new Error('账单日期必须介于 1 至 31');
  return value;
}

function optionalRate(input) {
  const text = input.value.trim();
  if (!text) return null;
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0 || value > 100) throw new Error('贷款年利率必须介于 0.01% 至 100%');
  return Math.round(value * 100);
}

function updateLoanFields({ resetMode = false } = {}) {
  const type = $('#loanType').value;
  if (resetMode) $('#loanCalculationMode').value = type === 'home' ? 'reducing_balance' : type === 'car' ? 'fixed_instalment' : 'manual';
  const mode = $('#loanCalculationMode').value;
  $('#annualInterestRateRow').hidden = mode !== 'reducing_balance';
  $('#annualInterestRate').required = false;
  $('#loanCalculationHelp').textContent = mode === 'fixed_instalment'
    ? '适合传统车贷：月供已包含利息，每期整笔减少剩余应付总额。'
    : mode === 'reducing_balance'
      ? '适合房贷与新制递减余额车贷：按当前本金与年利率估算本月利息。'
      : '不自动计算利息；本次还款金额会直接减少欠款。';
  $('#scheduledPaymentLabel').textContent = type === 'home' ? '每月计划还款（RM，可选）' : type === 'car' ? '每月固定还款（RM，可选）' : '每期计划还款（RM，可选）';
  $('#scheduledPaymentHelp').textContent = '记录还款时会自动填入这个金额，仍可修改。';
  $('#originalPrincipalLabel').textContent = mode === 'fixed_instalment' ? '原始应付总额（RM，可选）' : '原始融资额（RM，可选）';
}

function updateAccountSubtypeFields() {
  const subtype = document.querySelector('input[name="accountSubtype"]:checked')?.value ?? 'asset';
  $('#creditCardFields').hidden = subtype !== 'credit_card';
  $('#loanFields').hidden = subtype !== 'loan';
  $('#openingBalanceLabel').textContent = subtype === 'asset' ? '当前余额（RM）' : subtype === 'loan' && $('#loanCalculationMode').value === 'fixed_instalment' ? '目前剩余应付总额（RM）' : '当前欠款（RM）';
  if (subtype === 'loan') updateLoanFields();
}

function openAccount(id = null) {
  const account = id ? ledger.accounts.find(item => item.id === id) : null;
  const subtype = account ? accountSubtype(account) : 'asset';
  pendingAccountOperationId = uid(account ? 'account-edit' : 'account-create');
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
  const generic = document.querySelector('input[name="accountSubtype"][value="generic_liability"]');
  generic.closest('label').hidden = !account;
  document.querySelector(`input[name="accountSubtype"][value="${subtype}"]`).checked = true;
  $('#creditLimit').value = account?.creditLimitMinor ? senToAmount(account.creditLimitMinor) : '';
  $('#statementDay').value = account?.statementDay ?? '';
  $('#dueDay').value = account?.dueDay ?? '';
  $('#loanType').value = account?.loanType ?? 'car';
  $('#loanCalculationMode').value = account ? loanCalculationMode(account) : 'fixed_instalment';
  $('#annualInterestRate').value = account?.annualInterestRateBps ? (account.annualInterestRateBps / 100).toFixed(2) : '';
  $('#originalPrincipal').value = account?.originalPrincipalMinor ? senToAmount(account.originalPrincipalMinor) : '';
  $('#scheduledPayment').value = account?.scheduledPaymentMinor ? senToAmount(account.scheduledPaymentMinor) : '';
  $('#expectedPayoffDate').value = account?.expectedPayoffDate ?? '';
  updateAccountSubtypeFields();
  showDialog($('#accountDialog'));
  setTimeout(() => $('#accountName').focus(), 30);
}

function renderRecycle() {
  const deleted = ledger.transactions.filter(entry => entry.deletedAt).sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
  $('#recycleList').innerHTML = deleted.length ? deleted.map(entry => `<div class="recycle-row"><span class="transaction-icon expense">−</span><div class="transaction-main"><b>${escapeHtml(entry.category || typeLabel(entry.kind))} · ${formatRM(entry.amountMinor)}</b><small>${dateLabel(entry.deletedAt)} 移入 · ${escapeHtml(entry.note || '无备注')}</small><div class="recycle-actions"><button class="minor-button" data-restore="${escapeHtml(entry.id)}">恢复</button><button class="minor-button delete" data-delete="${escapeHtml(entry.id)}">永久删除</button></div></div></div>`).join('') : '<div class="empty-state"><b>回收站是空的</b><p>移除的账目会先放在这里，方便恢复。</p></div>';

  document.querySelectorAll('[data-restore]').forEach(button => button.addEventListener('click', async () => {
    const operationId = uid('restore');
    const result = restoreFromRecycleBin(ledger, button.dataset.restore, operationId);
    await applyLedgerChange(result.ledger, next => saveTransactionRecord(next, button.dataset.restore), pendingLedgerPatch(result.ledger, 'transactionPatch', button.dataset.restore, operationId));
    renderRecycle();
    showToast(result.duplicate ? '重复恢复已阻止。' : '已恢复账目并重新核对余额。');
  }));
  document.querySelectorAll('[data-delete]').forEach(button => button.addEventListener('click', async () => {
    const operationId = uid('delete');
    const prior = ledger.transactions.find(entry => entry.id === button.dataset.delete);
    const result = permanentlyDelete(ledger, button.dataset.delete, operationId);
    await applyLedgerChange(result.ledger, async () => {
      if (usesCloudStore()) await cloud.purgeTransaction(currentHousehold.id, button.dataset.delete, operationId);
    }, pendingLedgerPatch(result.ledger, 'transactionPatch', button.dataset.delete, operationId, { ...prior, purgedAt:new Date().toISOString(), lastOperationId:operationId }));
    renderRecycle();
    showToast(result.duplicate ? '重复删除已阻止。' : '已永久移除这笔账目。');
  }));
}

async function exportLocal() {
  const button = $('#exportButton');
  button.disabled = true;
  $('#settingsMessage').textContent = '';
  try {
    const payments = usesCloudStore()
      ? await cloud.loadAllItemPayments(currentHousehold.id)
      : serialiseItemsState(itemsState).itemPayments;
    const payload = withoutMediaDataUrls({
      schemaVersion:2,
      exportedAt:new Date().toISOString(),
      household:usesCloudStore() ? { id:currentHousehold.id, name:currentHousehold.name } : { id:'local', name:'本机账本' },
      ledger:serialiseLedger(ledger),
      items:itemRecords,
      itemPayments:payments
    });
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type:'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `family-wallet-backup-${today()}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
    dismissDialog($('#settingsDialog'));
    showToast('已导出 schemaVersion 2 资料；照片内容未包含。');
  } catch (error) {
    $('#settingsMessage').textContent = `无法导出：${error.message}`;
  } finally {
    button.disabled = false;
  }
}

function closeRepayment({ returnToDetail = false } = {}) {
  const accountId = returnToDetail ? repaymentReturnAccountId : null;
  repaymentReturnAccountId = null;
  pendingRepayment = null;
  dismissDialog($('#repaymentDialog'), () => {
    const account = accountId ? accountById(accountId) : null;
    if (account && !account.archivedAt) openAccountDetail(accountId);
  });
}

function openRepaymentFromDetail(accountId, transactionId = null) {
  if (!navigator.onLine) {
    openRepayment(accountId, transactionId);
    return;
  }
  dismissDialog($('#accountDetailDialog'), () => openRepayment(accountId, transactionId, accountId));
}

function requestDialogClose(dialog) {
  if (dialog?.id === 'itemDetailDialog') closeItemDetail();
  else if (dialog?.id === 'receiptViewerDialog') closeReceiptViewer();
  else if (dialog?.id === 'repaymentDialog') closeRepayment({ returnToDetail:true });
  else dismissDialog(dialog);
}

document.querySelectorAll('[data-view-target]').forEach(button => button.addEventListener('click', () => setView(button.dataset.viewTarget)));
document.querySelectorAll('[data-close-dialog]').forEach(button => button.addEventListener('click', () => requestDialogClose($(`#${button.dataset.closeDialog}`))));
document.querySelectorAll('dialog').forEach(dialog => {
  dialog.addEventListener('click', event => {
    if (event.target === dialog) requestDialogClose(dialog);
  });
  dialog.addEventListener('cancel', event => {
    event.preventDefault();
    requestDialogClose(dialog);
  });
});
$('#moreButton').addEventListener('click', () => {
  $('#settingsMessage').textContent = '';
  showDialog($('#settingsDialog'));
});
$('#syncBadge').addEventListener('click', () => {
  if (runtimeMode === 'local') {
    showToast('本机模式不需要云端同步。');
    return;
  }
  itemListenerError = null;
  renderSyncStatus();
  syncCoordinator.requestRecovery('manual');
});
$('#newItemButton').addEventListener('click', openNewItem);
document.querySelectorAll('input[name="itemsFilter"]').forEach(input => input.addEventListener('change', event => {
  itemFilter = event.target.value;
  renderItemsView();
}));
$('#newItemDepositAmount').addEventListener('input', updateNewItemDepositControls);
$('#newItemLinked').addEventListener('change', updateNewItemDepositControls);
$('#paymentLinked').addEventListener('change', updatePaymentAccountRow);
$('#payItemFullButton').addEventListener('click', () => openPaymentDialog(true));
$('#payItemPartButton').addEventListener('click', () => openPaymentDialog(false));
$('#editItemButton').addEventListener('click', openEditItem);
$('#archiveItemButton').addEventListener('click', event => runItemLifecycle('archive', event.currentTarget));
$('#restoreItemButton').addEventListener('click', event => runItemLifecycle('restore', event.currentTarget));
$('#closeReceiptViewerButton').addEventListener('click', closeReceiptViewer);
$('#editItemCover').addEventListener('change', event => {
  if (event.target.files?.length) $('#editItemRemoveCover').checked = false;
  if (pendingItemEdit) {
    pendingItemEdit.cover = null;
    pendingItemEdit.coverFile = null;
  }
});
$('#editItemRemoveCover').addEventListener('change', event => {
  if (event.target.checked) {
    $('#editItemCover').value = '';
    if (pendingItemEdit) {
      pendingItemEdit.cover = null;
      pendingItemEdit.coverFile = null;
    }
  }
});

$('#newItemForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (!pendingItemCreate) return;
  const button = $('#saveNewItemButton');
  const original = button.textContent;
  button.disabled = true;
  button.textContent = '保存中…';
  $('#newItemMessage').textContent = '';
  try {
    if (usesCloudStore() && !navigator.onLine) throw new Error('新增物品需要联网');
    const depositText = $('#newItemDepositAmount').value.trim();
    const hasDeposit = depositText !== '';
    if (!hasDeposit && $('#newItemReceipt').files?.length) throw new Error('请先填写订金金额，再附上订金凭证');
    const fullPriceMinor = amountToSen($('#newItemFullPrice').value);
    const depositAmountMinor = hasDeposit ? amountToSen(depositText) : 0;
    if (depositAmountMinor > fullPriceMinor) throw new Error('订金不能超过物品全价');
    const linked = hasDeposit && $('#newItemLinked').checked;
    const accountId = linked ? $('#newItemAccount').value : null;
    if (linked && !accountId) throw new Error('请选择付款账户，或关闭账目联动');
    const cover = await prepareFormMedia($('#newItemCover'), 'cover', pendingItemCreate, 'cover', $('#newItemCoverStatus'));
    const receipt = hasDeposit
      ? await prepareFormMedia($('#newItemReceipt'), 'receipt', pendingItemCreate, 'receipt', $('#newItemReceiptStatus'))
      : null;
    const deposit = hasDeposit ? {
      paymentId:pendingItemCreate.depositPaymentId,
      operationId:pendingItemCreate.depositOperationId,
      amountMinor:depositAmountMinor,
      occurredAt:`${$('#newItemDepositDate').value || today()}T12:00:00.000Z`,
      note:$('#newItemDepositNote').value.trim(),
      accountId,
      mode:linked ? 'linked' : 'independent',
      ledgerMode:linked ? 'linked' : 'independent',
      receiptMedia:receipt,
      receiptMediaId:receipt?.id ?? null,
      actor:'local'
    } : null;
    if (usesCloudStore()) {
      const result = await cloud.createItem({
        householdId:currentHousehold.id,
        itemId:pendingItemCreate.itemId,
        operationId:pendingItemCreate.operationId,
        actorUid:cloudUser.uid,
        createdAt:pendingItemCreate.createdAt,
        name:$('#newItemName').value.trim(),
        note:$('#newItemNote').value.trim(),
        etaDate:$('#newItemEtaDate').value || null,
        fullPriceMinor,
        coverMedia:cover,
        deposit
      });
      upsertItemRecord(result.item);
      if (cover) mediaCache.set(mediaKey(currentHousehold.id, cover.id), cover);
      render();
    } else {
      const result = createLocalItem(itemsState, {
        id:pendingItemCreate.itemId,
        operationId:pendingItemCreate.operationId,
        expectedRevision:itemsState.revision,
        createdAt:pendingItemCreate.createdAt,
        actor:'local',
        name:$('#newItemName').value.trim(),
        note:$('#newItemNote').value.trim(),
        etaDate:$('#newItemEtaDate').value || null,
        fullPriceMinor,
        coverMediaId:cover?.id ?? null,
        deposit:deposit ? { ...deposit, receiptMedia:undefined } : null
      });
      const nextLedger = applyLinkedExpenseSpec(ledger, result.expenseSpec);
      const nextMedia = new Map(localItemMedia);
      if (cover) nextMedia.set(cover.id, { ...cover, itemId:pendingItemCreate.itemId, paymentId:null, kind:'cover' });
      if (receipt) nextMedia.set(receipt.id, { ...receipt, itemId:pendingItemCreate.itemId, paymentId:pendingItemCreate.depositPaymentId, kind:'receipt' });
      commitLocalItemMutation(nextLedger, result.state, nextMedia);
    }
    pendingItemCreate = null;
    dismissDialog($('#newItemDialog'));
    setView('items');
    showToast(hasDeposit ? '物品与订金已保存。' : '物品已保存。');
  } catch (error) {
    $('#newItemMessage').textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
});

$('#paymentForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (!pendingPayment || !selectedItemId) return;
  const button = $('#savePaymentButton');
  const original = button.textContent;
  button.disabled = true;
  button.textContent = '保存中…';
  $('#paymentMessage').textContent = '';
  const wasFull = pendingPayment.full;
  try {
    if (usesCloudStore() && !navigator.onLine) throw new Error('记录付款需要联网');
    const item = normaliseDisplayItem(itemById(selectedItemId));
    if (!item || item.status === 'archived') throw new Error('物品不可付款');
    const amountMinor = pendingPayment.full ? item.balanceMinor : amountToSen($('#paymentAmount').value);
    if (amountMinor <= 0 || amountMinor > item.balanceMinor) throw new Error('付款金额不能超过当前余额');
    if (pendingPayment.full) $('#paymentAmount').value = senToAmount(amountMinor);
    const linked = $('#paymentLinked').checked;
    const accountId = linked ? $('#paymentAccount').value : null;
    if (linked && !accountId) throw new Error('请选择付款账户，或关闭账目联动');
    const receipt = await prepareFormMedia($('#paymentReceipt'), 'receipt', pendingPayment, 'receipt', $('#paymentReceiptStatus'));
    const input = {
      householdId:currentHousehold?.id,
      itemId:item.id,
      paymentId:pendingPayment.paymentId,
      operationId:pendingPayment.operationId,
      expectedRevision:usesCloudStore() ? item.revision : itemsState.revision,
      actorUid:cloudUser?.uid,
      actor:'local',
      createdAt:pendingPayment.createdAt,
      amountMinor,
      type:'payment',
      occurredAt:`${$('#paymentDate').value || today()}T12:00:00.000Z`,
      note:$('#paymentNote').value.trim(),
      accountId,
      mode:linked ? 'linked' : 'independent',
      ledgerMode:linked ? 'linked' : 'independent',
      receiptMedia:receipt,
      receiptMediaId:receipt?.id ?? null
    };
    if (usesCloudStore()) {
      const result = await cloud.addItemPayment(input);
      upsertItemRecord(result.item);
      upsertCurrentPayment(result.payment);
      render();
      renderItemDetail();
    } else {
      const result = recordLocalItemPayment(itemsState, item.id, { ...input, receiptMedia:undefined });
      const nextLedger = applyLinkedExpenseSpec(ledger, result.expenseSpec);
      const nextMedia = new Map(localItemMedia);
      if (receipt) nextMedia.set(receipt.id, { ...receipt, itemId:item.id, paymentId:pendingPayment.paymentId, kind:'receipt' });
      commitLocalItemMutation(nextLedger, result.state, nextMedia);
    }
    pendingPayment = null;
    dismissDialog($('#paymentDialog'));
    showToast(wasFull ? '物品已付清。' : '付款已保存。');
  } catch (error) {
    $('#paymentMessage').textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
});

$('#editItemForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (!pendingItemEdit || !selectedItemId) return;
  const button = $('#saveEditItemButton');
  const original = button.textContent;
  button.disabled = true;
  button.textContent = '保存中…';
  $('#editItemMessage').textContent = '';
  try {
    if (usesCloudStore() && !navigator.onLine) throw new Error('编辑物品需要联网');
    const item = itemById(selectedItemId);
    if (!item) throw new Error('物品不存在');
    const cover = await prepareFormMedia($('#editItemCover'), 'cover', pendingItemEdit, 'cover', $('#editItemCoverStatus'));
    const removeCover = !cover && $('#editItemRemoveCover').checked;
    const changes = {
      name:$('#editItemName').value.trim(),
      note:$('#editItemNote').value.trim(),
      etaDate:$('#editItemEtaDate').value || null,
      fullPriceMinor:amountToSen($('#editItemFullPrice').value)
    };
    if (cover) changes.coverMediaId = cover.id;
    else if (removeCover) changes.coverMediaId = null;
    if (usesCloudStore()) {
      const result = await cloud.editItem({
        householdId:currentHousehold.id,
        itemId:item.id,
        operationId:pendingItemEdit.operationId,
        expectedRevision:item.revision,
        actorUid:cloudUser.uid,
        updatedAt:pendingItemEdit.updatedAt,
        changes,
        coverMedia:cover
      });
      if (pendingItemEdit.originalCoverMediaId && pendingItemEdit.originalCoverMediaId !== result.item.coverMediaId) {
        mediaCache.delete(mediaKey(currentHousehold.id, pendingItemEdit.originalCoverMediaId));
      }
      if (cover) mediaCache.set(mediaKey(currentHousehold.id, cover.id), cover);
      upsertItemRecord(result.item);
      render();
      renderItemDetail();
    } else {
      const result = editLocalItem(itemsState, item.id, changes, {
        operationId:pendingItemEdit.operationId,
        expectedRevision:itemsState.revision,
        actor:'local',
        updatedAt:pendingItemEdit.updatedAt
      });
      const nextMedia = new Map(localItemMedia);
      if ((cover || removeCover) && pendingItemEdit.originalCoverMediaId) nextMedia.delete(pendingItemEdit.originalCoverMediaId);
      if (cover) nextMedia.set(cover.id, { ...cover, itemId:item.id, paymentId:null, kind:'cover' });
      commitLocalItemMutation(ledger, result.state, nextMedia);
    }
    pendingItemEdit = null;
    dismissDialog($('#editItemDialog'));
    showToast('物品资料已更新。');
  } catch (error) {
    $('#editItemMessage').textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
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
ensureRepaymentArchiveButton();
document.querySelectorAll('input[name="accountSubtype"]').forEach(input => input.addEventListener('change', updateAccountSubtypeFields));
$('#loanType').addEventListener('change', () => { updateLoanFields({ resetMode:true }); updateAccountSubtypeFields(); });
$('#loanCalculationMode').addEventListener('change', updateAccountSubtypeFields);
document.querySelectorAll('input[name="repaymentFunding"]').forEach(input => input.addEventListener('change', updateRepaymentFunding));
document.querySelectorAll('input[name="appTheme"]').forEach(input => input.addEventListener('change', () => applyTheme(input.value)));
$('#openRepaymentButton').addEventListener('click', () => openRepaymentFromDetail(selectedAccountDetailId));
$('#repaymentAmount').addEventListener('input', renderRepaymentBreakdown);
$('#repaymentInterest').addEventListener('input', renderRepaymentBreakdown);
$('#repaymentFullButton').addEventListener('click', () => {
  const account = accountById(pendingRepayment?.accountId);
  if (!account || pendingRepayment?.transactionId) return;
  const interestMinor = estimatedMonthlyInterestMinor(account);
  $('#repaymentAmount').value = senToAmount(account.balanceMinor + interestMinor);
  if (loanCalculationMode(account) === 'reducing_balance') $('#repaymentInterest').value = interestMinor ? senToAmount(interestMinor) : '';
  renderRepaymentBreakdown();
});
$('#repaymentForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (!pendingRepayment) return;
  const button = $('#saveRepaymentButton');
  button.disabled = true;
  $('#repaymentMessage').textContent = '';
  try {
    if (!navigator.onLine) throw new Error('记录还款需要联网');
    if (pendingRepayment.transactionId) throw new Error('既有还款不能直接覆写，请移入回收站后重新记录');
    const account = accountById(pendingRepayment.accountId);
    if (!account || account.kind !== 'liability') throw new Error('还款账户不存在');
    const breakdown = currentRepaymentBreakdown(account);
    const funding = document.querySelector('input[name="repaymentFunding"]:checked').value;
    const changes = {
      kind:'repayment',
      accountId:funding === 'asset' ? $('#repaymentSourceAccount').value : null,
      targetAccountId:account.id,
      principalMinor:breakdown.principalMinor,
      interestMinor:breakdown.interestMinor,
      amountMinor:breakdown.amountMinor,
      category:null,
      note:$('#repaymentNote').value.trim(),
      occurredAt:`${$('#repaymentDate').value || today()}T12:00:00.000Z`
    };
    if (funding === 'asset' && !changes.accountId) throw new Error('请选择付款账户');
    const result = applyLedgerOperation(ledger, { id:pendingRepayment.operationId, ...changes });
    const transactionId = pendingRepayment.operationId;
    await applyLedgerChange(result.ledger, next => saveTransactionRecord(next, transactionId), pendingLedgerPatch(result.ledger, 'transactionPatch', transactionId, pendingRepayment.operationId));
    pendingRepayment = null;
    closeRepayment({ returnToDetail:true });
    showToast('还款已保存。');
  } catch (error) { $('#repaymentMessage').textContent = error.message; }
  finally { button.disabled = false; }
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
      : applyLedgerOperation(ledger, { id:pendingOperationId, ...changes });
    const transactionId = editingTransactionId || pendingOperationId;
    await applyLedgerChange(result.ledger, next => saveTransactionRecord(next, transactionId), pendingLedgerPatch(result.ledger, 'transactionPatch', transactionId, pendingOperationId));
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
  const operationId = uid('recycle');
  const result = moveToRecycleBin(ledger, editingTransactionId, operationId);
  await applyLedgerChange(result.ledger, next => saveTransactionRecord(next, editingTransactionId), pendingLedgerPatch(result.ledger, 'transactionPatch', editingTransactionId, operationId));
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
    const subtype = document.querySelector('input[name="accountSubtype"]:checked').value;
    const kind = subtype === 'asset' ? 'asset' : 'liability';
    const metadata = {
      subtype,
      kind,
      creditLimitMinor:subtype === 'credit_card' ? optionalMoney($('#creditLimit'), '信用额度') : null,
      statementDay:subtype === 'credit_card' ? optionalDay($('#statementDay')) : null,
      dueDay:subtype === 'credit_card' ? optionalDay($('#dueDay')) : null,
      loanType:subtype === 'loan' ? $('#loanType').value : null,
      loanCalculationMode:subtype === 'loan' ? $('#loanCalculationMode').value : null,
      annualInterestRateBps:subtype === 'loan' && $('#loanCalculationMode').value === 'reducing_balance' ? optionalRate($('#annualInterestRate')) : null,
      originalPrincipalMinor:subtype === 'loan' ? optionalMoney($('#originalPrincipal'), '原始融资额') : null,
      scheduledPaymentMinor:subtype === 'loan' ? optionalMoney($('#scheduledPayment'), '计划还款额') : null,
      expectedPayoffDate:subtype === 'loan' ? ($('#expectedPayoffDate').value || null) : null
    };
    const openingBalanceMinor = id ? null : amountToSen($('#openingBalance').value, true);
    if (!id && kind === 'liability' && openingBalanceMinor < 0) throw new Error('当前欠款不能为负数');
    const changes = { name, includeInTotal, photoDataUrl:pendingAccountPhotoDataUrl, ...metadata };
    const nextLedger = id ? updateAccount(ledger, id, changes) : createAccount(ledger, {
      id:uid('account'),
      name,
      openingBalanceMinor,
      includeInTotal,
      photoDataUrl:pendingAccountPhotoDataUrl,
      ...metadata
    });
    const accountId = id || nextLedger.accounts.at(-1).id;
    await applyLedgerChange(nextLedger, next => saveAccountRecord(next, accountId), pendingLedgerPatch(nextLedger, 'accountPatch', accountId, pendingAccountOperationId));
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
  await applyLedgerChange(nextLedger, next => saveAccountRecord(next, id), pendingLedgerPatch(nextLedger, 'accountPatch', id, pendingAccountOperationId));
  dismissDialog($('#accountDialog'));
  setView('accounts');
  showToast('账户已归档，并从家庭净额排除。');
});

function stopItemListeners() {
  stopItemsWatch?.();
  stopItemPaymentsWatch?.();
  stopItemsWatch = stopItemPaymentsWatch = null;
  coverObserver?.disconnect();
  coverObserver = null;
}

function restartHouseholdListener(listenerToken, householdId) {
  stopHouseholdWatch?.();
  stopHouseholdWatch = cloud.subscribeHousehold(householdId, state => {
    if (listenerToken !== currentListenerToken || householdId !== desiredHouseholdId) return;
    const { metadata, ...raw } = state;
    syncCoordinator.acceptSnapshot(listenerToken, raw, metadata);
  }, error => {
    if (listenerToken !== currentListenerToken || householdId !== desiredHouseholdId) return;
    const failedBeforeFirstSnapshot = !householdSwitchHasSnapshot;
    syncCoordinator.listenerError(listenerToken, error);
    if (failedBeforeFirstSnapshot && householdSwitchPreviousId) {
      const rollbackId = householdSwitchPreviousId;
      householdSwitchPreviousId = null;
      desiredHouseholdId = rollbackId;
      householdSwitchHasSnapshot = false;
      currentListenerToken = syncCoordinator.activateHousehold(cloudSessionToken, rollbackId);
      $('#workspaceSelect').value = rollbackId;
      restartHouseholdListener(currentListenerToken, rollbackId);
      showToast(`无法切换账本，已返回原账本：${error.message}`);
      return;
    }
    setSwitching(false);
    if (!currentHousehold) showAuth(`无法读取这个账本：${error.message}`);
    else showToast(`实时同步暂时中断：${error.message}`);
  });
}

function restartItemsListener(householdId) {
  stopItemsWatch?.();
  stopItemsWatch = null;
  if (!usesCloudStore() || !householdId || householdId !== desiredHouseholdId) return;
  stopItemsWatch = cloud.subscribeItems(householdId, state => {
    if (householdId !== desiredHouseholdId || currentHousehold?.id !== householdId) return;
    itemListenerError = null;
    itemRecords = state.items.map(normaliseDisplayItem);
    renderSyncStatus();
    renderItemsView();
    renderUpcomingActions();
    if (selectedItemId && $('#itemDetailDialog').open) renderItemDetail();
  }, error => {
    if (householdId !== desiredHouseholdId) return;
    itemListenerError = error.message;
    renderSyncStatus();
    $('#itemsMessage').textContent = `物品实时更新中断：${error.message}`;
  });
}

function switchCloudHousehold(householdId, { persistSelection = false } = {}) {
  if (!cloudSessionToken || !householdId || householdId === desiredHouseholdId && currentListenerToken) return;
  householdSwitchPreviousId = currentHousehold?.id ?? null;
  desiredHouseholdId = householdId;
  householdSwitchHasSnapshot = false;
  itemListenerError = null;
  setSwitching(true);
  setSyncState('切换中', false, 'loading');
  stopItemListeners();
  if ($('#itemDetailDialog').open) closeItemDetail();
  currentListenerToken = syncCoordinator.activateHousehold(cloudSessionToken, householdId);
  restartHouseholdListener(currentListenerToken, householdId);
  if (persistSelection && cloudUser) {
    cloud.selectHousehold(cloudUser.uid, householdId).catch(error => {
      if (householdId === desiredHouseholdId) showToast(`账本已切换，但偏好保存失败：${error.message}`);
    });
  }
}

async function applyCloudProfile(profile, sessionToken = cloudSessionToken) {
  if (!profile || sessionToken !== cloudSessionToken || sessionToken?.sessionGeneration !== syncCoordinator.getState().sessionGeneration) return;
  cloudProfile = profile;
  const options = await cloud.householdOptions(profile.householdIds || []);
  if (sessionToken !== cloudSessionToken) return;
  const selected = options.some(option => option.id === profile.selectedHouseholdId) ? profile.selectedHouseholdId : options[0]?.id;
  $('#workspaceSelect').innerHTML = options.map(option => `<option value="${escapeHtml(option.id)}">${escapeHtml(option.name)}</option>`).join('');
  $('#workspaceSelect').value = desiredHouseholdId || selected || '';
  // Profile snapshots update options, but a direct user switch owns navigation until fenced completion.
  if (selected && !desiredHouseholdId) switchCloudHousehold(selected);
}

async function handleCloudUser(user) {
  stopUserWatch?.();
  stopInviteWatch?.();
  stopHouseholdWatch?.();
  stopItemListeners();
  if ($('#itemDetailDialog').open) {
    cleanupItemDetail();
    $('#itemDetailDialog').close();
  }
  stopUserWatch = stopInviteWatch = stopHouseholdWatch = null;
  currentHousehold = null;
  desiredHouseholdId = null;
  currentListenerToken = null;
  cloudRawState = null;
  cloudUser = user;
  pendingInvite = null;
  $('#pendingInvitePanel').hidden = true;
  if (!user) {
    cloudSessionToken = null;
    syncCoordinator.signOut();
    showAuth(runtimeMode === 'emulator' ? '请使用测试帐号登录。' : '使用你自己的 Google 帐号登录。');
    return;
  }
  cloudSessionToken = syncCoordinator.beginSession();
  syncCoordinator.setOnline(navigator.onLine);
  showAuth('正在打开你的账本…');
  const profile = await cloud.ensureWorkspace(user);
  const sessionToken = cloudSessionToken;
  stopUserWatch = cloud.watchUser(user.uid, value => applyCloudProfile(value, sessionToken).catch(error => {
    if (!currentHousehold && sessionToken === cloudSessionToken) showAuth(error.message);
    else showToast(error.message);
  }), error => {
    if (!currentHousehold && sessionToken === cloudSessionToken) showAuth(error.message);
    else showToast(`个人资料监听中断：${error.message}`);
  });
  stopInviteWatch = cloud.watchInvite(user.email, invite => {
    if (sessionToken !== cloudSessionToken) return;
    pendingInvite = invite;
    if (invite) {
      $('#pendingInviteTitle').textContent = '收到家庭邀请';
      $('#pendingInviteMessage').textContent = `加入「${invite.householdName}」，与家人一起记账。`;
      $('#pendingInvitePanel').hidden = false;
      showAuth(`你已使用 ${user.email} 登录。`);
    }
  }, error => currentHousehold ? showToast(error.message) : showAuth(error.message));
  await applyCloudProfile(profile, sessionToken);
}

let googleSignInPending = false;

function googleSignInErrorMessage(error) {
  if (error?.code === 'auth/popup-closed-by-user') return 'Google 登录窗口已关闭，请再试一次。';
  if (error?.code === 'auth/cancelled-popup-request') return '上一轮 Google 登录仍在处理，请稍后再试。';
  return `Google 登录失败：${error?.message || '未知错误'}`;
}

$('#googleSignInButton').addEventListener('click', async () => {
  if (googleSignInPending) return;
  const button = $('#googleSignInButton');
  googleSignInPending = true;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.textContent = '等待 Google 登录…';
  showAuth('Google 登录窗口已打开，请在该窗口完成登录。');
  try {
    await cloud.signInGoogle();
  } catch (error) {
    showAuth(googleSignInErrorMessage(error));
  } finally {
    googleSignInPending = false;
    button.disabled = false;
    button.removeAttribute('aria-busy');
    button.textContent = '使用 Google 帐号登录';
  }
});

$('#testRegisterButton').addEventListener('click', async () => {
  try { await cloud.registerTestUser($('#testEmail').value, $('#testPassword').value); }
  catch (error) { showAuth(`测试注册失败：${error.message}`); }
});

$('#testLoginButton').addEventListener('click', async () => {
  try { await cloud.signInTestUser($('#testEmail').value, $('#testPassword').value); }
  catch (error) { showAuth(`测试登录失败：${error.message}`); }
});

$('#signOutButton').addEventListener('click', () => {
  const logout = () => cloud?.logout();
  if ($('#settingsDialog').open) dismissDialog($('#settingsDialog'), logout);
  else logout();
});
$('#workspaceSelect').addEventListener('change', event => {
  if (cloudUser && event.target.value) switchCloudHousehold(event.target.value, { persistSelection:true });
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
  showAuth(useEmulators ? '正在初始化本机 Firebase Emulator…' : '正在检查 Google 登录状态…');
  cloud = await createFirebaseWallet({ config: firebaseConfig, useEmulators });
  cloud.onAuthChanged(user => {
    if (useEmulators) $('#testAuthControls').hidden = false;
    else $('#googleSignInButton').hidden = Boolean(user);
    handleCloudUser(user).catch(error => {
      if (!useEmulators) $('#googleSignInButton').hidden = false;
      showAuth(error.message);
    });
  });
}

function requestForegroundRecovery(trigger) {
  if (!usesCloudStore()) return;
  itemListenerError = null;
  renderSyncStatus();
  syncCoordinator.requestRecovery(trigger);
}

window.addEventListener('online', () => {
  syncCoordinator.setOnline(true);
  requestForegroundRecovery('online');
});
window.addEventListener('offline', () => syncCoordinator.setOnline(false));
window.addEventListener('focus', () => requestForegroundRecovery('focus'));
window.addEventListener('pageshow', () => requestForegroundRecovery('pageshow'));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') requestForegroundRecovery('visibility');
});

applyTheme(localStorage.getItem(THEME_STORE) || document.documentElement.dataset.theme || 'teal', { persist:false });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./service-worker.js').catch(() => {});
startRuntime().catch(error => showAuth(`无法启动：${error.message}`));
