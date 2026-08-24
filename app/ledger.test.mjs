import test from 'node:test';
import assert from 'node:assert/strict';
import {
  accountSubtype, applyOperation, archiveAccount, compareEntriesNewestFirst, createAccount, createLedger, deriveLedger,
  estimatedMonthlyInterestMinor, householdTotals, loanCalculationMode, monthlySummary, moveToRecycleBin, permanentlyDelete, reconcile,
  remainingPayoffMonths, repaymentBreakdown, restoreFromRecycleBin, suggestedRepayment, updateAccount, updateTransaction
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

const liabilitySeed = () => createLedger({ accounts: [
  { id: 'cash', name: '现金', kind: 'asset', openingBalanceMinor: 100000, balanceMinor: 100000, includeInTotal: true },
  { id: 'card', name: '信用卡', kind: 'liability', subtype: 'credit_card', openingBalanceMinor: 50000, balanceMinor: 50000, includeInTotal: true },
  { id: 'loan', name: '车贷', kind: 'liability', subtype: 'loan', openingBalanceMinor: 200000, balanceMinor: 200000, includeInTotal: true }
] });

test('旧账户缺少 subtype 时按会计类型兼容，旧负债支出使用正数债务语义', () => {
  assert.equal(accountSubtype({ kind: 'asset' }), 'asset');
  assert.equal(accountSubtype({ kind: 'liability' }), 'generic_liability');
  const rebuilt = deriveLedger({
    accounts: [
      { id: 'legacy-asset', kind: 'asset', openingBalanceMinor: 10000 },
      { id: 'legacy-debt', kind: 'liability', openingBalanceMinor: 2000 }
    ],
    transactions: [
      { id: 'asset-expense', kind: 'expense', accountId: 'legacy-asset', amountMinor: 500, occurredAt: '2026-08-01T00:00:00.000Z' },
      { id: 'debt-expense', kind: 'expense', accountId: 'legacy-debt', amountMinor: 700, occurredAt: '2026-08-01T00:00:00.000Z' }
    ]
  });
  assert.equal(rebuilt.accounts[0].balanceMinor, 9500);
  assert.equal(rebuilt.accounts[1].balanceMinor, 2700);
  assert.deepEqual(householdTotals(rebuilt), { assetsMinor: 9500, liabilitiesMinor: 2700, netMinor: 6800 });
  assert.deepEqual(reconcile(rebuilt), { ok: true, mismatches: [] });
});

test('信用卡支出增加正数债务且月度支出只计算一次', () => {
  const ledger = applyOperation(liabilitySeed(), {
    id: 'card-groceries', kind: 'expense', accountId: 'card', amountMinor: 8800,
    occurredAt: '2026-08-10T12:00:00.000Z'
  }).ledger;
  assert.equal(ledger.accounts.find(account => account.id === 'card').balanceMinor, 58800);
  assert.deepEqual(monthlySummary(ledger, '2026-08'), { incomeMinor: 0, expenseMinor: 8800 });
  assert.deepEqual(reconcile(ledger), { ok: true, mismatches: [] });
});

test('收入只能记入资产账户，拒绝负债收入且不污染账本', () => {
  const ledger = liabilitySeed();
  assert.throws(() => applyOperation(ledger, {
    id: 'invalid-liability-income', kind: 'income', accountId: 'card', amountMinor: 1000
  }), /收入仅支持资产账户/);
  assert.equal(ledger.accounts.find(account => account.id === 'card').balanceMinor, 50000);
  assert.equal(ledger.transactions.length, 0);
});

test('信用卡还款可从资产扣款或使用账外资金，并支持部分与全额还清', () => {
  let ledger = applyOperation(liabilitySeed(), {
    id: 'card-partial', kind: 'repayment', accountId: 'cash', targetAccountId: 'card', amountMinor: 20000
  }).ledger;
  assert.equal(ledger.accounts.find(account => account.id === 'cash').balanceMinor, 80000);
  assert.equal(ledger.accounts.find(account => account.id === 'card').balanceMinor, 30000);
  assert.deepEqual(
    (({ principalMinor, interestMinor }) => ({ principalMinor, interestMinor }))(ledger.transactions[0]),
    { principalMinor: 20000, interestMinor: 0 }
  );

  const retry = applyOperation(ledger, {
    id: 'card-partial', kind: 'repayment', accountId: 'cash', targetAccountId: 'card', amountMinor: 20000
  });
  assert.equal(retry.duplicate, true);
  ledger = applyOperation(retry.ledger, {
    id: 'card-full-off-ledger', kind: 'repayment', targetAccountId: 'card', amountMinor: 30000
  }).ledger;
  assert.equal(ledger.accounts.find(account => account.id === 'cash').balanceMinor, 80000);
  assert.equal(ledger.accounts.find(account => account.id === 'card').balanceMinor, 0);
  assert.deepEqual(monthlySummary(ledger, ledger.transactions[0].occurredAt.slice(0, 7)), { incomeMinor: 0, expenseMinor: 0 });
  assert.deepEqual(reconcile(ledger), { ok: true, mismatches: [] });
});

test('超过当前债务的还款被拒绝且不污染原账本', () => {
  const ledger = liabilitySeed();
  assert.throws(() => applyOperation(ledger, {
    id: 'card-overpay', kind: 'repayment', accountId: 'cash', targetAccountId: 'card', amountMinor: 50001
  }), /还款本金不能超过当前债务/);
  assert.equal(ledger.accounts.find(account => account.id === 'cash').balanceMinor, 100000);
  assert.equal(ledger.accounts.find(account => account.id === 'card').balanceMinor, 50000);
  assert.equal(ledger.transactions.length, 0);
  assert.equal(ledger.appliedOperationIds.has('card-overpay'), false);
});

test('贷款还款总额等于本金加利息，资产扣总额、负债只扣本金且月度只计利息', () => {
  const ledger = applyOperation(liabilitySeed(), {
    id: 'loan-payment', kind: 'repayment', accountId: 'cash', targetAccountId: 'loan',
    amountMinor: 12000, principalMinor: 10000, interestMinor: 2000,
    occurredAt: '2026-08-12T00:00:00.000Z'
  }).ledger;
  assert.equal(ledger.accounts.find(account => account.id === 'cash').balanceMinor, 88000);
  assert.equal(ledger.accounts.find(account => account.id === 'loan').balanceMinor, 190000);
  assert.deepEqual(monthlySummary(ledger, '2026-08'), { incomeMinor: 0, expenseMinor: 2000 });
  assert.throws(() => applyOperation(liabilitySeed(), {
    id: 'bad-loan-sum', kind: 'repayment', targetAccountId: 'loan',
    amountMinor: 12000, principalMinor: 10000, interestMinor: 1000
  }), /本金与利息之和/);
  assert.deepEqual(reconcile(ledger), { ok: true, mismatches: [] });
});

test('马来西亚固定月供车贷默认使用计划金额且整笔减少剩余应付总额', () => {
  const account = {
    id:'car-hp', kind:'liability', subtype:'loan', loanType:'car', loanCalculationMode:'fixed_instalment',
    balanceMinor:500000, scheduledPaymentMinor:119900
  };
  assert.equal(loanCalculationMode(account), 'fixed_instalment');
  assert.deepEqual(suggestedRepayment(account), { amountMinor:119900, principalMinor:119900, interestMinor:0 });
  assert.deepEqual(repaymentBreakdown(account, 100000), { amountMinor:100000, principalMinor:100000, interestMinor:0 });
});

test('马来西亚浮动房贷按当前本金与年利率估算利息并从月供拆出本金', () => {
  const account = {
    id:'home-loan', kind:'liability', subtype:'loan', loanType:'home', loanCalculationMode:'reducing_balance',
    balanceMinor:10000000, scheduledPaymentMinor:120000, annualInterestRateBps:420
  };
  assert.equal(loanCalculationMode(account), 'reducing_balance');
  assert.equal(estimatedMonthlyInterestMinor(account), 35000);
  assert.deepEqual(suggestedRepayment(account), { amountMinor:120000, principalMinor:85000, interestMinor:35000 });
  assert.deepEqual(repaymentBreakdown(account, 150000), { amountMinor:150000, principalMinor:115000, interestMinor:35000 });
  assert.deepEqual(repaymentBreakdown(account, 150000, 36000), { amountMinor:150000, principalMinor:114000, interestMinor:36000 });
  assert.throws(() => repaymentBreakdown(account, 35000), /必须高于本期利息/);
});

test('信用卡建议金额默认为一次还清当前欠款', () => {
  const account = { id:'visa', kind:'liability', subtype:'credit_card', balanceMinor:87654 };
  assert.deepEqual(suggestedRepayment(account), { amountMinor:87654, principalMinor:87654, interestMinor:0 });
});

test('转账严格限制为资产到账户，负债只能通过还款减少', () => {
  const ledger = liabilitySeed();
  assert.throws(() => applyOperation(ledger, {
    id: 'asset-to-debt-transfer', kind: 'transfer', accountId: 'cash', targetAccountId: 'card', amountMinor: 100
  }), /转账仅支持资产账户/);
  assert.throws(() => applyOperation(ledger, {
    id: 'debt-to-asset-transfer', kind: 'transfer', accountId: 'card', targetAccountId: 'cash', amountMinor: 100
  }), /转账仅支持资产账户/);
  assert.equal(ledger.transactions.length, 0);
});

test('还款回收、恢复、编辑会准确反向与重放，编辑越界保持原账本不变', () => {
  let ledger = applyOperation(liabilitySeed(), {
    id: 'editable-payment', kind: 'repayment', accountId: 'cash', targetAccountId: 'card', amountMinor: 20000
  }).ledger;
  ledger = moveToRecycleBin(ledger, 'editable-payment', 'void-payment').ledger;
  assert.equal(ledger.accounts.find(account => account.id === 'cash').balanceMinor, 100000);
  assert.equal(ledger.accounts.find(account => account.id === 'card').balanceMinor, 50000);
  ledger = restoreFromRecycleBin(ledger, 'editable-payment', 'restore-payment').ledger;
  assert.equal(ledger.accounts.find(account => account.id === 'cash').balanceMinor, 80000);
  assert.equal(ledger.accounts.find(account => account.id === 'card').balanceMinor, 30000);

  const edited = updateTransaction(ledger, 'editable-payment', { amountMinor: 30000 }, 'edit-payment');
  assert.equal(edited.ledger.accounts.find(account => account.id === 'cash').balanceMinor, 70000);
  assert.equal(edited.ledger.accounts.find(account => account.id === 'card').balanceMinor, 20000);
  assert.deepEqual(reconcile(edited.ledger), { ok: true, mismatches: [] });

  assert.throws(() => updateTransaction(edited.ledger, 'editable-payment', {
    amountMinor: 60000, principalMinor: 60000
  }, 'edit-overpay'), /还款本金不能超过当前债务/);
  assert.equal(edited.ledger.accounts.find(account => account.id === 'cash').balanceMinor, 70000);
  assert.equal(edited.ledger.accounts.find(account => account.id === 'card').balanceMinor, 20000);
});

test('创建和更新会校验信用卡及贷款元数据', () => {
  let ledger = createAccount(seed(), {
    id: 'new-card', name: '家庭信用卡', kind: 'liability', subtype: 'credit_card', openingBalanceMinor: 0,
    creditLimitMinor: 300000, statementDay: 10, dueDay: 28
  });
  assert.equal(ledger.accounts.find(account => account.id === 'new-card').creditLimitMinor, 300000);
  ledger = updateAccount(ledger, 'new-card', { dueDay: 25 });
  assert.equal(ledger.accounts.find(account => account.id === 'new-card').dueDay, 25);
  assert.throws(() => createAccount(seed(), {
    id: 'bad-day', name: '错误卡', kind: 'liability', subtype: 'credit_card', openingBalanceMinor: 0, dueDay: 32
  }), /日期必须介于 1 至 31/);
  assert.throws(() => createAccount(seed(), {
    id: 'bad-loan', name: '错误贷款', kind: 'liability', subtype: 'loan', openingBalanceMinor: 0,
    loanType: 'holiday', expectedPayoffDate: '2026-02-30'
  }), /贷款类型无效|预计还清日期无效/);
  const loanLedger = createAccount(seed(), {
    id: 'new-loan', name: '房贷', kind: 'liability', subtype: 'loan', openingBalanceMinor: 25000000,
    loanType: 'home', loanCalculationMode:'reducing_balance', annualInterestRateBps:420,
    originalPrincipalMinor: 30000000, scheduledPaymentMinor: 150000,
    expectedPayoffDate: '2040-08-24'
  });
  assert.equal(loanLedger.accounts.find(account => account.id === 'new-loan').loanType, 'home');
});

test('显式 asset→credit_card 转换仅允许零余额且无历史的账户，并保留账户 ID', () => {
  const emptyAsset = createAccount(seed(), { id: 'convert-me', name: '待转换账户', kind: 'asset', openingBalanceMinor: 0 });
  const converted = updateAccount(emptyAsset, 'convert-me', {
    subtype: 'credit_card', creditLimitMinor: 100000, statementDay: 5, dueDay: 20
  });
  const account = converted.accounts.find(candidate => candidate.id === 'convert-me');
  assert.equal(account.id, 'convert-me');
  assert.equal(account.kind, 'liability');
  assert.equal(account.subtype, 'credit_card');

  assert.throws(() => updateAccount(seed(), 'mbb', { subtype: 'loan', loanType: 'other' }), /零余额且无账目历史/);
  let historical = createAccount(seed(), { id: 'zero-history', name: '有历史', kind: 'asset', openingBalanceMinor: 0 });
  historical = applyOperation(historical, { id: 'in', kind: 'income', accountId: 'zero-history', amountMinor: 100 }).ledger;
  historical = applyOperation(historical, { id: 'out', kind: 'expense', accountId: 'zero-history', amountMinor: 100 }).ledger;
  assert.throws(() => updateAccount(historical, 'zero-history', { subtype: 'credit_card' }), /零余额且无账目历史/);
});

test('预计还清月数使用纯日期计算，不受时区解析影响', () => {
  const loan = { kind: 'liability', subtype: 'loan', expectedPayoffDate: '2027-08-24' };
  assert.equal(remainingPayoffMonths(loan, '2026-08-24'), 12);
  assert.equal(remainingPayoffMonths(loan, '2026-08-25'), 12);
  assert.equal(remainingPayoffMonths({ kind: 'liability', subtype: 'loan' }, '2026-08-24'), null);
  assert.equal(remainingPayoffMonths({ ...loan, expectedPayoffDate: '2026-08-23' }, '2026-08-24'), 0);
});
