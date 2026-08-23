import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyOperation, archiveAccount, compareEntriesNewestFirst, createAccount, createLedger, deriveLedger, householdTotals,
  monthlySummary, moveToRecycleBin, permanentlyDelete, reconcile, restoreFromRecycleBin, updateAccount, updateTransaction
} from './ledger.js';

const seed = () => createLedger({ accounts: [
  { id: 'mbb', name: 'Maybank', kind: 'asset', openingBalanceMinor: 500000, balanceMinor: 500000, includeInTotal: true },
  { id: 'pbb', name: 'Public Bank', kind: 'asset', openingBalanceMinor: 30000, balanceMinor: 30000, includeInTotal: true }
] });

test('同一 operationId 重送不会双重记账', () => {
  const first = applyOperation(seed(), { id: 'expense-breakfast-1', kind: 'expense', accountId: 'mbb', amountMinor: 1250 });
  const repeated = applyOperation(first.ledger, { id: 'expense-breakfast-1', kind: 'expense', accountId: 'mbb', amountMinor: 1250 });
  assert.equal(first.ledger.accounts[0].balanceMinor, 498750);
  assert.equal(repeated.duplicate, true);
  assert.equal(repeated.ledger.transactions.length, 1);
});

test('账目先按记账日期新到旧，同一天最后新增的排最前；编辑不会改变新增时间', () => {
  let ledger = seed();
  ledger = applyOperation(ledger, { id: 'same-day-first', kind: 'expense', accountId: 'mbb', amountMinor: 100, occurredAt: '2026-08-22T12:00:00.000Z', createdAt: '2026-08-22T01:00:00.000Z' }).ledger;
  ledger = applyOperation(ledger, { id: 'older-day', kind: 'expense', accountId: 'mbb', amountMinor: 100, occurredAt: '2026-08-21T12:00:00.000Z', createdAt: '2026-08-23T01:00:00.000Z' }).ledger;
  ledger = applyOperation(ledger, { id: 'same-day-last', kind: 'expense', accountId: 'mbb', amountMinor: 100, occurredAt: '2026-08-22T12:00:00.000Z', createdAt: '2026-08-22T02:00:00.000Z' }).ledger;
  assert.deepEqual([...ledger.transactions].sort(compareEntriesNewestFirst).map(entry => entry.id), ['same-day-last', 'same-day-first', 'older-day']);
  const edited = updateTransaction(ledger, 'same-day-first', { note: 'edited' }, 'edit-same-day-first').ledger;
  assert.equal(edited.transactions.find(entry => entry.id === 'same-day-first').createdAt, '2026-08-22T01:00:00.000Z');
});

test('旧记录缺少 createdAt 时按原数组新增顺序兼容，同步记录可由账目重算余额', () => {
  const ledger = createLedger({ accounts: seed().accounts, transactions: [
    { id: 'legacy-first', operationId: 'legacy-first', kind: 'expense', accountId: 'mbb', amountMinor: 100, occurredAt: '2026-08-22T12:00:00.000Z', deletedAt: null },
    { id: 'legacy-last', operationId: 'legacy-last', kind: 'expense', accountId: 'mbb', amountMinor: 200, occurredAt: '2026-08-22T12:00:00.000Z', deletedAt: null }
  ] });
  assert.deepEqual([...ledger.transactions].sort(compareEntriesNewestFirst).map(entry => entry.id), ['legacy-last', 'legacy-first']);
  const rebuilt = deriveLedger({ accounts: seed().accounts, transactions: ledger.transactions });
  assert.equal(rebuilt.accounts.find(account => account.id === 'mbb').balanceMinor, 499700);
});

test('收入只增加来源账户且可对账', () => {
  const result = applyOperation(seed(), { id: 'income-1', kind: 'income', accountId: 'mbb', amountMinor: 380000 });
  assert.equal(result.ledger.accounts[0].balanceMinor, 880000);
  assert.equal(result.ledger.accounts[1].balanceMinor, 30000);
  assert.deepEqual(reconcile(result.ledger), { ok: true, mismatches: [] });
});

test('不同 operationId 不能复用 transactionId，失败时不污染余额或账目', () => {
  const first = applyOperation(seed(), { id: 'expense-1', transactionId: 'shared-entry', kind: 'expense', accountId: 'mbb', amountMinor: 1250 });
  assert.throws(() => applyOperation(first.ledger, { id: 'expense-2', transactionId: 'shared-entry', kind: 'expense', accountId: 'mbb', amountMinor: 800 }), /账目 ID 已存在/);
  assert.equal(first.ledger.transactions.length, 1);
  assert.equal(first.ledger.accounts[0].balanceMinor, 498750);
  assert.deepEqual(reconcile(first.ledger), { ok: true, mismatches: [] });
});

test('转账一次同时扣来源并加目标，且重复重送无影响', () => {
  const first = applyOperation(seed(), { id: 'transfer-1', kind: 'transfer', accountId: 'mbb', targetAccountId: 'pbb', amountMinor: 20000 });
  const retry = applyOperation(first.ledger, { id: 'transfer-1', kind: 'transfer', accountId: 'mbb', targetAccountId: 'pbb', amountMinor: 20000 });
  assert.equal(first.ledger.accounts[0].balanceMinor, 480000);
  assert.equal(first.ledger.accounts[1].balanceMinor, 50000);
  assert.equal(retry.duplicate, true);
  assert.deepEqual(reconcile(retry.ledger), { ok: true, mismatches: [] });
});

test('不允许转给同一个账户且不污染账本', () => {
  const ledger = seed();
  assert.throws(() => applyOperation(ledger, { id: 'bad-transfer', kind: 'transfer', accountId: 'mbb', targetAccountId: 'mbb', amountMinor: 100 }), /同一账户/);
  assert.equal(ledger.transactions.length, 0);
});

test('对账能抓到任何余额偏差', () => {
  const result = applyOperation(seed(), { id: 'expense-1', kind: 'expense', accountId: 'mbb', amountMinor: 1000 });
  result.ledger.accounts[0].balanceMinor += 1;
  assert.equal(reconcile(result.ledger).ok, false);
});

test('对账拒绝引用不存在账户的损坏账目，而非把它静默算成 NaN', () => {
  const ledger = seed();
  ledger.transactions.push({
    id: 'corrupt-transfer', operationId: 'corrupt-transfer', kind: 'transfer',
    accountId: 'mbb', targetAccountId: 'missing-account', amountMinor: 100,
    occurredAt: '2026-07-17T10:00:00.000Z', deletedAt: null
  });
  const result = reconcile(ledger);
  assert.equal(result.ok, false);
  assert.deepEqual(result.integrityIssues, [{
    transactionId: 'corrupt-transfer', field: 'targetAccountId', accountId: 'missing-account', reason: '账户不存在'
  }]);
});

test('账户可创建、改名、排除总额并归档；归档后不能记账', () => {
  let ledger = createAccount(seed(), { id: 'cash', name: '现金', kind: 'asset', openingBalanceMinor: 12000, includeInTotal: true });
  ledger = updateAccount(ledger, 'cash', { name: '零钱', includeInTotal: false });
  assert.equal(householdTotals(ledger).assetsMinor, 530000);
  ledger = archiveAccount(ledger, 'cash', '2026-07-17T10:00:00.000Z');
  assert.equal(ledger.accounts.find(account => account.id === 'cash').includeInTotal, false);
  assert.throws(() => applyOperation(ledger, { id: 'bad-archived', kind: 'expense', accountId: 'cash', amountMinor: 1 }), /归档账户/);
});

test('账户照片可创建、更新、移除并拒绝无效或过大的本地图片', () => {
  const photo = 'data:image/jpeg;base64,YWNjb3VudC1waG90bw==';
  let ledger = createAccount(seed(), { id: 'cash-photo', name: '现金', kind: 'asset', openingBalanceMinor: 0, photoDataUrl: photo });
  assert.equal(ledger.accounts.find(account => account.id === 'cash-photo').photoDataUrl, photo);
  ledger = updateAccount(ledger, 'cash-photo', { photoDataUrl: null });
  assert.equal(ledger.accounts.find(account => account.id === 'cash-photo').photoDataUrl, null);
  assert.throws(() => createAccount(seed(), { id: 'bad-photo', name: '错误照片', kind: 'asset', openingBalanceMinor: 0, photoDataUrl: 'https://example.com/photo.jpg' }), /照片格式无效/);
  const oversized = `data:image/jpeg;base64,${'A'.repeat(300001)}`;
  assert.throws(() => createAccount(seed(), { id: 'large-photo', name: '过大照片', kind: 'asset', openingBalanceMinor: 0, photoDataUrl: oversized }), /照片过大/);
});

test('回收、恢复和永久删除要求稳定操作 ID；重送不重复改变账本', () => {
  let ledger = applyOperation(seed(), { id: 'lunch-1', kind: 'expense', accountId: 'mbb', amountMinor: 1800, occurredAt: '2026-07-17T10:00:00.000Z' }).ledger;
  assert.throws(() => moveToRecycleBin(ledger, 'lunch-1'), /回收 operationId 必填/);

  const recycled = moveToRecycleBin(ledger, 'lunch-1', 'recycle-lunch-1', '2026-07-17T11:00:00.000Z');
  const recycleRetry = moveToRecycleBin(recycled.ledger, 'lunch-1', 'recycle-lunch-1');
  assert.equal(recycled.ledger.accounts[0].balanceMinor, 500000);
  assert.equal(recycleRetry.duplicate, true);
  assert.deepEqual(reconcile(recycleRetry.ledger), { ok: true, mismatches: [] });

  const restored = restoreFromRecycleBin(recycleRetry.ledger, 'lunch-1', 'restore-lunch-1');
  const restoreRetry = restoreFromRecycleBin(restored.ledger, 'lunch-1', 'restore-lunch-1');
  assert.equal(restored.ledger.accounts[0].balanceMinor, 498200);
  assert.equal(restoreRetry.duplicate, true);

  ledger = moveToRecycleBin(restoreRetry.ledger, 'lunch-1', 'recycle-lunch-2').ledger;
  const deleted = permanentlyDelete(ledger, 'lunch-1', 'delete-lunch-1');
  const deleteRetry = permanentlyDelete(deleted.ledger, 'lunch-1', 'delete-lunch-1');
  assert.equal(deleteRetry.duplicate, true);
  assert.equal(deleteRetry.ledger.transactions.length, 0);
  assert.deepEqual(reconcile(deleteRetry.ledger), { ok: true, mismatches: [] });
});

test('编辑账目会先回滚旧影响再应用新影响，重复编辑不重复影响余额', () => {
  let ledger = applyOperation(seed(), { id: 'old-expense', kind: 'expense', accountId: 'mbb', amountMinor: 1000, occurredAt: '2026-07-01T12:00:00.000Z' }).ledger;
  const first = updateTransaction(ledger, 'old-expense', { kind: 'transfer', accountId: 'mbb', targetAccountId: 'pbb', amountMinor: 2500, note: '调拨' }, 'edit-expense-1');
  const retry = updateTransaction(first.ledger, 'old-expense', { kind: 'transfer', accountId: 'mbb', targetAccountId: 'pbb', amountMinor: 2500 }, 'edit-expense-1');
  assert.equal(first.ledger.accounts[0].balanceMinor, 497500);
  assert.equal(first.ledger.accounts[1].balanceMinor, 32500);
  assert.equal(retry.duplicate, true);
  assert.deepEqual(reconcile(retry.ledger), { ok: true, mismatches: [] });
});

test('月度收支排除转账与回收账目', () => {
  let ledger = applyOperation(seed(), { id: 'salary', kind: 'income', accountId: 'mbb', amountMinor: 100000, occurredAt: '2026-07-04T12:00:00.000Z' }).ledger;
  ledger = applyOperation(ledger, { id: 'food', kind: 'expense', accountId: 'mbb', amountMinor: 2050, occurredAt: '2026-07-05T12:00:00.000Z' }).ledger;
  ledger = applyOperation(ledger, { id: 'transfer', kind: 'transfer', accountId: 'mbb', targetAccountId: 'pbb', amountMinor: 100, occurredAt: '2026-07-05T12:00:00.000Z' }).ledger;
  ledger = moveToRecycleBin(ledger, 'food', 'recycle-food').ledger;
  assert.deepEqual(monthlySummary(ledger, '2026-07'), { incomeMinor: 100000, expenseMinor: 0 });
});

test('物品付款来源字段在创建、派生与编辑后保持不变', () => {
  const created = applyOperation(seed(), {
    id: 'pay-item-op', transactionId: 'item-payment-pay-1', kind: 'expense', accountId: 'mbb',
    amountMinor: 2500, category: '购物', sourceType: 'itemPayment',
    sourceItemId: 'bike', sourcePaymentId: 'pay-1'
  }).ledger;
  const entry = created.transactions[0];
  assert.deepEqual(
    [entry.sourceType, entry.sourceItemId, entry.sourcePaymentId],
    ['itemPayment', 'bike', 'pay-1']
  );
  const derived = deriveLedger({ accounts: seed().accounts, transactions: created.transactions });
  const edited = updateTransaction(derived, entry.id, { note: '保留来源' }, 'edit-linked-note').ledger;
  assert.deepEqual(
    edited.transactions.map(({ sourceType, sourceItemId, sourcePaymentId }) => ({ sourceType, sourceItemId, sourcePaymentId })),
    [{ sourceType: 'itemPayment', sourceItemId: 'bike', sourcePaymentId: 'pay-1' }]
  );
});

test('普通旧账目不新增物品付款来源键', () => {
  const ordinary = applyOperation(seed(), {
    id: 'ordinary-expense', kind: 'expense', accountId: 'mbb', amountMinor: 100
  }).ledger.transactions[0];
  assert.equal(Object.hasOwn(ordinary, 'sourceType'), false);
  assert.equal(Object.hasOwn(ordinary, 'sourceItemId'), false);
  assert.equal(Object.hasOwn(ordinary, 'sourcePaymentId'), false);
  const derived = deriveLedger({ accounts: seed().accounts, transactions: [ordinary] }).transactions[0];
  assert.equal(Object.hasOwn(derived, 'sourceType'), false);
});
