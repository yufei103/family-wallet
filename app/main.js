import {
  accountSubtype, applyOperation as applyLedgerOperation, archiveAccount, compareEntriesNewestFirst, createAccount, createLedger, deriveLedger, estimatedMonthlyInterestMinor, formatRM, householdTotals,
  loanCalculationMode, monthlySummary, moveToRecycleBin, permanentlyDelete, reconcile, repaymentBreakdown, restoreFromRecycleBin,
  remainingPayoffMonths, serialiseLedger, suggestedRepayment, updateAccount, updateTransaction
} from './ledger.js';
import {
  archiveItem as archiveLocalItem, createItem as createLocalItem, createItemsState, deleteItem as deleteLocalItem,
  editItem as editLocalItem, recordItemPayment as recordLocalItemPayment, restoreDeletedItem as restoreDeletedLocalItem,
  restoreItem as restoreLocalItem, restoreItemPayment as restoreLocalItemPayment, serialiseItemsState,
  voidItemPayment as voidLocalItemPayment
} from './items.js';
import { compressItemMedia, normaliseCoverEditState } from './item-media.js';
import { createSyncCoordinator } from './cloud-sync.js';
import {
  describeEtaDate, displayItemsFromLocal, hydrateLocalEnvelope, mergePendingLedgerPatch, normaliseDisplayItem,
  rawSnapshotHasOperation, renderItemCards, renderItemsLoadingState, serialiseLocalEnvelope
} from './items-view.js';
import {
  MAX_BACKUP_BYTES, createBackupPayload, deterministicImportIdentity, replaceLocalAtomically, validateBackup
} from './backup-restore.js';
import {
  activeFilterSummary, actorLabel, copyPreviousEntry, deleteEntryTemplate, dismissOnboarding, filterEntries,
  isOnboardingDismissed, loadEntryTemplates, onboardingState, saveEntryTemplate
} from './wallet-features.js';
import { resolveStateIcon, stateIconMarkup, staticIconMarkup } from './state-icon-data.js';

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
const viewIconFamilies = { overview:'nav-home', accounts:'nav-accounts', entries:'nav-entries', items:'nav-items' };
const transactionIconEndpoints = Object.freeze({
  income:'income-arrow', expense:'expense-arrow', transfer:'transfer-arrows', repayment:'payment-arrow', item:'package-check'
});
const dialogInvokers = new WeakMap();

function setStateIcon(root, state) {
  const icon = root?.matches?.('[data-state-icon]') ? root : root?.querySelector?.('[data-state-icon]');
  if (!icon) return;
  const target = resolveStateIcon(icon.dataset.stateIcon, state);
  if (!target.valid || icon.dataset.iconState === target.state) return;
  icon.dataset.iconState = target.state;
}

function transactionIconMarkup(state) {
  return staticIconMarkup(transactionIconEndpoints[state] ?? 'neutral');
}

const hydratedLocal = hydrate();
let ledger = hydratedLocal.ledger;
let itemsState = hydratedLocal.itemsState;
let localItemMedia = new Map(hydratedLocal.itemMedia.map(media => [media.id, media]));
let saveLocked = false;
let pendingOperationId = uid('op');
let pendingAccountOperationId = uid('account');
let toastTimer;
let toastHideTimer;
let viewTransitionTimer;
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
let stopMembersWatch = null;
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
let itemReadState = { householdId:'local', generation:0, hasSnapshot:true, error:null };
let itemPaymentReadState = { householdId:'local', itemId:null, generation:0, hasSnapshot:true, error:null };
let mediaCache = new Map(hydratedLocal.itemMedia.map(media => [`local/${media.id}`, media]));
let coverObserver = null;
let pendingItemCreate = null;
let pendingPayment = null;
let pendingItemEdit = null;
let newItemCoverEdit = { mode:'full', zoom:1, offsetX:0, offsetY:0, sourceWidth:0, sourceHeight:0 };
let newItemCoverPreviewUrl = null;
let pendingRepayment = null;
let repaymentReturnAccountId = null;
let requestedPaymentId = null;
const mediaLoads = new Map();
const mediaLoadErrors = new Map();
const itemActionOperations = new Map();
let householdMembers = [];
let householdPendingInvites = [];
let memberReadGeneration = 0;
let memberReadState = { householdId:'local', generation:0, membersKnown:true, invitesKnown:true, membersError:null, invitesError:null };
let pendingRestore = null;
let entryFilters = { keyword:'', kind:'all', accountId:'all', category:'all', dateFrom:'', dateTo:'', allMonths:false };
const feedbackControls = new WeakMap();
const balancedHandoffs = new Map();
const TOAST_DURATIONS = Object.freeze({ neutral:2800, success:2800, warning:4500, error:4500 });
const FEEDBACK_TONES = new Set(Object.keys(TOAST_DURATIONS));
const FEEDBACK_ICON_PATHS = Object.freeze({
  neutral:'M12 8h.01M11 12h1v4h1M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18',
  success:'M20 6 9 17l-5-5M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18',
  warning:'M12 9v4M12 17h.01M10.3 4.6 2.5 18a2 2 0 0 0 1.7 3h15.6a2 2 0 0 0 1.7-3L13.7 4.6a2 2 0 0 0-3.4 0',
  error:'M9 9l6 6M15 9l-6 6M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18'
});

function feedbackIconMarkup(tone) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${FEEDBACK_ICON_PATHS[tone] ?? FEEDBACK_ICON_PATHS.neutral}"/></svg>`;
}

function resolveFeedback(target) {
  return typeof target === 'string' ? $(target) : target;
}

function ensureFeedbackRow(target) {
  const feedback = resolveFeedback(target);
  if (!feedback) return null;
  feedback.classList.add('feedback-row');
  let icon = feedback.querySelector('[data-feedback-icon]');
  let text = feedback.querySelector('[data-feedback-text]');
  if (!icon || !text) {
    const current = feedback.textContent;
    feedback.replaceChildren();
    icon = document.createElement('span');
    icon.className = 'feedback-icon';
    icon.dataset.feedbackIcon = '';
    icon.setAttribute('aria-hidden', 'true');
    text = document.createElement('span');
    text.dataset.feedbackText = '';
    text.textContent = current;
    feedback.append(icon, text);
  }
  return { feedback, icon, text };
}

function setFeedback(target, message, tone = 'neutral', control = null) {
  if (!FEEDBACK_TONES.has(tone)) throw new TypeError(`Unknown feedback tone: ${tone}`);
  const row = ensureFeedbackRow(target);
  if (!row) return;
  const { feedback, icon, text } = row;
  for (const prior of feedbackControls.get(feedback) ?? []) {
    prior.removeAttribute('aria-invalid');
    const ids = (prior.getAttribute('aria-describedby') || '').split(/\s+/).filter(id => id && id !== feedback.id);
    if (ids.length) prior.setAttribute('aria-describedby', ids.join(' '));
    else prior.removeAttribute('aria-describedby');
  }
  feedbackControls.delete(feedback);
  text.textContent = message || '';
  icon.innerHTML = feedbackIconMarkup(tone);
  feedback.dataset.tone = tone;
  feedback.setAttribute('role', tone === 'error' ? 'alert' : 'status');
  feedback.setAttribute('aria-live', tone === 'error' ? 'assertive' : 'polite');
  if (message && control && feedback.id) {
    const controls = (Array.isArray(control) ? control : [control]).filter(Boolean);
    for (const owner of controls) {
      owner.setAttribute('aria-invalid', tone === 'error' ? 'true' : 'false');
      const ids = new Set((owner.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean));
      ids.add(feedback.id);
      owner.setAttribute('aria-describedby', [...ids].join(' '));
    }
    feedbackControls.set(feedback, controls);
  }
}

function clearFeedback(target) {
  setFeedback(target, '', 'neutral');
}

const FORM_ERROR_CONTROL_MAP = Object.freeze({
  entryForm:[[/分类/, '#categoryRow'], [/转入账户|目标账户/, '#targetAccountTrigger'], [/账户/, '#sourceAccountTrigger'], [/金额|RM/, '#amountInput'], [/日期/, '#dateInput'], [/类型/, '#kindControl']],
  accountForm:[[/账户名称|名称/, '#accountName'], [/账户类型|类型/, '#accountSubtypeControl'], [/信用额度/, '#creditLimit'], [/账单日|账单日期/, '#statementDay'], [/还款日/, '#dueDay'], [/贷款类型/, '#loanType'], [/计算方式/, '#loanCalculationMode'], [/年利率/, '#annualInterestRate'], [/原始融资额|原始应付/, '#originalPrincipal'], [/计划还款|月供/, '#scheduledPayment'], [/还清日期/, '#expectedPayoffDate'], [/余额|欠款/, '#openingBalance'], [/照片/, '#accountPhotoInput']],
  repaymentForm:[[/资金来源/, '.repayment-funding-control'], [/付款账户|来源账户/, '#repaymentSourceAccountTrigger'], [/利息/, '#repaymentInterest'], [/日期/, '#repaymentDate'], [/金额|还款/, '#repaymentAmount']],
  newItemForm:[[/物品名称|名称/, '#newItemName'], [/全价/, '#newItemFullPrice'], [/订金.*金额|订金不能/, '#newItemDepositAmount'], [/付款账户|账目联动/, '#newItemAccountTrigger'], [/订金.*日期|日期/, '#newItemDepositDate'], [/凭证/, '#newItemReceipt'], [/封面|图片|照片|媒体/, '#newItemCover']],
  paymentForm:[[/付款账户|账目联动/, '#paymentAccountTrigger'], [/日期/, '#paymentDate'], [/凭证|图片|媒体/, '#paymentReceipt'], [/金额|余额|付款/, '#paymentAmount']],
  editItemForm:[[/物品名称|名称/, '#editItemName'], [/日期/, '#editItemEtaDate'], [/封面|图片|照片|媒体/, '#editItemCover'], [/全价|金额/, '#editItemFullPrice']]
});

function focusableValidationControl(control) {
  if (!control) return null;
  if (control.hidden || control.getAttribute?.('aria-hidden') === 'true') {
    const proxy = control.id ? $(`#${control.id}Trigger`) : null;
    if (proxy) return proxy;
  }
  return control;
}

function reportSubmitError(feedbackTarget, form, error) {
  const currentInvalid = form?.querySelector?.(':invalid');
  const semantic = (FORM_ERROR_CONTROL_MAP[form?.id] || []).find(([pattern]) => pattern.test(String(error?.message || '')))?.[1];
  const control = focusableValidationControl(currentInvalid) || (semantic ? $(semantic) : null);
  setFeedback(feedbackTarget, error.message, 'error', control);
  if (!control?.focus) return;
  if (control.tabIndex < 0 && !control.matches?.('input, select, textarea, button, [tabindex]')) control.tabIndex = -1;
  try { control.focus({ preventScroll:true }); }
  catch { control.focus(); }
}

function initializeFeedbackRows() {
  document.querySelectorAll('.form-message, .feedback-row').forEach(feedback => {
    setFeedback(feedback, feedback.textContent, feedback.dataset.tone || 'neutral');
  });
}

function ensureActionButton(button) {
  if (!button || button.dataset.actionEnhanced === 'true') return button;
  const label = button.textContent.trim();
  button.dataset.actionEnhanced = 'true';
  button.dataset.actionLabel = label;
  button.dataset.actionState = 'idle';
  button.innerHTML = `${stateIconMarkup('action', 'idle')}<span data-action-label>${escapeHtml(label)}</span>`;
  return button;
}

function setActionButtonState(button, state, { label = null } = {}) {
  if (!['idle', 'pending', 'success', 'error'].includes(state) || !ensureActionButton(button)) return;
  if (state === 'pending' && button.dataset.actionPreviousDisabled === undefined) {
    button.dataset.actionPreviousDisabled = String(button.disabled);
  }
  button.dataset.actionState = state;
  setStateIcon(button, state);
  const visibleLabel = button.querySelector('[data-action-label]');
  if (visibleLabel) visibleLabel.textContent = label ?? button.dataset.actionLabel;
  if (state === 'pending') {
    button.setAttribute('aria-busy', 'true');
    button.disabled = true;
  } else {
    button.removeAttribute('aria-busy');
  }
}

function releaseActionButton(button, state = null) {
  if (!button) return;
  if (state) setActionButtonState(button, state);
  button.removeAttribute('aria-busy');
  if (button.dataset.actionPreviousDisabled !== undefined) {
    const previousDisabled = button.dataset.actionPreviousDisabled === 'true';
    button.disabled = previousDisabled;
    delete button.dataset.actionPreviousDisabled;
  }
}

function resetActionButton(button, label = null) {
  if (!button) return;
  ensureActionButton(button);
  if (label !== null) button.dataset.actionLabel = label;
  releaseActionButton(button, 'idle');
}

function initializeActionButtons() {
  for (const id of [
    'googleSignInButton', 'acceptInviteButton', 'sendInviteButton', 'saveEntryButton', 'saveAccountButton',
    'saveRepaymentButton', 'saveNewItemButton', 'savePaymentButton', 'saveEditItemButton', 'exportButton',
    'confirmRestoreButton', 'refreshMembersButton', 'archiveItemButton', 'restoreItemButton', 'deleteItemButton'
  ]) resetActionButton($(`#${id}`));
}

function queueBalancedHandoff(kind, id) {
  if (!id || !['transaction', 'account', 'item', 'payment'].includes(kind)) return;
  balancedHandoffs.set(`${kind}:${id}`, { kind, id });
  requestAnimationFrame(applyBalancedHandoffs);
}

function applyBalancedHandoffs() {
  const attributes = { transaction:'data-transaction-id', account:'data-account-id', item:'data-item-id', payment:'data-payment-id' };
  for (const [key, handoff] of balancedHandoffs) {
    const element = document.querySelector(`[${attributes[handoff.kind]}="${CSS.escape(handoff.id)}"]`);
    if (!element) continue;
    balancedHandoffs.delete(key);
    element.classList.add('balanced-handoff');
    setTimeout(() => element.classList.remove('balanced-handoff'), 220);
  }
}

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
  document.querySelectorAll('input[name="appTheme"]').forEach(input => {
    input.checked = input.value === selected;
    setStateIcon(input.closest('label'), input.checked ? 'selected' : 'idle');
  });
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
  $('#desktopSidebar').hidden = false;
  $('#bottomNav').hidden = false;
}

function showAuth(message, tone = 'neutral') {
  setFeedback('#authMessage', message, tone);
  $('#authGate').hidden = false;
  $('#appShell').hidden = true;
  $('#desktopSidebar').hidden = true;
  $('#bottomNav').hidden = true;
}

function setSyncState(message, bad = false, state = '') {
  const badge = $('#syncBadge');
  const label = badge.querySelector('[data-sync-label]');
  if (label) label.textContent = message;
  else badge.textContent = message;
  badge.classList.toggle('bad', bad);
  badge.dataset.state = state;
  setStateIcon(badge, ['loading', 'cached', 'pending', 'synced', 'offline', 'recovering', 'error', 'update'].includes(state) ? state : 'idle');
  const freshness = $('#desktopFreshness');
  if (freshness) freshness.textContent = `资料状态：${message}`;
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
  const badge = $('#syncBadge');
  badge.title = status === 'synced'
    ? '资料已同步；点按刷新 App'
    : status === 'error'
      ? (itemListenerError || state.error || '点按重试同步')
      : `${labels[status] ?? '准备中'}；点按重新检查同步`;
  badge.setAttribute('aria-label', status === 'synced'
    ? '资料已同步；点按刷新App'
    : `同步状态：${labels[status] ?? '准备中'}；点按重新检查`);
}

function setSwitching(value) {
  document.body.classList.toggle('is-switching', value);
  for (const control of document.querySelectorAll('[data-mutation], #newEntryButton, #newAccountButton, #desktopContextAction, #archiveTransactionButton, #archiveAccountButton')) {
    control.disabled = Boolean(value);
  }
  $('#workspaceSelect').setAttribute('aria-busy', String(Boolean(value)));
}

function applyCoordinatorState(state) {
  renderSyncStatus(state);
  const raw = state.data;
  if (!raw?.household || raw.household.id !== state.householdId) return;
  const previousHouseholdId = currentHousehold?.id ?? null;
  cloudRawState = raw;
  currentHousehold = raw.household;
  ledger = deriveLedger({ accounts:raw.accounts, transactions:raw.transactions });
  const firstForSwitch = !householdSwitchHasSnapshot && desiredHouseholdId === currentHousehold.id;
  if (firstForSwitch) {
    householdSwitchHasSnapshot = true;
    householdSwitchPreviousId = null;
    setSwitching(false);
    if (previousHouseholdId !== currentHousehold.id) {
      itemRecords = [];
      currentItemPayments = [];
      mediaLoadErrors.clear();
    }
    renderItemsView();
    restartItemsListener(currentHousehold.id);
    restartMembersListener(currentHousehold.id);
  }
  $('#inviteMemberButton').hidden = currentHousehold.ownerId !== cloudUser?.uid;
  $('#privacyNote').textContent = `资料已同步到你的个人 Firebase · ${currentHousehold.name}`;
  $('#accountPhotoHelp').textContent = '照片会在浏览器内裁切压缩，并同步给这个账本的家庭成员。';
  if (!pendingInvite) showApp();
  render();
  setView(activeView, false);
}

const DIALOG_CLOSE_FALLBACK_MS = 220;
const prefersReducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

function dialogMotionPanel(dialog) {
  if (dialog?.classList.contains('topbar-actions-dialog')) return dialog.querySelector('.topbar-actions-panel');
  if (dialog?.classList.contains('account-picker-dialog')) return dialog.querySelector('.account-picker-panel');
  if (dialog?.classList.contains('receipt-viewer')) return dialog.querySelector('.receipt-viewer-shell');
  return dialog?.querySelector(':scope > form, :scope > div') ?? null;
}

function showDialog(dialog, afterOpen) {
  if (!dialog || dialog.open) return;
  const invoker = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  if (invoker && !dialog.contains(invoker)) dialogInvokers.set(dialog, invoker);
  dialog.classList.remove('is-open', 'is-closing');
  dialog.classList.add('is-preparing');
  dialog.showModal();
  const finishOpen = () => {
    if (!dialog.open || dialog.classList.contains('is-closing')) return;
    dialog.classList.remove('is-preparing');
    dialog.classList.add('is-open');
    if (afterOpen) requestAnimationFrame(afterOpen);
  };
  if (prefersReducedMotion()) {
    finishOpen();
    return;
  }
  requestAnimationFrame(() => requestAnimationFrame(finishOpen));
}

function dismissDialog(dialog, afterClose) {
  if (!dialog?.open || dialog.classList.contains('is-closing')) return;
  const panel = dialogMotionPanel(dialog);
  let finished = false;
  let fallbackTimer = null;
  const finish = () => {
    if (finished) return;
    finished = true;
    if (fallbackTimer !== null) clearTimeout(fallbackTimer);
    panel?.removeEventListener('transitionend', onTransitionEnd);
    dialog.classList.remove('is-preparing', 'is-open', 'is-closing');
    if (dialog.open) dialog.close();
    if (afterClose) {
      dialogInvokers.delete(dialog);
      afterClose();
    }
    else {
      const invoker = dialogInvokers.get(dialog);
      dialogInvokers.delete(dialog);
      if (invoker?.isConnected && !invoker.hidden && !invoker.closest('[hidden]')) invoker.focus({ preventScroll:true });
    }
  };
  const onTransitionEnd = event => {
    if (event.target !== panel || !['opacity', 'transform'].includes(event.propertyName)) return;
    finish();
  };
  if (prefersReducedMotion() || !panel) {
    finish();
    return;
  }
  dialog.classList.remove('is-preparing', 'is-open');
  dialog.classList.add('is-closing');
  panel.addEventListener('transitionend', onTransitionEnd);
  fallbackTimer = setTimeout(finish, DIALOG_CLOSE_FALLBACK_MS);
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
  try {
    const acknowledgement = await Promise.resolve(writePromise);
    syncCoordinator.acknowledgeWrite(token);
    return acknowledgement;
  } catch (error) {
    syncCoordinator.rejectWrite(token, error);
    throw error;
  }
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
    : stateIconMarkup('account', accountSubtype(account) === 'credit_card' ? 'credit' : accountSubtype(account) === 'loan' ? 'loan' : 'idle');
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
  accountPicker.sync('source');
  if (kind !== 'transfer') return;
  const targets = assetAccounts();
  const fallbackTarget = targets.find(account => account.id !== sourceId)?.id || sourceId;
  const targetId = targets.some(account => account.id === remembered.targetAccountId && account.id !== sourceId)
    ? remembered.targetAccountId
    : fallbackTarget;
  $('#targetAccount').value = targetId;
  accountPicker.sync('target');
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

function showToast(message, tone) {
  if (!FEEDBACK_TONES.has(tone)) throw new TypeError(`Unknown toast tone: ${tone}`);
  const toast = $('#toast');
  const actionFailure = tone === 'warning' || tone === 'error';
  const repeated = toast.classList.contains('is-visible') && toast.dataset.message === String(message) && toast.dataset.tone === tone;
  toast.dataset.message = String(message);
  toast.dataset.tone = tone;
  toast.querySelector('[data-toast-text]').textContent = message;
  toast.querySelector('[data-feedback-icon]').innerHTML = feedbackIconMarkup(tone);
  toast.setAttribute('role', actionFailure ? 'alert' : 'status');
  toast.setAttribute('aria-live', actionFailure ? 'assertive' : 'polite');
  clearTimeout(toastTimer);
  clearTimeout(toastHideTimer);
  toast.classList.remove('is-hiding');
  if (!repeated) toast.classList.add('is-visible');
  toastTimer = setTimeout(() => {
    toast.classList.add('is-hiding');
    toast.classList.remove('is-visible');
    toastHideTimer = setTimeout(() => toast.classList.remove('is-hiding'), 120);
  }, TOAST_DURATIONS[tone]);
}

function dateLabel(value) {
  return new Intl.DateTimeFormat('zh-CN', { month:'short', day:'numeric' }).format(new Date(value));
}

function monthLabel(value) {
  return new Intl.DateTimeFormat('zh-CN', { year:'numeric', month:'long' }).format(new Date(`${value}-01T00:00:00`));
}

function typeLabel(kind) { return ({ income:'收入', expense:'支出', transfer:'转账' })[kind] || kind; }
function senToAmount(value) { return (value / 100).toFixed(2); }

function currentActorUid() { return usesCloudStore() ? cloudUser?.uid : 'local'; }
function currentScope() {
  return { userId:currentActorUid() || 'local', householdId:usesCloudStore() ? currentHousehold?.id : 'local' };
}
function visibleActor(uidValue) { return actorLabel(uidValue, currentActorUid(), householdMembers); }

function setView(view, scroll = true, animate = false) {
  if (!viewTitles[view]) return;
  activeView = view;
  document.querySelectorAll('[data-view]').forEach(section => { section.hidden = section.dataset.view !== view; });
  document.querySelectorAll('[data-view-target]').forEach(button => {
    const current = button.dataset.viewTarget === view;
    button.classList.toggle('active', current);
    if (current) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
    setStateIcon(button, current ? 'active' : 'idle');
  });
  $('#viewTitle').textContent = viewTitles[view];
  const contextAction = $('#desktopContextAction');
  if (contextAction) contextAction.textContent = view === 'accounts' ? '新增账户' : view === 'items' ? '新增物品' : '新增账目';
  const activeSection = document.querySelector(`[data-view="${view}"]`);
  document.querySelectorAll('[data-view-transition]').forEach(section => section.removeAttribute('data-view-transition'));
  if (animate && !prefersReducedMotion()) activeSection?.setAttribute('data-view-transition', 'entering');
  clearTimeout(viewTransitionTimer);
  viewTransitionTimer = animate && !prefersReducedMotion()
    ? setTimeout(() => activeSection?.removeAttribute('data-view-transition'), 220)
    : null;
  if (scroll) window.scrollTo({ top:0, behavior:prefersReducedMotion() ? 'auto' : 'smooth' });
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

async function retryCoverMedia(householdId, mediaId, itemId = null) {
  const key = mediaKey(householdId, mediaId);
  mediaLoads.delete(key);
  mediaCache.delete(key);
  mediaLoadErrors.delete(key);
  renderItemsView();
  if (itemId === selectedItemId && $('#itemDetailDialog').open) renderItemDetail();
  try {
    await loadMediaOnce(householdId, mediaId);
  } catch (error) {
    mediaLoadErrors.set(key, error);
    throw error;
  } finally {
    if (householdId === currentMediaHouseholdId()) {
      renderItemsView();
      if (itemId === selectedItemId && $('#itemDetailDialog').open) renderItemDetail();
    }
  }
}

function markCoverImageError(householdId, mediaId, itemId = null) {
  const key = mediaKey(householdId, mediaId);
  mediaLoadErrors.set(key, new Error('封面图片无法显示'));
  renderItemsView();
  if (itemId === selectedItemId && $('#itemDetailDialog').open) renderItemDetail();
}

function observeLazyCovers() {
  coverObserver?.disconnect();
  coverObserver = null;
  const householdId = currentMediaHouseholdId();
  const targets = [...$('#itemsGrid').querySelectorAll('[data-cover-media-id]')]
    .filter(target => !mediaCache.has(mediaKey(householdId, target.dataset.coverMediaId))
      && !mediaLoadErrors.has(mediaKey(householdId, target.dataset.coverMediaId)));
  if (!targets.length) return;
  const loadTargets = targetsToLoad => Promise.allSettled(targetsToLoad.map(target =>
    loadMediaOnce(householdId, target.dataset.coverMediaId)
  )).then(results => {
    if (householdId !== currentMediaHouseholdId()) return;
    const failure = results.find(result => result.status === 'rejected');
    if (failure) {
      const failedIndex = results.indexOf(failure);
      const failedTarget = targetsToLoad[failedIndex];
      if (failedTarget) mediaLoadErrors.set(mediaKey(householdId, failedTarget.dataset.coverMediaId), failure.reason);
      setFeedback('#itemsMessage', `封面载入失败：${failure.reason.message}`, 'error');
    }
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
  const visible = itemRecords.filter(item => !item.deletedAt).filter(item => itemFilter === 'archived'
    ? item.status === 'archived' || Boolean(item.archivedAt)
    : item.status !== 'archived' && !item.archivedAt
  ).sort((a, b) => String(b.updatedAt ?? b.createdAt ?? '').localeCompare(String(a.updatedAt ?? a.createdAt ?? '')));
  const awaitingFirstSnapshot = usesCloudStore() && itemReadState.householdId === desiredHouseholdId && !itemReadState.hasSnapshot;
  const readError = itemReadState.error || itemListenerError;
  const freshnessMessage = readError
    ? `物品实时更新中断：${readError}`
    : awaitingFirstSnapshot
      ? (visible.length ? '正在更新物品，暂时显示上次资料。' : '正在载入物品，请稍候。')
      : '';
  setFeedback('#itemsMessage', freshnessMessage, readError ? 'error' : 'neutral');
  $('#itemsGrid').innerHTML = awaitingFirstSnapshot && !visible.length
    ? renderItemsLoadingState('正在载入物品，请稍候。')
    : readError && !visible.length && !itemReadState.hasSnapshot
      ? renderItemsLoadingState(`物品载入失败：${readError}`, 'error')
      : renderItemCards(visible, {
    formatMoney:formatRM,
    mediaCache,
    mediaErrors:mediaLoadErrors,
    householdId:currentMediaHouseholdId()
  });
  $('#itemsGrid').querySelectorAll('[data-item-id]').forEach(button => {
    button.addEventListener('click', () => openItemDetail(button.dataset.itemId));
  });
  $('#itemsGrid').querySelectorAll('[data-new-item]').forEach(button => {
    button.addEventListener('click', openNewItem);
  });
  $('#itemsGrid').querySelectorAll('[data-retry-cover]').forEach(button => {
    button.addEventListener('click', async () => {
      setActionButtonState(button, 'pending', { label:'重试中…' });
      try {
        await retryCoverMedia(currentMediaHouseholdId(), button.dataset.retryCover, button.dataset.retryItem);
      } catch (error) {
        setFeedback('#itemsMessage', `封面载入失败：${error.message}`, 'error', button);
      } finally {
        releaseActionButton(button);
      }
    });
  });
  $('#itemsGrid').querySelectorAll('[data-cover-image-id]').forEach(image => {
    image.addEventListener('error', () => markCoverImageError(currentMediaHouseholdId(), image.dataset.coverImageId, image.closest('[data-item-id]')?.dataset.itemId), { once:true });
  });
  observeLazyCovers();
  applyBalancedHandoffs();
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
  setActionButtonState(button, 'pending', { label:'查看凭证' });
  clearFeedback('#itemDetailMessage');
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
    setActionButtonState(button, 'success');
    if (!$('#receiptViewerDialog').open) showDialog($('#receiptViewerDialog'));
  } catch (error) {
    setActionButtonState(button, 'error');
    setFeedback('#itemDetailMessage', `无法读取凭证：${error.message}`, 'error', button);
  } finally {
    releaseActionButton(button);
  }
}

let paymentMenuPortal = null;
let paymentMenuOwner = null;

function restorePaymentMenuPortal() {
  if (paymentMenuPortal && paymentMenuOwner?.isConnected) {
    paymentMenuPortal.removeAttribute('style');
    paymentMenuOwner.append(paymentMenuPortal);
  } else paymentMenuPortal?.remove();
  paymentMenuPortal = null;
  paymentMenuOwner = null;
}

function closePaymentCorrectionMenus(except = null) {
  if (paymentMenuOwner && paymentMenuOwner !== except) {
    const owner = paymentMenuOwner;
    restorePaymentMenuPortal();
    owner.open = false;
  }
  $('#itemPaymentTimeline')?.querySelectorAll('.payment-menu[open]').forEach(menu => {
    if (menu !== except) menu.open = false;
  });
}

function paymentMenuViewportBounds() {
  const viewport = window.visualViewport;
  const left = Number.isFinite(viewport?.offsetLeft) ? viewport.offsetLeft : 0;
  const top = Number.isFinite(viewport?.offsetTop) ? viewport.offsetTop : 0;
  const width = Number.isFinite(viewport?.width) && viewport.width > 0 ? viewport.width : window.innerWidth;
  const height = Number.isFinite(viewport?.height) && viewport.height > 0 ? viewport.height : window.innerHeight;
  return { left, top, right:left + width, bottom:top + height };
}

function clampPaymentMenuToViewport(popover) {
  const margin = 8;
  const viewport = paymentMenuViewportBounds();
  const availableWidth = Math.max(0, viewport.right - viewport.left - margin * 2);
  const availableHeight = Math.max(0, viewport.bottom - viewport.top - margin * 2);
  const firstRect = popover.getBoundingClientRect();
  if (firstRect.width > availableWidth) popover.style.maxWidth = `${availableWidth}px`;
  if (firstRect.height > availableHeight) popover.style.maxHeight = `${availableHeight}px`;

  for (let pass = 0; pass < 2; pass += 1) {
    const rect = popover.getBoundingClientRect();
    const minLeft = viewport.left + margin;
    const minTop = viewport.top + margin;
    const maxLeft = viewport.right - margin - rect.width;
    const maxTop = viewport.bottom - margin - rect.height;
    const desiredLeft = maxLeft < minLeft ? minLeft : Math.max(minLeft, Math.min(maxLeft, rect.left));
    const desiredTop = maxTop < minTop ? minTop : Math.max(minTop, Math.min(maxTop, rect.top));
    const deltaLeft = desiredLeft - rect.left;
    const deltaTop = desiredTop - rect.top;
    if (Math.abs(deltaLeft) < 0.5 && Math.abs(deltaTop) < 0.5) break;
    popover.style.left = `${(Number.parseFloat(popover.style.left) || 0) + deltaLeft}px`;
    popover.style.top = `${(Number.parseFloat(popover.style.top) || 0) + deltaTop}px`;
  }
}

function portalPaymentMenu(menu) {
  const popover = menu.querySelector('.payment-menu-popover');
  const summary = menu.querySelector('summary');
  if (!popover || !summary) return;
  closePaymentCorrectionMenus(menu);
  restorePaymentMenuPortal();
  const rect = summary.getBoundingClientRect();
  paymentMenuPortal = popover;
  paymentMenuOwner = menu;
  $('#itemDetailDialog').append(popover);
  popover.style.position = 'fixed';
  popover.style.visibility = 'hidden';
  popover.style.left = '8px';
  popover.style.top = '8px';
  const viewport = paymentMenuViewportBounds();
  const width = popover.offsetWidth;
  const height = popover.offsetHeight;
  const minLeft = viewport.left + 8;
  const maxLeft = viewport.right - width - 8;
  const left = maxLeft < minLeft ? minLeft : Math.max(minLeft, Math.min(maxLeft, rect.right - width));
  const below = rect.bottom + 6;
  const top = below + height <= viewport.bottom - 8 ? below : Math.max(viewport.top + 8, rect.top - height - 6);
  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;
  popover.style.visibility = 'visible';
  clampPaymentMenuToViewport(popover);
}

document.addEventListener('pointerdown', event => {
  if (!paymentMenuOwner) return;
  if (event.target.closest?.('.payment-menu-popover')) return;
  if (event.target.closest?.('.payment-menu') === paymentMenuOwner) return;
  closePaymentCorrectionMenus();
});
window.addEventListener('resize', closePaymentCorrectionMenus);
window.addEventListener('scroll', closePaymentCorrectionMenus, true);

function paymentTimelineMarkup(payments) {
  if (!payments.length) return '<div class="empty-state"><b>还没有付款</b><p>记录订金或第一期后会显示在这里。</p></div>';
  return [...payments].sort((a, b) => String(b.occurredAt ?? b.createdAt ?? '').localeCompare(String(a.occurredAt ?? a.createdAt ?? '')))
    .map(raw => {
      const payment = normalisePayment(raw);
      const voided = payment.status === 'voided';
      const linked = payment.mode === 'linked';
      const label = payment.type === 'deposit' ? '订金' : '付款';
      const receipt = payment.receiptMediaId
        ? `<button class="minor-button icon-label-button" type="button" data-view-receipt="${escapeHtml(payment.id)}">${stateIconMarkup('receipt', 'idle')}<span>查看凭证</span></button>` : '';
      const correction = voided
        ? `<button class="minor-button icon-label-button" data-restore-payment="${escapeHtml(payment.id)}" type="button">${stateIconMarkup('correction', 'restore')}<span>恢复付款</span></button>`
        : `<button class="minor-button delete icon-label-button" data-void-payment="${escapeHtml(payment.id)}" type="button">${stateIconMarkup('correction', 'void')}<span>作废付款</span></button>`;
      const menu = `<details class="payment-menu"><summary class="minor-button" aria-label="付款更正菜单">${stateIconMarkup('menu', 'closed')}</summary><div class="payment-menu-popover">${correction}</div></details>`;
      const actor = visibleActor(payment.actorUid ?? payment.createdBy ?? payment.updatedByUid);
      return `<div class="payment-row ${voided ? 'voided' : ''}" data-payment-id="${escapeHtml(payment.id)}"><div class="payment-row-main"><b>${stateIconMarkup('correction', voided ? 'void' : 'active')}<span>${label} · ${formatRM(payment.amountMinor)}</span></b><small><span class="payment-badge">${linked ? '已联动账目' : '独立付款'}</span>${dateLabel(payment.occurredAt ?? payment.createdAt)} · ${escapeHtml(actor)}${payment.note ? ` · ${escapeHtml(payment.note)}` : ''}${voided ? ' · 已作废' : ''}</small></div><div class="payment-row-actions">${receipt}${menu}</div></div>`;
    }).join('');
}

function renderItemDetail() {
  closePaymentCorrectionMenus();
  const item = normaliseDisplayItem(itemById(selectedItemId));
  if (!item) {
    $('#itemDetailDialog').removeAttribute('data-item-id');
    setFeedback('#itemDetailMessage', '物品已不存在或尚未同步。', 'warning');
    return;
  }
  $('#itemDetailDialog').setAttribute('data-item-id', item.id);
  $('#itemDetailName').textContent = item.name;
  const itemState = $('#itemDetailState');
  itemState.querySelector('b').textContent = item.status === 'archived' ? '已归档' : item.status === 'completed' ? '已付清' : '收藏中';
  setStateIcon(itemState, item.status === 'archived' ? 'archive' : item.status === 'completed' ? 'complete' : 'idle');
  $('#itemDetailBalance').textContent = formatRM(item.balanceMinor);
  $('#itemDetailPaid').textContent = `已付 ${formatRM(item.paidMinor)} / ${formatRM(item.fullPriceMinor)}`;
  $('#itemDetailProgress').style.width = `${item.progress}%`;
  const etaDescription = item.etaDate ? describeEtaDate(item.etaDate, today()) : '';
  $('#itemDetailEta').textContent = etaDescription;
  $('#itemDetailEta').hidden = !etaDescription;
  $('#itemDetailNote').textContent = item.note || '暂无备注';
  if (!itemPaymentReadState.error) clearFeedback('#itemDetailMessage');
  const archived = item.status === 'archived';
  $('#payItemFullButton').disabled = archived || item.balanceMinor <= 0;
  $('#payItemPartButton').disabled = archived || item.balanceMinor <= 0;
  $('#editItemButton').disabled = archived;
  $('#archiveItemButton').hidden = archived || item.status !== 'completed';
  $('#restoreItemButton').hidden = !archived;
  $('#deleteItemButton').hidden = archived;
  const householdId = currentMediaHouseholdId();
  const awaitingPayments = usesCloudStore()
    && itemPaymentReadState.itemId === item.id
    && itemPaymentReadState.householdId === householdId
    && !itemPaymentReadState.hasSnapshot;
  $('#itemPaymentCount').textContent = itemPaymentReadState.error
    ? '付款记录暂时无法更新'
    : awaitingPayments
      ? '正在载入付款记录…'
      : `${currentItemPayments.length} 笔记录`;
  $('#itemPaymentTimeline').innerHTML = itemPaymentReadState.error && !currentItemPayments.length
    ? `<div class="timeline-read-state error" role="status">付款记录载入失败：${escapeHtml(itemPaymentReadState.error)}</div>`
    : awaitingPayments
      ? `${currentItemPayments.length ? paymentTimelineMarkup(currentItemPayments) : ''}<div class="timeline-read-state" role="status">${stateIconMarkup('item-payment', 'pending')}<span>${currentItemPayments.length ? '正在更新，暂时显示上次付款记录。' : '正在载入付款记录，请稍候。'}</span></div>`
      : paymentTimelineMarkup(currentItemPayments);
  const coverKey = item.coverMediaId ? mediaKey(householdId, item.coverMediaId) : null;
  const cover = coverKey ? mediaCache.get(coverKey) : null;
  const coverError = coverKey ? mediaLoadErrors.get(coverKey) : null;
  $('#itemDetailCover').innerHTML = cover?.dataUrl && !coverError
    ? `<img src="${escapeHtml(cover.dataUrl)}" alt="${escapeHtml(item.name)} 封面" data-detail-cover-image="${escapeHtml(item.coverMediaId)}">`
    : coverError
      ? `<div class="item-cover-error" role="status">${stateIconMarkup('item-cover', 'error')}<small>封面载入失败</small><button class="minor-button" type="button" data-retry-detail-cover="${escapeHtml(item.coverMediaId)}">${stateIconMarkup('receipt', 'retry')}<span>重试</span></button></div>`
      : `<div class="item-cover-placeholder"><span class="item-cover-placeholder-icon">${stateIconMarkup('item-cover', 'idle')}</span><small>暂无封面</small></div>`;
  $('#itemDetailCover').querySelector('[data-detail-cover-image]')?.addEventListener('error', event => {
    markCoverImageError(householdId, event.currentTarget.dataset.detailCoverImage, item.id);
  }, { once:true });
  $('#itemDetailCover').querySelector('[data-retry-detail-cover]')?.addEventListener('click', async event => {
    const button = event.currentTarget;
    setActionButtonState(button, 'pending', { label:'重试中…' });
    try {
      await retryCoverMedia(householdId, button.dataset.retryDetailCover, item.id);
    } catch (error) {
      setFeedback('#itemDetailMessage', `封面载入失败：${error.message}`, 'error', button);
    } finally {
      releaseActionButton(button);
    }
  });
  $('#itemPaymentTimeline').querySelectorAll('.payment-menu').forEach(menu => menu.addEventListener('toggle', () => {
    setStateIcon(menu, menu.open ? 'open' : 'closed');
    if (menu.open) portalPaymentMenu(menu);
    else if (paymentMenuOwner === menu) restorePaymentMenuPortal();
  }));
  $('#itemPaymentTimeline').querySelectorAll('[data-view-receipt]').forEach(button => {
    button.addEventListener('click', () => showReceipt(currentItemPayments.find(payment => payment.id === button.dataset.viewReceipt), button));
  });
  $('#itemPaymentTimeline').querySelectorAll('[data-void-payment]').forEach(button => {
    button.addEventListener('click', () => {
      closePaymentCorrectionMenus();
      correctItemPayment('void', button.dataset.voidPayment, button);
    });
  });
  $('#itemPaymentTimeline').querySelectorAll('[data-restore-payment]').forEach(button => {
    button.addEventListener('click', () => {
      closePaymentCorrectionMenus();
      correctItemPayment('restore', button.dataset.restorePayment, button);
    });
  });
  if (requestedPaymentId) {
    const paymentId = requestedPaymentId;
    requestedPaymentId = null;
    setTimeout(() => $('#itemPaymentTimeline').querySelector(`[data-payment-id="${CSS.escape(paymentId)}"]`)?.scrollIntoView({ behavior:prefersReducedMotion() ? 'auto' : 'smooth', block:'center' }), 40);
  }
  applyBalancedHandoffs();
}

function restartItemPaymentsListener(householdId, itemId) {
  stopItemPaymentsWatch?.();
  stopItemPaymentsWatch = null;
  if (!usesCloudStore() || !householdId || !itemId || !$('#itemDetailDialog').open) return;
  const sameScope = itemPaymentReadState.householdId === householdId && itemPaymentReadState.itemId === itemId;
  if (!sameScope) currentItemPayments = [];
  const generation = itemPaymentReadState.generation + 1;
  itemPaymentReadState = { householdId, itemId, generation, hasSnapshot:false, error:null };
  renderItemDetail();
  stopItemPaymentsWatch = cloud.subscribeItemPayments(householdId, itemId, state => {
    if (generation !== itemPaymentReadState.generation || selectedItemId !== itemId || currentMediaHouseholdId() !== householdId || !$('#itemDetailDialog').open) return;
    itemPaymentReadState = { ...itemPaymentReadState, hasSnapshot:true, error:null };
    currentItemPayments = state.payments.map(normalisePayment);
    renderItemDetail();
  }, error => {
    if (generation !== itemPaymentReadState.generation || selectedItemId !== itemId || currentMediaHouseholdId() !== householdId) return;
    itemPaymentReadState = { ...itemPaymentReadState, error:error.message };
    if ($('#itemDetailDialog').open) {
      setFeedback('#itemDetailMessage', `付款时间线更新中断：${error.message}`, 'error');
      renderItemDetail();
    }
  });
}

function cleanupItemDetail() {
  stopItemPaymentsWatch?.();
  stopItemPaymentsWatch = null;
  selectedItemId = null;
  requestedPaymentId = null;
  currentItemPayments = [];
  itemPaymentReadState = { householdId:null, itemId:null, generation:itemPaymentReadState.generation + 1, hasSnapshot:false, error:null };
  closePaymentCorrectionMenus();
  clearReceiptViewer();
}

function closeItemDetail(afterClose) {
  cleanupItemDetail();
  dismissDialog($('#itemDetailDialog'), afterClose);
}

function openItemDetail(itemId, paymentId = null) {
  const item = itemById(itemId);
  if (!item || item.deletedAt) {
    showToast('物品尚未同步或已被移除。', 'warning');
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
  itemPaymentReadState = runtimeMode === 'local'
    ? { householdId:'local', itemId, generation:itemPaymentReadState.generation + 1, hasSnapshot:true, error:null }
    : { householdId:currentMediaHouseholdId(), itemId, generation:itemPaymentReadState.generation, hasSnapshot:false, error:null };
  renderItemDetail();
  if (!$('#itemDetailDialog').open) showDialog($('#itemDetailDialog'));
  if (usesCloudStore()) restartItemPaymentsListener(currentHousehold.id, itemId);
  if (item.coverMediaId) {
    const householdId = currentMediaHouseholdId();
    loadMediaOnce(householdId, item.coverMediaId).then(() => {
      if (selectedItemId === itemId && $('#itemDetailDialog').open && householdId === currentMediaHouseholdId()) renderItemDetail();
    }).catch(error => {
      mediaLoadErrors.set(mediaKey(householdId, item.coverMediaId), error);
      if (selectedItemId === itemId) {
        setFeedback('#itemDetailMessage', `封面载入失败：${error.message}`, 'error');
        renderItemDetail();
      }
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

const MEDIA_STATUS_COPY = Object.freeze({
  cover:Object.freeze({
    idle:'选择图片后会在本机安全处理', selected:'已选择封面，正在准备预览', validating:'正在验证封面图片',
    compressing:'正在压缩封面图片', ready:'封面图片已准备好', error:'封面图片处理失败'
  }),
  receipt:Object.freeze({
    idle:'选择凭证后会在本机安全处理', selected:'已选择凭证，保存时处理', validating:'正在验证凭证图片',
    compressing:'正在压缩凭证图片', ready:'凭证图片已准备好', error:'凭证图片处理失败'
  })
});
const MEDIA_STATUS_TONES = Object.freeze({ idle:'neutral', selected:'neutral', validating:'neutral', compressing:'neutral', ready:'success', error:'error' });

function setMediaStatus(target, kind, phase) {
  const element = typeof target === 'string' ? $(target) : target;
  const copy = MEDIA_STATUS_COPY[kind]?.[phase];
  if (!element || !copy || !MEDIA_STATUS_TONES[phase]) throw new Error('媒体状态无效');
  element.classList.add('media-status');
  element.dataset.mediaPhase = phase;
  element.dataset.tone = MEDIA_STATUS_TONES[phase];
  element.textContent = copy;
}

function validateSelectedMediaFile(file) {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file?.type)) throw new Error('请选择 JPG、PNG 或 WebP 图片');
  if (!Number.isSafeInteger(file.size) || file.size <= 0) throw new Error('图片文件为空或无法读取');
  if (file.size > 8 * 1024 * 1024) throw new Error('原图不能超过 8MB');
}

async function prepareFormMedia(input, kind, pending, slot, statusElement, renderPlan = null) {
  const file = input.files?.[0] ?? null;
  if (!file) return null;
  const renderKey = renderPlan ? JSON.stringify(renderPlan) : '';
  if (pending[`${slot}File`] === file && pending[`${slot}RenderKey`] === renderKey && pending[slot]) {
    setMediaStatus(statusElement, kind, 'ready');
    return pending[slot];
  }
  try {
    setMediaStatus(statusElement, kind, 'validating');
    validateSelectedMediaFile(file);
    setMediaStatus(statusElement, kind, 'compressing');
    const compressed = await compressItemMedia(file, kind, renderPlan ? { renderPlan } : {});
    const media = { id:pending[`${slot}Id`], ...compressed };
    pending[`${slot}File`] = file;
    pending[`${slot}RenderKey`] = renderKey;
    pending[slot] = media;
    setMediaStatus(statusElement, kind, 'ready');
    return media;
  } catch (error) {
    setMediaStatus(statusElement, kind, 'error');
    throw error;
  }
}

function clearPendingNewItemMedia(slot) {
  if (!pendingItemCreate) return;
  pendingItemCreate[slot] = null;
  pendingItemCreate[`${slot}File`] = null;
  pendingItemCreate[`${slot}RenderKey`] = null;
}

function updateNewItemUploadRow(kind, file = null) {
  const cover = kind === 'cover';
  $(`#newItem${cover ? 'Cover' : 'Receipt'}FileName`).textContent = file?.name || (cover ? '未选择照片' : '未选择凭证');
  $(`#newItem${cover ? 'Cover' : 'Receipt'}Choose`).textContent = file ? '重新选择' : (cover ? '选择照片' : '选择凭证');
  $(`#removeNewItem${cover ? 'Cover' : 'Receipt'}`).hidden = !file;
}

function releaseNewItemCoverPreview() {
  if (newItemCoverPreviewUrl) URL.revokeObjectURL(newItemCoverPreviewUrl);
  newItemCoverPreviewUrl = null;
  $('#newItemCoverPreview').removeAttribute('src');
}

function currentNewItemCoverRenderPlan() {
  return {
    mode:newItemCoverEdit.mode,
    zoom:newItemCoverEdit.zoom,
    offsetX:newItemCoverEdit.offsetX,
    offsetY:newItemCoverEdit.offsetY
  };
}

function renderNewItemCoverEditor() {
  const editor = $('#newItemCoverEditor');
  const image = $('#newItemCoverPreview');
  if (!newItemCoverEdit.sourceWidth || !newItemCoverEdit.sourceHeight || !image.src) return;
  newItemCoverEdit = { ...newItemCoverEdit, ...normaliseCoverEditState(newItemCoverEdit.sourceWidth, newItemCoverEdit.sourceHeight, newItemCoverEdit) };
  const crop = newItemCoverEdit.mode === 'crop';
  $('#newItemCoverZoomRow').hidden = !crop;
  $('#newItemCoverZoom').value = String(newItemCoverEdit.zoom);
  $('#newItemCoverCropHelp').textContent = crop
    ? '拖动图片调整位置，使用滑杆缩放；裁切框不会出现空洞。'
    : '完整图片会放入 4:5 画布，不会裁掉内容。';
  const viewport = $('#newItemCoverViewport');
  if (!crop) {
    Object.assign(image.style, { width:'100%', height:'100%', left:'0px', top:'0px', objectFit:'contain' });
    viewport.classList.remove('is-cropping');
    return;
  }

  const frameWidth = viewport.clientWidth || 240;
  const frameHeight = viewport.clientHeight || frameWidth * 1.25;
  const scale = Math.max(frameWidth / newItemCoverEdit.sourceWidth, frameHeight / newItemCoverEdit.sourceHeight) * newItemCoverEdit.zoom;
  const renderedWidth = newItemCoverEdit.sourceWidth * scale;
  const renderedHeight = newItemCoverEdit.sourceHeight * scale;
  const left = ((frameWidth - renderedWidth) / 2) + (newItemCoverEdit.offsetX * frameWidth / 400);
  const top = ((frameHeight - renderedHeight) / 2) + (newItemCoverEdit.offsetY * frameHeight / 500);
  Object.assign(image.style, { width:`${renderedWidth}px`, height:`${renderedHeight}px`, left:`${left}px`, top:`${top}px`, objectFit:'fill' });
  viewport.classList.add('is-cropping');
  editor.hidden = false;
}

function setNewItemCoverEdit(partial) {
  if (!newItemCoverEdit.sourceWidth || !newItemCoverEdit.sourceHeight) return;
  const next = normaliseCoverEditState(newItemCoverEdit.sourceWidth, newItemCoverEdit.sourceHeight, { ...newItemCoverEdit, ...partial });
  newItemCoverEdit = { ...newItemCoverEdit, ...next };
  clearPendingNewItemMedia('cover');
  setMediaStatus('#newItemCoverStatus', 'cover', 'selected');
  renderNewItemCoverEditor();
}

function resetNewItemCoverEditor({ keepFile = false } = {}) {
  newItemCoverEdit = { mode:'full', zoom:1, offsetX:0, offsetY:0, sourceWidth:0, sourceHeight:0 };
  document.querySelector('input[name="newItemCoverMode"][value="full"]').checked = true;
  $('#newItemCoverZoom').value = '1';
  $('#newItemCoverZoomRow').hidden = true;
  $('#newItemCoverEditor').hidden = true;
  $('#newItemCoverViewport').classList.remove('is-cropping');
  if (!keepFile) releaseNewItemCoverPreview();
}

function loadNewItemCoverPreview(file) {
  releaseNewItemCoverPreview();
  resetNewItemCoverEditor({ keepFile:true });
  if (!file) return;
  setMediaStatus('#newItemCoverStatus', 'cover', 'validating');
  newItemCoverPreviewUrl = URL.createObjectURL(file);
  const image = $('#newItemCoverPreview');
  image.onload = () => {
    newItemCoverEdit = { ...newItemCoverEdit, sourceWidth:image.naturalWidth, sourceHeight:image.naturalHeight };
    $('#newItemCoverEditor').hidden = false;
    renderNewItemCoverEditor();
    setMediaStatus('#newItemCoverStatus', 'cover', 'selected');
  };
  image.onerror = () => {
    setMediaStatus('#newItemCoverStatus', 'cover', 'error');
    $('#newItemCoverEditor').hidden = true;
  };
  image.src = newItemCoverPreviewUrl;
}

function resetNewItemMediaUI() {
  releaseNewItemCoverPreview();
  resetNewItemCoverEditor({ keepFile:true });
  updateNewItemUploadRow('cover');
  updateNewItemUploadRow('receipt');
  setMediaStatus('#newItemCoverStatus', 'cover', 'idle');
  setMediaStatus('#newItemReceiptStatus', 'receipt', 'idle');
}

function updateNewItemDepositControls() {
  const hasDeposit = $('#newItemDepositAmount').value.trim() !== '';
  $('#newItemLinkControls').hidden = !hasDeposit;
  $('#newItemAccountRow').hidden = !$('#newItemLinked').checked;
}

function openNewItem() {
  if (usesCloudStore() && !navigator.onLine) {
    showToast('新增物品需要联网。', 'warning');
    return;
  }
  pendingItemCreate = {
    itemId:uid('item'), operationId:uid('item-create'), depositPaymentId:uid('item-payment'),
    depositOperationId:uid('item-deposit'), coverId:uid('item-cover'), receiptId:uid('item-receipt'),
    createdAt:new Date().toISOString()
  };
  $('#newItemForm').reset();
  resetNewItemMediaUI();
  populateAccounts();
  $('#newItemDepositDate').value = today();
  $('#newItemLinked').checked = true;
  clearFeedback('#newItemMessage');
  resetActionButton($('#saveNewItemButton'));
  updateNewItemDepositControls();
  showDialog($('#newItemDialog'), () => $('#newItemName').focus());
}

function updatePaymentAccountRow() { $('#paymentAccountRow').hidden = !$('#paymentLinked').checked; }

function openPaymentDialog(full = false) {
  const item = normaliseDisplayItem(itemById(selectedItemId));
  if (!item || item.status === 'archived' || item.balanceMinor <= 0) return;
  if (usesCloudStore() && !navigator.onLine) {
    setFeedback('#itemDetailMessage', '记录付款需要联网。', 'warning', $('#payItemPartButton'));
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
  clearFeedback('#paymentMessage');
  resetActionButton($('#savePaymentButton'));
  setMediaStatus('#paymentReceiptStatus', 'receipt', 'idle');
  updatePaymentAccountRow();
  showDialog($('#paymentDialog'), () => (full ? $('#paymentDate') : $('#paymentAmount')).focus());
}

function openEditItem() {
  const item = itemById(selectedItemId);
  if (!item || item.archivedAt || item.status === 'archived') return;
  if (usesCloudStore() && !navigator.onLine) {
    setFeedback('#itemDetailMessage', '编辑物品需要联网。', 'warning', $('#editItemButton'));
    return;
  }
  pendingItemEdit = { operationId:uid('item-edit'), coverId:uid('item-cover'), updatedAt:new Date().toISOString(), originalCoverMediaId:item.coverMediaId ?? null };
  $('#editItemForm').reset();
  $('#editItemName').value = item.name;
  $('#editItemFullPrice').value = senToAmount(item.fullPriceMinor);
  $('#editItemEtaDate').value = item.etaDate || '';
  $('#editItemNote').value = item.note || '';
  clearFeedback('#editItemMessage');
  resetActionButton($('#saveEditItemButton'));
  setMediaStatus('#editItemCoverStatus', 'cover', 'idle');
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
    setFeedback('#itemDetailMessage', '此操作需要联网。', 'warning', button);
    return;
  }
  const key = `${currentMediaHouseholdId()}:${action}:item:${item.id}`;
  const operationId = actionOperationId(key, `item-${action}`);
  setActionButtonState(button, 'pending', { label:'处理中…' });
  clearFeedback('#itemDetailMessage');
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
    queueBalancedHandoff('item', item.id);
    renderItemsView();
    renderItemDetail();
    setActionButtonState(button, 'success');
    showToast(action === 'archive' ? '物品已归档。' : '物品已恢复到收藏。', 'success');
  } catch (error) {
    setActionButtonState(button, 'error');
    setFeedback('#itemDetailMessage', error.message, 'error', button);
  } finally {
    releaseActionButton(button);
  }
}

async function deleteSelectedItem(button) {
  const item = itemById(selectedItemId);
  if (!item || item.deletedAt) return;
  if (item.archivedAt || item.status === 'archived') {
    setFeedback('#itemDetailMessage', '请先恢复已归档物品，再删除。', 'warning', button);
    return;
  }
  if (usesCloudStore() && !navigator.onLine) {
    setFeedback('#itemDetailMessage', '删除物品需要联网。', 'warning', button);
    return;
  }
  if (!confirm(`删除「${item.name}」？所有仍生效的物品付款会作废，关联账目会移入回收状态，不再计入支出。`)) return;
  const key = `${currentMediaHouseholdId()}:delete:item:${item.id}`;
  const groupOperationId = actionOperationId(key, 'item-delete-group');
  setActionButtonState(button, 'pending', { label:'撤销付款中…' });
  clearFeedback('#itemDetailMessage');
  try {
    if (usesCloudStore()) {
      let latestItem = item;
      const payments = (await cloud.loadItemPayments(currentHousehold.id, item.id))
        .filter(payment => payment.status === 'active' && !payment.voidedAt)
        .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || a.id.localeCompare(b.id));
      for (const payment of payments) {
        const result = await cloud.voidItemPayment({
          householdId:currentHousehold.id, itemId:item.id, paymentId:payment.id,
          operationId:`${groupOperationId}:void:${payment.id}`,
          expectedRevision:latestItem.revision, actorUid:cloudUser.uid
        });
        latestItem = result.item;
        upsertItemRecord(result.item);
        upsertCurrentPayment(result.payment);
      }
      setActionButtonState(button, 'pending', { label:'删除物品中…' });
      const result = await cloud.deleteItem({
        householdId:currentHousehold.id, itemId:item.id,
        operationId:`${groupOperationId}:final`, expectedRevision:latestItem.revision, actorUid:cloudUser.uid
      });
      upsertItemRecord(result.item);
    } else {
      let nextState = itemsState;
      let nextLedger = ledger;
      const payments = nextState.itemPayments
        .filter(payment => payment.itemId === item.id && !payment.voidedAt)
        .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || a.id.localeCompare(b.id));
      for (const payment of payments) {
        const result = voidLocalItemPayment(nextState, item.id, payment.id, {
          operationId:`${groupOperationId}:void:${payment.id}`, expectedRevision:nextState.revision, actor:'local'
        });
        nextLedger = applyLinkedExpenseSpec(nextLedger, result.expenseSpec, result.payment.voidedAt);
        nextState = result.state;
      }
      const deleted = deleteLocalItem(nextState, item.id, {
        operationId:`${groupOperationId}:final`, expectedRevision:nextState.revision, actor:'local'
      });
      commitLocalItemMutation(nextLedger, deleted.state, new Map(localItemMedia));
    }
    itemActionOperations.delete(key);
    setActionButtonState(button, 'success');
    closeItemDetail(() => {
      render();
      showToast('物品已移入回收站，相关付款不再计入账目。', 'success');
    });
  } catch (error) {
    setActionButtonState(button, 'error');
    setFeedback('#itemDetailMessage', `${error.message}；若部分付款已撤销，请保持联网后再按一次删除继续。`, 'error', button);
  } finally {
    releaseActionButton(button);
  }
}

async function correctItemPayment(action, paymentId, button) {
  const item = itemById(selectedItemId);
  const payment = currentItemPayments.find(candidate => candidate.id === paymentId);
  if (!item || !payment) return;
  if (usesCloudStore() && !navigator.onLine) {
    setFeedback('#itemDetailMessage', '更正付款需要联网。', 'warning', button);
    return;
  }
  const key = `${currentMediaHouseholdId()}:${action}:payment:${paymentId}`;
  const operationId = actionOperationId(key, `payment-${action}`);
  setActionButtonState(button, 'pending', { label:'处理中…' });
  clearFeedback('#itemDetailMessage');
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
    queueBalancedHandoff('item', item.id);
    queueBalancedHandoff('payment', paymentId);
    render();
    renderItemDetail();
    setActionButtonState(button, 'success');
    showToast(action === 'void' ? '付款已作废，相关账目已同步更正。' : '付款与相关账目已恢复。', 'success');
  } catch (error) {
    setActionButtonState(button, 'error');
    setFeedback('#itemDetailMessage', error.message, 'error', button);
  } finally {
    releaseActionButton(button);
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
      const metadata = `${dateLabel(entry.occurredAt)} · ${source?.name ?? '账外资金'} → ${target?.name ?? '负债账户'} · ${visibleActor(entry.actorUid)}${entry.interestMinor ? ` · 含利息 ${formatRM(entry.interestMinor)}` : ''}${entry.note ? ` · ${entry.note}` : ''}`;
      const amountClass = targetContext ? '' : 'expense';
      const amountText = targetContext ? `−欠款 ${formatRM(shownMinor)}` : `−${formatRM(shownMinor)}`;
      const desktopFlow = `${source?.name ?? '账外资金'} → ${target?.name ?? '负债账户'}${entry.note ? ` · ${entry.note}` : ''}`;
      return `<button class="transaction-row" data-transaction-id="${escapeHtml(entry.id)}" aria-label="查看还款 ${formatRM(entry.amountMinor)}"><span class="transaction-icon repayment">${stateIconMarkup('transaction', 'repayment')}</span><span class="transaction-main"><b>还款 · ${escapeHtml(target?.name ?? '负债账户')}</b><small>${escapeHtml(metadata)}</small></span><span class="transaction-value ${amountClass}">${amountText}</span><span class="desktop-entry-cell desktop-entry-date desktop-only">${escapeHtml(entry.occurredAt.slice(0, 10))}</span><span class="desktop-entry-cell desktop-entry-kind desktop-only"><b>还款</b><small>${escapeHtml(target?.name ?? '负债账户')}</small></span><span class="desktop-entry-cell desktop-entry-flow desktop-only">${escapeHtml(desktopFlow)}</span><span class="desktop-entry-cell desktop-entry-actor desktop-only">${escapeHtml(visibleActor(entry.actorUid))}</span><span class="desktop-entry-cell desktop-entry-amount desktop-only ${amountClass}">${amountText}</span></button>`;
    }
    const isLinkedItemPayment = entry.sourceType === 'itemPayment';
    const linkedItem = isLinkedItemPayment ? itemById(entry.sourceItemId) : null;

    let amountClass = entry.kind === 'expense' ? 'expense' : '';
    let amount = entry.kind === 'transfer' ? '转账' : `${entry.kind === 'expense' ? '−' : '＋'}${formatRM(entry.amountMinor)}`;
    if (entry.kind === 'transfer' && contextAccountId) {
      const outgoing = entry.accountId === contextAccountId;
      amountClass = outgoing ? 'expense' : '';
      amount = `${outgoing ? '−' : '＋'}${formatRM(entry.amountMinor)}`;
    }
    const metadata = `${dateLabel(entry.occurredAt)} · ${accountFlowLabel(entry)} · ${visibleActor(entry.actorUid)} · ${entry.note || linkedItem?.name || '无备注'}`;
    const title = isLinkedItemPayment ? `物品付款${linkedItem ? ` · ${linkedItem.name}` : ''}` : (entry.category || typeLabel(entry.kind));
    const route = isLinkedItemPayment ? ` data-linked-item-id="${escapeHtml(entry.sourceItemId)}" data-linked-payment-id="${escapeHtml(entry.sourcePaymentId)}"` : '';
    const aria = isLinkedItemPayment ? `查看物品付款 ${linkedItem?.name ?? ''}` : `编辑 ${typeLabel(entry.kind)} ${formatRM(entry.amountMinor)}`;
    const desktopFlow = `${accountFlowLabel(entry)} · ${entry.note || linkedItem?.name || '无备注'}`;
    return `<button class="transaction-row" data-transaction-id="${escapeHtml(entry.id)}"${route} aria-label="${escapeHtml(aria)}"><span class="transaction-icon ${entry.kind}">${stateIconMarkup('transaction', isLinkedItemPayment ? 'item' : entry.kind)}</span><span class="transaction-main"><b>${escapeHtml(title)}</b><small>${escapeHtml(metadata)}</small></span><span class="transaction-value ${amountClass}">${amount}</span><span class="desktop-entry-cell desktop-entry-date desktop-only">${escapeHtml(entry.occurredAt.slice(0, 10))}</span><span class="desktop-entry-cell desktop-entry-kind desktop-only"><b>${escapeHtml(title)}</b><small>${escapeHtml(typeLabel(entry.kind))}</small></span><span class="desktop-entry-cell desktop-entry-flow desktop-only">${escapeHtml(desktopFlow)}</span><span class="desktop-entry-cell desktop-entry-actor desktop-only">${escapeHtml(visibleActor(entry.actorUid))}</span><span class="desktop-entry-cell desktop-entry-amount desktop-only ${amountClass}">${amount}</span></button>`;
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
      actions.push({ type:'account', id:account.id, sortDate:dueDate, iconFamily:'credit', iconState:'idle', iconClass:'repayment', title:`${account.name} 还款日`, detail:`当前欠款 ${formatRM(account.balanceMinor)}`, value:describeEtaDate(dueDate, today()).replace(/^预计/, '') });
    } else if (subtype === 'loan' && account.balanceMinor > 0 && account.scheduledPaymentMinor) {
      actions.push({ type:'account', id:account.id, sortDate:account.expectedPayoffDate || '9999-12-31', iconFamily:'loan', iconState:'scheduled', iconClass:'repayment', title:`${account.name} 每期还款`, detail:`剩余本金 ${formatRM(account.balanceMinor)}`, value:formatRM(account.scheduledPaymentMinor), meta:account.expectedPayoffDate ? `预计 ${account.expectedPayoffDate} 还清` : '按计划还款' });
    }
  }
  for (const item of itemRecords) {
    if (item.deletedAt || !item.etaDate || item.archivedAt || item.status === 'archived') continue;
    actions.push({ type:'item', id:item.id, sortDate:item.etaDate, iconFamily:'package', iconState:item.balanceMinor > 0 ? 'pending' : 'complete', iconClass:'eta', title:`${item.name} 预计到货`, detail:item.balanceMinor > 0 ? `待付 ${formatRM(item.balanceMinor)}` : '已付清', value:describeEtaDate(item.etaDate, today()) });
  }
  actions.sort((a, b) => a.sortDate.localeCompare(b.sortDate) || a.title.localeCompare(b.title, 'zh-CN'));
  const visible = actions.slice(0, 5);
  const list = $('#upcomingActionList');
  if (!visible.length) {
    list.innerHTML = '<div class="empty-state upcoming-empty-state"><b>近期没有待处理事项</b><p>信用卡还款、贷款计划和物品预计到货会显示在这里。</p></div>';
    return;
  }
  list.innerHTML = visible.map(action => `<button class="upcoming-action-row" type="button" data-upcoming-type="${action.type}" data-upcoming-id="${escapeHtml(action.id)}"><span class="upcoming-action-icon ${action.iconClass}">${stateIconMarkup(action.iconFamily, action.iconState)}</span><span class="upcoming-action-main"><b>${escapeHtml(action.title)}</b><small>${escapeHtml(action.detail)}</small></span><span class="upcoming-action-value">${escapeHtml(action.value)}${action.meta ? `<small>${escapeHtml(action.meta)}</small>` : ''}</span></button>`).join('');
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
  const chevron = staticIconMarkup('chevron-right');
  return `<button class="account-row ${debt ? 'liability' : ''} ${subtypeClass} ${account.includeInTotal ? '' : 'excluded'}" data-account-id="${escapeHtml(account.id)}" data-account-subtype="${subtype}" aria-label="查看 ${escapeHtml(account.name)} 明细"><span class="account-mark ${debt ? 'liability' : ''}">${accountAvatarMarkup(account)}</span><span class="account-main"><b>${escapeHtml(account.name)}</b><small>${escapeHtml(type)} ${totalStatus}</small></span><span class="account-value"><b>${formatRM(account.balanceMinor)}</b><small>${accountBalanceMeaning(account)}</small></span><span class="row-chevron">${chevron}</span><span class="desktop-account-cell desktop-account-name desktop-only"><span class="account-mark ${debt ? 'liability' : ''}">${accountAvatarMarkup(account)}</span><b>${escapeHtml(account.name)}</b></span><span class="desktop-account-cell desktop-account-type desktop-only">${escapeHtml(type)}</span><span class="desktop-account-cell desktop-account-balance desktop-only"><b>${formatRM(account.balanceMinor)}</b><small>${accountBalanceMeaning(account)}</small></span><span class="desktop-account-cell desktop-account-included desktop-only">${totalStatus}</span><span class="desktop-account-cell desktop-account-open desktop-only">${chevron}</span></button>`;
}

function renderAccountGroups(accounts) {
  const groups = [
    ['可用资金', accounts.filter(account => accountSubtype(account) === 'asset')],
    ['信用卡', accounts.filter(account => accountSubtype(account) === 'credit_card')],
    ['贷款与其他负债', accounts.filter(account => ['loan', 'generic_liability'].includes(accountSubtype(account)))]
  ];
  return `<div class="account-groups">${groups.filter(([, rows]) => rows.length).map(([title, rows]) => `<section class="account-group"><div class="account-group-heading"><h3>${title}</h3><span>${rows.length} 个账户</span></div><div class="desktop-account-table-head desktop-only" aria-hidden="true"><span>账户</span><span>类型</span><span>余额／欠款</span><span>计入状态</span><span></span></div><div class="account-group-list">${rows.map(accountRowMarkup).join('')}</div></section>`).join('')}</div>`;
}

function accountDetailAmountSize(amountMinor) {
  const minorDigits = String(Math.trunc(Math.abs(amountMinor))).length;
  if (minorDigits >= 14) return 'dense';
  if (minorDigits >= 10) return 'compact';
  return 'standard';
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
  const detailBalance = $('#accountDetailBalance');
  detailBalance.textContent = formatRM(account.balanceMinor);
  detailBalance.dataset.amountSize = accountDetailAmountSize(account.balanceMinor);
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
  accountPicker.sync('repayment');
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
    clearFeedback('#repaymentMessage');
  } catch (error) {
    $('#repaymentBreakdown').hidden = true;
    setFeedback('#repaymentMessage', error.message, 'error', $('#repaymentAmount'));
  }
}

function openRepayment(accountId, transactionId = null, returnAccountId = null) {
  const account = accountById(accountId);
  const entry = transactionId ? ledger.transactions.find(candidate => candidate.id === transactionId && !candidate.deletedAt) : null;
  if (!account || account.kind !== 'liability') return;
  if (!navigator.onLine) {
    showToast('记录还款需要联网。', 'warning');
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
  accountPicker.sync('repayment');
  $('#repaymentDate').value = entry?.occurredAt?.slice(0, 10) ?? today();
  $('#repaymentNote').value = entry?.note ?? '';
  clearFeedback('#repaymentMessage');
  resetActionButton($('#saveRepaymentButton'));
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
    accountPicker.sync('repayment');
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
    const transactionId = pendingRepayment.transactionId;
    setActionButtonState(button, 'pending', { label:'处理中…' });
    try {
      const result = moveToRecycleBin(ledger, transactionId, operationId);
      await applyLedgerChange(result.ledger, next => saveTransactionRecord(next, transactionId), pendingLedgerPatch(result.ledger, 'transactionPatch', transactionId, operationId));
      queueBalancedHandoff('transaction', transactionId);
      setActionButtonState(button, 'success');
      closeRepayment({ returnToDetail:true });
      showToast('还款已移入回收站。', 'success');
    } catch (error) {
      setActionButtonState(button, 'error');
      setFeedback('#repaymentMessage', error.message, 'error', $('#repaymentAmount'));
    } finally {
      releaseActionButton(button);
    }
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

function hasActiveEntryFilters() {
  return Boolean(entryFilters.keyword || entryFilters.kind !== 'all' || entryFilters.accountId !== 'all'
    || entryFilters.category !== 'all' || entryFilters.dateFrom || entryFilters.dateTo || entryFilters.allMonths);
}

function renderEntryFilterOptions() {
  const accountSelect = $('#entryAccountFilter');
  const categorySelect = $('#entryCategoryFilter');
  accountSelect.innerHTML = '<option value="all">全部账户</option>' + activeAccounts()
    .map(account => `<option value="${escapeHtml(account.id)}">${escapeHtml(account.name)}</option>`).join('');
  const categories = [...new Set(liveEntries().map(entry => String(entry.category || '').trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'zh-CN'));
  categorySelect.innerHTML = '<option value="all">全部分类</option>'
    + categories.map(category => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`).join('');
  if ([...accountSelect.options].some(option => option.value === entryFilters.accountId)) accountSelect.value = entryFilters.accountId;
  else entryFilters.accountId = 'all';
  if ([...categorySelect.options].some(option => option.value === entryFilters.category)) categorySelect.value = entryFilters.category;
  else entryFilters.category = 'all';
}

function filteredEntries() {
  return filterEntries(liveEntries(), { ...entryFilters, month:selectedMonth }, ledger.accounts, formatRM)
    .sort(compareEntriesNewestFirst);
}

function renderEntryResults() {
  renderEntryFilterOptions();
  const entries = filteredEntries();
  $('#entryFilterSummary').textContent = activeFilterSummary(entryFilters, accountById(entryFilters.accountId)?.name || '', entries.length);
  $('#clearEntryFilters').hidden = !hasActiveEntryFilters();
  setStateIcon($('#openEntryFilters'), hasActiveEntryFilters() ? 'active' : 'idle');
  $('#entrySearchInput').value = entryFilters.keyword;
  $('#allMonthsToggle').checked = entryFilters.allMonths;
  $('#transactionList').innerHTML = renderTransactionRows(entries,
    hasActiveEntryFilters() ? '没有符合筛选的账目' : '这个月还没有账目',
    hasActiveEntryFilters() ? '调整关键词、日期或其他条件后再试。' : '新增一笔收入、支出或转账后，会在这里显示。');
  bindRenderedControls($('#transactionList'));
}

function isCurrentOwner() {
  return usesCloudStore() && Boolean(cloudUser?.uid) && currentHousehold?.ownerId === cloudUser.uid;
}

function renderOnboarding() {
  const panel = $('#gettingStarted');
  const scope = currentScope();
  const state = onboardingState({
    accounts:ledger.accounts,
    transactions:ledger.transactions,
    isOwner:isCurrentOwner(),
    hasSharedHousehold:currentHousehold?.kind === 'shared' || householdMembers.some(member => member.role === 'member'),
    hasInvite:householdPendingInvites.length > 0
  });
  const hidden = state.complete || isOnboardingDismissed(localStorage, scope.userId, scope.householdId);
  panel.hidden = hidden;
  if (hidden) return;
  const next = state.steps.find(step => !step.complete);
  $('#gettingStartedList').innerHTML = `<div class="getting-started-steps">${state.steps.map(step =>
    `<span class="getting-started-step ${step.complete ? 'complete' : ''}"><i>${stateIconMarkup('onboarding', step.complete ? 'complete' : 'incomplete')}</i>${escapeHtml(step.label)}</span>`
  ).join('')}</div>${next ? `<button class="primary-button compact-onboarding-cta icon-label-button" type="button" data-onboarding-action="${next.action}">${stateIconMarkup('onboarding', next.action === 'account' ? 'wallet' : next.action === 'entry' ? 'entry' : 'member')}<span>${escapeHtml(next.label)}</span></button>` : ''}`;
  panel.querySelector('[data-onboarding-action]')?.addEventListener('click', event => {
    const action = event.currentTarget.dataset.onboardingAction;
    if (action === 'account') openAccount();
    else if (action === 'entry') openEntry();
    else openInviteDialog();
  });
}

function memberDisplayMarkup(member) {
  const title = String(member.displayName || member.email || '家庭成员');
  const subtitle = member.displayName && member.email ? member.email : '';
  return `<span class="member-main"><b>${escapeHtml(title)}</b>${subtitle ? `<small>${escapeHtml(subtitle)}</small>` : ''}</span>`;
}

function renderMembers() {
  const list = $('#memberList');
  if (!usesCloudStore()) {
    list.innerHTML = `<div class="member-row"><span class="member-main"><b>你</b><small>本机账本</small></span><span class="member-status">${stateIconMarkup('member', 'active')}<span>本机</span></span></div>`;
    $('#refreshMembersButton').hidden = true;
    return;
  }
  $('#refreshMembersButton').hidden = false;
  if (!currentHousehold) {
    list.innerHTML = '<p class="settings-placeholder">载入成员中…</p>';
    return;
  }
  const owner = isCurrentOwner();
  const rows = householdMembers.map(member => {
    const status = member.role === 'owner' ? 'owner' : member.active === false ? 'disabled' : 'active';
    const label = status === 'owner' ? '建立者' : status === 'disabled' ? '已停用' : '已启用';
    const manageable = owner && member.role === 'member' && member.uid !== cloudUser?.uid;
    const action = manageable
      ? `<button class="minor-button member-action" type="button" data-member-id="${escapeHtml(member.uid)}" data-member-active="${member.active === false}">${member.active === false ? '启用' : '停用'}</button>` : '';
    return `<div class="member-row" data-member-status="${status}">${memberDisplayMarkup(member)}<span class="member-status">${stateIconMarkup('member', status)}<span>${label}</span></span>${action}</div>`;
  });
  for (const invite of householdPendingInvites) {
    const action = owner ? `<button class="minor-button member-action delete" type="button" data-cancel-invite="${escapeHtml(invite.email)}">取消邀请</button>` : '';
    rows.push(`<div class="member-row" data-member-status="pending"><span class="member-main"><b>${escapeHtml(invite.email)}</b><small>等待对方接受</small></span><span class="member-status">${stateIconMarkup('member', 'pending')}<span>待加入</span></span>${action}</div>`);
  }
  if (!memberReadState.membersKnown) rows.push(`<div class="member-read-state" role="status">${stateIconMarkup('member', 'loading')}<span>${householdMembers.length ? '正在更新成员，暂时显示上次资料。' : '正在载入成员资料…'}</span></div>`);
  if (owner && !memberReadState.invitesKnown) rows.push(`<div class="member-read-state" role="status">${stateIconMarkup('member', 'loading')}<span>${householdPendingInvites.length ? '正在更新待处理邀请。' : '正在载入待处理邀请…'}</span></div>`);
  if (memberReadState.membersError) rows.push(`<div class="member-read-state error" role="status">成员载入失败：${escapeHtml(memberReadState.membersError)}</div>`);
  if (memberReadState.invitesError) rows.push(`<div class="member-read-state error" role="status">邀请载入失败：${escapeHtml(memberReadState.invitesError)}</div>`);
  const readsKnown = memberReadState.membersKnown && (!owner || memberReadState.invitesKnown);
  list.innerHTML = rows.join('') || (readsKnown
    ? '<div class="empty-state"><b>尚无成员资料</b><p>这个账本目前没有成员或待处理邀请。</p></div>'
    : `<div class="member-read-state" role="status">${stateIconMarkup('member', 'loading')}<span>正在载入成员与邀请…</span></div>`);
  list.querySelectorAll('[data-member-id]').forEach(button => button.addEventListener('click', async () => {
    const member = householdMembers.find(candidate => candidate.uid === button.dataset.memberId);
    const active = button.dataset.memberActive === 'true';
    if (!member || !confirm(`${active ? '启用' : '停用'}「${member.displayName || member.email || '这位成员'}」？`)) return;
    setActionButtonState(button, 'pending', { label:'处理中…' });
    try {
      const readback = await cloud.setMemberActive({ householdId:currentHousehold.id, memberId:member.uid, active });
      householdMembers = householdMembers.map(candidate => candidate.uid === readback.uid ? readback : candidate);
      setActionButtonState(button, 'success');
      renderMembers(); renderOnboarding();
      showToast(active ? '成员已启用。' : '成员已停用。', 'success');
    } catch (error) {
      setActionButtonState(button, 'error');
      setFeedback('#settingsMessage', `成员状态更新失败：${error.message}`, 'error', button);
    } finally {
      releaseActionButton(button);
    }
  }));
  list.querySelectorAll('[data-cancel-invite]').forEach(button => button.addEventListener('click', async () => {
    const email = button.dataset.cancelInvite;
    if (!confirm(`取消发送给 ${email} 的邀请？`)) return;
    setActionButtonState(button, 'pending', { label:'处理中…' });
    try {
      householdPendingInvites = await cloud.cancelInvite({ householdId:currentHousehold.id, inviteEmail:email });
      setActionButtonState(button, 'success');
      renderMembers(); renderOnboarding();
      showToast('邀请已取消。', 'success');
    } catch (error) {
      setActionButtonState(button, 'error');
      setFeedback('#settingsMessage', `取消邀请失败：${error.message}`, 'error', button);
    } finally {
      releaseActionButton(button);
    }
  }));
}

function restartMembersListener(householdId) {
  stopMembersWatch?.();
  stopMembersWatch = null;
  const generation = ++memberReadGeneration;
  const sameScope = memberReadState.householdId === householdId;
  if (!sameScope) {
    householdMembers = [];
    householdPendingInvites = [];
  }
  const owner = isCurrentOwner();
  memberReadState = {
    householdId, generation, membersKnown:false, invitesKnown:!owner,
    membersError:null, invitesError:null
  };
  renderMembers();
  if (!usesCloudStore() || !householdId) {
    memberReadState = { householdId:'local', generation, membersKnown:true, invitesKnown:true, membersError:null, invitesError:null };
    renderMembers();
    return Promise.resolve({ ok:true });
  }
  let settleMembers;
  let membersSettled = false;
  const membersReady = new Promise(resolve => { settleMembers = resolve; });
  stopMembersWatch = cloud.subscribeMembers(householdId, members => {
    if (generation !== memberReadGeneration || householdId !== desiredHouseholdId) return;
    householdMembers = members;
    memberReadState = { ...memberReadState, membersKnown:true, membersError:null };
    if (!membersSettled) {
      membersSettled = true;
      settleMembers({ ok:true });
    }
    renderMembers(); renderOnboarding(); render();
  }, error => {
    if (generation !== memberReadGeneration || householdId !== desiredHouseholdId) return;
    memberReadState = { ...memberReadState, membersError:error.message };
    if (!membersSettled) {
      membersSettled = true;
      settleMembers({ ok:false, error });
    }
    renderMembers();
  });
  let invitesReady;
  if (!owner) {
    householdPendingInvites = [];
    renderMembers(); renderOnboarding();
    invitesReady = Promise.resolve({ ok:true });
  } else {
    invitesReady = cloud.loadPendingInvites(householdId).then(invites => {
      if (generation !== memberReadGeneration || householdId !== desiredHouseholdId) return { ok:true };
      householdPendingInvites = invites;
      memberReadState = { ...memberReadState, invitesKnown:true, invitesError:null };
      renderMembers(); renderOnboarding();
      return { ok:true };
    }).catch(error => {
      if (generation === memberReadGeneration && householdId === desiredHouseholdId) {
        memberReadState = { ...memberReadState, invitesError:error.message };
        setFeedback('#settingsMessage', `邀请载入失败：${error.message}`, 'error', $('#refreshMembersButton'));
        renderMembers();
      }
      return { ok:false, error };
    });
  }
  return Promise.all([membersReady, invitesReady]).then(results => {
    const failure = results.find(result => result?.ok === false);
    return failure || { ok:true };
  });
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
  $('#desktopAccountAssets').textContent = formatRM(totals.assetsMinor);
  $('#desktopAccountLiabilities').textContent = formatRM(totals.liabilitiesMinor);
  $('#desktopAccountNet').textContent = formatRM(totals.netMinor);
  $('#monthLabel').textContent = monthText;
  $('#monthPicker').value = selectedMonth;

  const status = $('#reconcileStatus');
  status.querySelector('span').textContent = check.ok ? '余额已核对' : `发现 ${check.mismatches.length} 项差异`;
  setStateIcon(status, check.ok ? 'balanced' : 'mismatch');
  status.classList.toggle('bad', !check.ok);

  const accounts = activeAccounts();
  $('#accountList').innerHTML = accounts.length ? renderAccountGroups(accounts) : '<div class="empty-state"><b>还没有账户</b><p>新增现金、银行或信用卡账户，开始建立家庭账本。</p><button class="secondary-button" type="button" data-new-account>新增账户</button></div>';

  const entries = selectedEntries().sort(compareEntriesNewestFirst);
  renderEntryResults();

  renderCategoryOverview(entries);
  renderItemsView();
  renderUpcomingActions();
  renderOnboarding();

  bindRenderedControls();
  if (selectedAccountDetailId && $('#accountDetailDialog').open) renderAccountDetail();
  document.querySelectorAll('[data-new-account]').forEach(button => button.addEventListener('click', () => openAccount()));
  applyBalancedHandoffs();
}

function accountOptionDetails(account) {
  const subtype = accountSubtype(account);
  return {
    type:subtype === 'loan' ? loanTypeLabel(account) : accountSubtypeLabel(account),
    balance:account.kind === 'liability' ? `欠款 ${formatRM(account.balanceMinor)}` : `余额 ${formatRM(account.balanceMinor)}`
  };
}

function accountOptions(accounts) {
  return accounts.map(account => {
    const { type, balance } = accountOptionDetails(account);
    return `<option value="${escapeHtml(account.id)}">${escapeHtml(account.name)} ｜ ${escapeHtml(type)} ｜ ${escapeHtml(balance)}</option>`;
  }).join('');
}

function createAccountPicker({ dialogId, titleId, listId, closeId, backdropId, pickers }) {
  const dialog = $(`#${dialogId}`);
  const title = $(`#${titleId}`);
  const list = $(`#${listId}`);
  const panel = dialog.querySelector('.account-picker-panel');
  const dragHandleSelector = '.account-picker-grabber, .account-picker-handle, .account-picker-head';
  const dragCloseDistance = 72;
  const dragCloseVelocity = 0.55;
  const controls = Object.fromEntries(pickers.map(config => {
    const trigger = $(`#${config.triggerId}`);
    return [config.key, {
      ...config,
      select:$(`#${config.selectId}`),
      trigger,
      name:trigger.querySelector('.account-picker-name'),
      type:trigger.querySelector('.account-picker-type'),
      amount:trigger.querySelector('.account-picker-amount'),
      accounts:[],
      context:null
    }];
  }));
  let activeKey = null;
  let dragState = null;

  const optionMarkup = (account, selectedId) => {
    const details = accountOptionDetails(account);
    const selected = account.id === selectedId;
    return `<button class="account-picker-option" type="button" role="option" aria-selected="${selected}" tabindex="${selected ? '0' : '-1'}" data-account-picker-id="${escapeHtml(account.id)}"><span class="account-picker-name">${escapeHtml(account.name)}</span><span class="account-picker-type">${escapeHtml(details.type)}</span><span class="account-picker-amount">${escapeHtml(details.balance)}</span><span class="account-picker-check">${stateIconMarkup('completion', selected ? 'complete' : 'incomplete')}</span></button>`;
  };

  const renderOptions = () => {
    const control = controls[activeKey];
    if (!control) return;
    list.innerHTML = control.accounts.map(account => optionMarkup(account, control.select.value)).join('');
  };

  const sync = key => {
    const control = controls[key];
    const selected = control.accounts.find(account => account.id === control.select.value) || control.accounts[0] || null;
    if (selected && control.select.value !== selected.id) control.select.value = selected.id;
    const details = selected ? accountOptionDetails(selected) : { type:'', balance:'' };
    control.name.textContent = selected?.name || '暂无可用账户';
    control.type.textContent = details.type;
    control.amount.textContent = details.balance;
    control.trigger.disabled = control.select.disabled || !selected;
    setStateIcon(control.trigger, activeKey === key ? 'up' : 'down');
    if (activeKey === key) renderOptions();
  };

  const resetDrag = (animate = false) => {
    const dragY = (dragState?.dragY ?? Number.parseFloat(panel.style.getPropertyValue('--sheet-drag-y'))) || 0;
    dragState = null;
    panel.classList.remove('is-dragging');
    if (animate && dragY > 0 && !prefersReducedMotion()) void panel.offsetHeight;
    panel.style.setProperty('--sheet-drag-y', '0px');
  };

  const close = (returnFocus = false, { preserveDrag = false } = {}) => {
    if (dialog.classList.contains('is-closing')) return;
    const control = controls[activeKey];
    const finishClose = () => {
      resetDrag();
      control?.trigger.setAttribute('aria-expanded', 'false');
      setStateIcon(control?.trigger, 'down');
      activeKey = null;
      if (returnFocus) control?.trigger.focus();
    };
    if (preserveDrag) {
      dragState = null;
      panel.classList.remove('is-dragging');
      void panel.offsetHeight;
    } else resetDrag();
    if (!dialog.open) {
      finishClose();
      return;
    }
    dismissDialog(dialog, finishClose);
  };

  const open = (key, focusDirection = 'selected') => {
    const control = controls[key];
    if (!control?.accounts.length || control.trigger.disabled || dialog.open || dialog.classList.contains('is-closing')) return;
    close();
    activeKey = key;
    sync(key);
    title.textContent = control.title;
    control.trigger.setAttribute('aria-expanded', 'true');
    setStateIcon(control.trigger, 'up');
    showDialog(dialog, () => {
      const optionButtons = [...list.querySelectorAll('[role="option"]')];
      const selectedIndex = optionButtons.findIndex(option => option.getAttribute('aria-selected') === 'true');
      const index = focusDirection === 'last' ? optionButtons.length - 1 : Math.max(0, selectedIndex);
      optionButtons[index]?.focus();
    });
  };

  const setOptions = (key, context, preferredValue = null) => {
    const control = controls[key];
    const previousValue = control.select.value;
    control.context = context;
    control.accounts = control.options(context);
    control.select.innerHTML = accountOptions(control.accounts);
    const desiredValue = preferredValue ?? previousValue;
    if (desiredValue && control.accounts.some(account => account.id === desiredValue)) control.select.value = desiredValue;
    sync(key);
  };

  const selectOption = accountId => {
    const control = controls[activeKey];
    if (!control?.accounts.some(account => account.id === accountId)) return;
    control.select.value = accountId;
    sync(activeKey);
    control.select.dispatchEvent(new Event('change', { bubbles:true }));
    close(true);
  };

  for (const control of Object.values(controls)) {
    control.trigger.addEventListener('click', () => open(control.key));
    control.trigger.addEventListener('keydown', event => {
      if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
      event.preventDefault();
      open(control.key, event.key === 'ArrowUp' ? 'last' : 'selected');
    });
  }
  list.addEventListener('click', event => {
    const option = event.target.closest('[data-account-picker-id]');
    if (option) selectOption(option.dataset.accountPickerId);
  });
  list.addEventListener('keydown', event => {
    const optionButtons = [...list.querySelectorAll('[role="option"]')];
    const currentIndex = optionButtons.indexOf(document.activeElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const nextIndex = event.key === 'Home' ? 0
      : event.key === 'End' ? optionButtons.length - 1
      : (currentIndex + (event.key === 'ArrowDown' ? 1 : -1) + optionButtons.length) % optionButtons.length;
    optionButtons[nextIndex]?.focus();
  });
  panel.addEventListener('pointerdown', event => {
    const dragRegion = event.target.closest(dragHandleSelector);
    const interactiveTarget = event.target.closest('button, a, input, select, textarea, [role="button"]');
    if (!dragRegion || interactiveTarget || (event.pointerType === 'mouse' && event.button !== 0)) return;
    event.preventDefault();
    dragState = {
      pointerId:event.pointerId,
      startY:event.clientY,
      lastY:event.clientY,
      lastTime:event.timeStamp,
      dragY:0,
      velocity:0
    };
    panel.classList.add('is-dragging');
    panel.setPointerCapture?.(event.pointerId);
  });
  panel.addEventListener('pointermove', event => {
    if (!dragState || dragState.pointerId !== event.pointerId) return;
    event.preventDefault();
    const dragY = Math.max(0, event.clientY - dragState.startY);
    const elapsed = Math.max(1, event.timeStamp - dragState.lastTime);
    dragState.velocity = Math.max(0, (event.clientY - dragState.lastY) / elapsed);
    dragState.lastY = event.clientY;
    dragState.lastTime = event.timeStamp;
    dragState.dragY = dragY;
    panel.style.setProperty('--sheet-drag-y', `${dragY}px`);
  });
  panel.addEventListener('pointerup', event => {
    if (!dragState || dragState.pointerId !== event.pointerId) return;
    dragState.dragY = Math.max(dragState.dragY, event.clientY - dragState.startY, 0);
    const releaseVelocity = event.timeStamp - dragState.lastTime <= 80 ? dragState.velocity : 0;
    const shouldClose = dragState.dragY > dragCloseDistance || releaseVelocity > dragCloseVelocity;
    if (panel.hasPointerCapture?.(event.pointerId)) panel.releasePointerCapture(event.pointerId);
    if (shouldClose) close(true, { preserveDrag:true });
    else resetDrag(true);
  });
  panel.addEventListener('pointercancel', event => {
    if (!dragState || dragState.pointerId !== event.pointerId) return;
    if (panel.hasPointerCapture?.(event.pointerId)) panel.releasePointerCapture(event.pointerId);
    resetDrag(true);
  });
  $(`#${closeId}`).addEventListener('click', () => close(true));
  $(`#${backdropId}`).addEventListener('click', () => close(true));

  return { close, isOpen:() => activeKey !== null, setOptions, sync };
}

const accountPicker = createAccountPicker({
  dialogId:'accountPickerDialog',
  titleId:'accountPickerTitle',
  listId:'accountPickerOptions',
  closeId:'closeAccountPicker',
  backdropId:'accountPickerBackdrop',
  pickers:[
    { key:'source', selectId:'sourceAccount', triggerId:'sourceAccountTrigger', title:'选择账户', options:kind => entryAccounts(kind) },
    { key:'target', selectId:'targetAccount', triggerId:'targetAccountTrigger', title:'选择转入账户', options:() => assetAccounts() },
    { key:'repayment', selectId:'repaymentSourceAccount', triggerId:'repaymentSourceAccountTrigger', title:'选择付款账户', options:() => assetAccounts() },
    { key:'newItem', selectId:'newItemAccount', triggerId:'newItemAccountTrigger', title:'选择付款账户', options:() => itemPaymentAccounts() },
    { key:'payment', selectId:'paymentAccount', triggerId:'paymentAccountTrigger', title:'选择付款账户', options:() => itemPaymentAccounts() }
  ]
});

for (const dialogId of ['entryDialog', 'repaymentDialog', 'newItemDialog', 'paymentDialog']) {
  $(`#${dialogId}`).addEventListener('close', () => accountPicker.close());
}

function populateEntryAccounts(kind, sourceId = null, targetId = null) {
  accountPicker.setOptions('source', kind, sourceId);
  accountPicker.setOptions('target', null, targetId);
}

function populateAccounts() {
  const kind = document.querySelector('input[name="kind"]:checked')?.value ?? 'expense';
  populateEntryAccounts(kind);
  accountPicker.setOptions('repayment', null);
  accountPicker.setOptions('newItem', null);
  accountPicker.setOptions('payment', null);
}

function selectCategory(value = '', focusCustom = false) {
  const normalized = String(value || '').trim();
  const directCategory = ENTRY_CATEGORIES.includes(normalized);
  const selectedCategory = directCategory ? normalized : normalized ? '其它' : '';
  document.querySelectorAll('[data-category]').forEach(button => {
    const selected = button.dataset.category === selectedCategory;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-checked', String(selected));
    setStateIcon(button, selected ? 'selected' : 'idle');
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
  accountPicker.close();
  populateEntryAccounts(kind, $('#sourceAccount').value, $('#targetAccount').value);
  if ($('#entryShortcutsDialog').open) renderEntryTemplates();
}

function currentEntryKind() {
  return document.querySelector('input[name="kind"]:checked').value;
}

function applyEntryBusinessFields(values, feedback) {
  if (!values || !['income', 'expense', 'transfer'].includes(values.kind)) return;
  document.querySelector(`input[name="kind"][value="${values.kind}"]`).checked = true;
  updateKindState();
  if (entryAccounts(values.kind).some(account => account.id === values.accountId)) $('#sourceAccount').value = values.accountId;
  if (values.kind === 'transfer' && assetAccounts().some(account => account.id === values.targetAccountId && account.id !== $('#sourceAccount').value)) {
    $('#targetAccount').value = values.targetAccountId;
  }
  accountPicker.sync('source');
  accountPicker.sync('target');
  $('#amountInput').value = Number.isSafeInteger(values.amountMinor) ? senToAmount(values.amountMinor) : '';
  selectCategory(values.kind === 'transfer' ? '' : values.category || '');
  $('#noteInput').value = values.note || '';
  $('#dateInput').value = today();
  setFeedback('#entryMessage', feedback, 'success');
  $('#amountInput').focus();
  $('#amountInput').select();
}

function renderEntryTemplates() {
  const list = $('#entryTemplateList');
  const kind = currentEntryKind();
  const kindLabel = typeLabel(kind);
  $('#entryShortcutsTitle').textContent = `${kindLabel}快捷方式`;
  const scope = currentScope();
  const templates = loadEntryTemplates(localStorage, scope.userId, scope.householdId, kind);
  list.innerHTML = templates.length ? templates.map(template =>
    `<div class="entry-template-row"><button class="entry-template-apply" type="button" data-template-id="${escapeHtml(template.id)}">${stateIconMarkup('template', 'copy')}<span><b>${escapeHtml(template.name)}</b><small>${escapeHtml(typeLabel(template.kind))} · ${formatRM(template.amountMinor)}</small></span></button><button class="entry-template-delete" type="button" data-delete-template="${escapeHtml(template.id)}" aria-label="删除 ${escapeHtml(template.name)}">${staticIconMarkup('trash')}</button></div>`
  ).join('') : `<p class="entry-template-empty">还没有${escapeHtml(kindLabel)}常用模板。可先填写表单，再存为常用。</p>`;
  list.querySelectorAll('[data-template-id]').forEach(button => button.addEventListener('click', () => {
    const template = templates.find(candidate => candidate.id === button.dataset.templateId);
    dismissDialog($('#entryShortcutsDialog'), () => applyEntryBusinessFields(template, `已套用「${template?.name || '常用账目'}」，请确认后保存。`));
  }));
  list.querySelectorAll('[data-delete-template]').forEach(button => button.addEventListener('click', () => {
    deleteEntryTemplate(localStorage, scope.userId, scope.householdId, button.dataset.deleteTemplate);
    renderEntryTemplates();
    setFeedback('#entryShortcutMessage', '常用账目已删除。', 'success');
  }));
}

function currentEntryTemplate() {
  const kind = document.querySelector('input[name="kind"]:checked').value;
  const amountMinor = amountToSen($('#amountInput').value);
  const category = kind === 'transfer' ? '' : $('#categoryInput').value.trim();
  if (kind !== 'transfer' && !category) throw new Error('请先选择分类');
  return {
    id:uid('template'), kind, amountMinor, category, note:$('#noteInput').value.trim(),
    accountId:$('#sourceAccount').value || null,
    targetAccountId:kind === 'transfer' ? ($('#targetAccount').value || null) : null
  };
}

function openEntry(id = null) {
  const entryId = typeof id === 'string' ? id : null;
  if (!activeAccounts().length) {
    showToast('请先新增一个可用账户。', 'warning');
    openAccount();
    return;
  }
  const entry = entryId ? ledger.transactions.find(item => item.id === entryId && !item.deletedAt) : null;
  if (entryId && !entry) {
    showToast('该账目已不在可编辑列表。', 'warning');
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
  accountPicker.close();
  clearFeedback('#entryMessage');
  $('#entryForm').reset();
  $('#editingTransactionId').value = entry?.id || '';
  $('#entryDialogTitle').textContent = entry ? '编辑账目' : '新增账目';
  resetActionButton($('#saveEntryButton'), entry ? '保存修改' : '保存账目');
  $('#archiveTransactionButton').hidden = !entry;
  $('#openEntryShortcuts').hidden = Boolean(entry);

  if (entry) {
    document.querySelector(`input[name="kind"][value="${entry.kind}"]`).checked = true;
    updateKindState();
    $('#amountInput').value = senToAmount(entry.amountMinor);
    $('#sourceAccount').value = entry.accountId;
    $('#targetAccount').value = entry.targetAccountId || '';
    accountPicker.sync('source');
    accountPicker.sync('target');
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

  renderEntryTemplates();
  showDialog($('#entryDialog'), () => $('#amountInput').focus());
}

function renderAccountPhotoPreview() {
  const preview = $('#accountPhotoPreview');
  preview.innerHTML = pendingAccountPhotoDataUrl
    ? `<img src="${escapeHtml(pendingAccountPhotoDataUrl)}" alt="账户照片预览">`
    : stateIconMarkup('account', document.querySelector('input[name="accountSubtype"]:checked')?.value === 'credit_card' ? 'credit' : document.querySelector('input[name="accountSubtype"]:checked')?.value === 'loan' ? 'loan' : 'idle');
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
  if (!pendingAccountPhotoDataUrl) renderAccountPhotoPreview();
}

function openAccount(id = null) {
  const account = id ? ledger.accounts.find(item => item.id === id) : null;
  const subtype = account ? accountSubtype(account) : 'asset';
  pendingAccountOperationId = uid(account ? 'account-edit' : 'account-create');
  $('#accountForm').reset();
  clearFeedback('#accountMessage');
  resetActionButton($('#saveAccountButton'));
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
  showDialog($('#accountDialog'), () => $('#accountName').focus());
}

async function restoreDeletedItemFromRecycle(itemId, button) {
  const item = itemById(itemId);
  if (!item?.deletedAt) return;
  if (usesCloudStore() && !navigator.onLine) {
    showToast('恢复物品需要联网。', 'warning');
    return;
  }
  const key = `${currentMediaHouseholdId()}:restore-deleted:item:${item.id}`;
  const operationId = actionOperationId(key, 'item-restore-deleted');
  setActionButtonState(button, 'pending', { label:'恢复中…' });
  try {
    if (usesCloudStore()) {
      const result = await cloud.restoreDeletedItem({
        householdId:currentHousehold.id, itemId:item.id, operationId,
        expectedRevision:item.revision, actorUid:cloudUser.uid
      });
      upsertItemRecord(result.item);
    } else {
      const result = restoreDeletedLocalItem(itemsState, item.id, {
        operationId, expectedRevision:itemsState.revision, actor:'local'
      });
      commitLocalItemMutation(ledger, result.state, new Map(localItemMedia));
    }
    itemActionOperations.delete(key);
    queueBalancedHandoff('item', item.id);
    render();
    renderRecycle();
    setActionButtonState(button, 'success');
    showToast('物品已恢复；原付款仍保持作废，可在物品详情逐笔恢复。', 'success');
  } catch (error) {
    setActionButtonState(button, 'error');
    showToast(`无法恢复物品：${error.message}`, 'error');
  } finally {
    releaseActionButton(button);
  }
}

function renderRecycle() {
  const deletedItems = itemRecords
    .filter(item => item.deletedAt)
    .sort((a, b) => String(b.deletedAt).localeCompare(String(a.deletedAt)));
  const deletedEntries = ledger.transactions
    .filter(entry => entry.deletedAt && entry.sourceType !== 'itemPayment')
    .sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
  const itemMarkup = deletedItems.map(item => `<div class="recycle-row item-recycle-row"><span class="transaction-icon">${stateIconMarkup('recycle', 'idle')}</span><div class="transaction-main"><b>物品 · ${escapeHtml(item.name)}</b><small>${dateLabel(item.deletedAt)} 移入 · ${escapeHtml(visibleActor(item.deletedByUid ?? item.deletedBy))} · 关联付款已作废，不计入支出</small><div class="recycle-actions"><button class="minor-button icon-label-button" data-restore-deleted-item="${escapeHtml(item.id)}">${stateIconMarkup('recycle', 'restore')}<span>恢复物品</span></button></div></div></div>`).join('');
  const entryMarkup = deletedEntries.map(entry => `<div class="recycle-row"><span class="transaction-icon expense">${stateIconMarkup('transaction', entry.kind === 'repayment' ? 'repayment' : entry.kind)}</span><div class="transaction-main"><b>${escapeHtml(entry.category || typeLabel(entry.kind))} · ${formatRM(entry.amountMinor)}</b><small>${dateLabel(entry.deletedAt)} 移入 · ${escapeHtml(visibleActor(entry.actorUid))} · ${escapeHtml(entry.note || '无备注')}</small><div class="recycle-actions"><button class="minor-button icon-label-button" data-restore="${escapeHtml(entry.id)}">${stateIconMarkup('recycle', 'restore')}<span>恢复</span></button><button class="minor-button delete icon-label-button" data-delete="${escapeHtml(entry.id)}">${staticIconMarkup('trash')}<span>永久删除</span></button></div></div></div>`).join('');
  $('#recycleList').innerHTML = itemMarkup || entryMarkup
    ? `${itemMarkup}${entryMarkup}`
    : '<div class="empty-state"><b>回收站是空的</b><p>移除的普通账目和物品会显示在这里。</p></div>';

  document.querySelectorAll('[data-restore-deleted-item]').forEach(button => button.addEventListener('click', () => {
    restoreDeletedItemFromRecycle(button.dataset.restoreDeletedItem, button);
  }));
  document.querySelectorAll('[data-restore]').forEach(button => button.addEventListener('click', async () => {
    const operationId = uid('restore');
    const transactionId = button.dataset.restore;
    const result = restoreFromRecycleBin(ledger, transactionId, operationId);
    setActionButtonState(button, 'pending', { label:'恢复中…' });
    try {
      await applyLedgerChange(result.ledger, next => saveTransactionRecord(next, transactionId), pendingLedgerPatch(result.ledger, 'transactionPatch', transactionId, operationId));
      queueBalancedHandoff('transaction', transactionId);
      setActionButtonState(button, 'success');
      renderRecycle();
      showToast(result.duplicate ? '重复恢复已阻止。' : '已恢复账目并重新核对余额。', result.duplicate ? 'warning' : 'success');
    } catch (error) {
      setActionButtonState(button, 'error');
      showToast(`无法恢复账目：${error.message}`, 'error');
    } finally {
      releaseActionButton(button);
    }
  }));
  document.querySelectorAll('[data-delete]').forEach(button => button.addEventListener('click', async () => {
    if (!confirm('永久删除这笔账目？此操作无法撤销。')) return;
    const operationId = uid('delete');
    const prior = ledger.transactions.find(entry => entry.id === button.dataset.delete);
    const result = permanentlyDelete(ledger, button.dataset.delete, operationId);
    setActionButtonState(button, 'pending', { label:'删除中…' });
    try {
      await applyLedgerChange(result.ledger, async () => {
        if (usesCloudStore()) await cloud.purgeTransaction(currentHousehold.id, button.dataset.delete, operationId);
      }, pendingLedgerPatch(result.ledger, 'transactionPatch', button.dataset.delete, operationId, { ...prior, purgedAt:new Date().toISOString(), lastOperationId:operationId }));
      setActionButtonState(button, 'success');
      renderRecycle();
      showToast(result.duplicate ? '重复删除已阻止。' : '已永久移除这笔账目。', result.duplicate ? 'warning' : 'success');
    } catch (error) {
      setActionButtonState(button, 'error');
      showToast(`无法永久删除账目：${error.message}`, 'error');
    } finally {
      releaseActionButton(button);
    }
  }));
}

async function currentBackupPayload() {
  const payments = usesCloudStore()
    ? await cloud.loadAllItemPayments(currentHousehold.id)
    : serialiseItemsState(itemsState).itemPayments;
  return createBackupPayload({
    householdName:usesCloudStore() ? currentHousehold.name : '本机账本',
    ledger,
    items:itemRecords,
    itemPayments:payments
  });
}

function downloadBackupPayload(payload) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type:'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `family-wallet-backup-${today()}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
}

async function downloadCurrentBackup({ closeSettings = false } = {}) {
  const payload = await currentBackupPayload();
  downloadBackupPayload(payload);
  if (closeSettings) dismissDialog($('#settingsDialog'));
  return payload;
}

async function exportLocal() {
  const button = $('#exportButton');
  setActionButtonState(button, 'pending', { label:'导出中…' });
  clearFeedback('#settingsMessage');
  try {
    await downloadCurrentBackup({ closeSettings:true });
    setActionButtonState(button, 'success');
    showToast('已导出可校验备份；照片内容未包含。', 'success');
  } catch (error) {
    setActionButtonState(button, 'error');
    setFeedback('#settingsMessage', `无法导出：${error.message}`, 'error', button);
  } finally {
    releaseActionButton(button);
  }
}

function renderRestorePreview(validated, mode) {
  const counts = validated.counts;
  const modeCopy = mode === 'cloud'
    ? '<b>云端恢复方式</b><p>会建立新的恢复副本，不覆盖当前账本。成功后会切换并重新载入恢复副本。</p>'
    : '<b>本机恢复方式</b><p>会先自动下载当前账本备份，再原子替换本机资料并重新载入。失败时保留原账本。</p>';
  $('#restorePreview').innerHTML = `<div class="restore-ledger-name"><span>账本名称</span><strong>${escapeHtml(validated.sourceName)}</strong></div><div class="restore-counts"><span><b>${counts.accounts}</b>账户</span><span><b>${counts.transactions}</b>账目</span><span><b>${counts.items}</b>物品</span><span><b>${counts.itemPayments}</b>付款</span></div><div class="restore-mode-copy">${modeCopy}</div>`;
}

async function prepareRestoreFile(file) {
  if (!file) return;
  if (file.size <= 0 || file.size > MAX_BACKUP_BYTES) throw new Error('只可选择不超过 5MB 的 JSON 备份');
  if (!file.name.toLowerCase().endsWith('.json') && file.type !== 'application/json') throw new Error('请选择 JSON 备份文件');
  if (usesCloudStore() && (!cloudUser || !cloudProfile || !isCurrentOwner())) {
    throw new Error('云端只有当前账本建立者可以恢复；家庭成员可查看资料，但不能建立恢复副本');
  }
  const text = await file.text();
  let payload;
  try { payload = JSON.parse(text); }
  catch { throw new Error('JSON 文件已损坏'); }
  const mode = usesCloudStore() ? 'cloud' : 'local';
  const identity = mode === 'cloud' ? await deterministicImportIdentity(payload, cloudUser.uid) : null;
  const validated = await validateBackup(payload, {
    destinationHouseholdId:identity?.householdId ?? 'local-restored',
    ownerUid:cloudUser?.uid ?? 'local',
    byteLength:file.size
  });
  pendingRestore = { mode, payload, identity, validated };
  renderRestorePreview(validated, mode);
  clearFeedback('#restoreMessage');
  resetActionButton($('#confirmRestoreButton'));
  showDialog($('#restorePreviewDialog'), () => $('#confirmRestoreButton').focus());
}

async function confirmRestore() {
  if (!pendingRestore) return;
  const request = pendingRestore;
  const button = $('#confirmRestoreButton');
  setActionButtonState(button, 'pending', { label:'恢复中…' });
  clearFeedback('#restoreMessage');
  try {
    if (request.mode === 'cloud') {
      if (!cloudUser || !cloudProfile || !isCurrentOwner()) throw new Error('只有当前账本建立者可以恢复云端备份');
      const result = await cloud.restoreBackupCopy({ identity:request.identity, validated:request.validated, user:cloudUser });
      if (result.householdId !== request.identity.householdId) throw new Error('恢复副本回读不一致');
      setActionButtonState(button, 'success');
      const refreshUrl = new URL(location.href);
      refreshUrl.searchParams.set('wallet-restored', result.householdId);
      location.replace(refreshUrl.href);
    } else {
      await replaceLocalAtomically({
        storage:localStorage,
        storeKey:STORE,
        validated:request.validated,
        downloadCurrent:() => downloadCurrentBackup({ closeSettings:false })
      });
      setActionButtonState(button, 'success');
      location.reload();
    }
  } catch (error) {
    setActionButtonState(button, 'error');
    setFeedback('#restoreMessage', `恢复失败：${error.message}。当前账本未切换。`, 'error', button);
  } finally {
    releaseActionButton(button);
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

let pendingWalletUpdateCache = null;
const hadServiceWorkerControllerAtStartup = Boolean(navigator.serviceWorker?.controller);

function hasOpenWalletDialog() {
  return Boolean(document.querySelector('dialog[open]'));
}

function applyPendingWalletUpdate() {
  if (!pendingWalletUpdateCache || hasOpenWalletDialog()) return;
  const refreshUrl = new URL(location.href);
  if (refreshUrl.searchParams.get('wallet-sw') === pendingWalletUpdateCache) {
    pendingWalletUpdateCache = null;
    return;
  }
  refreshUrl.searchParams.set('wallet-sw', pendingWalletUpdateCache);
  location.replace(refreshUrl.href);
}

function handleWalletUpdateMessage(event) {
  if (!hadServiceWorkerControllerAtStartup || event.data?.type !== 'FAMILY_WALLET_UPDATE_READY') return;
  pendingWalletUpdateCache = String(event.data.cache || 'latest');
  if (hasOpenWalletDialog()) {
    setSyncState('更新就绪，完成当前操作后刷新', false, 'update');
    $('#syncBadge').setAttribute('role', 'status');
    $('#syncBadge').setAttribute('aria-live', 'polite');
    return;
  }
  applyPendingWalletUpdate();
}

function requestDialogClose(dialog) {
  if (dialog?.id === 'accountPickerDialog') accountPicker.close(true);
  else if (dialog?.id === 'itemDetailDialog') closeItemDetail();
  else if (dialog?.id === 'receiptViewerDialog') closeReceiptViewer();
  else if (dialog?.id === 'repaymentDialog') closeRepayment({ returnToDetail:true });
  else dismissDialog(dialog);
}

document.querySelectorAll('[data-view-target]').forEach(button => button.addEventListener('click', () => setView(button.dataset.viewTarget, true, true)));
document.querySelectorAll('[data-close-dialog]').forEach(button => button.addEventListener('click', () => requestDialogClose($(`#${button.dataset.closeDialog}`))));
document.querySelectorAll('dialog').forEach(dialog => {
  dialog.addEventListener('click', event => {
    if (event.target === dialog) requestDialogClose(dialog);
  });
  dialog.addEventListener('cancel', event => {
    event.preventDefault();
    requestDialogClose(dialog);
  });
  dialog.addEventListener('close', () => {
    if (dialog.id === 'topbarActionsDialog') setStateIcon($('#moreButton'), 'closed');
    applyPendingWalletUpdate();
  });
});
$('#moreButton').addEventListener('click', () => {
  setStateIcon($('#moreButton'), 'open');
  showDialog($('#topbarActionsDialog'));
});
function openSettingsDialog() {
  clearFeedback('#settingsMessage');
  resetActionButton($('#exportButton'));
  resetActionButton($('#refreshMembersButton'));
  renderMembers();
  showDialog($('#settingsDialog'));
}
$('#openSettingsButton').addEventListener('click', () => {
  dismissDialog($('#topbarActionsDialog'), () => {
    clearFeedback('#settingsMessage');
    renderMembers();
    showDialog($('#settingsDialog'));
  });
});
$('#desktopSettingsButton').addEventListener('click', openSettingsDialog);
$('#desktopContextAction').addEventListener('click', () => {
  if (activeView === 'accounts') openAccount();
  else if (activeView === 'items') openNewItem();
  else openEntry();
});
$('#syncBadge').addEventListener('click', () => {
  if (runtimeMode === 'local') {
    showToast('本机模式不需要云端同步。', 'neutral');
    return;
  }
  const state = syncCoordinator.getState();
  if (state.status === 'synced' && !itemListenerError) {
    if (hasOpenWalletDialog()) {
      showToast('请先关闭正在使用的窗口，再刷新 App。', 'warning');
      return;
    }
    const refreshUrl = new URL(location.href);
    refreshUrl.searchParams.set('wallet-refresh', String(Date.now()));
    setSyncState('刷新中', false, 'update');
    $('#syncBadge').disabled = true;
    location.replace(refreshUrl.href);
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
$('#newItemCover').addEventListener('change', event => {
  const file = event.target.files?.[0] ?? null;
  clearPendingNewItemMedia('cover');
  updateNewItemUploadRow('cover', file);
  setMediaStatus('#newItemCoverStatus', 'cover', file ? 'selected' : 'idle');
  loadNewItemCoverPreview(file);
});
$('#newItemReceipt').addEventListener('change', event => {
  const file = event.target.files?.[0] ?? null;
  clearPendingNewItemMedia('receipt');
  updateNewItemUploadRow('receipt', file);
  setMediaStatus('#newItemReceiptStatus', 'receipt', file ? 'selected' : 'idle');
});
$('#removeNewItemCover').addEventListener('click', () => {
  $('#newItemCover').value = '';
  clearPendingNewItemMedia('cover');
  updateNewItemUploadRow('cover');
  resetNewItemCoverEditor();
  setMediaStatus('#newItemCoverStatus', 'cover', 'idle');
});
$('#removeNewItemReceipt').addEventListener('click', () => {
  $('#newItemReceipt').value = '';
  clearPendingNewItemMedia('receipt');
  updateNewItemUploadRow('receipt');
  setMediaStatus('#newItemReceiptStatus', 'receipt', 'idle');
});
document.querySelectorAll('input[name="newItemCoverMode"]').forEach(input => input.addEventListener('change', event => {
  setNewItemCoverEdit({ mode:event.target.value, zoom:newItemCoverEdit.zoom, offsetX:newItemCoverEdit.offsetX, offsetY:newItemCoverEdit.offsetY });
}));
$('#newItemCoverZoom').addEventListener('input', event => setNewItemCoverEdit({ zoom:Number(event.target.value) }));
$('#resetNewItemCoverCrop').addEventListener('click', () => setNewItemCoverEdit({ zoom:1, offsetX:0, offsetY:0 }));
let newItemCoverDrag = null;
$('#newItemCoverViewport').addEventListener('pointerdown', event => {
  if (newItemCoverEdit.mode !== 'crop' || (event.pointerType === 'mouse' && event.button !== 0)) return;
  event.preventDefault();
  newItemCoverDrag = { pointerId:event.pointerId, x:event.clientX, y:event.clientY, offsetX:newItemCoverEdit.offsetX, offsetY:newItemCoverEdit.offsetY };
  event.currentTarget.setPointerCapture?.(event.pointerId);
});
$('#newItemCoverViewport').addEventListener('pointermove', event => {
  if (!newItemCoverDrag || newItemCoverDrag.pointerId !== event.pointerId) return;
  event.preventDefault();
  const viewport = event.currentTarget;
  setNewItemCoverEdit({
    offsetX:newItemCoverDrag.offsetX + ((event.clientX - newItemCoverDrag.x) * 400 / Math.max(1, viewport.clientWidth)),
    offsetY:newItemCoverDrag.offsetY + ((event.clientY - newItemCoverDrag.y) * 500 / Math.max(1, viewport.clientHeight))
  });
});
const finishNewItemCoverDrag = event => {
  if (newItemCoverDrag?.pointerId === event.pointerId) newItemCoverDrag = null;
};
$('#newItemCoverViewport').addEventListener('pointerup', finishNewItemCoverDrag);
$('#newItemCoverViewport').addEventListener('pointercancel', finishNewItemCoverDrag);
window.addEventListener('resize', renderNewItemCoverEditor);
$('#paymentLinked').addEventListener('change', updatePaymentAccountRow);
$('#paymentReceipt').addEventListener('change', event => {
  if (pendingPayment) {
    pendingPayment.receipt = null;
    pendingPayment.receiptFile = null;
  }
  setMediaStatus('#paymentReceiptStatus', 'receipt', event.target.files?.length ? 'selected' : 'idle');
});
$('#payItemFullButton').addEventListener('click', () => openPaymentDialog(true));
$('#payItemPartButton').addEventListener('click', () => openPaymentDialog(false));
$('#editItemButton').addEventListener('click', openEditItem);
$('#archiveItemButton').addEventListener('click', event => runItemLifecycle('archive', event.currentTarget));
$('#restoreItemButton').addEventListener('click', event => runItemLifecycle('restore', event.currentTarget));
$('#deleteItemButton').addEventListener('click', event => deleteSelectedItem(event.currentTarget));
$('#closeReceiptViewerButton').addEventListener('click', closeReceiptViewer);
$('#editItemCover').addEventListener('change', event => {
  if (event.target.files?.length) $('#editItemRemoveCover').checked = false;
  if (pendingItemEdit) {
    pendingItemEdit.cover = null;
    pendingItemEdit.coverFile = null;
  }
  setMediaStatus('#editItemCoverStatus', 'cover', event.target.files?.length ? 'selected' : 'idle');
});
$('#editItemRemoveCover').addEventListener('change', event => {
  if (event.target.checked) {
    $('#editItemCover').value = '';
    if (pendingItemEdit) {
      pendingItemEdit.cover = null;
      pendingItemEdit.coverFile = null;
    }
    setMediaStatus('#editItemCoverStatus', 'cover', 'idle');
  }
});

$('#newItemForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (!pendingItemCreate) return;
  const button = $('#saveNewItemButton');
  clearFeedback('#newItemMessage');
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
    setActionButtonState(button, 'pending', { label:'保存中…' });
    const cover = await prepareFormMedia($('#newItemCover'), 'cover', pendingItemCreate, 'cover', $('#newItemCoverStatus'), currentNewItemCoverRenderPlan());
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
    queueBalancedHandoff('item', pendingItemCreate.itemId);
    if (hasDeposit) queueBalancedHandoff('payment', pendingItemCreate.depositPaymentId);
    setActionButtonState(button, 'success');
    pendingItemCreate = null;
    dismissDialog($('#newItemDialog'));
    setView('items');
    showToast(hasDeposit ? '物品与订金已保存。' : '物品已保存。', 'success');
  } catch (error) {
    setActionButtonState(button, 'error');
    reportSubmitError('#newItemMessage', event.currentTarget, error);
  } finally {
    releaseActionButton(button);
  }
});

$('#paymentForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (!pendingPayment || !selectedItemId) return;
  const button = $('#savePaymentButton');
  clearFeedback('#paymentMessage');
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
    setActionButtonState(button, 'pending', { label:'保存中…' });
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
    queueBalancedHandoff('item', item.id);
    queueBalancedHandoff('payment', pendingPayment.paymentId);
    setActionButtonState(button, 'success');
    pendingPayment = null;
    dismissDialog($('#paymentDialog'));
    showToast(wasFull ? '物品已付清。' : '付款已保存。', 'success');
  } catch (error) {
    setActionButtonState(button, 'error');
    reportSubmitError('#paymentMessage', event.currentTarget, error);
  } finally {
    releaseActionButton(button);
  }
});

$('#editItemForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (!pendingItemEdit || !selectedItemId) return;
  const button = $('#saveEditItemButton');
  clearFeedback('#editItemMessage');
  try {
    if (usesCloudStore() && !navigator.onLine) throw new Error('编辑物品需要联网');
    const item = itemById(selectedItemId);
    if (!item) throw new Error('物品不存在');
    const fullPriceMinor = amountToSen($('#editItemFullPrice').value);
    setActionButtonState(button, 'pending', { label:'保存中…' });
    const cover = await prepareFormMedia($('#editItemCover'), 'cover', pendingItemEdit, 'cover', $('#editItemCoverStatus'));
    const removeCover = !cover && $('#editItemRemoveCover').checked;
    const changes = {
      name:$('#editItemName').value.trim(),
      note:$('#editItemNote').value.trim(),
      etaDate:$('#editItemEtaDate').value || null,
      fullPriceMinor
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
    queueBalancedHandoff('item', item.id);
    setActionButtonState(button, 'success');
    pendingItemEdit = null;
    dismissDialog($('#editItemDialog'));
    showToast('物品资料已更新。', 'success');
  } catch (error) {
    setActionButtonState(button, 'error');
    reportSubmitError('#editItemMessage', event.currentTarget, error);
  } finally {
    releaseActionButton(button);
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
  clearFeedback('#repaymentMessage');
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
    setActionButtonState(button, 'pending', { label:'保存中…' });
    await applyLedgerChange(result.ledger, next => saveTransactionRecord(next, transactionId), pendingLedgerPatch(result.ledger, 'transactionPatch', transactionId, pendingRepayment.operationId));
    queueBalancedHandoff('transaction', transactionId);
    setActionButtonState(button, 'success');
    pendingRepayment = null;
    closeRepayment({ returnToDetail:true });
    showToast('还款已保存。', 'success');
  } catch (error) {
    setActionButtonState(button, 'error');
    setFeedback('#repaymentMessage', error.message, 'error', $('#repaymentAmount'));
  } finally {
    releaseActionButton(button);
  }
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
  clearFeedback('#accountMessage');
  try {
    pendingAccountPhotoDataUrl = await compressAccountPhoto(file);
    renderAccountPhotoPreview();
  } catch (error) {
    setFeedback('#accountMessage', error.message, 'error', event.currentTarget?.querySelector?.(':invalid') || $('#accountName'));
  } finally {
    event.target.value = '';
  }
});
$('#removeAccountPhotoButton').addEventListener('click', () => {
  pendingAccountPhotoDataUrl = null;
  renderAccountPhotoPreview();
});
$('#viewAllEntriesButton').addEventListener('click', () => setView('entries', true, true));
$('#exportButton').addEventListener('click', exportLocal);
$('#restoreFileInput').addEventListener('change', async event => {
  const file = event.target.files?.[0] ?? null;
  clearFeedback('#settingsMessage');
  try { await prepareRestoreFile(file); }
  catch (error) { setFeedback('#settingsMessage', `无法预览备份：${error.message}`, 'error', $('#restoreFileInput')); }
  finally { event.target.value = ''; }
});
$('#confirmRestoreButton').addEventListener('click', confirmRestore);
$('#restorePreviewDialog').addEventListener('close', () => {
  pendingRestore = null;
  resetActionButton($('#confirmRestoreButton'));
});
$('#recycleButton').addEventListener('click', () => { renderRecycle(); showDialog($('#recycleDialog')); });
$('#closeRecycleButton').addEventListener('click', () => dismissDialog($('#recycleDialog')));
$('#monthFilterButton').addEventListener('click', () => showDialog($('#monthDialog')));
$('#overviewMonthButton').addEventListener('click', () => showDialog($('#monthDialog')));
$('#entrySearchInput').addEventListener('input', event => {
  entryFilters.keyword = event.target.value;
  renderEntryResults();
});
$('#openEntryFilters').addEventListener('click', () => {
  renderEntryFilterOptions();
  $('#entryKindFilter').value = entryFilters.kind;
  $('#entryAccountFilter').value = entryFilters.accountId;
  $('#entryCategoryFilter').value = entryFilters.category;
  $('#entryDateFrom').value = entryFilters.dateFrom;
  $('#entryDateTo').value = entryFilters.dateTo;
  $('#allMonthsToggle').checked = entryFilters.allMonths;
  showDialog($('#entryFilterDialog'), () => $('#entryKindFilter').focus());
});
$('#entryFilterForm').addEventListener('submit', event => {
  event.preventDefault();
  const dateFrom = $('#entryDateFrom').value;
  const dateTo = $('#entryDateTo').value;
  if (dateFrom && dateTo && dateFrom > dateTo) {
    showToast('开始日期不能晚于结束日期。', 'warning');
    return;
  }
  entryFilters = {
    ...entryFilters,
    kind:$('#entryKindFilter').value,
    accountId:$('#entryAccountFilter').value,
    category:$('#entryCategoryFilter').value,
    dateFrom,
    dateTo,
    allMonths:$('#allMonthsToggle').checked
  };
  dismissDialog($('#entryFilterDialog'));
  renderEntryResults();
});
$('#clearEntryFilters').addEventListener('click', () => {
  entryFilters = { keyword:'', kind:'all', accountId:'all', category:'all', dateFrom:'', dateTo:'', allMonths:false };
  renderEntryResults();
  $('#entrySearchInput').focus();
});
$('#openEntryShortcuts').addEventListener('click', () => {
  clearFeedback('#entryShortcutMessage');
  renderEntryTemplates();
  showDialog($('#entryShortcutsDialog'), () => $('#copyPreviousEntry').focus());
});
$('#copyPreviousEntry').addEventListener('click', () => {
  const kind = currentEntryKind();
  const copy = copyPreviousEntry(liveEntries(), kind);
  if (!copy) {
    setFeedback('#entryShortcutMessage', `还没有可复制的${typeLabel(kind)}。`, 'warning', $('#copyPreviousEntry'));
    return;
  }
  dismissDialog($('#entryShortcutsDialog'), () => applyEntryBusinessFields(copy, `已复制上一笔${typeLabel(kind)}，日期已改为今天，请确认后保存。`));
});
$('#saveEntryTemplate').addEventListener('click', () => {
  clearFeedback('#entryShortcutMessage');
  try {
    const template = currentEntryTemplate();
    const suggested = template.note || template.category || '常用账目';
    const name = prompt('给这个常用账目取名', suggested);
    if (name === null) return;
    const scope = currentScope();
    saveEntryTemplate(localStorage, scope.userId, scope.householdId, { ...template, name:name.trim() || suggested });
    renderEntryTemplates();
    setFeedback('#entryShortcutMessage', '已存为常用账目，不会自动提交。', 'success');
  } catch (error) {
    setFeedback('#entryShortcutMessage', error.message, 'error', $('#saveEntryTemplate'));
  }
});
$('#dismissGettingStarted').addEventListener('click', () => {
  const scope = currentScope();
  dismissOnboarding(localStorage, scope.userId, scope.householdId);
  renderOnboarding();
});
$('#refreshMembersButton').addEventListener('click', async event => {
  const button = event.currentTarget;
  setActionButtonState(button, 'pending', { label:'载入中…' });
  clearFeedback('#settingsMessage');
  try {
    const result = usesCloudStore() && currentHousehold
      ? await restartMembersListener(currentHousehold.id)
      : (renderMembers(), { ok:true });
    if (result?.ok === false) throw result.error;
    setActionButtonState(button, 'success');
  } catch (error) {
    setActionButtonState(button, 'error');
    setFeedback('#settingsMessage', `成员载入失败：${error.message}`, 'error', button);
  } finally {
    releaseActionButton(button);
  }
});
$('#monthPicker').addEventListener('change', event => {
  if (!event.target.value) return;
  selectedMonth = event.target.value;
  setStateIcon($('#monthFilterButton'), 'selected');
  render();
});
$('#monthForm').addEventListener('submit', event => {
  event.preventDefault();
  dismissDialog($('#monthDialog'));
  setView('entries', true, true);
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
  clearFeedback('#entryMessage');
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
    setActionButtonState(button, 'pending', { label:'保存中…' });
    await applyLedgerChange(result.ledger, next => saveTransactionRecord(next, transactionId), pendingLedgerPatch(result.ledger, 'transactionPatch', transactionId, pendingOperationId));
    queueBalancedHandoff('transaction', transactionId);
    setActionButtonState(button, 'success');
    rememberEntryPreferences(kind, changes.accountId, changes.targetAccountId);
    dismissDialog($('#entryDialog'));
    if (!editingTransactionId) setView('entries');
    showToast(result.duplicate ? '重复保存已阻止。' : editingTransactionId ? '修改已保存，余额已重新核对。' : '已保存，余额已重新核对。', result.duplicate ? 'warning' : 'success');
  } catch (error) {
    setActionButtonState(button, 'error');
    reportSubmitError('#entryMessage', event.currentTarget, error);
    saveLocked = false;
  } finally {
    releaseActionButton(button);
  }
});

$('#archiveTransactionButton').addEventListener('click', async event => {
  const editingTransactionId = $('#editingTransactionId').value;
  if (!editingTransactionId) return;
  const button = event.currentTarget;
  const operationId = uid('recycle');
  const result = moveToRecycleBin(ledger, editingTransactionId, operationId);
  setActionButtonState(button, 'pending', { label:'处理中…' });
  try {
    await applyLedgerChange(result.ledger, next => saveTransactionRecord(next, editingTransactionId), pendingLedgerPatch(result.ledger, 'transactionPatch', editingTransactionId, operationId));
    queueBalancedHandoff('transaction', editingTransactionId);
    setActionButtonState(button, 'success');
    dismissDialog($('#entryDialog'));
    setView('entries');
    showToast(result.duplicate ? '重复回收已阻止。' : '已移入回收站，余额已重新核对。', result.duplicate ? 'warning' : 'success');
  } catch (error) {
    setActionButtonState(button, 'error');
    setFeedback('#entryMessage', error.message, 'error', button);
  } finally {
    releaseActionButton(button);
  }
});

$('#accountForm').addEventListener('submit', async event => {
  event.preventDefault();
  const button = $('#saveAccountButton');
  clearFeedback('#accountMessage');
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
    setActionButtonState(button, 'pending', { label:'保存中…' });
    await applyLedgerChange(nextLedger, next => saveAccountRecord(next, accountId), pendingLedgerPatch(nextLedger, 'accountPatch', accountId, pendingAccountOperationId));
    queueBalancedHandoff('account', accountId);
    setActionButtonState(button, 'success');
    dismissDialog($('#accountDialog'));
    setView('accounts');
    showToast(id ? '账户设置已保存。' : '新账户已加入当前账本。', 'success');
  } catch (error) {
    setActionButtonState(button, 'error');
    setFeedback('#accountMessage', error.message, 'error', event.currentTarget?.querySelector?.(':invalid') || $('#accountName'));
  } finally {
    releaseActionButton(button);
  }
});

$('#archiveAccountButton').addEventListener('click', async event => {
  const id = $('#editingAccountId').value;
  if (!id) return;
  if (!confirm('归档后，这个账户会被隐藏并从家庭净额排除；目前没有恢复入口。确定继续吗？')) return;
  const button = event.currentTarget;
  const nextLedger = archiveAccount(ledger, id);
  setActionButtonState(button, 'pending', { label:'处理中…' });
  try {
    await applyLedgerChange(nextLedger, next => saveAccountRecord(next, id), pendingLedgerPatch(nextLedger, 'accountPatch', id, pendingAccountOperationId));
    queueBalancedHandoff('account', id);
    setActionButtonState(button, 'success');
    dismissDialog($('#accountDialog'));
    setView('accounts');
    showToast('账户已归档，并从家庭净额排除。', 'success');
  } catch (error) {
    setActionButtonState(button, 'error');
    setFeedback('#accountMessage', error.message, 'error', button);
  } finally {
    releaseActionButton(button);
  }
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
      showToast(`无法切换账本，已返回原账本：${error.message}`, 'error');
      return;
    }
    setSwitching(false);
    if (!currentHousehold) showAuth(`无法读取这个账本：${error.message}`);
    else showToast(`实时同步暂时中断：${error.message}`, 'error');
  });
}

function restartItemsListener(householdId) {
  stopItemsWatch?.();
  stopItemsWatch = null;
  if (!usesCloudStore() || !householdId || householdId !== desiredHouseholdId) return;
  const sameScope = itemReadState.householdId === householdId;
  if (!sameScope) itemRecords = [];
  const generation = itemReadState.generation + 1;
  itemReadState = { householdId, generation, hasSnapshot:false, error:null };
  itemListenerError = null;
  renderItemsView();
  stopItemsWatch = cloud.subscribeItems(householdId, state => {
    if (generation !== itemReadState.generation || householdId !== desiredHouseholdId || currentHousehold?.id !== householdId) return;
    itemListenerError = null;
    itemReadState = { ...itemReadState, hasSnapshot:true, error:null };
    itemRecords = state.items.map(normaliseDisplayItem);
    renderSyncStatus();
    renderItemsView();
    renderUpcomingActions();
    if (selectedItemId && $('#itemDetailDialog').open) renderItemDetail();
  }, error => {
    if (generation !== itemReadState.generation || householdId !== desiredHouseholdId) return;
    itemListenerError = error.message;
    itemReadState = { ...itemReadState, error:error.message };
    renderSyncStatus();
    renderItemsView();
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
  stopMembersWatch?.();
  stopMembersWatch = null;
  memberReadGeneration += 1;
  memberReadState = { householdId, generation:memberReadGeneration, membersKnown:false, invitesKnown:false, membersError:null, invitesError:null };
  if ($('#itemDetailDialog').open) closeItemDetail();
  currentListenerToken = syncCoordinator.activateHousehold(cloudSessionToken, householdId);
  restartHouseholdListener(currentListenerToken, householdId);
  if (persistSelection && cloudUser) {
    cloud.selectHousehold(cloudUser.uid, householdId).catch(error => {
      if (householdId === desiredHouseholdId) showToast(`账本已切换，但偏好保存失败：${error.message}`, 'warning');
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
  stopMembersWatch?.();
  stopItemListeners();
  if ($('#itemDetailDialog').open) {
    cleanupItemDetail();
    dismissDialog($('#itemDetailDialog'));
  }
  stopUserWatch = stopInviteWatch = stopHouseholdWatch = stopMembersWatch = null;
  householdMembers = [];
  householdPendingInvites = [];
  memberReadGeneration += 1;
  memberReadState = { householdId:null, generation:memberReadGeneration, membersKnown:false, invitesKnown:false, membersError:null, invitesError:null };
  itemReadState = { householdId:null, generation:itemReadState.generation + 1, hasSnapshot:false, error:null };
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
    else showToast(error.message, 'error');
  }), error => {
    if (!currentHousehold && sessionToken === cloudSessionToken) showAuth(error.message);
    else showToast(`个人资料监听中断：${error.message}`, 'error');
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
  }, error => currentHousehold ? showToast(error.message, 'error') : showAuth(error.message, 'error'));
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
  setActionButtonState(button, 'pending', { label:'等待 Google 登录…' });
  showAuth('Google 登录窗口已打开，请在该窗口完成登录。');
  try {
    await cloud.signInGoogle();
    setActionButtonState(button, 'success');
  } catch (error) {
    setActionButtonState(button, 'error');
    showAuth(googleSignInErrorMessage(error), 'error');
  } finally {
    googleSignInPending = false;
    releaseActionButton(button);
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
function openInviteDialog() {
  $('#inviteForm').reset();
  clearFeedback('#inviteMessage');
  resetActionButton($('#sendInviteButton'));
  showDialog($('#inviteDialog'));
}
$('#inviteMemberButton').addEventListener('click', () => {
  if ($('#topbarActionsDialog').open) dismissDialog($('#topbarActionsDialog'), openInviteDialog);
  else openInviteDialog();
});
$('#inviteForm').addEventListener('submit', async event => {
  event.preventDefault();
  const button = $('#sendInviteButton');
  clearFeedback('#inviteMessage');
  setActionButtonState(button, 'pending', { label:'发送中…' });
  try {
    await cloud.inviteMember({
      householdId: currentHousehold.id,
      email: $('#inviteEmail').value,
      ownerUid: cloudUser.uid,
      ownerEmail: cloudUser.email,
      ownerDisplayName: cloudUser.displayName
    });
    setActionButtonState(button, 'success');
    dismissDialog($('#inviteDialog'));
    showToast('邀请已建立。对方使用该 Gmail 登录后即可加入家庭账本。', 'success');
  } catch (error) {
    setActionButtonState(button, 'error');
    setFeedback('#inviteMessage', error.message, 'error', $('#inviteEmail'));
  } finally {
    releaseActionButton(button);
  }
});
$('#acceptInviteButton').addEventListener('click', async () => {
  if (!pendingInvite || !cloudUser) return;
  const button = $('#acceptInviteButton');
  setActionButtonState(button, 'pending', { label:'加入中…' });
  try {
    await cloud.acceptInvite({ invite: pendingInvite, user: cloudUser });
    setActionButtonState(button, 'success');
    pendingInvite = null;
    $('#pendingInvitePanel').hidden = true;
    showAuth('正在打开家庭账本…');
  } catch (error) {
    setActionButtonState(button, 'error');
    showAuth(`无法加入家庭账本：${error.message}`, 'error');
  } finally {
    releaseActionButton(button);
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
  const firebaseWebHost = `${firebaseConfig.projectId}.web.app`;
  const firebaseAuthHost = `${firebaseConfig.projectId}.firebaseapp.com`;
  if (!useEmulators && location.hostname === firebaseWebHost) {
    const canonicalUrl = new URL(location.href);
    canonicalUrl.hostname = firebaseAuthHost;
    canonicalUrl.protocol = 'https:';
    canonicalUrl.port = '';
    location.replace(canonicalUrl.href);
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
      if (!useEmulators) $('#googleSignInButton').hidden = Boolean(user);
      showAuth(user
        ? `Google 登录仍然有效，但账本暂时无法打开：${error.message}。请刷新后重试。`
        : error.message);
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

initializeFeedbackRows();
initializeActionButtons();
applyTheme(localStorage.getItem(THEME_STORE) || document.documentElement.dataset.theme || 'teal', { persist:false });
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', handleWalletUpdateMessage);
  navigator.serviceWorker.register('./service-worker.js', { updateViaCache:'none' })
    .then(registration => registration.update())
    .catch(() => {});
}
startRuntime().catch(error => showAuth(`无法启动：${error.message}`));
