import { createLedger, serialiseLedger } from './ledger.js';
import { createItemsState, deriveItems, normaliseEtaDate, serialiseItemsState } from './items.js';
import { stateIconMarkup } from './state-icon-data.js';

export const LOCAL_SCHEMA_VERSION = 2;

const clone = value => value == null ? value : structuredClone(value);
const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, char => ({
  '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;'
})[char]);

const localTodayDate = () => {
  const now = new Date();
  return `${String(now.getFullYear()).padStart(4, '0')}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
};

export function describeEtaDate(etaDate, todayDate) {
  const eta = normaliseEtaDate(etaDate);
  if (!eta) return '';
  const today = normaliseEtaDate(todayDate);
  if (!today) throw new Error('今天日期必须是有效的 YYYY-MM-DD');
  const [, , month, day] = /^(\d{4})-(\d{2})-(\d{2})$/.exec(eta).map(Number);
  const calendarDay = `${month}月${day}日`;
  if (eta === today) return '预计今天到货';
  return eta > today ? `预计 ${calendarDay}到货` : `原预计 ${calendarDay}`;
}

/** Read schema v2, while treating the old bare ledger payload as a legacy fallback. */
export function hydrateLocalEnvelope(raw, fallbackLedger) {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (parsed?.schemaVersion === LOCAL_SCHEMA_VERSION && parsed.ledger) {
      return {
        ledger: createLedger(parsed.ledger),
        itemsState: createItemsState(parsed.items),
        itemMedia: Array.isArray(parsed.itemMedia) ? clone(parsed.itemMedia) : []
      };
    }
    if (parsed?.accounts && parsed?.transactions) {
      return { ledger:createLedger(parsed), itemsState:createItemsState(), itemMedia:[] };
    }
  } catch {
    // A corrupt local demo payload must not prevent the app shell from opening.
  }
  return { ledger:createLedger(serialiseLedger(fallbackLedger)), itemsState:createItemsState(), itemMedia:[] };
}

export function serialiseLocalEnvelope(ledger, itemsState, itemMedia = []) {
  return {
    schemaVersion:LOCAL_SCHEMA_VERSION,
    ledger:serialiseLedger(ledger),
    items:serialiseItemsState(itemsState),
    itemMedia:clone(itemMedia)
  };
}

/** Merge a pending account/transaction document into the latest raw Firestore snapshot. */
export function mergePendingLedgerPatch(rawState, operation) {
  if (!operation?.record?.id) return rawState;
  const state = rawState ? clone(rawState) : { household:null, accounts:[], transactions:[] };
  const key = operation.kind === 'accountPatch' ? 'accounts' : operation.kind === 'transactionPatch' ? 'transactions' : null;
  if (!key) return state;
  const records = Array.isArray(state[key]) ? state[key] : [];
  const index = records.findIndex(record => record.id === operation.record.id);
  if (operation.remove === true) {
    if (index >= 0) records.splice(index, 1);
  } else if (index >= 0) records[index] = { ...records[index], ...clone(operation.record) };
  else records.push(clone(operation.record));
  state[key] = records;
  return state;
}

/** Firestore transaction records are the acknowledgement source for manual writes. */
export function rawSnapshotHasOperation(rawState, operationId) {
  return (rawState?.transactions ?? []).some(record =>
    record.operationId === operationId || record.lastOperationId === operationId
    || record.sourceOperationId === operationId
  );
}

export function normaliseDisplayItem(item) {
  const fullPriceMinor = Number.isSafeInteger(item?.fullPriceMinor) ? item.fullPriceMinor : 0;
  const paidMinor = Number.isSafeInteger(item?.paidMinor) ? item.paidMinor : 0;
  const balanceMinor = Math.max(0, fullPriceMinor - paidMinor);
  return {
    ...clone(item),
    fullPriceMinor,
    paidMinor,
    balanceMinor,
    progress:fullPriceMinor > 0 ? Math.min(100, Math.round((paidMinor / fullPriceMinor) * 100)) : 0,
    status:item?.archivedAt || item?.status === 'archived' ? 'archived' : balanceMinor === 0 ? 'completed' : 'active'
  };
}

export function displayItemsFromLocal(itemsState) {
  return deriveItems(itemsState).map(normaliseDisplayItem);
}

export function renderItemCards(items, { formatMoney, mediaCache = new Map(), householdId = 'local', todayDate = localTodayDate() } = {}) {
  if (!items.length) {
    return '<div class="items-empty"><b>橱窗还是空的</b><p>把想收藏、正在分期或已经拥有的物品放进来。</p><button class="secondary-button" type="button" data-new-item>新增物品</button></div>';
  }
  return items.map(raw => {
    const item = normaliseDisplayItem(raw);
    const mediaKey = `${householdId}/${item.coverMediaId ?? ''}`;
    const cover = item.coverMediaId ? mediaCache.get(mediaKey) : null;
    const coverMarkup = cover?.dataUrl
      ? `<img src="${escapeHtml(cover.dataUrl)}" alt="" loading="lazy">`
      : `<div class="item-cover-placeholder" ${item.coverMediaId ? `data-cover-media-id="${escapeHtml(item.coverMediaId)}"` : ''}><span class="item-cover-placeholder-icon">${stateIconMarkup('item-cover', item.coverMediaId ? 'pending' : 'idle')}</span><small>${item.coverMediaId ? '载入封面' : '暂无封面'}</small></div>`;
    const paid = formatMoney(item.paidMinor);
    const full = formatMoney(item.fullPriceMinor);
    const balance = formatMoney(item.balanceMinor);
    const etaDescription = item.etaDate ? describeEtaDate(item.etaDate, todayDate) : '';
    const statusText = item.status === 'completed' ? '已付清' : item.status === 'archived' ? '已归档' : `待付 ${balance}`;
    const etaMarkup = etaDescription ? `<small class="item-eta">${escapeHtml(etaDescription)}</small>` : '';
    const accessibleLabel = `查看 ${item.name}，${statusText}${etaDescription ? `，${etaDescription}` : ''}`;
    const statusIcon = stateIconMarkup('item-lifecycle', item.status === 'completed' ? 'complete' : item.status === 'archived' ? 'archive' : 'idle');
    return `<button class="item-card" type="button" data-item-id="${escapeHtml(item.id)}" aria-label="${escapeHtml(accessibleLabel)}"><span class="item-cover">${coverMarkup}</span><span class="item-card-copy"><b>${escapeHtml(item.name)}</b><small>已付 ${escapeHtml(paid)} / ${escapeHtml(full)}</small>${etaMarkup}<span class="item-progress" aria-label="已完成 ${item.progress}%"><i style="width:${item.progress}%"></i></span><span class="item-card-foot"><em class="item-status ${item.status}" data-item-status="${item.status}">${statusIcon}${escapeHtml(statusText)}</em></span></span></button>`;
  }).join('');
}

/** Backup metadata only: image bytes and account photo Data URLs are always omitted. */
export function withoutMediaDataUrls(value) {
  if (Array.isArray(value)) return value.map(withoutMediaDataUrls);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key, child]) => !/dataurl|photodataurl/i.test(key) && !(typeof child === 'string' && child.startsWith('data:image/')))
    .map(([key, child]) => [key, withoutMediaDataUrls(child)]));
}
