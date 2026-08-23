const ITEM_STATUSES = new Set(['active', 'completed', 'archived']);
const PAYMENT_TYPES = new Set(['deposit', 'payment']);
const PAYMENT_MODES = new Set(['linked', 'independent']);
const ITEM_FINGERPRINT_BOOKKEEPING_FIELDS = new Set([
  'id', 'name', 'fullPriceMinor', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy',
  'actor', 'actorId', 'status', 'archivedAt', 'archivedBy', 'restoredAt', 'restoredBy', 'lifecycle'
]);

const clone = value => structuredClone(value);
const nowIso = value => value ?? new Date().toISOString();
const nonEmptyId = (value, label) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} 必填`);
  return value.trim();
};
const positiveMoney = (value, label = '金额') => {
  if (!Number.isSafeInteger(value)) throw new Error(`${label}必须是安全整数 sen`);
  if (value <= 0) throw new Error(`${label}必须大于零`);
  return value;
};
const operationInput = value => typeof value === 'string' ? { operationId: value } : (value ?? {});
const actorOf = input => input.actor ?? input.actorId ?? input.updatedBy ?? input.createdBy ?? null;
const normaliseMode = input => input.mode ?? input.linkMode ?? input.ledgerMode ?? 'independent';
const normalisePaymentId = input => input.paymentId ?? input.id;
const normaliseFullPrice = input => input.fullPriceMinor ?? input.fullPriceSen;
const normaliseAmount = input => input.amountMinor ?? input.amountSen;

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
  }
  return value;
}

const fingerprint = value => JSON.stringify(stableValue(value));
const itemById = (state, itemId) => state.items.find(item => item.id === itemId);
const paymentById = (state, paymentId) => state.itemPayments.find(payment => payment.id === paymentId);
const activePaymentsFor = (state, itemId) => state.itemPayments.filter(payment => payment.itemId === itemId && !payment.voidedAt);
const paidMinorFor = (state, itemId) => activePaymentsFor(state, itemId).reduce((sum, payment) => sum + payment.amountMinor, 0);

function requireItem(state, itemId) {
  const item = itemById(state, itemId);
  if (!item) throw new Error('物品不存在');
  return item;
}

function requireMutableItem(state, itemId) {
  const item = requireItem(state, itemId);
  if (item.status === 'archived' || item.archivedAt) throw new Error('已归档物品必须先恢复才能修改');
  return item;
}

function assertExpectedRevision(state, expectedRevision) {
  if (expectedRevision !== undefined && expectedRevision !== state.revision) {
    const error = new Error(`版本冲突：期望 revision ${expectedRevision}，当前为 ${state.revision}`);
    error.code = 'REVISION_CONFLICT';
    error.expectedRevision = expectedRevision;
    error.actualRevision = state.revision;
    throw error;
  }
}

function operationRecord(state, operationId) {
  return state.appliedOperations.find(operation => operation.id === operationId);
}

function checkDuplicate(state, operationId, signature) {
  const existing = operationRecord(state, operationId);
  if (!existing) return false;
  if (existing.signature && existing.signature !== signature) throw new Error('operationId 已用于不同操作，存在冲突');
  return true;
}

function rememberOperation(state, operationId, kind, entityId, signature) {
  state.appliedOperationIds.add(operationId);
  state.appliedOperations.push({ id: operationId, kind, entityId, signature });
}

function asItemsState(state) {
  return state?.appliedOperationIds instanceof Set && Array.isArray(state.items) && Array.isArray(state.itemPayments)
    ? state
    : hydrateItemsState(state);
}

function nextState(state) {
  return hydrateItemsState(serialiseItemsState(state));
}

function mutationResult(state, extra = {}) {
  return { state, model: state, duplicate: false, ...extra };
}

function duplicateResult(state, extra = {}) {
  return { state, model: state, duplicate: true, ...extra };
}

function refreshItemStatus(state, item) {
  if (item.archivedAt) item.status = 'archived';
  else item.status = paidMinorFor(state, item.id) === item.fullPriceMinor ? 'completed' : 'active';
}

function normaliseItem(raw, index) {
  const item = clone(raw);
  item.id = nonEmptyId(item.id, '物品 ID');
  item.fullPriceMinor = positiveMoney(normaliseFullPrice(item), '物品全价');
  item.createdAt = item.createdAt ?? new Date(index).toISOString();
  item.status = ITEM_STATUSES.has(item.status) ? item.status : (item.archivedAt ? 'archived' : 'active');
  item.archivedAt = item.archivedAt ?? (item.status === 'archived' ? item.updatedAt ?? item.createdAt : null);
  item.createdBy = item.createdBy ?? item.actor ?? null;
  item.updatedAt = item.updatedAt ?? item.createdAt;
  item.updatedBy = item.updatedBy ?? item.createdBy;
  item.lifecycle = Array.isArray(item.lifecycle) ? clone(item.lifecycle) : [];
  return item;
}

function normalisePayment(raw, index) {
  const payment = clone(raw);
  payment.id = nonEmptyId(normalisePaymentId(payment), 'paymentId');
  payment.paymentId = payment.id;
  payment.itemId = nonEmptyId(payment.itemId, '物品 ID');
  payment.type = payment.type ?? 'payment';
  if (!PAYMENT_TYPES.has(payment.type)) throw new Error('付款类型必须是 deposit 或 payment');
  payment.mode = normaliseMode(payment);
  if (!PAYMENT_MODES.has(payment.mode)) throw new Error('付款模式必须是 linked 或 independent');
  payment.amountMinor = positiveMoney(normaliseAmount(payment), '付款金额');
  payment.operationId = nonEmptyId(payment.operationId ?? `legacy-payment-${payment.id}`, 'operationId');
  payment.occurredAt = payment.occurredAt ?? payment.createdAt ?? new Date(index).toISOString();
  payment.createdAt = payment.createdAt ?? payment.occurredAt;
  payment.createdBy = payment.createdBy ?? payment.actor ?? null;
  payment.status = payment.status === 'voided' || payment.voidedAt ? 'voided' : 'active';
  payment.voidedAt = payment.voidedAt ?? (payment.status === 'voided' ? payment.updatedAt ?? payment.createdAt : null);
  payment.voidedBy = payment.voidedBy ?? null;
  payment.restoredAt = payment.restoredAt ?? null;
  payment.restoredBy = payment.restoredBy ?? null;
  payment.lifecycle = Array.isArray(payment.lifecycle) ? clone(payment.lifecycle) : [];
  if (payment.mode === 'linked') payment.transactionId = `item-payment-${payment.id}`;
  else payment.transactionId = null;
  return payment;
}

/** Hydrates persisted or legacy empty item state into the in-memory domain model. */
export function hydrateItemsState(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const items = (Array.isArray(source.items) ? source.items : []).map(normaliseItem);
  const itemPayments = (Array.isArray(source.itemPayments) ? source.itemPayments : []).map(normalisePayment);
  if (new Set(items.map(item => item.id)).size !== items.length) throw new Error('物品 ID 冲突');
  if (new Set(itemPayments.map(payment => payment.id)).size !== itemPayments.length) throw new Error('paymentId 冲突');
  const itemIds = new Set(items.map(item => item.id));
  for (const payment of itemPayments) if (!itemIds.has(payment.itemId)) throw new Error('付款引用的物品不存在');

  const legacyOperationIds = source.appliedOperationIds instanceof Set
    ? [...source.appliedOperationIds]
    : (Array.isArray(source.appliedOperationIds) ? source.appliedOperationIds : []);
  const appliedOperations = Array.isArray(source.appliedOperations) ? clone(source.appliedOperations) : [];
  const recordedIds = new Set(appliedOperations.map(operation => operation.id));
  for (const id of legacyOperationIds) {
    if (!recordedIds.has(id)) appliedOperations.push({ id, kind: 'legacy', entityId: null, signature: null });
  }
  for (const payment of itemPayments) {
    if (!appliedOperations.some(operation => operation.id === payment.operationId)) {
      appliedOperations.push({ id: payment.operationId, kind: 'recordPayment', entityId: payment.id, signature: null });
    }
  }

  const state = {
    items,
    itemPayments,
    revision: Number.isSafeInteger(source.revision) && source.revision >= 0 ? source.revision : 0,
    appliedOperationIds: new Set(appliedOperations.map(operation => operation.id)),
    appliedOperations
  };
  for (const item of state.items) {
    const paidMinor = paidMinorFor(state, item.id);
    if (paidMinor > item.fullPriceMinor) throw new Error('已付总额不能超过物品全价');
    refreshItemStatus(state, item);
  }
  return state;
}

export function createItemsState(initial = {}) {
  return hydrateItemsState(initial);
}

/** Produces JSON/Firestore-safe data while retaining idempotency records. */
export function serialiseItemsState(state) {
  const hydrated = state?.appliedOperationIds instanceof Set ? state : hydrateItemsState(state);
  return {
    items: clone(hydrated.items),
    itemPayments: clone(hydrated.itemPayments),
    revision: hydrated.revision,
    appliedOperationIds: [...hydrated.appliedOperationIds],
    appliedOperations: clone(hydrated.appliedOperations)
  };
}

export const serializeItemsState = serialiseItemsState;

export function createItem(state, input, options = {}) {
  const current = asItemsState(state);
  const merged = { ...input, ...options };
  const itemId = nonEmptyId(input?.id, '物品 ID');
  const operationId = nonEmptyId(merged.operationId ?? `item-create-${itemId}`, 'operationId');
  const fullPriceMinor = positiveMoney(normaliseFullPrice(input), '物品全价');
  const name = String(input?.name ?? '').trim();
  if (!name) throw new Error('物品名称必填');
  const reserved = new Set([
    'deposit', 'depositMinor', 'depositPaymentId', 'depositOperationId', 'depositMode', 'depositAccountId',
    'operationId', 'expectedRevision', 'fullPriceSen', 'status', 'archivedAt', 'lifecycle'
  ]);
  const metadata = Object.fromEntries(Object.entries(input).filter(([key]) => !reserved.has(key)));
  const signatureMetadata = Object.fromEntries(
    Object.entries(metadata).filter(([key]) => !ITEM_FINGERPRINT_BOOKKEEPING_FIELDS.has(key))
  );
  const deposit = input.deposit ?? (input.depositMinor !== undefined ? {
    paymentId: input.depositPaymentId,
    operationId: input.depositOperationId,
    amountMinor: input.depositMinor,
    mode: input.depositMode,
    accountId: input.depositAccountId,
    occurredAt: input.depositOccurredAt
  } : null);
  const depositMode = deposit ? normaliseMode(deposit) : null;
  const signatureDeposit = deposit ? {
    paymentId: normalisePaymentId(deposit) ?? null,
    operationId: deposit.operationId ?? null,
    amountMinor: normaliseAmount(deposit) ?? null,
    mode: depositMode,
    accountId: depositMode === 'linked' ? deposit.accountId ?? null : null,
    occurredAt: deposit.occurredAt ?? null,
    note: deposit.note ?? null,
    receiptMediaId: deposit.receiptMediaId ?? null
  } : null;
  const signature = fingerprint({
    kind: 'createItem', itemId, name, fullPriceMinor, metadata: signatureMetadata, deposit: signatureDeposit
  });
  if (checkDuplicate(current, operationId, signature)) {
    const existing = itemById(current, itemId);
    if (!existing) throw new Error('幂等记录存在但物品不存在');
    return duplicateResult(current, { item: existing, expenseSpec: null, linkedExpenseSpecs: [] });
  }
  assertExpectedRevision(current, merged.expectedRevision);
  if (itemById(current, itemId)) throw new Error('物品 ID 已存在');
  const createdAt = nowIso(merged.createdAt);
  const actor = actorOf(merged);
  const next = nextState(current);
  const item = {
    ...metadata,
    id: itemId,
    name,
    fullPriceMinor,
    status: 'active',
    createdAt,
    createdBy: merged.createdBy ?? actor,
    updatedAt: createdAt,
    updatedBy: merged.createdBy ?? actor,
    archivedAt: null,
    archivedBy: null,
    restoredAt: null,
    restoredBy: null,
    lifecycle: [{ type: 'itemCreated', at: createdAt, actor: merged.createdBy ?? actor, operationId }]
  };
  next.items.push(item);
  next.revision += 1;
  rememberOperation(next, operationId, 'createItem', itemId, signature);

  if (deposit && normaliseAmount(deposit) !== 0) {
    const depositInput = input.deposit ? deposit : { ...deposit, createdAt, actor };
    const deposited = recordItemPayment(next, itemId, { ...depositInput, type: 'deposit' });
    return mutationResult(deposited.state, {
      item: itemById(deposited.state, itemId),
      payment: deposited.payment,
      expenseSpec: deposited.expenseSpec,
      linkedExpenseSpecs: deposited.linkedExpenseSpecs
    });
  }
  return mutationResult(next, { item, expenseSpec: null, linkedExpenseSpecs: [] });
}

export function buildLinkedExpenseSpec(item, payment, action = 'create', operationId = payment.operationId) {
  if (payment.mode !== 'linked') return null;
  return {
    action,
    id: operationId,
    operationId,
    transactionId: `item-payment-${payment.id}`,
    kind: 'expense',
    accountId: payment.accountId,
    amountMinor: payment.amountMinor,
    category: '购物',
    note: payment.note ?? item.name ?? '',
    occurredAt: payment.occurredAt,
    createdAt: payment.createdAt,
    sourceType: 'itemPayment',
    sourceItemId: item.id,
    sourcePaymentId: payment.id
  };
}

export function recordItemPayment(state, itemId, input, options = {}) {
  const current = asItemsState(state);
  const merged = { ...input, ...options };
  const paymentId = nonEmptyId(normalisePaymentId(input ?? {}), 'paymentId');
  const operationId = nonEmptyId(merged.operationId, 'operationId');
  const amountMinor = positiveMoney(normaliseAmount(input ?? {}), '付款金额');
  const type = input?.type ?? 'payment';
  const mode = normaliseMode(input ?? {});
  if (!PAYMENT_TYPES.has(type)) throw new Error('付款类型必须是 deposit 或 payment');
  if (!PAYMENT_MODES.has(mode)) throw new Error('付款模式必须是 linked 或 independent');
  if (mode === 'linked') nonEmptyId(input?.accountId, '联动账户 ID');
  const signature = fingerprint({
    kind: 'recordPayment',
    itemId,
    paymentId,
    amountMinor,
    type,
    mode,
    accountId: mode === 'linked' ? input?.accountId ?? null : null,
    occurredAt: input?.occurredAt ?? null,
    note: input?.note ?? null,
    receiptMediaId: input?.receiptMediaId ?? null
  });
  if (checkDuplicate(current, operationId, signature)) {
    const payment = paymentById(current, paymentId);
    if (!payment || payment.itemId !== itemId) throw new Error('operationId 与 paymentId 冲突');
    const item = requireItem(current, itemId);
    const expenseSpec = buildLinkedExpenseSpec(item, payment);
    return duplicateResult(current, { payment, item: deriveItem(current, itemId), expenseSpec, linkedExpenseSpecs: expenseSpec ? [expenseSpec] : [] });
  }
  assertExpectedRevision(current, merged.expectedRevision);
  const item = requireMutableItem(current, itemId);
  if (paymentById(current, paymentId)) throw new Error('paymentId 已存在，不能用于不同付款');
  const itemPayments = current.itemPayments.filter(payment => payment.itemId === itemId);
  if (type === 'deposit' && itemPayments.length) throw new Error('订金只能是第一笔付款，请恢复或更正原付款');
  const paidMinor = paidMinorFor(current, itemId);
  if (paidMinor + amountMinor > item.fullPriceMinor) throw new Error('付款会超过物品全价');

  const next = nextState(current);
  const nextItem = requireItem(next, itemId);
  const occurredAt = nowIso(input?.occurredAt ?? merged.createdAt);
  const createdAt = nowIso(merged.createdAt ?? occurredAt);
  const actor = actorOf(merged);
  const payment = {
    ...clone(input),
    id: paymentId,
    paymentId,
    itemId,
    type,
    mode,
    accountId: mode === 'linked' ? input.accountId : null,
    amountMinor,
    operationId,
    transactionId: mode === 'linked' ? `item-payment-${paymentId}` : null,
    occurredAt,
    createdAt,
    createdBy: input?.createdBy ?? actor,
    status: 'active',
    voidedAt: null,
    voidedBy: null,
    restoredAt: null,
    restoredBy: null,
    lifecycle: [{ type: 'paymentRecorded', at: createdAt, actor: input?.createdBy ?? actor, operationId }]
  };
  next.itemPayments.push(payment);
  refreshItemStatus(next, nextItem);
  nextItem.updatedAt = createdAt;
  nextItem.updatedBy = input?.createdBy ?? actor;
  next.revision += 1;
  rememberOperation(next, operationId, 'recordPayment', paymentId, signature);
  const expenseSpec = buildLinkedExpenseSpec(nextItem, payment);
  return mutationResult(next, { payment, item: deriveItem(next, itemId), expenseSpec, linkedExpenseSpecs: expenseSpec ? [expenseSpec] : [] });
}

function resolvePaymentMutationArgs(itemOrPaymentId, paymentOrOperation, maybeOperation) {
  if (maybeOperation !== undefined) return { itemId: itemOrPaymentId, paymentId: paymentOrOperation, input: operationInput(maybeOperation) };
  return { itemId: null, paymentId: itemOrPaymentId, input: operationInput(paymentOrOperation) };
}

function mutatePaymentLifecycle(state, action, itemOrPaymentId, paymentOrOperation, maybeOperation) {
  const current = asItemsState(state);
  const { itemId, paymentId: rawPaymentId, input } = resolvePaymentMutationArgs(itemOrPaymentId, paymentOrOperation, maybeOperation);
  const paymentId = nonEmptyId(rawPaymentId, 'paymentId');
  const operationId = nonEmptyId(input.operationId, 'operationId');
  const knownPayment = paymentById(current, paymentId);
  const resolvedItemId = itemId ?? knownPayment?.itemId ?? null;
  const signature = fingerprint({ kind: `${action}Payment`, paymentId, itemId: resolvedItemId });
  if (checkDuplicate(current, operationId, signature)) {
    const payment = paymentById(current, paymentId);
    if (!payment) throw new Error('幂等记录存在但付款不存在');
    const item = requireItem(current, payment.itemId);
    const expenseSpec = buildLinkedExpenseSpec(item, payment, action, operationId);
    return duplicateResult(current, { payment, item: deriveItem(current, item.id), expenseSpec, linkedExpenseSpecs: expenseSpec ? [expenseSpec] : [] });
  }
  assertExpectedRevision(current, input.expectedRevision);
  const existing = paymentById(current, paymentId);
  if (!existing) throw new Error('付款不存在');
  if (itemId && existing.itemId !== itemId) throw new Error('付款不属于指定物品');
  requireMutableItem(current, existing.itemId);
  if (action === 'void' && existing.voidedAt) throw new Error('付款已作废');
  if (action === 'restore' && !existing.voidedAt) throw new Error('付款未作废');
  if (action === 'restore') {
    const item = requireItem(current, existing.itemId);
    if (paidMinorFor(current, item.id) + existing.amountMinor > item.fullPriceMinor) throw new Error('恢复付款会超过物品全价');
  }

  const next = nextState(current);
  const payment = paymentById(next, paymentId);
  const item = requireItem(next, payment.itemId);
  const at = nowIso(input.occurredAt ?? input.updatedAt);
  const actor = actorOf(input);
  if (action === 'void') {
    payment.status = 'voided';
    payment.voidedAt = at;
    payment.voidedBy = actor;
    payment.lifecycle.push({ type: 'paymentVoided', at, actor, operationId });
  } else {
    payment.status = 'active';
    payment.voidedAt = null;
    payment.voidedBy = null;
    payment.restoredAt = at;
    payment.restoredBy = actor;
    payment.lifecycle.push({ type: 'paymentRestored', at, actor, operationId });
  }
  payment.lastOperationId = operationId;
  item.updatedAt = at;
  item.updatedBy = actor;
  refreshItemStatus(next, item);
  next.revision += 1;
  rememberOperation(next, operationId, `${action}Payment`, paymentId, signature);
  const expenseSpec = buildLinkedExpenseSpec(item, payment, action, operationId);
  return mutationResult(next, { payment, item: deriveItem(next, item.id), expenseSpec, linkedExpenseSpecs: expenseSpec ? [expenseSpec] : [] });
}

export function voidItemPayment(state, itemOrPaymentId, paymentOrOperation, maybeOperation) {
  return mutatePaymentLifecycle(state, 'void', itemOrPaymentId, paymentOrOperation, maybeOperation);
}

export function restoreItemPayment(state, itemOrPaymentId, paymentOrOperation, maybeOperation) {
  return mutatePaymentLifecycle(state, 'restore', itemOrPaymentId, paymentOrOperation, maybeOperation);
}

export function archiveItem(state, itemId, operation = {}) {
  const current = asItemsState(state);
  const input = operationInput(operation);
  const operationId = nonEmptyId(input.operationId, 'operationId');
  const signature = fingerprint({ kind: 'archiveItem', itemId });
  if (checkDuplicate(current, operationId, signature)) return duplicateResult(current, { item: requireItem(current, itemId) });
  assertExpectedRevision(current, input.expectedRevision);
  const existing = requireItem(current, itemId);
  if (existing.archivedAt || existing.status === 'archived') throw new Error('物品已归档');
  if (existing.status !== 'completed' || paidMinorFor(current, itemId) !== existing.fullPriceMinor) {
    throw new Error('物品必须结清并完成后才能归档');
  }
  const next = nextState(current);
  const item = requireItem(next, itemId);
  const at = nowIso(input.archivedAt ?? input.occurredAt);
  const actor = actorOf(input);
  item.status = 'archived';
  item.archivedAt = at;
  item.archivedBy = actor;
  item.updatedAt = at;
  item.updatedBy = actor;
  item.lifecycle.push({ type: 'itemArchived', at, actor, operationId });
  next.revision += 1;
  rememberOperation(next, operationId, 'archiveItem', itemId, signature);
  return mutationResult(next, { item });
}

export function restoreItem(state, itemId, operation = {}) {
  const current = asItemsState(state);
  const input = operationInput(operation);
  const operationId = nonEmptyId(input.operationId, 'operationId');
  const signature = fingerprint({ kind: 'restoreItem', itemId });
  if (checkDuplicate(current, operationId, signature)) return duplicateResult(current, { item: requireItem(current, itemId) });
  assertExpectedRevision(current, input.expectedRevision);
  const existing = requireItem(current, itemId);
  if (!existing.archivedAt && existing.status !== 'archived') throw new Error('物品未归档');
  const next = nextState(current);
  const item = requireItem(next, itemId);
  const at = nowIso(input.restoredAt ?? input.occurredAt);
  const actor = actorOf(input);
  item.archivedAt = null;
  item.archivedBy = null;
  item.restoredAt = at;
  item.restoredBy = actor;
  item.updatedAt = at;
  item.updatedBy = actor;
  refreshItemStatus(next, item);
  item.lifecycle.push({ type: 'itemRestored', at, actor, operationId });
  next.revision += 1;
  rememberOperation(next, operationId, 'restoreItem', itemId, signature);
  return mutationResult(next, { item });
}

export function editItem(state, itemId, changes = {}, operation = {}) {
  const current = asItemsState(state);
  const input = { ...changes, ...operationInput(operation) };
  const operationId = nonEmptyId(input.operationId, 'operationId');
  const allowedMetadata = ['name', 'description', 'imageUrl', 'coverMediaId', 'category', 'targetDate', 'note', 'metadata'];
  const changedMetadata = Object.fromEntries(allowedMetadata.filter(key => changes[key] !== undefined).map(key => [key, changes[key]]));
  const requestedPrice = normaliseFullPrice(changes);
  const signature = fingerprint({ kind: 'editItem', itemId, metadata: changedMetadata, fullPriceMinor: requestedPrice });
  if (checkDuplicate(current, operationId, signature)) return duplicateResult(current, { item: requireItem(current, itemId) });
  assertExpectedRevision(current, input.expectedRevision);
  const existing = requireMutableItem(current, itemId);
  if (changes.name !== undefined && !String(changes.name).trim()) throw new Error('物品名称必填');
  if (requestedPrice !== undefined) {
    positiveMoney(requestedPrice, '物品全价');
    if (requestedPrice < paidMinorFor(current, itemId)) throw new Error('物品全价不能低于已付总额');
  }
  if (!Object.keys(changedMetadata).length && requestedPrice === undefined) throw new Error('没有可编辑的物品字段');

  const next = nextState(current);
  const item = requireItem(next, itemId);
  for (const [key, value] of Object.entries(changedMetadata)) item[key] = key === 'name' ? String(value).trim() : clone(value);
  if (requestedPrice !== undefined) item.fullPriceMinor = requestedPrice;
  const at = nowIso(input.updatedAt ?? input.occurredAt);
  const actor = actorOf(input);
  item.updatedAt = at;
  item.updatedBy = actor;
  refreshItemStatus(next, item);
  item.lifecycle.push({ type: 'itemEdited', at, actor, operationId });
  next.revision += 1;
  rememberOperation(next, operationId, 'editItem', itemId, signature);
  return mutationResult(next, { item });
}

function timelineFor(state, item) {
  const events = [...(item.lifecycle ?? []).map(event => ({ ...event, itemId: item.id }))];
  for (const payment of state.itemPayments.filter(candidate => candidate.itemId === item.id)) {
    if (payment.lifecycle?.length) {
      for (const event of payment.lifecycle) events.push({ ...event, itemId: item.id, paymentId: payment.id, amountMinor: payment.amountMinor, paymentType: payment.type, mode: payment.mode });
    } else {
      events.push({ type: 'paymentRecorded', at: payment.createdAt, actor: payment.createdBy, operationId: payment.operationId, itemId: item.id, paymentId: payment.id, amountMinor: payment.amountMinor, paymentType: payment.type, mode: payment.mode });
      if (payment.voidedAt) events.push({ type: 'paymentVoided', at: payment.voidedAt, actor: payment.voidedBy, itemId: item.id, paymentId: payment.id, amountMinor: payment.amountMinor, paymentType: payment.type, mode: payment.mode });
    }
  }
  return events.sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? '')) || String(a.paymentId ?? '').localeCompare(String(b.paymentId ?? '')) || String(a.type).localeCompare(String(b.type)));
}

export function deriveItem(state, itemId) {
  const current = asItemsState(state);
  const item = requireItem(current, itemId);
  const payments = current.itemPayments.filter(payment => payment.itemId === itemId);
  const paidMinor = paidMinorFor(current, itemId);
  const balanceMinor = item.fullPriceMinor - paidMinor;
  return {
    ...clone(item),
    status: item.archivedAt ? 'archived' : (balanceMinor === 0 ? 'completed' : 'active'),
    paidMinor,
    balanceMinor,
    payments: clone(payments),
    timeline: timelineFor(current, item)
  };
}

export function deriveItems(state) {
  const current = asItemsState(state);
  return current.items.map(item => deriveItem(current, item.id));
}

export const recordPayment = recordItemPayment;
export const voidPayment = voidItemPayment;
export const restorePayment = restoreItemPayment;
export const updateItem = editItem;
export const getItemSummary = deriveItem;
export const deriveItemTimeline = (state, itemId) => deriveItem(state, itemId).timeline;
