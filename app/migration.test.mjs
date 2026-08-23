import test from 'node:test';
import assert from 'node:assert/strict';
import { migrateLegacy, prepareMigration } from './migration.js';

test('旧版 RM 账户与收支/转账可迁移为家庭账本且保留金额', () => {
  const result = migrateLegacy({ householdId: 'home-1', actorUid: 'owner-a', accounts: [
    { id: 'mbb', name: 'Maybank', balance: 5000, type: 'savings' },
    { id: 'pbb', name: 'Public Bank', balance: 300, type: 'savings', includeInTotal: false },
    { id: 'cc', name: 'Credit Card', balance: -125, type: 'credit' }
  ], transactions: [
    { id: 't-expense', amount: 12.5, isExpense: true, accountId: 'mbb', date: '2026-07-17' },
    { id: 't-income', amount: 3800, isExpense: false, accountId: 'mbb', date: '2026-07-15' },
    { id: 't-transfer', amount: 200, isTransfer: true, accountId: 'mbb', targetAccountId: 'pbb', date: '2026-07-16' }
  ] });
  assert.equal(result.accounts[0].balanceMinor, 500000);
  assert.equal(result.accounts[1].includeInTotal, false);
  assert.equal(result.accounts[2].kind, 'liability');
  assert.equal(result.transactions[0].kind, 'expense');
  assert.equal(result.transactions[0].createdAt, '1970-01-01T00:00:00.000Z');
  assert.equal(result.transactions[2].createdAt, '1970-01-01T00:00:00.002Z');
  assert.equal(result.transactions[2].kind, 'transfer');
  assert.equal(result.report.ok, true);
  assert.equal(result.report.transactionCount, 3);
});

test('迁移会拦截引用不存在账户的交易', () => {
  const result = migrateLegacy({ householdId: 'home-1', actorUid: 'owner-a', accounts: [{ id: 'mbb', name: 'Maybank', balance: 0, type: 'savings' }], transactions: [{ id: 'bad', amount: 1, isExpense: true, accountId: 'missing', date: '2026-07-17' }] });
  assert.equal(result.report.ok, false);
  assert.deepEqual(result.report.badReferences, ['bad']);
});

test('迁移预检会生成可审阅、可回滚的本地计划，且不接受无效导入', () => {
  const input = {
    householdId: 'home-1', actorUid: 'owner-a', migrationId: 'review-2026-07-17',
    accounts: [{ id: 'mbb', name: 'Maybank', balance: 5000, type: 'savings' }],
    transactions: [{ id: 'expense-1', amount: 12.5, isExpense: true, accountId: 'mbb', date: '2026-07-17' }]
  };
  const prepared = prepareMigration(input);
  assert.equal(prepared.ready, true);
  assert.equal(prepared.plan.migrationId, 'review-2026-07-17');
  assert.equal(prepared.plan.writeMode, 'operator-reviewed-only');
  assert.deepEqual(prepared.plan.rollback, {
    mode: 'delete-imported-by-migration-id',
    requiresOperatorApproval: true,
    writesPerformed: false
  });
  assert.deepEqual(prepared.plan.validation, { ok: true, errors: [] });

  const rejected = prepareMigration({ ...input, transactions: [{ id: 'bad', amount: 0, isExpense: true, accountId: 'missing', date: 'not-a-date' }] });
  assert.equal(rejected.ready, false);
  assert.match(rejected.plan.validation.errors.join(' '), /金额|账户|日期/);
  assert.equal(rejected.plan.rollback.writesPerformed, false);
});
