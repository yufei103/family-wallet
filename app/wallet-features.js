const clone = value => structuredClone(value);
const TEMPLATE_STORE = 'family-wallet-v2-entry-templates';
const ONBOARDING_STORE = 'family-wallet-v2-onboarding-dismissed';

export function entryScopeKey(userId, householdId) {
  return `${String(userId || 'local')}::${String(householdId || 'local')}`;
}

export function filterEntries(entries, filters, accounts, formatMoney) {
  const accountNames = new Map(accounts.map(account => [account.id, account.name]));
  const keyword = String(filters.keyword || '').trim().toLocaleLowerCase('zh-CN');
  const from = filters.dateFrom || null;
  const to = filters.dateTo || null;
  const allMonths = Boolean(filters.allMonths || from || to);
  return entries.filter(entry => {
    const day = String(entry.occurredAt || '').slice(0, 10);
    if (!allMonths && filters.month && day.slice(0, 7) !== filters.month) return false;
    if (from && day < from) return false;
    if (to && day > to) return false;
    if (filters.kind && filters.kind !== 'all' && entry.kind !== filters.kind) return false;
    if (filters.accountId && filters.accountId !== 'all' && entry.accountId !== filters.accountId && entry.targetAccountId !== filters.accountId) return false;
    if (filters.category && filters.category !== 'all' && String(entry.category || '') !== filters.category) return false;
    if (!keyword) return true;
    const amount = Number.isSafeInteger(entry.amountMinor) ? entry.amountMinor : 0;
    const haystack = [
      entry.category, entry.note, accountNames.get(entry.accountId), accountNames.get(entry.targetAccountId),
      formatMoney?.(amount), (amount / 100).toFixed(2), String(amount / 100)
    ].filter(Boolean).join(' ').toLocaleLowerCase('zh-CN');
    return haystack.includes(keyword);
  });
}

export function activeFilterSummary(filters, accountName = '', resultCount = 0) {
  const labels = [];
  if (filters.keyword) labels.push(`“${filters.keyword}”`);
  if (filters.kind && filters.kind !== 'all') labels.push(({ income:'收入', expense:'支出', transfer:'转账', repayment:'还款' })[filters.kind]);
  if (filters.accountId && filters.accountId !== 'all') labels.push(accountName || '指定账户');
  if (filters.category && filters.category !== 'all') labels.push(filters.category);
  if (filters.dateFrom || filters.dateTo) labels.push(`${filters.dateFrom || '最早'} 至 ${filters.dateTo || '今天'}`);
  else if (filters.allMonths) labels.push('全部月份');
  return labels.length ? `${labels.join(' · ')} · ${resultCount} 个结果` : `${resultCount} 个结果`;
}

export function copyPreviousEntry(entries, kind) {
  if (!['income','expense','transfer'].includes(kind)) return null;
  const previous = entries.filter(entry => !entry.deletedAt && !entry.purgedAt && entry.kind === kind)
    .sort((a,b) => String(b.occurredAt).localeCompare(String(a.occurredAt)) || String(b.createdAt).localeCompare(String(a.createdAt)))[0];
  if (!previous) return null;
  return {
    kind:previous.kind, category:previous.category ?? '', note:previous.note ?? '',
    accountId:previous.accountId ?? null, targetAccountId:previous.targetAccountId ?? null,
    amountMinor:previous.amountMinor
  };
}

function readStore(storage, key) {
  try {
    const value = JSON.parse(storage.getItem(key) || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

export function loadEntryTemplates(storage, userId, householdId, kind = null) {
  const store = readStore(storage, TEMPLATE_STORE);
  const templates = store[entryScopeKey(userId, householdId)];
  return Array.isArray(templates) ? clone(templates).filter(template => template && typeof template.id === 'string'
    && (!kind || template.kind === kind)) : [];
}

export function saveEntryTemplate(storage, userId, householdId, template) {
  const store = readStore(storage, TEMPLATE_STORE);
  const scope = entryScopeKey(userId, householdId);
  const current = Array.isArray(store[scope]) ? store[scope] : [];
  const clean = {
    id:String(template.id), name:String(template.name || template.note || template.category || '常用账目').slice(0, 40),
    kind:template.kind, category:template.category ?? '', note:String(template.note ?? '').slice(0, 100),
    accountId:template.accountId ?? null, targetAccountId:template.targetAccountId ?? null,
    amountMinor:template.amountMinor
  };
  if (!['income','expense','transfer'].includes(clean.kind) || !Number.isSafeInteger(clean.amountMinor) || clean.amountMinor <= 0) throw new Error('模板内容无效');
  store[scope] = [...current.filter(item => item.id !== clean.id), clean].slice(-12);
  storage.setItem(TEMPLATE_STORE, JSON.stringify(store));
  return clone(clean);
}

export function deleteEntryTemplate(storage, userId, householdId, templateId) {
  const store = readStore(storage, TEMPLATE_STORE);
  const scope = entryScopeKey(userId, householdId);
  store[scope] = (Array.isArray(store[scope]) ? store[scope] : []).filter(item => item.id !== templateId);
  storage.setItem(TEMPLATE_STORE, JSON.stringify(store));
}

export function onboardingState({ accounts, transactions, isOwner, hasSharedHousehold, hasInvite }) {
  const steps = [
    { id:'account', label:'建立第一个账户', complete:accounts.some(account => !account.archivedAt), action:'account' },
    { id:'entry', label:'记录第一笔账目', complete:transactions.some(entry => !entry.deletedAt && !entry.purgedAt), action:'entry' }
  ];
  if (isOwner) steps.push({ id:'share', label:'邀请家人一起记账', complete:Boolean(hasSharedHousehold || hasInvite), action:'invite' });
  return { steps, complete:steps.every(step => step.complete) };
}

export function isOnboardingDismissed(storage, userId, householdId) {
  return readStore(storage, ONBOARDING_STORE)[entryScopeKey(userId, householdId)] === true;
}

export function dismissOnboarding(storage, userId, householdId) {
  const store = readStore(storage, ONBOARDING_STORE);
  store[entryScopeKey(userId, householdId)] = true;
  storage.setItem(ONBOARDING_STORE, JSON.stringify(store));
}

export function actorLabel(uid, currentUid, members = []) {
  if (!uid || uid === 'local') return currentUid === 'local' || !currentUid ? '你' : '家庭成员';
  if (uid === currentUid) return '你';
  const member = members.find(candidate => candidate.uid === uid);
  return String(member?.displayName || member?.email || '家庭成员');
}

export { TEMPLATE_STORE, ONBOARDING_STORE };
