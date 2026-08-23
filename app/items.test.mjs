import test from 'node:test';
import assert from 'node:assert/strict';
import {
  archiveItem,
  createItem,
  createItemsState,
  deriveItem,
  editItem,
  hydrateItemsState,
  recordItemPayment,
  restoreItem,
  restoreItemPayment,
  serialiseItemsState,
  voidItemPayment
} from './items.js';

const T0 = '2026-08-23T01:00:00.000Z';
const T1 = '2026-08-23T02:00:00.000Z';
const T2 = '2026-08-23T03:00:00.000Z';
const T3 = '2026-08-23T04:00:00.000Z';

const empty = () => createItemsState();
const itemState = (fullPriceMinor = 10000) => createItem(empty(), {
  id: 'bike',
  name: '脚踏车',
  fullPriceMinor,
  operationId: 'create-bike',
  createdAt: T0,
  actor: 'parent-a'
}).state;

const pay = (state, overrides = {}) => recordItemPayment(state, 'bike', {
  paymentId: 'pay-1',
  operationId: 'record-pay-1',
  amountMinor: 1000,
  type: 'payment',
  mode: 'independent',
  occurredAt: T1,
  actor: 'parent-a',
  ...overrides
});

test('无订金可创建预购物品，余额和状态完全由付款派生', () => {
  const state = itemState();
  const item = deriveItem(state, 'bike');
  assert.equal(item.fullPriceMinor, 10000);
  assert.equal(item.paidMinor, 0);
  assert.equal(item.balanceMinor, 10000);
  assert.equal(item.status, 'active');
  assert.equal(item.createdBy, 'parent-a');
  assert.deepEqual(item.payments, []);
});

test('订金是可选的第一笔付款，并能在创建时原子返回账目联动规格', () => {
  const result = createItem(empty(), {
    id: 'laptop',
    name: '电脑',
    fullPriceMinor: 50000,
    operationId: 'create-laptop',
    createdAt: T0,
    actor: 'parent-a',
    deposit: {
      paymentId: 'laptop-deposit',
      operationId: 'record-laptop-deposit',
      amountMinor: 10000,
      mode: 'linked',
      accountId: 'maybank',
      occurredAt: T1,
      actor: 'parent-b'
    }
  });
  const item = deriveItem(result.state, 'laptop');
  assert.equal(item.paidMinor, 10000);
  assert.equal(item.balanceMinor, 40000);
  assert.equal(item.payments[0].type, 'deposit');
  assert.equal(item.payments[0].createdBy, 'parent-b');
  assert.equal(result.expenseSpec.transactionId, 'item-payment-laptop-deposit');
  assert.equal(result.expenseSpec.sourcePaymentId, 'laptop-deposit');
});

test('创建幂等指纹覆盖物品元数据和完整订金载荷，但忽略重试记账字段', () => {
  const input = {
    id: 'camera',
    name: '相机',
    fullPriceMinor: 30000,
    operationId: 'create-camera',
    coverMediaId: 'cover-a',
    note: '家庭旅行使用',
    targetDate: T3,
    createdAt: T0,
    actor: 'parent-a',
    deposit: {
      paymentId: 'camera-deposit',
      operationId: 'record-camera-deposit',
      amountMinor: 5000,
      mode: 'linked',
      accountId: 'cash',
      occurredAt: T1,
      note: '相机订金',
      receiptMediaId: 'receipt-a',
      createdAt: T1,
      actor: 'parent-a'
    }
  };
  const first = createItem(empty(), input);
  const retry = createItem(first.state, {
    ...input,
    createdAt: T2,
    actor: 'parent-b',
    deposit: { ...input.deposit, createdAt: T2, actor: 'parent-b' }
  });
  assert.equal(retry.duplicate, true);
  assert.strictEqual(retry.state, first.state);
  assert.equal(retry.state.items.length, 1);
  assert.equal(retry.state.itemPayments.length, 1);

  assert.throws(
    () => createItem(first.state, { ...input, coverMediaId: 'cover-b' }),
    /operationId 已用于不同操作/
  );
  assert.throws(
    () => createItem(first.state, { ...input, note: '改为学习使用' }),
    /operationId 已用于不同操作/
  );
  assert.throws(
    () => createItem(first.state, { ...input, targetDate: T2 }),
    /operationId 已用于不同操作/
  );
  assert.throws(
    () => createItem(first.state, { ...input, deposit: { ...input.deposit, amountMinor: 6000 } }),
    /operationId 已用于不同操作/
  );
});

test('分期付款累计余额，刚好付清时 completed，但不会自动归档', () => {
  let state = pay(itemState(), { amountMinor: 2500 }).state;
  state = pay(state, { paymentId: 'pay-2', operationId: 'record-pay-2', amountMinor: 3500, occurredAt: T2 }).state;
  let item = deriveItem(state, 'bike');
  assert.deepEqual([item.paidMinor, item.balanceMinor, item.status], [6000, 4000, 'active']);
  state = pay(state, { paymentId: 'pay-3', operationId: 'record-pay-3', amountMinor: 4000, occurredAt: T3 }).state;
  item = deriveItem(state, 'bike');
  assert.deepEqual([item.paidMinor, item.balanceMinor, item.status], [10000, 0, 'completed']);
  assert.equal(item.archivedAt, null);
});

test('付款拒绝超付、零、负数和非安全整数且失败不污染原状态', () => {
  const state = itemState(1000);
  assert.throws(() => pay(state, { amountMinor: 1001 }), /超过物品全价/);
  assert.throws(() => pay(state, { amountMinor: 0 }), /必须大于零/);
  assert.throws(() => pay(state, { amountMinor: -1 }), /必须大于零/);
  assert.throws(() => pay(state, { amountMinor: Number.MAX_SAFE_INTEGER + 1 }), /安全整数/);
  assert.equal(state.itemPayments.length, 0);
  assert.equal(state.revision, 1);
});

test('同一 operationId/paymentId 重送幂等，不会重复付款', () => {
  const first = pay(itemState());
  const retry = pay(first.state);
  assert.equal(retry.duplicate, true);
  assert.strictEqual(retry.state, first.state);
  assert.equal(retry.state.itemPayments.length, 1);
  assert.equal(deriveItem(retry.state, 'bike').paidMinor, 1000);
});

test('付款幂等指纹覆盖业务日期、备注和收据，但忽略 actor/createdAt 重试记账字段', () => {
  const first = pay(itemState(), { note: '第一期', receiptMediaId: 'receipt-a' });
  const retry = pay(first.state, {
    note: '第一期',
    receiptMediaId: 'receipt-a',
    actor: 'parent-b',
    createdAt: T2
  });
  assert.equal(retry.duplicate, true);
  assert.strictEqual(retry.state, first.state);

  assert.throws(
    () => pay(first.state, { note: '第一期', receiptMediaId: 'receipt-a', occurredAt: T2 }),
    /operationId 已用于不同操作/
  );
  assert.throws(
    () => pay(first.state, { note: '第一期', receiptMediaId: 'receipt-b' }),
    /operationId 已用于不同操作/
  );
  assert.throws(
    () => pay(first.state, { note: '第二期', receiptMediaId: 'receipt-a' }),
    /operationId 已用于不同操作/
  );
});

test('operationId 或 paymentId 被另一付款复用时明确报冲突', () => {
  const first = pay(itemState()).state;
  assert.throws(() => pay(first, { paymentId: 'pay-other', amountMinor: 2000 }), /operationId.*冲突/);
  assert.throws(() => pay(first, { operationId: 'record-other', amountMinor: 1000 }), /paymentId 已存在/);
  assert.equal(first.itemPayments.length, 1);
  assert.equal(deriveItem(first, 'bike').paidMinor, 1000);
});

test('linked 返回确定性 expense spec，independent 不返回账目写入规格', () => {
  const linked = pay(itemState(), {
    mode: 'linked',
    accountId: 'cash',
    amountMinor: 1200,
    note: '预购物品付款'
  });
  assert.deepEqual(linked.expenseSpec, {
    action: 'create',
    id: 'record-pay-1',
    operationId: 'record-pay-1',
    transactionId: 'item-payment-pay-1',
    kind: 'expense',
    accountId: 'cash',
    amountMinor: 1200,
    category: '购物',
    note: '预购物品付款',
    occurredAt: T1,
    createdAt: T1,
    sourceType: 'itemPayment',
    sourceItemId: 'bike',
    sourcePaymentId: 'pay-1'
  });
  assert.deepEqual(linked.linkedExpenseSpecs, [linked.expenseSpec]);

  const independent = pay(itemState());
  assert.equal(independent.expenseSpec, null);
  assert.deepEqual(independent.linkedExpenseSpecs, []);
  assert.equal(independent.payment.transactionId, null);
});

test('并发争抢最后余额时 revision 冲突阻止第二个陈旧写入', () => {
  const initial = itemState(1000);
  const revision = initial.revision;
  const first = pay(initial, { amountMinor: 1000, expectedRevision: revision });
  assert.equal(deriveItem(first.state, 'bike').status, 'completed');
  assert.throws(
    () => pay(first.state, { paymentId: 'pay-2', operationId: 'record-pay-2', amountMinor: 1000, expectedRevision: revision }),
    error => error.code === 'REVISION_CONFLICT' && error.actualRevision === first.state.revision
  );
  assert.equal(first.state.itemPayments.length, 1);
});

test('付款通过作废与恢复更正，余额/状态反向联动且操作可重送', () => {
  const paid = pay(itemState(1000), { amountMinor: 1000, mode: 'linked', accountId: 'cash' }).state;
  const voided = voidItemPayment(paid, 'pay-1', { operationId: 'void-pay-1', occurredAt: T2, actor: 'parent-b' });
  assert.deepEqual([deriveItem(voided.state, 'bike').paidMinor, deriveItem(voided.state, 'bike').status], [0, 'active']);
  assert.equal(voided.payment.voidedBy, 'parent-b');
  assert.equal(voided.payment.status, 'voided');
  assert.equal(voided.expenseSpec.action, 'void');
  assert.equal(voided.expenseSpec.transactionId, 'item-payment-pay-1');
  const voidRetry = voidItemPayment(voided.state, 'pay-1', { operationId: 'void-pay-1', occurredAt: T2, actor: 'parent-b' });
  assert.equal(voidRetry.duplicate, true);

  const restored = restoreItemPayment(voidRetry.state, 'bike', 'pay-1', { operationId: 'restore-pay-1', occurredAt: T3, actor: 'parent-a' });
  const item = deriveItem(restored.state, 'bike');
  assert.deepEqual([item.paidMinor, item.balanceMinor, item.status], [1000, 0, 'completed']);
  assert.equal(restored.payment.restoredBy, 'parent-a');
  assert.equal(restored.payment.status, 'active');
  assert.equal(restored.expenseSpec.action, 'restore');
  assert.deepEqual(item.timeline.filter(event => event.paymentId === 'pay-1').map(event => event.type), [
    'paymentRecorded', 'paymentVoided', 'paymentRestored'
  ]);
});

test('恢复旧付款若会因后续付款导致超付则拒绝', () => {
  let state = pay(itemState(2000), { amountMinor: 1500 }).state;
  state = voidItemPayment(state, 'pay-1', { operationId: 'void-pay-1', occurredAt: T2 }).state;
  state = pay(state, { paymentId: 'pay-2', operationId: 'record-pay-2', amountMinor: 1000, occurredAt: T3 }).state;
  assert.throws(() => restoreItemPayment(state, 'pay-1', { operationId: 'restore-pay-1' }), /超过物品全价/);
  assert.equal(deriveItem(state, 'bike').paidMinor, 1000);
});

test('未结清物品拒绝归档且不污染状态', () => {
  const unpaid = pay(itemState()).state;
  assert.throws(
    () => archiveItem(unpaid, 'bike', { operationId: 'archive-unpaid-bike', archivedAt: T2 }),
    /必须结清并完成后才能归档/
  );
  assert.deepEqual([deriveItem(unpaid, 'bike').status, deriveItem(unpaid, 'bike').balanceMinor], ['active', 9000]);
  assert.equal(unpaid.revision, 2);
  assert.equal(unpaid.appliedOperationIds.has('archive-unpaid-bike'), false);
});

test('仅结清完成的物品可显式归档；归档后付款、作废、编辑都必须先恢复', () => {
  const paid = pay(itemState(), { amountMinor: 10000 }).state;
  const archived = archiveItem(paid, 'bike', { operationId: 'archive-bike', archivedAt: T2, actor: 'parent-a' });
  assert.equal(deriveItem(archived.state, 'bike').status, 'archived');
  assert.throws(() => pay(archived.state, { paymentId: 'pay-2', operationId: 'record-pay-2' }), /先恢复/);
  assert.throws(() => voidItemPayment(archived.state, 'pay-1', { operationId: 'void-pay-1' }), /先恢复/);
  assert.throws(() => editItem(archived.state, 'bike', { name: '新名字' }, { operationId: 'edit-bike' }), /先恢复/);

  const restored = restoreItem(archived.state, 'bike', { operationId: 'restore-bike', restoredAt: T3, actor: 'parent-b' });
  assert.equal(deriveItem(restored.state, 'bike').status, 'completed');
  assert.equal(restored.item.restoredBy, 'parent-b');
  const edited = editItem(restored.state, 'bike', { name: '新脚踏车' }, { operationId: 'edit-bike', updatedAt: T3 });
  assert.equal(edited.item.name, '新脚踏车');
});

test('编辑全价不能低于已付，可调到恰好已付并更新派生状态', () => {
  const paid = pay(itemState(), { amountMinor: 4000 }).state;
  assert.throws(() => editItem(paid, 'bike', { fullPriceMinor: 3999 }, { operationId: 'edit-price-low' }), /不能低于已付总额/);
  const exact = editItem(paid, 'bike', { fullPriceMinor: 4000, description: '家庭共用' }, {
    operationId: 'edit-price-exact', updatedAt: T2, actor: 'parent-b'
  });
  const item = deriveItem(exact.state, 'bike');
  assert.equal(item.status, 'completed');
  assert.equal(item.balanceMinor, 0);
  assert.equal(item.description, '家庭共用');
  assert.equal(item.updatedBy, 'parent-b');
});

test('封面媒体引用可编辑和清除，幂等签名区分封面变化', () => {
  const initial = itemState();
  const covered = editItem(initial, 'bike', { coverMediaId: 'media-cover-a' }, {
    operationId: 'edit-cover', updatedAt: T1, actor: 'parent-a'
  });
  assert.equal(covered.item.coverMediaId, 'media-cover-a');

  const retry = editItem(covered.state, 'bike', { coverMediaId: 'media-cover-a' }, {
    operationId: 'edit-cover', updatedAt: T2, actor: 'parent-b'
  });
  assert.equal(retry.duplicate, true);
  assert.strictEqual(retry.state, covered.state);
  assert.throws(
    () => editItem(covered.state, 'bike', { coverMediaId: 'media-cover-b' }, { operationId: 'edit-cover' }),
    /operationId 已用于不同操作/
  );

  const cleared = editItem(covered.state, 'bike', { coverMediaId: null }, {
    operationId: 'clear-cover', updatedAt: T3, actor: 'parent-b'
  });
  assert.equal(cleared.item.coverMediaId, null);
});

test('订金只能作为第一笔付款，避免用新增记录替代作废/恢复更正路径', () => {
  const state = pay(itemState()).state;
  assert.throws(() => pay(state, {
    paymentId: 'late-deposit', operationId: 'late-deposit-op', type: 'deposit', amountMinor: 100
  }), /订金只能是第一笔付款/);
});

test('旧版空状态可 hydrate/serialise 往返，Set 幂等索引可安全持久化', () => {
  const legacy = hydrateItemsState({});
  assert.deepEqual(serialiseItemsState(legacy), {
    items: [], itemPayments: [], revision: 0, appliedOperationIds: [], appliedOperations: []
  });
  const persisted = serialiseItemsState(pay(itemState()).state);
  const hydrated = hydrateItemsState(JSON.parse(JSON.stringify(persisted)));
  assert.ok(hydrated.appliedOperationIds instanceof Set);
  assert.equal(hydrated.itemPayments.length, 1);
  assert.equal(pay(hydrated).duplicate, true);
});
