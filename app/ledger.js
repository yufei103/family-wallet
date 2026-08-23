export const money = value => {
  if (!Number.isSafeInteger(value)) throw new Error('金额必须是安全整数 sen');
  if (value <= 0) throw new Error('金额必须大于零');
  return value;
};

const clone = value => structuredClone(value);
const byId = (accounts, id) => accounts.find(account => account.id === id);
const normaliseAccountPhoto = value => {
  if (value === null || value === undefined || value === '') return null;
  const photo = String(value);
  if (!/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(photo)) throw new Error('账户照片格式无效');
  if (photo.length > 300000) throw new Error('账户照片过大');
  return photo;
};
const activeAccount = (accounts, id) => {
  const account = byId(accounts, id);
  if (!account) throw new Error('账户不存在');
  if (account.archivedAt) throw new Error('已归档账户不可记账');
  return account;
};
const impact = (accounts, entry, direction) => {
  const amount = entry.amountMinor * direction;
  const source = byId(accounts, entry.accountId);
  if (!source) throw new Error('账目来源账户不存在');
  if (entry.kind === 'income') source.balanceMinor += amount;
  if (entry.kind === 'expense') source.balanceMinor -= amount;
  if (entry.kind === 'transfer') {
    const target = byId(accounts, entry.targetAccountId);
    if (!target) throw new Error('账目目标账户不存在');
    source.balanceMinor -= amount;
    target.balanceMinor += amount;
  }
};

const normaliseTransactions = transactions => transactions.map((transaction, index) => ({
  ...transaction,
  createdAt: transaction.createdAt ?? new Date(index).toISOString(),
  purgedAt: transaction.purgedAt ?? null
}));

export function createLedger({ accounts = [], transactions = [], appliedOperationIds = [] } = {}) {
  return {
    accounts: clone(accounts),
    transactions: clone(normaliseTransactions(transactions)),
    appliedOperationIds: new Set(appliedOperationIds)
  };
}

export function deriveLedger({ accounts = [], transactions = [], appliedOperationIds = [] } = {}) {
  const ledger = createLedger({
    accounts: accounts.map(account => ({ ...account, balanceMinor: account.openingBalanceMinor ?? 0 })),
    transactions,
    appliedOperationIds
  });
  for (const entry of ledger.transactions.filter(entry => !entry.deletedAt && !entry.purgedAt)) impact(ledger.accounts, entry, 1);
  return ledger;
}

export function compareEntriesNewestFirst(a, b) {
  return String(b.occurredAt ?? '').localeCompare(String(a.occurredAt ?? ''))
    || String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? ''))
    || String(b.id ?? '').localeCompare(String(a.id ?? ''));
}

export function serialiseLedger(ledger) {
  return { ...clone(ledger), appliedOperationIds: [...ledger.appliedOperationIds] };
}

export function applyOperation(ledger, operation) {
  if (!operation?.id) throw new Error('operationId 必填');
  if (ledger.appliedOperationIds.has(operation.id)) return { ledger, duplicate: true };
  const transactionId = operation.transactionId ?? operation.id;
  if (!transactionId) throw new Error('账目 ID 必填');
  if (ledger.transactions.some(transaction => transaction.id === transactionId)) throw new Error('账目 ID 已存在');
  const next = createLedger(serialiseLedger(ledger));
  const amountMinor = money(operation.amountMinor);
  const account = activeAccount(next.accounts, operation.accountId);
  if (operation.kind === 'transfer') {
    const target = activeAccount(next.accounts, operation.targetAccountId);
    if (target.id === account.id) throw new Error('不能转账到同一账户');
  } else if (!['income', 'expense'].includes(operation.kind)) {
    throw new Error('不支持的账务类型');
  }
  const entry = {
    id: transactionId,
    operationId: operation.id,
    kind: operation.kind,
    accountId: operation.accountId,
    targetAccountId: operation.targetAccountId ?? null,
    amountMinor,
    category: operation.category ?? null,
    note: operation.note ?? '',
    occurredAt: operation.occurredAt ?? new Date().toISOString(),
    createdAt: operation.createdAt ?? new Date().toISOString(),
    lastOperationId: operation.id,
    purgedAt: null,
    deletedAt: null
  };
  // Linked item-payment provenance is optional and immutable.  Do not add
  // these keys to ordinary/legacy entries: their persisted shape stays the
  // same, while clone/derive/edit naturally preserve keys that are present.
  if (operation.sourceType !== undefined) entry.sourceType = operation.sourceType;
  if (operation.sourceItemId !== undefined) entry.sourceItemId = operation.sourceItemId;
  if (operation.sourcePaymentId !== undefined) entry.sourcePaymentId = operation.sourcePaymentId;
  impact(next.accounts, entry, 1);
  next.transactions.push(entry);
  next.appliedOperationIds.add(operation.id);
  return { ledger: next, duplicate: false };
}

export function createAccount(ledger, account) {
  const name = String(account?.name ?? '').trim();
  if (!account?.id || !name) throw new Error('账户名称必填');
  if (byId(ledger.accounts, account.id)) throw new Error('账户 ID 已存在');
  if (!['asset', 'liability'].includes(account.kind)) throw new Error('账户类型无效');
  if (!Number.isSafeInteger(account.openingBalanceMinor ?? 0)) throw new Error('期初余额必须是整数 sen');
  const next = createLedger(serialiseLedger(ledger));
  next.accounts.push({
    id: account.id,
    name,
    kind: account.kind,
    openingBalanceMinor: account.openingBalanceMinor ?? 0,
    balanceMinor: account.openingBalanceMinor ?? 0,
    includeInTotal: account.includeInTotal !== false,
    photoDataUrl: normaliseAccountPhoto(account.photoDataUrl),
    archivedAt: null
  });
  return next;
}

export function updateAccount(ledger, accountId, changes) {
  const next = createLedger(serialiseLedger(ledger));
  const account = byId(next.accounts, accountId);
  if (!account) throw new Error('账户不存在');
  if (changes.name !== undefined) {
    const name = String(changes.name).trim();
    if (!name) throw new Error('账户名称必填');
    account.name = name;
  }
  if (changes.includeInTotal !== undefined) account.includeInTotal = Boolean(changes.includeInTotal);
  if (changes.photoDataUrl !== undefined) account.photoDataUrl = normaliseAccountPhoto(changes.photoDataUrl);
  return next;
}

export function archiveAccount(ledger, accountId, archivedAt = new Date().toISOString()) {
  const next = createLedger(serialiseLedger(ledger));
  const account = byId(next.accounts, accountId);
  if (!account) throw new Error('账户不存在');
  account.archivedAt = archivedAt;
  account.includeInTotal = false;
  return next;
}

export function updateTransaction(ledger, transactionId, changes, operationId) {
  if (!operationId) throw new Error('编辑 operationId 必填');
  if (ledger.appliedOperationIds.has(operationId)) return { ledger, duplicate: true };
  const next = createLedger(serialiseLedger(ledger));
  const entry = next.transactions.find(transaction => transaction.id === transactionId);
  if (!entry) throw new Error('账目不存在');
  if (entry.deletedAt) throw new Error('回收站账目不可编辑，请先恢复');
  impact(next.accounts, entry, -1);
  const kind = changes.kind ?? entry.kind;
  const accountId = changes.accountId ?? entry.accountId;
  const targetAccountId = changes.targetAccountId ?? entry.targetAccountId;
  activeAccount(next.accounts, accountId);
  if (kind === 'transfer') {
    const target = activeAccount(next.accounts, targetAccountId);
    if (target.id === accountId) throw new Error('不能转账到同一账户');
  } else if (!['income', 'expense'].includes(kind)) throw new Error('不支持的账务类型');
  Object.assign(entry, {
    kind,
    accountId,
    targetAccountId: kind === 'transfer' ? targetAccountId : null,
    amountMinor: changes.amountMinor === undefined ? entry.amountMinor : money(changes.amountMinor),
    category: changes.category ?? entry.category,
    note: changes.note ?? entry.note,
    occurredAt: changes.occurredAt ?? entry.occurredAt
  });
  entry.lastOperationId = operationId;
  impact(next.accounts, entry, 1);
  next.appliedOperationIds.add(operationId);
  return { ledger: next, duplicate: false };
}

const mutationOperation = (ledger, operationId, label) => {
  if (!operationId) throw new Error(`${label} operationId 必填`);
  if (ledger.appliedOperationIds.has(operationId)) return null;
  return createLedger(serialiseLedger(ledger));
};

export function moveToRecycleBin(ledger, transactionId, operationId, deletedAt = new Date().toISOString()) {
  const next = mutationOperation(ledger, operationId, '回收');
  if (!next) return { ledger, duplicate: true };
  const entry = next.transactions.find(transaction => transaction.id === transactionId);
  if (!entry) throw new Error('账目不存在');
  if (entry.deletedAt) throw new Error('账目已在回收站');
  impact(next.accounts, entry, -1);
  entry.deletedAt = deletedAt;
  entry.lastOperationId = operationId;
  next.appliedOperationIds.add(operationId);
  return { ledger: next, duplicate: false };
}

export function restoreFromRecycleBin(ledger, transactionId, operationId) {
  const next = mutationOperation(ledger, operationId, '恢复');
  if (!next) return { ledger, duplicate: true };
  const entry = next.transactions.find(transaction => transaction.id === transactionId);
  if (!entry) throw new Error('账目不存在');
  if (!entry.deletedAt) throw new Error('账目不在回收站');
  impact(next.accounts, entry, 1);
  entry.deletedAt = null;
  entry.lastOperationId = operationId;
  next.appliedOperationIds.add(operationId);
  return { ledger: next, duplicate: false };
}

export function permanentlyDelete(ledger, transactionId, operationId) {
  const next = mutationOperation(ledger, operationId, '永久删除');
  if (!next) return { ledger, duplicate: true };
  const index = next.transactions.findIndex(transaction => transaction.id === transactionId);
  if (index < 0) throw new Error('账目不存在');
  if (!next.transactions[index].deletedAt) throw new Error('请先移入回收站');
  next.transactions.splice(index, 1);
  next.appliedOperationIds.add(operationId);
  return { ledger: next, duplicate: false };
}

export function reconcile(ledger) {
  const calculated = new Map(ledger.accounts.map(account => [account.id, account.openingBalanceMinor ?? 0]));
  const integrityIssues = [];
  for (const entry of ledger.transactions.filter(entry => !entry.deletedAt && !entry.purgedAt)) {
    if (!calculated.has(entry.accountId)) {
      integrityIssues.push({ transactionId: entry.id, field: 'accountId', accountId: entry.accountId, reason: '账户不存在' });
      continue;
    }
    if (!Number.isSafeInteger(entry.amountMinor) || entry.amountMinor <= 0) {
      integrityIssues.push({ transactionId: entry.id, field: 'amountMinor', reason: '金额无效' });
      continue;
    }
    if (entry.kind === 'income') calculated.set(entry.accountId, calculated.get(entry.accountId) + entry.amountMinor);
    else if (entry.kind === 'expense') calculated.set(entry.accountId, calculated.get(entry.accountId) - entry.amountMinor);
    else if (entry.kind === 'transfer') {
      if (!calculated.has(entry.targetAccountId)) {
        integrityIssues.push({ transactionId: entry.id, field: 'targetAccountId', accountId: entry.targetAccountId, reason: '账户不存在' });
        continue;
      }
      if (entry.targetAccountId === entry.accountId) {
        integrityIssues.push({ transactionId: entry.id, field: 'targetAccountId', accountId: entry.targetAccountId, reason: '不能转账到同一账户' });
        continue;
      }
      calculated.set(entry.accountId, calculated.get(entry.accountId) - entry.amountMinor);
      calculated.set(entry.targetAccountId, calculated.get(entry.targetAccountId) + entry.amountMinor);
    } else integrityIssues.push({ transactionId: entry.id, field: 'kind', reason: '不支持的账务类型' });
  }
  const mismatches = ledger.accounts
    .filter(account => calculated.get(account.id) !== account.balanceMinor)
    .map(account => ({ id: account.id, expected: calculated.get(account.id), actual: account.balanceMinor }));
  if (integrityIssues.length) return { ok: false, mismatches, integrityIssues };
  return { ok: mismatches.length === 0, mismatches };
}

export function householdTotals(ledger) {
  const included = ledger.accounts.filter(account => !account.archivedAt && account.includeInTotal !== false);
  const assetsMinor = included.filter(account => account.kind === 'asset').reduce((sum, account) => sum + account.balanceMinor, 0);
  const liabilitiesMinor = included.filter(account => account.kind === 'liability').reduce((sum, account) => sum + account.balanceMinor, 0);
  return { assetsMinor, liabilitiesMinor, netMinor: assetsMinor - liabilitiesMinor };
}

export function monthlySummary(ledger, monthKey) {
  const entries = ledger.transactions.filter(entry => !entry.deletedAt && !entry.purgedAt && entry.occurredAt.slice(0, 7) === monthKey);
  return entries.reduce((summary, entry) => {
    if (entry.kind === 'income') summary.incomeMinor += entry.amountMinor;
    if (entry.kind === 'expense') summary.expenseMinor += entry.amountMinor;
    return summary;
  }, { incomeMinor: 0, expenseMinor: 0 });
}

export const formatRM = amountMinor => new Intl.NumberFormat('en-MY', { style: 'currency', currency: 'MYR' }).format(amountMinor / 100);
