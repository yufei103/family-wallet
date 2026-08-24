export const money = value => {
  if (!Number.isSafeInteger(value)) throw new Error('金额必须是安全整数 sen');
  if (value <= 0) throw new Error('金额必须大于零');
  return value;
};

const clone = value => structuredClone(value);
const byId = (accounts, id) => accounts.find(account => account.id === id);
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const ACCOUNT_SUBTYPES = new Set(['asset', 'credit_card', 'loan', 'generic_liability']);
const CREDIT_CARD_FIELDS = ['creditLimitMinor', 'statementDay', 'dueDay'];
const LOAN_FIELDS = ['loanType', 'loanCalculationMode', 'annualInterestRateBps', 'originalPrincipalMinor', 'scheduledPaymentMinor', 'expectedPayoffDate'];
const ACCOUNT_METADATA_FIELDS = [...CREDIT_CARD_FIELDS, ...LOAN_FIELDS];

export function accountSubtype(account) {
  return account?.subtype ?? (account?.kind === 'liability' ? 'generic_liability' : 'asset');
}

export function loanCalculationMode(account) {
  if (account?.loanCalculationMode) return account.loanCalculationMode;
  if (account?.loanType === 'home') return 'reducing_balance';
  if (account?.loanType === 'car') return 'fixed_instalment';
  return 'manual';
}

export function estimatedMonthlyInterestMinor(account) {
  if (accountSubtype(account) !== 'loan' || loanCalculationMode(account) !== 'reducing_balance') return 0;
  const rateBps = account.annualInterestRateBps ?? 0;
  if (!Number.isInteger(rateBps) || rateBps <= 0) return 0;
  return Math.max(0, Math.round(account.balanceMinor * rateBps / 120000));
}

export function suggestedRepayment(account) {
  const balanceMinor = Math.max(0, account?.balanceMinor ?? 0);
  const subtype = accountSubtype(account);
  if (balanceMinor === 0) return { amountMinor:0, principalMinor:0, interestMinor:0 };
  if (subtype !== 'loan') return { amountMinor:balanceMinor, principalMinor:balanceMinor, interestMinor:0 };
  const mode = loanCalculationMode(account);
  const estimatedInterestMinor = estimatedMonthlyInterestMinor(account);
  const scheduled = account.scheduledPaymentMinor ?? 0;
  if (mode === 'fixed_instalment' || mode === 'manual') {
    const amountMinor = Math.min(balanceMinor, scheduled || balanceMinor);
    return { amountMinor, principalMinor:amountMinor, interestMinor:0 };
  }
  const amountMinor = scheduled || balanceMinor + estimatedInterestMinor;
  const interestMinor = Math.min(amountMinor, estimatedInterestMinor);
  const principalMinor = Math.min(balanceMinor, Math.max(0, amountMinor - interestMinor));
  return { amountMinor:principalMinor + interestMinor, principalMinor, interestMinor };
}

export function repaymentBreakdown(account, amountMinor, interestOverrideMinor) {
  money(amountMinor);
  const subtype = accountSubtype(account);
  if (subtype !== 'loan' || loanCalculationMode(account) !== 'reducing_balance') {
    if (amountMinor > account.balanceMinor) throw new Error('还款金额不能超过当前欠款');
    return { amountMinor, principalMinor:amountMinor, interestMinor:0 };
  }
  const interestMinor = interestOverrideMinor === undefined || interestOverrideMinor === null
    ? Math.min(amountMinor, estimatedMonthlyInterestMinor(account))
    : nonNegativeMinor(interestOverrideMinor, '还款利息');
  if (interestMinor > amountMinor) throw new Error('利息不能超过本次还款总额');
  const principalMinor = amountMinor - interestMinor;
  if (principalMinor <= 0) throw new Error('还款金额必须高于本期利息');
  if (principalMinor > account.balanceMinor) throw new Error('还款本金不能超过当前债务');
  return { amountMinor, principalMinor, interestMinor };
}

const subtypeKind = subtype => subtype === 'asset' ? 'asset' : 'liability';
const positiveOptionalMinor = (value, label) => {
  if (value === null || value === undefined) return;
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label}必须是大于零的整数 sen`);
};
const calendarDateParts = (value, label) => {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new Error(`${label}无效`);
    return [value.getFullYear(), value.getMonth() + 1, value.getDate()];
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ''));
  if (!match) throw new Error(`${label}无效`);
  const parts = match.slice(1).map(Number);
  const date = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  if (date.getUTCFullYear() !== parts[0] || date.getUTCMonth() + 1 !== parts[1] || date.getUTCDate() !== parts[2]) {
    throw new Error(`${label}无效`);
  }
  return parts;
};

const validateAccountContract = account => {
  const subtype = accountSubtype(account);
  if (!ACCOUNT_SUBTYPES.has(subtype) || subtypeKind(subtype) !== account.kind) throw new Error('账户子类型无效');
  if (account.kind === 'liability' && (account.openingBalanceMinor ?? 0) < 0) throw new Error('负债期初余额不能为负数');
  const allowed = subtype === 'credit_card' ? new Set(CREDIT_CARD_FIELDS) : subtype === 'loan' ? new Set(LOAN_FIELDS) : new Set();
  for (const field of ACCOUNT_METADATA_FIELDS) {
    if (!allowed.has(field) && account[field] !== null && account[field] !== undefined) throw new Error('账户元数据与子类型不匹配');
  }
  if (subtype === 'credit_card') {
    positiveOptionalMinor(account.creditLimitMinor, '信用额度');
    for (const field of ['statementDay', 'dueDay']) {
      const value = account[field];
      if (value !== null && value !== undefined && (!Number.isInteger(value) || value < 1 || value > 31)) {
        throw new Error('账单日期必须介于 1 至 31');
      }
    }
  }
  if (subtype === 'loan') {
    if (account.loanType !== null && account.loanType !== undefined && !['car', 'home', 'other'].includes(account.loanType)) {
      throw new Error('贷款类型无效');
    }
    if (account.loanCalculationMode !== null && account.loanCalculationMode !== undefined && !['fixed_instalment', 'reducing_balance', 'manual'].includes(account.loanCalculationMode)) {
      throw new Error('贷款计算方式无效');
    }
    if (account.annualInterestRateBps !== null && account.annualInterestRateBps !== undefined && (!Number.isInteger(account.annualInterestRateBps) || account.annualInterestRateBps <= 0 || account.annualInterestRateBps > 10000)) {
      throw new Error('贷款年利率必须介于 0.01% 至 100%');
    }
    if (loanCalculationMode(account) !== 'reducing_balance' && account.annualInterestRateBps !== null && account.annualInterestRateBps !== undefined) {
      throw new Error('只有递减余额贷款需要年利率');
    }
    positiveOptionalMinor(account.originalPrincipalMinor, '原始本金');
    positiveOptionalMinor(account.scheduledPaymentMinor, '计划还款额');
    if (account.expectedPayoffDate !== null && account.expectedPayoffDate !== undefined) {
      if (typeof account.expectedPayoffDate !== 'string') throw new Error('预计还清日期无效');
      calendarDateParts(account.expectedPayoffDate, '预计还清日期');
    }
  }
  return subtype;
};

export function remainingPayoffMonths(account, asOf = new Date()) {
  if (!account?.expectedPayoffDate) return null;
  const [targetYear, targetMonth, targetDay] = calendarDateParts(account.expectedPayoffDate, '预计还清日期');
  const [year, month, day] = calendarDateParts(asOf, '起算日期');
  const months = (targetYear - year) * 12 + targetMonth - month + (targetDay > day ? 1 : 0);
  return Math.max(0, months);
}

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
const nonNegativeMinor = (value, label) => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label}必须是非负整数 sen`);
  return value;
};
const repaymentParts = (value, target) => {
  const amountMinor = money(value.amountMinor);
  const subtype = validateAccountContract(target);
  let principalMinor = value.principalMinor;
  let interestMinor = value.interestMinor;
  if (subtype !== 'loan') {
    principalMinor = principalMinor ?? amountMinor;
    interestMinor = interestMinor ?? 0;
    nonNegativeMinor(principalMinor, '还款本金');
    nonNegativeMinor(interestMinor, '还款利息');
    if (principalMinor !== amountMinor || interestMinor !== 0) throw new Error('信用卡及一般负债还款必须全部计入本金且利息为零');
  } else {
    if (principalMinor === undefined && interestMinor === undefined) {
      principalMinor = amountMinor;
      interestMinor = 0;
    } else if (principalMinor === undefined) principalMinor = amountMinor - interestMinor;
    else if (interestMinor === undefined) interestMinor = amountMinor - principalMinor;
    nonNegativeMinor(principalMinor, '还款本金');
    nonNegativeMinor(interestMinor, '还款利息');
    if (principalMinor + interestMinor !== amountMinor) throw new Error('贷款还款本金与利息之和必须等于总额');
  }
  if (principalMinor > target.balanceMinor) throw new Error('还款本金不能超过当前债务');
  return { amountMinor, principalMinor, interestMinor };
};
const validateEntryForApplication = (accounts, value) => {
  if (value.kind === 'repayment') {
    const target = activeAccount(accounts, value.targetAccountId);
    if (target.kind !== 'liability') throw new Error('还款目标必须是负债账户');
    const source = value.accountId === null || value.accountId === undefined ? null : activeAccount(accounts, value.accountId);
    if (source && source.kind !== 'asset') throw new Error('还款来源必须是资产账户');
    return { accountId: source?.id ?? null, targetAccountId: target.id, ...repaymentParts(value, target) };
  }
  const source = activeAccount(accounts, value.accountId);
  const amountMinor = money(value.amountMinor);
  if (value.kind === 'transfer') {
    const target = activeAccount(accounts, value.targetAccountId);
    if (target.id === source.id) throw new Error('不能转账到同一账户');
    if (source.kind !== 'asset' || target.kind !== 'asset') throw new Error('转账仅支持资产账户');
    return { accountId: source.id, targetAccountId: target.id, amountMinor };
  }
  if (!['income', 'expense'].includes(value.kind)) throw new Error('不支持的账务类型');
  if (value.kind === 'income' && source.kind !== 'asset') throw new Error('收入仅支持资产账户');
  return { accountId: source.id, targetAccountId: null, amountMinor };
};
const impact = (accounts, entry, direction) => {
  const amount = entry.amountMinor * direction;
  if (entry.kind === 'repayment') {
    const source = entry.accountId === null || entry.accountId === undefined ? null : byId(accounts, entry.accountId);
    const target = byId(accounts, entry.targetAccountId);
    if (entry.accountId !== null && entry.accountId !== undefined && !source) throw new Error('账目来源账户不存在');
    if (!target) throw new Error('账目目标账户不存在');
    if (source) source.balanceMinor -= amount;
    target.balanceMinor -= entry.principalMinor * direction;
    return;
  }
  const source = byId(accounts, entry.accountId);
  if (!source) throw new Error('账目来源账户不存在');
  if (entry.kind === 'income') source.balanceMinor += amount;
  if (entry.kind === 'expense') source.balanceMinor += source.kind === 'liability' ? amount : -amount;
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
  const validated = validateEntryForApplication(next.accounts, operation);
  const entry = {
    id: transactionId,
    operationId: operation.id,
    kind: operation.kind,
    accountId: validated.accountId,
    targetAccountId: validated.targetAccountId,
    amountMinor: validated.amountMinor,
    category: operation.category ?? null,
    note: operation.note ?? '',
    occurredAt: operation.occurredAt ?? new Date().toISOString(),
    createdAt: operation.createdAt ?? new Date().toISOString(),
    lastOperationId: operation.id,
    purgedAt: null,
    deletedAt: null
  };
  if (operation.kind === 'repayment') {
    entry.principalMinor = validated.principalMinor;
    entry.interestMinor = validated.interestMinor;
  }
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
  const created = {
    id: account.id,
    name,
    kind: account.kind,
    subtype: account.subtype ?? (account.kind === 'liability' ? 'generic_liability' : 'asset'),
    openingBalanceMinor: account.openingBalanceMinor ?? 0,
    balanceMinor: account.openingBalanceMinor ?? 0,
    includeInTotal: account.includeInTotal !== false,
    photoDataUrl: normaliseAccountPhoto(account.photoDataUrl),
    archivedAt: null
  };
  for (const field of ACCOUNT_METADATA_FIELDS) {
    if (account[field] !== null && account[field] !== undefined) created[field] = account[field];
  }
  validateAccountContract(created);
  const next = createLedger(serialiseLedger(ledger));
  next.accounts.push(created);
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
  if (changes.subtype !== undefined) {
    if (!ACCOUNT_SUBTYPES.has(changes.subtype)) throw new Error('账户子类型无效');
    const desiredKind = subtypeKind(changes.subtype);
    if (changes.kind !== undefined && changes.kind !== desiredKind) throw new Error('账户类型与子类型不匹配');
    if (desiredKind !== account.kind) {
      const hasHistory = next.transactions.some(entry => entry.accountId === accountId || entry.targetAccountId === accountId);
      if ((account.openingBalanceMinor ?? 0) !== 0 || account.balanceMinor !== 0 || hasHistory) {
        throw new Error('资产/负债类型转换仅允许零余额且无账目历史的账户');
      }
      account.kind = desiredKind;
    }
    account.subtype = changes.subtype;
    const allowed = changes.subtype === 'credit_card' ? new Set(CREDIT_CARD_FIELDS) : changes.subtype === 'loan' ? new Set(LOAN_FIELDS) : new Set();
    for (const field of ACCOUNT_METADATA_FIELDS) if (!allowed.has(field)) delete account[field];
  } else if (changes.kind !== undefined && changes.kind !== account.kind) {
    throw new Error('转换账户类型时必须显式选择子类型');
  }
  for (const field of ACCOUNT_METADATA_FIELDS) {
    if (!hasOwn(changes, field)) continue;
    if (changes[field] === null || changes[field] === undefined || changes[field] === '') delete account[field];
    else account[field] = changes[field];
  }
  if (changes.includeInTotal !== undefined) account.includeInTotal = Boolean(changes.includeInTotal);
  if (changes.photoDataUrl !== undefined) account.photoDataUrl = normaliseAccountPhoto(changes.photoDataUrl);
  validateAccountContract(account);
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
  const proposed = {
    ...entry,
    kind: changes.kind ?? entry.kind,
    accountId: hasOwn(changes, 'accountId') ? changes.accountId : entry.accountId,
    targetAccountId: hasOwn(changes, 'targetAccountId') ? changes.targetAccountId : entry.targetAccountId,
    amountMinor: changes.amountMinor === undefined ? entry.amountMinor : money(changes.amountMinor)
  };
  if (proposed.kind === 'repayment' && hasOwn(changes, 'amountMinor') && !hasOwn(changes, 'principalMinor')) {
    const target = byId(next.accounts, proposed.targetAccountId);
    if (target && accountSubtype(target) !== 'loan') proposed.principalMinor = proposed.amountMinor;
  }
  if (hasOwn(changes, 'principalMinor')) proposed.principalMinor = changes.principalMinor;
  if (hasOwn(changes, 'interestMinor')) proposed.interestMinor = changes.interestMinor;
  const validated = validateEntryForApplication(next.accounts, proposed);
  Object.assign(entry, {
    kind: proposed.kind,
    accountId: validated.accountId,
    targetAccountId: validated.targetAccountId,
    amountMinor: validated.amountMinor,
    category: hasOwn(changes, 'category') ? changes.category : entry.category,
    note: hasOwn(changes, 'note') ? changes.note : entry.note,
    occurredAt: hasOwn(changes, 'occurredAt') ? changes.occurredAt : entry.occurredAt
  });
  if (entry.kind === 'repayment') {
    entry.principalMinor = validated.principalMinor;
    entry.interestMinor = validated.interestMinor;
  } else {
    delete entry.principalMinor;
    delete entry.interestMinor;
  }
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
  validateEntryForApplication(next.accounts, entry);
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
  const accountMap = new Map(ledger.accounts.map(account => [account.id, account]));
  const calculated = new Map(ledger.accounts.map(account => [account.id, account.openingBalanceMinor ?? 0]));
  const integrityIssues = [];
  const issue = (entry, field, reason, accountId) => {
    const detail = { transactionId: entry.id, field };
    if (accountId !== undefined) detail.accountId = accountId;
    detail.reason = reason;
    integrityIssues.push(detail);
  };
  for (const entry of ledger.transactions.filter(entry => !entry.deletedAt && !entry.purgedAt)) {
    const sourceRequired = entry.kind !== 'repayment' || (entry.accountId !== null && entry.accountId !== undefined);
    if (sourceRequired && !calculated.has(entry.accountId)) {
      issue(entry, 'accountId', '账户不存在', entry.accountId);
      continue;
    }
    if (!Number.isSafeInteger(entry.amountMinor) || entry.amountMinor <= 0) {
      issue(entry, 'amountMinor', '金额无效');
      continue;
    }
    if (entry.kind === 'income') {
      if (accountMap.get(entry.accountId).kind !== 'asset') {
        issue(entry, 'accountId', '收入仅支持资产账户', entry.accountId);
        continue;
      }
      calculated.set(entry.accountId, calculated.get(entry.accountId) + entry.amountMinor);
    }
    else if (entry.kind === 'expense') {
      const direction = accountMap.get(entry.accountId).kind === 'liability' ? 1 : -1;
      calculated.set(entry.accountId, calculated.get(entry.accountId) + entry.amountMinor * direction);
    } else if (entry.kind === 'transfer') {
      if (!calculated.has(entry.targetAccountId)) {
        issue(entry, 'targetAccountId', '账户不存在', entry.targetAccountId);
        continue;
      }
      if (entry.targetAccountId === entry.accountId) {
        issue(entry, 'targetAccountId', '不能转账到同一账户', entry.targetAccountId);
        continue;
      }
      if (accountMap.get(entry.accountId).kind !== 'asset' || accountMap.get(entry.targetAccountId).kind !== 'asset') {
        issue(entry, 'kind', '转账仅支持资产账户');
        continue;
      }
      calculated.set(entry.accountId, calculated.get(entry.accountId) - entry.amountMinor);
      calculated.set(entry.targetAccountId, calculated.get(entry.targetAccountId) + entry.amountMinor);
    } else if (entry.kind === 'repayment') {
      if (!calculated.has(entry.targetAccountId)) {
        issue(entry, 'targetAccountId', '账户不存在', entry.targetAccountId);
        continue;
      }
      const target = accountMap.get(entry.targetAccountId);
      if (target.kind !== 'liability') {
        issue(entry, 'targetAccountId', '还款目标必须是负债账户', entry.targetAccountId);
        continue;
      }
      if (sourceRequired && accountMap.get(entry.accountId).kind !== 'asset') {
        issue(entry, 'accountId', '还款来源必须是资产账户', entry.accountId);
        continue;
      }
      const principalValid = Number.isSafeInteger(entry.principalMinor) && entry.principalMinor >= 0;
      const interestValid = Number.isSafeInteger(entry.interestMinor) && entry.interestMinor >= 0;
      if (!principalValid || !interestValid) {
        issue(entry, !principalValid ? 'principalMinor' : 'interestMinor', '还款拆分无效');
        continue;
      }
      const subtype = accountSubtype(target);
      if (!ACCOUNT_SUBTYPES.has(subtype) || subtypeKind(subtype) !== 'liability') {
        issue(entry, 'targetAccountId', '账户子类型无效', entry.targetAccountId);
        continue;
      }
      const splitValid = subtype === 'loan'
        ? entry.principalMinor + entry.interestMinor === entry.amountMinor
        : entry.principalMinor === entry.amountMinor && entry.interestMinor === 0;
      if (!splitValid) {
        issue(entry, 'amountMinor', '还款本金与利息不匹配');
        continue;
      }
      if (entry.principalMinor > calculated.get(entry.targetAccountId)) {
        issue(entry, 'principalMinor', '还款本金不能超过当前债务');
        continue;
      }
      if (sourceRequired) calculated.set(entry.accountId, calculated.get(entry.accountId) - entry.amountMinor);
      calculated.set(entry.targetAccountId, calculated.get(entry.targetAccountId) - entry.principalMinor);
    } else issue(entry, 'kind', '不支持的账务类型');
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
    if (entry.kind === 'repayment' && Number.isSafeInteger(entry.interestMinor)) summary.expenseMinor += entry.interestMinor;
    return summary;
  }, { incomeMinor: 0, expenseMinor: 0 });
}

export const formatRM = amountMinor => new Intl.NumberFormat('en-MY', { style: 'currency', currency: 'MYR' }).format(amountMinor / 100);
