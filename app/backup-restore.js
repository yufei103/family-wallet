import { createAccount, createLedger, deriveLedger, reconcile, serialiseLedger } from './ledger.js';
import { createItemsState, serialiseItemsState } from './items.js';

export const BACKUP_SCHEMA_VERSION = 3;
export const MAX_BACKUP_BYTES = 5 * 1024 * 1024;
export const FIRESTORE_IMPORT_BATCH_SIZE = 400;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)?$/;
const CHECKSUM = /^[a-f0-9]{64}$/;
const FORBIDDEN_KEYS = /^(?:access|accessToken|refreshToken|idToken|token|tokens|password|secret|credential|credentials|firebaseConfig|auth|users?|members?|invites?|ownerEmail|email|displayName)$/i;
const IDENTITY_KEYS = /^(?:uid|householdId|ownerId|actorUid|createdByUid|updatedByUid|deletedByUid|createdBy|updatedBy|deletedBy|voidedBy|restoredBy|actor|actorId)$/i;
const MEDIA_KEYS = /(?:dataUrl|photoData|photoDataUrl|coverMediaId|receiptMediaId|itemMedia)$/i;
const clone = value => structuredClone(value);
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function fail(message) { throw new Error(message); }
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label}必须是对象`);
  return value;
}
function array(value, label, cap = 100000) {
  if (!Array.isArray(value) || value.length > cap) fail(`${label}必须是有效数组`);
  return value;
}
function exactKeys(value, label, allowed, required = []) {
  object(value, label);
  const unknown = Object.keys(value).find(key => !allowed.includes(key));
  if (unknown) fail(`${label}包含未知字段 ${unknown}`);
  const missing = required.find(key => !hasOwn(value, key));
  if (missing) fail(`${label}缺少字段 ${missing}`);
  return value;
}
function safeId(value, label) {
  if (typeof value !== 'string' || !ID.test(value)) fail(`${label}无效`);
  return value;
}
function optionalId(value, label) { return value == null ? null : safeId(value, label); }
function string(value, label, cap, { empty = true } = {}) {
  if (typeof value !== 'string' || value.length > cap || (!empty && !value.trim())) fail(`${label}无效`);
  return value;
}
function money(value, label, { positive = false, nonNegative = false } = {}) {
  if (!Number.isSafeInteger(value) || (positive && value <= 0) || (nonNegative && value < 0)) {
    fail(`${label}必须是${positive ? '正' : nonNegative ? '非负' : ''}安全整数 sen`);
  }
  return value;
}
function date(value, label, optional = false) {
  if (optional && value == null) return null;
  if (typeof value !== 'string' || !ISO_DATE.test(value)) fail(`${label}无效`);
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() + 1 !== month || parsed.getUTCDate() !== day
      || Number.isNaN(Date.parse(value.length === 10 ? `${value}T00:00:00Z` : value))) fail(`${label}无效`);
  return value;
}
function calendarDate(value, label, optional = false) {
  const result = date(value, label, optional);
  if (result != null && result.length !== 10) fail(`${label}必须是 YYYY-MM-DD`);
  return result;
}
function unique(records, label) {
  const ids = new Set();
  for (const record of records) {
    const id = safeId(record?.id, `${label} ID`);
    if (ids.has(id)) fail(`${label} ID 重复：${id}`);
    ids.add(id);
  }
  return ids;
}
function uniqueIds(values, label) {
  const ids = new Set();
  for (const value of values) {
    const id = safeId(value, label);
    if (ids.has(id)) fail(`${label}重复：${id}`);
    ids.add(id);
  }
  return ids;
}
function scanForbidden(value, schemaVersion, path = '备份') {
  if (typeof value === 'string' && /^data:/i.test(value)) fail(`${path}包含 Data URL`);
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.test(key)) fail(`${path}包含禁止字段 ${key}`);
    // schemaVersion 2 was produced by the previous public release and kept
    // per-record actor/household bookkeeping. It is accepted only so those
    // fields can be discarded and rebound to the restoring owner below.
    if (schemaVersion >= 3 && IDENTITY_KEYS.test(key)) fail(`${path}包含身份字段 ${key}`);
    scanForbidden(child, schemaVersion, `${path}.${key}`);
  }
}
function assertJsonValue(value, path = '备份') {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(`${path}包含非 JSON 数字`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertJsonValue(child, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) fail(`${path}不是有效 JSON`);
  for (const [key, child] of Object.entries(value)) {
    if (child === undefined || typeof child === 'bigint' || typeof child === 'function' || typeof child === 'symbol') fail(`${path}.${key}不是有效 JSON`);
    assertJsonValue(child, `${path}.${key}`);
  }
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export async function sha256(value) {
  const bytes = new TextEncoder().encode(typeof value === 'string' ? value : canonicalJson(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function sanitiseForExport(value) {
  if (Array.isArray(value)) return value.map(sanitiseForExport);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key, child]) => !FORBIDDEN_KEYS.test(key) && !IDENTITY_KEYS.test(key) && !MEDIA_KEYS.test(key)
      && !(typeof child === 'string' && /^data:/i.test(child)))
    .map(([key, child]) => [key, sanitiseForExport(child)]));
}

export async function createBackupPayload({ householdName, ledger, items = [], itemPayments = [], exportedAt = new Date().toISOString() }) {
  const sourceItems = items.map(item => {
    const { balanceMinor:unusedBalance, progress:unusedProgress, payments:unusedPayments, timeline:unusedTimeline, ...record } = item;
    return record;
  });
  const body = sanitiseForExport({
    schemaVersion:BACKUP_SCHEMA_VERSION,
    exportedAt,
    household:{ name:String(householdName || '家庭账本').slice(0, 200) },
    // Never trust cached balances from the caller; the ledger contract derives
    // them from opening balances and immutable transactions before export.
    ledger:serialiseLedger(deriveLedger(serialiseLedger(ledger))),
    items:sourceItems,
    itemPayments
  });
  const counts = {
    accounts:body.ledger.accounts.length,
    transactions:body.ledger.transactions.length,
    items:body.items.length,
    itemPayments:body.itemPayments.length
  };
  const checksum = await sha256(body);
  const payload = { ...body, manifest:{ format:'family-wallet-backup', checksumAlgorithm:'SHA-256', checksum, counts, mediaIncluded:false } };
  await validateBackup(payload);
  return payload;
}

const ACCOUNT_KEYS = [
  'id', 'name', 'kind', 'subtype', 'openingBalanceMinor', 'balanceMinor', 'includeInTotal', 'photoDataUrl', 'archivedAt',
  'creditLimitMinor', 'statementDay', 'dueDay', 'loanType', 'loanCalculationMode', 'annualInterestRateBps',
  'originalPrincipalMinor', 'scheduledPaymentMinor', 'expectedPayoffDate'
];
function normaliseAccount(raw, householdId, schemaVersion) {
  const allowed = schemaVersion === 2 ? [...ACCOUNT_KEYS, 'householdId'] : ACCOUNT_KEYS;
  const account = exactKeys(raw, '账户', allowed, ['id', 'name', 'kind', 'openingBalanceMinor', 'includeInTotal']);
  safeId(account.id, '账户 ID');
  string(account.name, '账户名称', 200, { empty:false });
  if (!['asset', 'liability'].includes(account.kind)) fail(`账户 ${account.id} 类型无效`);
  money(account.openingBalanceMinor, `账户 ${account.id} 金额`);
  if (account.kind === 'liability' && account.openingBalanceMinor < 0) fail(`账户 ${account.id} 欠款不能为负数`);
  if (typeof account.includeInTotal !== 'boolean') fail(`账户 ${account.id} 总额设置无效`);
  if (hasOwn(account, 'balanceMinor')) money(account.balanceMinor, `账户 ${account.id} 余额`);
  if (account.photoDataUrl != null) fail(`账户 ${account.id} 媒体必须清除`);
  const result = {
    id:account.id, householdId, name:account.name, kind:account.kind,
    subtype:account.subtype ?? (account.kind === 'liability' ? 'generic_liability' : 'asset'),
    openingBalanceMinor:account.openingBalanceMinor, includeInTotal:account.includeInTotal,
    photoDataUrl:null, archivedAt:account.archivedAt == null ? null : date(account.archivedAt, `账户 ${account.id} 归档日期`),
    creditLimitMinor:account.creditLimitMinor ?? null, statementDay:account.statementDay ?? null, dueDay:account.dueDay ?? null,
    loanType:account.loanType ?? null, loanCalculationMode:account.loanCalculationMode ?? null,
    annualInterestRateBps:account.annualInterestRateBps ?? null, originalPrincipalMinor:account.originalPrincipalMinor ?? null,
    scheduledPaymentMinor:account.scheduledPaymentMinor ?? null,
    expectedPayoffDate:account.expectedPayoffDate == null ? null : calendarDate(account.expectedPayoffDate, `账户 ${account.id} 预计还清日期`)
  };
  try { createAccount(createLedger(), result); }
  catch (error) { fail(`账户 ${account.id} 合同无效：${error.message}`); }
  return result;
}

const TRANSACTION_KEYS = [
  'id', 'operationId', 'kind', 'accountId', 'targetAccountId', 'amountMinor', 'principalMinor', 'interestMinor',
  'category', 'note', 'occurredAt', 'createdAt', 'deletedAt', 'purgedAt', 'lastOperationId',
  'sourceType', 'sourceItemId', 'sourcePaymentId'
];
function normaliseTransaction(raw, householdId, ownerUid, accountsById, schemaVersion) {
  const allowed = schemaVersion === 2 ? [...TRANSACTION_KEYS, 'householdId', 'actorUid'] : TRANSACTION_KEYS;
  const entry = exactKeys(raw, '账目', allowed, ['id', 'kind', 'amountMinor', 'occurredAt']);
  safeId(entry.id, '账目 ID');
  if (!['income', 'expense', 'transfer', 'repayment'].includes(entry.kind)) fail(`账目 ${entry.id} 类型无效`);
  money(entry.amountMinor, `账目 ${entry.id} 金额`, { positive:true });
  const source = entry.accountId == null ? null : accountsById.get(entry.accountId);
  const target = entry.targetAccountId == null ? null : accountsById.get(entry.targetAccountId);
  if (entry.kind !== 'repayment' && !source) fail(`账目 ${entry.id} 引用不存在账户`);
  if (entry.kind === 'income' && source.kind !== 'asset') fail(`账目 ${entry.id} 收入账户无效`);
  if (entry.kind === 'expense' && source.kind === 'liability' && source.subtype === 'loan') fail(`账目 ${entry.id} 贷款账户不可直接消费`);
  if (entry.kind === 'transfer' && (!target || source.kind !== 'asset' || target.kind !== 'asset' || source.id === target.id)) fail(`转账 ${entry.id} 账户引用无效`);
  let principalMinor = null;
  let interestMinor = null;
  if (entry.kind === 'repayment') {
    if (!target || target.kind !== 'liability' || (source && source.kind !== 'asset')) fail(`还款 ${entry.id} 账户引用无效`);
    principalMinor = money(entry.principalMinor, `还款 ${entry.id} 本金`, { nonNegative:true });
    interestMinor = money(entry.interestMinor, `还款 ${entry.id} 利息`, { nonNegative:true });
    const splitValid = target.subtype === 'loan'
      ? principalMinor + interestMinor === entry.amountMinor
      : principalMinor === entry.amountMinor && interestMinor === 0;
    if (!splitValid) fail(`还款 ${entry.id} 拆分无效`);
  } else if ((hasOwn(entry, 'principalMinor') && entry.principalMinor != null) || (hasOwn(entry, 'interestMinor') && entry.interestMinor != null)) {
    fail(`账目 ${entry.id} 不应包含还款拆分`);
  }
  const sourceKeys = ['sourceType', 'sourceItemId', 'sourcePaymentId'];
  const sourceCount = sourceKeys.filter(key => hasOwn(entry, key)).length;
  if (sourceCount !== 0 && sourceCount !== sourceKeys.length) fail(`账目 ${entry.id} 物品付款来源字段不完整`);
  const operationId = safeId(entry.operationId ?? entry.id, `账目 ${entry.id} operationId`);
  const result = {
    id:entry.id, householdId, operationId, actorUid:ownerUid, kind:entry.kind,
    accountId:source?.id ?? null, targetAccountId:target?.id ?? null, amountMinor:entry.amountMinor,
    principalMinor, interestMinor,
    category:entry.category == null ? null : string(entry.category, `账目 ${entry.id} 分类`, 200),
    note:string(entry.note ?? '', `账目 ${entry.id} 备注`, 2000),
    occurredAt:date(entry.occurredAt, `账目 ${entry.id} 日期`), createdAt:date(entry.createdAt ?? entry.occurredAt, `账目 ${entry.id} 创建日期`),
    deletedAt:date(entry.deletedAt, `账目 ${entry.id} 删除日期`, true), purgedAt:date(entry.purgedAt, `账目 ${entry.id} 永久删除日期`, true),
    lastOperationId:safeId(entry.lastOperationId ?? operationId, `账目 ${entry.id} lastOperationId`)
  };
  if (sourceCount === sourceKeys.length) {
    result.sourceType = string(entry.sourceType, `账目 ${entry.id} sourceType`, 50, { empty:false });
    result.sourceItemId = safeId(entry.sourceItemId, `账目 ${entry.id} sourceItemId`);
    result.sourcePaymentId = safeId(entry.sourcePaymentId, `账目 ${entry.id} sourcePaymentId`);
  }
  return result;
}

const PAYMENT_KEYS = [
  'id', 'paymentId', 'itemId', 'type', 'amountMinor', 'amountSen', 'occurredAt', 'note', 'receiptMediaId',
  'ledgerMode', 'mode', 'linkMode', 'accountId', 'transactionId', 'status', 'createdAt', 'updatedAt', 'voidedAt',
  'operationId', 'lastOperationId', 'lifecycle'
];
function normalisePayment(raw, householdId, ownerUid, itemIds, accountIds, schemaVersion) {
  const legacy = ['householdId', 'actorUid', 'createdByUid', 'updatedByUid', 'createdBy', 'updatedBy'];
  const payment = exactKeys(raw, '付款', schemaVersion === 2 ? [...PAYMENT_KEYS, ...legacy] : PAYMENT_KEYS, ['itemId']);
  const paymentId = payment.id ?? payment.paymentId;
  safeId(paymentId, '付款 ID');
  if (hasOwn(payment, 'id') && hasOwn(payment, 'paymentId') && payment.id !== payment.paymentId) fail(`付款 ${paymentId} ID 不一致`);
  if (!itemIds.has(payment.itemId)) fail(`付款 ${paymentId} 引用不存在物品`);
  const amountMinor = payment.amountMinor ?? payment.amountSen;
  money(amountMinor, `付款 ${paymentId} 金额`, { positive:true });
  const ledgerMode = payment.ledgerMode ?? payment.mode ?? payment.linkMode ?? 'independent';
  if (!['linked', 'independent'].includes(ledgerMode)) fail(`付款 ${paymentId} 联动模式无效`);
  const type = payment.type ?? 'payment';
  if (!['deposit', 'payment'].includes(type)) fail(`付款 ${paymentId} 类型无效`);
  const expectedTransactionId = ledgerMode === 'linked' ? `item-payment-${paymentId}` : null;
  if (ledgerMode === 'linked' && !accountIds.has(payment.accountId)) fail(`付款 ${paymentId} 引用不存在账户`);
  if (hasOwn(payment, 'transactionId') && payment.transactionId !== expectedTransactionId) fail(`付款 ${paymentId} transactionId 无效`);
  if (ledgerMode === 'independent' && payment.accountId != null) fail(`独立付款 ${paymentId} 不应引用账户`);
  if (schemaVersion >= 3 && payment.receiptMediaId != null) fail(`付款 ${paymentId} 媒体必须清除`);
  const createdAt = date(payment.createdAt ?? payment.occurredAt, `付款 ${paymentId} 创建日期`);
  const voidedAt = date(payment.voidedAt, `付款 ${paymentId} 作废日期`, true);
  const status = payment.status ?? (voidedAt ? 'voided' : 'active');
  if (!['active', 'voided'].includes(status) || ((status === 'voided') !== (voidedAt != null))) fail(`付款 ${paymentId} 状态无效`);
  return {
    id:paymentId, householdId, itemId:payment.itemId, type, amountMinor,
    occurredAt:date(payment.occurredAt ?? createdAt, `付款 ${paymentId} 日期`), note:string(payment.note ?? '', `付款 ${paymentId} 备注`, 2000),
    receiptMediaId:null, ledgerMode, accountId:ledgerMode === 'linked' ? payment.accountId : null,
    transactionId:expectedTransactionId, status, actorUid:ownerUid, createdAt,
    updatedByUid:ownerUid, updatedAt:date(payment.updatedAt ?? createdAt, `付款 ${paymentId} 更新日期`),
    voidedAt, lastOperationId:safeId(payment.lastOperationId ?? payment.operationId ?? `restore-payment:${paymentId}`, `付款 ${paymentId} operationId`)
  };
}

const ITEM_KEYS = [
  'id', 'name', 'note', 'fullPriceMinor', 'fullPriceSen', 'paidMinor', 'status', 'coverMediaId', 'createdAt', 'updatedAt',
  'archivedAt', 'revision', 'lastOperationId', 'lastPaymentId', 'etaDate', 'deletedAt', 'lifecycle'
];
function latestPaymentId(payments) {
  return [...payments].sort((a, b) => (a.updatedAt || a.createdAt).localeCompare(b.updatedAt || b.createdAt) || a.id.localeCompare(b.id)).at(-1)?.id ?? null;
}
function normaliseItem(raw, householdId, ownerUid, payments, schemaVersion) {
  const legacy = ['householdId', 'createdByUid', 'updatedByUid', 'deletedByUid', 'createdBy', 'updatedBy', 'deletedBy', 'balanceMinor', 'progress', 'payments', 'timeline'];
  const item = exactKeys(raw, '物品', schemaVersion === 2 ? [...ITEM_KEYS, ...legacy] : ITEM_KEYS, ['id', 'name']);
  if (schemaVersion === 2 && hasOwn(item, 'payments')) array(item.payments, `物品 ${item.id} 派生付款`);
  if (schemaVersion === 2 && hasOwn(item, 'timeline')) array(item.timeline, `物品 ${item.id} 派生时间线`);
  safeId(item.id, '物品 ID');
  string(item.name, `物品 ${item.id} 名称`, 200, { empty:false });
  const fullPriceMinor = item.fullPriceMinor ?? item.fullPriceSen;
  money(fullPriceMinor, `物品 ${item.id} 全价`, { positive:true });
  if (schemaVersion >= 3 && item.coverMediaId != null) fail(`物品 ${item.id} 媒体必须清除`);
  const ownPayments = payments.filter(payment => payment.itemId === item.id);
  const paidMinor = ownPayments.filter(payment => payment.status === 'active').reduce((sum, payment) => sum + payment.amountMinor, 0);
  if (!Number.isSafeInteger(paidMinor) || paidMinor > fullPriceMinor) fail(`物品 ${item.id} 付款合计无效`);
  if (hasOwn(item, 'paidMinor') && item.paidMinor !== paidMinor) fail(`物品 ${item.id} 已付金额与付款不一致`);
  const balanceMinor = fullPriceMinor - paidMinor;
  const progress = Math.min(100, Math.round((paidMinor / fullPriceMinor) * 100));
  if (hasOwn(item, 'balanceMinor') && item.balanceMinor !== balanceMinor) fail(`物品 ${item.id} 待付金额与付款不一致`);
  if (hasOwn(item, 'progress') && (!Number.isSafeInteger(item.progress) || item.progress !== progress)) fail(`物品 ${item.id} 进度与付款不一致`);
  const createdAt = date(item.createdAt ?? '1970-01-01T00:00:00.000Z', `物品 ${item.id} 创建日期`);
  const archivedAt = date(item.archivedAt, `物品 ${item.id} 归档日期`, true);
  const deletedAt = date(item.deletedAt, `物品 ${item.id} 删除日期`, true);
  if (archivedAt && deletedAt) fail(`物品 ${item.id} 不能同时归档和删除`);
  const status = archivedAt ? 'archived' : paidMinor === fullPriceMinor ? 'completed' : 'active';
  if (hasOwn(item, 'status') && item.status !== status) fail(`物品 ${item.id} 状态与付款不一致`);
  const expectedLastPaymentId = latestPaymentId(ownPayments);
  if (hasOwn(item, 'lastPaymentId') && (item.lastPaymentId ?? null) !== expectedLastPaymentId) fail(`物品 ${item.id} lastPaymentId 引用无效`);
  return {
    id:item.id, householdId, name:item.name, note:string(item.note ?? '', `物品 ${item.id} 备注`, 2000),
    fullPriceMinor, paidMinor, status, coverMediaId:null, createdByUid:ownerUid, createdAt, updatedByUid:ownerUid,
    updatedAt:date(item.updatedAt ?? createdAt, `物品 ${item.id} 更新日期`), archivedAt,
    revision:Number.isSafeInteger(item.revision) && item.revision > 0 ? item.revision : 1,
    lastOperationId:safeId(item.lastOperationId ?? `restore-item:${item.id}`, `物品 ${item.id} operationId`),
    lastPaymentId:expectedLastPaymentId,
    etaDate:item.etaDate == null ? null : calendarDate(item.etaDate, `物品 ${item.id} ETA`),
    deletedAt, deletedByUid:deletedAt ? ownerUid : null
  };
}

function validateLinkedIntegrity(transactions, payments) {
  const transactionsById = new Map(transactions.map(entry => [entry.id, entry]));
  const paymentsById = new Map(payments.map(payment => [payment.id, payment]));
  for (const payment of payments) {
    if (payment.ledgerMode !== 'linked') continue;
    const entry = transactionsById.get(payment.transactionId);
    if (!entry) fail(`联动付款 ${payment.id} 缺少确定性账目`);
    const matches = entry.id === `item-payment-${payment.id}`
      && entry.sourceType === 'itemPayment'
      && entry.sourceItemId === payment.itemId
      && entry.sourcePaymentId === payment.id
      && entry.kind === 'expense'
      && entry.accountId === payment.accountId
      && entry.targetAccountId === null
      && entry.amountMinor === payment.amountMinor
      && entry.category === '购物'
      && entry.note === payment.note
      && entry.occurredAt === payment.occurredAt
      && entry.createdAt === payment.createdAt
      && entry.actorUid === payment.actorUid
      && entry.deletedAt === payment.voidedAt
      && entry.purgedAt === null
      && entry.lastOperationId === payment.lastOperationId;
    if (!matches) fail(`联动付款 ${payment.id} 与确定性账目不一致`);
  }
  for (const entry of transactions) {
    if (!hasOwn(entry, 'sourceType')) continue;
    if (entry.sourceType !== 'itemPayment') fail(`账目 ${entry.id} 来源类型无效`);
    const payment = paymentsById.get(entry.sourcePaymentId);
    if (!payment || payment.ledgerMode !== 'linked' || payment.transactionId !== entry.id) fail(`物品付款账目 ${entry.id} 缺少对应付款`);
  }
}

function bodyWithoutManifest(payload) {
  const { manifest:unused, ...body } = payload;
  return body;
}
function parsePayload(input) {
  if (typeof input !== 'string') return clone(input);
  try { return JSON.parse(input); }
  catch { fail('JSON 文件已损坏'); }
}
function validateManifest(payload, expectedCounts) {
  // Unknown manifest metadata is intentionally forward-compatible. The
  // security-sensitive payload body remains exact-key validated below.
  const manifest = object(payload.manifest, 'manifest');
  for (const required of ['format', 'checksumAlgorithm', 'checksum', 'counts', 'mediaIncluded']) {
    if (!hasOwn(manifest, required)) fail(`manifest缺少字段 ${required}`);
  }
  if (manifest.format !== 'family-wallet-backup') fail('备份 manifest 格式无效');
  if (manifest.checksumAlgorithm !== 'SHA-256' || typeof manifest.checksum !== 'string' || !CHECKSUM.test(manifest.checksum)) fail('备份 checksum 无效');
  if (manifest.mediaIncluded !== false) fail('备份不得包含媒体');
  exactKeys(manifest.counts, 'manifest counts', ['accounts', 'transactions', 'items', 'itemPayments'], ['accounts', 'transactions', 'items', 'itemPayments']);
  if (Object.entries(expectedCounts).some(([key, count]) => !Number.isSafeInteger(manifest.counts[key]) || manifest.counts[key] !== count)) fail('备份 manifest 数量不一致');
  return manifest;
}

export async function validateBackup(input, { destinationHouseholdId = 'restore-preview', ownerUid = 'restore-owner', byteLength } = {}) {
  if (byteLength != null && (!Number.isSafeInteger(byteLength) || byteLength <= 0 || byteLength > MAX_BACKUP_BYTES)) fail('备份文件大小无效或超过 5MB');
  const measured = new TextEncoder().encode(typeof input === 'string' ? input : JSON.stringify(input)).byteLength;
  if (measured <= 0 || measured > MAX_BACKUP_BYTES) fail('备份文件大小无效或超过 5MB');
  const payload = parsePayload(input);
  assertJsonValue(payload);
  object(payload, '备份');
  if (![2, BACKUP_SCHEMA_VERSION].includes(payload.schemaVersion)) fail(`不支持 schemaVersion ${payload.schemaVersion ?? '未知'}`);
  const topKeys = payload.schemaVersion === 3
    ? ['schemaVersion', 'exportedAt', 'household', 'ledger', 'items', 'itemPayments', 'manifest']
    : ['schemaVersion', 'exportedAt', 'household', 'ledger', 'items', 'itemPayments'];
  scanForbidden(payload, payload.schemaVersion);
  exactKeys(payload, '备份', topKeys, ['schemaVersion', 'ledger']);
  safeId(destinationHouseholdId, '目的家庭 ID');
  safeId(ownerUid, '恢复 owner UID');
  if (payload.exportedAt != null) date(payload.exportedAt, '导出日期');
  if (payload.household != null) {
    exactKeys(payload.household, '家庭资料', payload.schemaVersion === 2 ? ['id', 'name'] : ['name']);
    string(payload.household.name, '账本名称', 200, { empty:false });
  }
  const ledgerInput = exactKeys(payload.ledger, '账本', ['accounts', 'transactions', 'appliedOperationIds'], ['accounts', 'transactions']);
  const accountsInput = array(ledgerInput.accounts, '账户');
  const transactionsInput = array(ledgerInput.transactions, '账目');
  const itemsInput = array(payload.items ?? [], '物品');
  const paymentsInput = array(payload.itemPayments ?? [], '付款');
  unique(accountsInput, '账户'); unique(transactionsInput, '账目'); unique(itemsInput, '物品');
  const paymentIds = new Set();
  for (const payment of paymentsInput) {
    const id = safeId(payment?.id ?? payment?.paymentId, '付款 ID');
    if (paymentIds.has(id)) fail(`付款 ID 重复：${id}`);
    paymentIds.add(id);
  }
  const appliedOperationIds = ledgerInput.appliedOperationIds == null ? [] : array(ledgerInput.appliedOperationIds, 'operation IDs');
  uniqueIds(appliedOperationIds, 'operationId');
  const accounts = accountsInput.map(record => normaliseAccount(record, destinationHouseholdId, payload.schemaVersion));
  const accountsById = new Map(accounts.map(record => [record.id, record]));
  const transactions = transactionsInput.map(record => normaliseTransaction(record, destinationHouseholdId, ownerUid, accountsById, payload.schemaVersion));
  const itemIds = new Set(itemsInput.map(record => record.id));
  const payments = paymentsInput.map(record => normalisePayment(record, destinationHouseholdId, ownerUid, itemIds, accountsById, payload.schemaVersion));
  validateLinkedIntegrity(transactions, payments);
  const items = itemsInput.map(record => normaliseItem(record, destinationHouseholdId, ownerUid, payments, payload.schemaVersion));
  const ledger = deriveLedger({ accounts, transactions, appliedOperationIds });
  const check = reconcile(ledger);
  if (!check.ok) fail(`账本对账失败：${check.integrityIssues?.[0]?.reason ?? '余额不一致'}`);
  for (let index = 0; index < accountsInput.length; index += 1) {
    if (hasOwn(accountsInput[index], 'balanceMinor') && accountsInput[index].balanceMinor !== ledger.accounts[index].balanceMinor) {
      fail(`账户 ${accountsInput[index].id} 余额与账目不一致`);
    }
  }
  const expectedCounts = { accounts:accounts.length, transactions:transactions.length, items:items.length, itemPayments:payments.length };
  let checksum = await sha256(bodyWithoutManifest(payload));
  if (payload.schemaVersion === 3) {
    const manifest = validateManifest(payload, expectedCounts);
    if (checksum !== manifest.checksum) fail('备份 checksum 不一致');
    checksum = manifest.checksum;
  }
  const itemsState = createItemsState({
    items:items.map(item => ({
      id:item.id, name:item.name, note:item.note, fullPriceMinor:item.fullPriceMinor, etaDate:item.etaDate,
      coverMediaId:null, createdBy:ownerUid, createdAt:item.createdAt, updatedBy:ownerUid, updatedAt:item.updatedAt,
      archivedAt:item.archivedAt, deletedAt:item.deletedAt, deletedBy:item.deletedByUid, status:item.status, revision:item.revision,
      lastOperationId:item.lastOperationId, lifecycle:[]
    })),
    itemPayments:payments.map(payment => ({
      id:payment.id, paymentId:payment.id, itemId:payment.itemId, type:payment.type, amountMinor:payment.amountMinor,
      occurredAt:payment.occurredAt, note:payment.note, receiptMediaId:null, mode:payment.ledgerMode, ledgerMode:payment.ledgerMode,
      accountId:payment.accountId, transactionId:payment.transactionId, status:payment.status, createdBy:ownerUid,
      createdAt:payment.createdAt, updatedBy:ownerUid, updatedAt:payment.updatedAt, voidedAt:payment.voidedAt,
      operationId:payment.lastOperationId, lastOperationId:payment.lastOperationId, lifecycle:[]
    })), revision:1, appliedOperationIds:[]
  });
  return {
    schemaVersion:payload.schemaVersion,
    checksum,
    sourceName:string(payload.household?.name ?? '家庭账本', '账本名称', 200, { empty:false }),
    counts:expectedCounts,
    mediaCleared:true,
    accounts, transactions, items, itemPayments:payments,
    local:{ ledger:serialiseLedger(ledger), items:serialiseItemsState(itemsState), itemMedia:[] }
  };
}

export async function deterministicImportIdentity(payload, ownerUid) {
  const checksum = await sha256(bodyWithoutManifest(payload));
  if (payload?.schemaVersion === 3 && payload?.manifest?.checksum !== checksum) fail('备份 checksum 不一致');
  const ownerHash = await sha256(String(ownerUid));
  return { checksum, operationId:`restore:${checksum}`, householdId:`restored-${ownerHash.slice(0, 16)}-${checksum.slice(0, 24)}` };
}

function importUnits(validated) {
  const linkedPaymentIds = new Set(validated.itemPayments.filter(payment => payment.ledgerMode === 'linked').map(payment => payment.id));
  const linkedTransactions = new Map(validated.transactions
    .filter(entry => entry.sourceType === 'itemPayment')
    .map(entry => [entry.sourcePaymentId, entry]));
  const units = [
    ...validated.accounts.map(data => [{ collection:'accounts', id:data.id, data }]),
    ...validated.items.map(data => [{ collection:'items', id:data.id, data }]),
    ...validated.itemPayments.filter(data => !linkedPaymentIds.has(data.id)).map(data => [{ collection:'itemPayments', id:data.id, data }]),
    ...validated.transactions.filter(data => data.sourceType !== 'itemPayment').map(data => [{ collection:'transactions', id:data.id, data }]),
    ...validated.itemPayments.filter(data => linkedPaymentIds.has(data.id)).map(data => {
      const transaction = linkedTransactions.get(data.id);
      if (!transaction) fail(`联动付款 ${data.id} 缺少确定性账目`);
      return [
        { collection:'itemPayments', id:data.id, data },
        { collection:'transactions', id:transaction.id, data:transaction }
      ];
    })
  ];
  return units;
}

export function chunkImportRecords(validated, size = FIRESTORE_IMPORT_BATCH_SIZE) {
  if (!Number.isInteger(size) || size < 1 || size >= 500) fail('Firestore batch size 必须低于 500');
  const chunks = [];
  let current = [];
  for (const unit of importUnits(validated)) {
    if (unit.length >= 500 || unit.length > size) fail('单一恢复记录组超过 Firestore batch 上限');
    if (current.length + unit.length > size) {
      chunks.push(current);
      current = [];
    }
    current.push(...unit);
  }
  if (current.length) chunks.push(current);
  return chunks;
}

export async function replaceLocalAtomically({ storage, storeKey, validated, downloadCurrent }) {
  const before = storage.getItem(storeKey);
  await downloadCurrent?.();
  const next = JSON.stringify({ schemaVersion:2, ledger:validated.local.ledger, items:validated.local.items, itemMedia:[] });
  try { storage.setItem(storeKey, next); }
  catch (error) {
    try { if (before == null) storage.removeItem(storeKey); else storage.setItem(storeKey, before); } catch {}
    throw error;
  }
  return { previous:before, current:next };
}
