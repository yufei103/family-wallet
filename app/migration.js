export function migrateLegacy({ householdId, actorUid, accounts = [], transactions = [] }) {
  if (!householdId || !actorUid) throw new Error('householdId 和 actorUid 必填');
  const migratedAccounts = accounts.map(account => ({
    id: account.id,
    householdId,
    name: account.name,
    kind: account.type === 'credit' ? 'liability' : 'asset',
    balanceMinor: Math.round(Number(account.balance) * 100),
    includeInTotal: account.includeInTotal !== false,
    openingBalanceMinor: 0,
    archivedAt: null
  }));
  const migratedTransactions = transactions.map((transaction, index) => ({
    id: transaction.id,
    householdId,
    operationId: `legacy-${transaction.id}`,
    actorUid,
    kind: transaction.isTransfer ? 'transfer' : transaction.isExpense ? 'expense' : 'income',
    amountMinor: Math.round(Number(transaction.amount) * 100),
    accountId: transaction.accountId,
    targetAccountId: transaction.targetAccountId ?? null,
    category: transaction.category ?? null,
    note: transaction.note ?? '',
    occurredAt: transaction.date,
    createdAt: transaction.createdAt ?? new Date(index).toISOString(),
    purgedAt: null,
    deletedAt: null
  }));
  return { accounts: migratedAccounts, transactions: migratedTransactions, report: reconcileMigration(migratedAccounts, migratedTransactions) };
}

export function reconcileMigration(accounts, transactions) {
  const known = new Set(accounts.map(a => a.id));
  const badReferences = transactions.filter(t => !known.has(t.accountId) || (t.kind === 'transfer' && !known.has(t.targetAccountId))).map(t => t.id);
  const totalMinor = accounts.filter(a => a.includeInTotal).reduce((sum, a) => sum + a.balanceMinor, 0);
  return { accountCount: accounts.length, transactionCount: transactions.length, totalMinor, badReferences, ok: badReferences.length === 0 };
}

const duplicateIds = values => values.filter((value, index) => values.indexOf(value) !== index);
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value) && !Number.isNaN(Date.parse(value));

/**
 * Build a local, side-effect-free migration review plan. This function never
 * reads old Firebase data and never writes any destination. An approved
 * operator must execute a separately reviewed import against an approved test
 * project; the plan's migrationId is the required tag for a targeted rollback.
 */
export function prepareMigration({ householdId, actorUid, migrationId, accounts = [], transactions = [] }) {
  const errors = [];
  if (!householdId) errors.push('householdId 必填');
  if (!actorUid) errors.push('actorUid 必填');
  if (!migrationId || !/^[A-Za-z0-9_-]{3,80}$/.test(migrationId)) errors.push('migrationId 必须为 3–80 位字母、数字、_ 或 -');
  if (!Array.isArray(accounts) || !Array.isArray(transactions)) errors.push('账户和交易必须为数组');
  if (errors.length === 0) {
    const accountIds = accounts.map(account => account?.id);
    const transactionIds = transactions.map(transaction => transaction?.id);
    if (accountIds.some(id => !id)) errors.push('每个账户必须有 ID');
    if (transactionIds.some(id => !id)) errors.push('每笔交易必须有 ID');
    if (duplicateIds(accountIds).length) errors.push('账户 ID 不可重复');
    if (duplicateIds(transactionIds).length) errors.push('交易 ID 不可重复');
    accounts.forEach(account => {
      if (!String(account?.name ?? '').trim()) errors.push(`账户 ${account?.id ?? '未知'} 名称必填`);
      if (!Number.isFinite(Number(account?.balance))) errors.push(`账户 ${account?.id ?? '未知'} 余额无效`);
    });
    transactions.forEach(transaction => {
      if (!Number.isFinite(Number(transaction?.amount)) || Number(transaction.amount) <= 0) errors.push(`交易 ${transaction?.id ?? '未知'} 金额必须大于零`);
      if (!validDate(transaction?.date)) errors.push(`交易 ${transaction?.id ?? '未知'} 日期无效`);
    });
  }

  let migration = null;
  if (errors.length === 0) {
    migration = migrateLegacy({ householdId, actorUid, accounts, transactions });
    if (!migration.report.ok) errors.push(`交易引用不存在账户：${migration.report.badReferences.join('、')}`);
    migration.transactions.filter(transaction => transaction.kind === 'transfer' && transaction.accountId === transaction.targetAccountId)
      .forEach(transaction => errors.push(`转账 ${transaction.id} 不可使用同一来源和目标账户`));
  }
  const validation = { ok: errors.length === 0, errors };
  return {
    ready: validation.ok,
    migration: validation.ok ? migration : null,
    plan: {
      migrationId: migrationId ?? null,
      source: 'operator-supplied-local-export-only',
      destination: 'approved-test-project-only',
      writeMode: 'operator-reviewed-only',
      validation,
      rollback: {
        mode: 'delete-imported-by-migration-id',
        requiresOperatorApproval: true,
        writesPerformed: false
      }
    }
  };
}
