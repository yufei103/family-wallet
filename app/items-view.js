import { createLedger, serialiseLedger } from './ledger.js';
import { createItemsState, deriveItems, serialiseItemsState } from './items.js';

export const LOCAL_SCHEMA_VERSION = 2;

const clone = value => value == null ? value : structuredClone(value);
const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, char => ({
  '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;'
})[char]);

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

export function renderItemCards(items, { formatMoney, mediaCache = new Map(), householdId = 'local' } = {}) {
  if (!items.length) {
    return '<div class="items-empty"><b>橱窗还是空的</b><p>把想收藏、正在分期或已经拥有的物品放进来。</p><button class="secondary-button" type="button" data-new-item>新增物品</button></div>';
  }
  return items.map(raw => {
    const item = normaliseDisplayItem(raw);
    const mediaKey = `${householdId}/${item.coverMediaId ?? ''}`;
    const cover = item.coverMediaId ? mediaCache.get(mediaKey) : null;
    const coverMarkup = cover?.dataUrl
      ? `<img src="${escapeHtml(cover.dataUrl)}" alt="" loading="lazy">`
      : `<div class="item-cover-placeholder" ${item.coverMediaId ? `data-cover-media-id="${escapeHtml(item.coverMediaId)}"` : ''}><span aria-hidden="true">FW</span><small>${item.coverMediaId ? '载入封面' : '暂无封面'}</small></div>`;
    const paid = formatMoney(item.paidMinor);
    const full = formatMoney(item.fullPriceMinor);
    const balance = formatMoney(item.balanceMinor);
    return `<button class="item-card" type="button" data-item-id="${escapeHtml(item.id)}" aria-label="查看 ${escapeHtml(item.name)}"><span class="item-cover">${coverMarkup}</span><span class="item-card-copy"><b>${escapeHtml(item.name)}</b><small>已付 ${paid} / ${full}</small><span class="item-progress" aria-label="已完成 ${item.progress}%"><i style="width:${item.progress}%"></i></span><span class="item-card-foot"><span>余额 ${balance}</span><em class="item-status ${item.status}">${item.status === 'completed' ? '已付清' : item.status === 'archived' ? '已归档' : '待付'}</em></span></span></button>`;
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
