import test from 'node:test';
import assert from 'node:assert/strict';
import {
  actorLabel, copyPreviousEntry, deleteEntryTemplate, dismissOnboarding, filterEntries,
  isOnboardingDismissed, loadEntryTemplates, onboardingState, saveEntryTemplate
} from './wallet-features.js';

const entries = [
  { id:'jan', kind:'expense', amountMinor:1234, category:'购物', note:'午餐', accountId:'cash', targetAccountId:null, occurredAt:'2026-01-10T12:00:00.000Z', createdAt:'2026-01-10T12:00:00.000Z' },
  { id:'feb', kind:'income', amountMinor:500000, category:'薪水', note:'二月', accountId:'bank', targetAccountId:null, occurredAt:'2026-02-02T12:00:00.000Z', createdAt:'2026-02-02T12:00:00.000Z' },
  { id:'transfer', kind:'transfer', amountMinor:1000, category:null, note:'零钱', accountId:'bank', targetAccountId:'cash', occurredAt:'2026-02-03T12:00:00.000Z', createdAt:'2026-02-03T12:00:00.000Z' }
];
const accounts = [{ id:'cash', name:'现金' }, { id:'bank', name:'Maybank' }];
const format = value => `RM ${(value / 100).toFixed(2)}`;
const memory = () => {
  const values = new Map();
  return { getItem:key => values.get(key) ?? null, setItem:(key,value) => values.set(key,value), removeItem:key => values.delete(key) };
};

test('搜索可组合关键词、类型、账户、分类与日期，金额可读文本可匹配', () => {
  assert.deepEqual(filterEntries(entries, { month:'2026-02', keyword:'Maybank', kind:'income', accountId:'bank', category:'薪水' }, accounts, format).map(x => x.id), ['feb']);
  assert.deepEqual(filterEntries(entries, { month:'2026-01', keyword:'RM 12.34' }, accounts, format).map(x => x.id), ['jan']);
  assert.deepEqual(filterEntries(entries, { month:'2026-02', kind:'transfer', accountId:'cash' }, accounts, format).map(x => x.id), ['transfer']);
});

test('默认月份限制列表；全部月份与自定义范围不会被月份偷偷截断', () => {
  assert.deepEqual(filterEntries(entries, { month:'2026-02' }, accounts, format).map(x => x.id), ['feb','transfer']);
  assert.equal(filterEntries(entries, { month:'2026-02', allMonths:true }, accounts, format).length, 3);
  assert.deepEqual(filterEntries(entries, { month:'2026-02', dateFrom:'2026-01-01', dateTo:'2026-01-31' }, accounts, format).map(x => x.id), ['jan']);
});

test('复制上一笔只取当前 kind，并只返回可编辑业务字段', () => {
  const copy = copyPreviousEntry(entries, 'transfer');
  assert.deepEqual(copy, { kind:'transfer', category:'', note:'零钱', accountId:'bank', targetAccountId:'cash', amountMinor:1000 });
  for (const forbidden of ['id','operationId','createdAt','occurredAt']) assert.equal(Object.hasOwn(copy, forbidden), false);
  assert.equal(copyPreviousEntry(entries, 'expense').kind, 'expense');
  assert.equal(copyPreviousEntry(entries, 'income').kind, 'income');
  assert.equal(copyPreviousEntry(entries, 'repayment'), null);
  assert.equal(copyPreviousEntry(entries.filter(entry => entry.kind !== 'income'), 'income'), null);
});

test('常用模板按 user+household 隔离，可删除且不会提交', () => {
  const storage = memory();
  saveEntryTemplate(storage, 'u1', 'h1', { id:'t1', name:'午餐', kind:'expense', category:'购物', note:'午餐', accountId:'cash', amountMinor:1200 });
  assert.equal(loadEntryTemplates(storage, 'u1', 'h1').length, 1);
  assert.equal(loadEntryTemplates(storage, 'u2', 'h1').length, 0);
  assert.equal(loadEntryTemplates(storage, 'u1', 'h2').length, 0);
  assert.equal(Object.hasOwn(loadEntryTemplates(storage, 'u1', 'h1')[0], 'submit'), false);
  deleteEntryTemplate(storage, 'u1', 'h1', 't1');
  assert.equal(loadEntryTemplates(storage, 'u1', 'h1').length, 0);
});

test('常用模板按 kind 过滤，0 与 4+ 模板场景保持 user+household 隔离', () => {
  const storage = memory();
  assert.deepEqual(loadEntryTemplates(storage, 'u1', 'h1', 'expense'), []);
  for (let index = 0; index < 5; index += 1) {
    saveEntryTemplate(storage, 'u1', 'h1', {
      id:`expense-${index}`, name:`支出 ${index}`, kind:'expense', category:'购物', note:'', accountId:'cash', amountMinor:100 + index
    });
  }
  saveEntryTemplate(storage, 'u1', 'h1', { id:'income-1', name:'薪水', kind:'income', category:'薪水', accountId:'bank', amountMinor:500000 });
  saveEntryTemplate(storage, 'u1', 'h1', { id:'transfer-1', name:'转账', kind:'transfer', accountId:'bank', targetAccountId:'cash', amountMinor:1000 });
  assert.equal(loadEntryTemplates(storage, 'u1', 'h1', 'expense').length, 5);
  assert.deepEqual(loadEntryTemplates(storage, 'u1', 'h1', 'income').map(template => template.id), ['income-1']);
  assert.deepEqual(loadEntryTemplates(storage, 'u1', 'h1', 'transfer').map(template => template.id), ['transfer-1']);
  assert.equal(loadEntryTemplates(storage, 'u2', 'h1', 'expense').length, 0);
  assert.equal(loadEntryTemplates(storage, 'u1', 'h2', 'expense').length, 0);
});

test('引导从真实资料与 owner 权限派生，dismiss 按成员与账本隔离', () => {
  const owner = onboardingState({ accounts:[], transactions:[], isOwner:true, hasSharedHousehold:false, hasInvite:false });
  assert.deepEqual(owner.steps.map(step => step.id), ['account','entry','share']);
  const member = onboardingState({ accounts, transactions:entries, isOwner:false, hasSharedHousehold:true, hasInvite:false });
  assert.equal(member.complete, true);
  assert.deepEqual(member.steps.map(step => step.id), ['account','entry']);
  const storage = memory();
  dismissOnboarding(storage, 'u1', 'h1');
  assert.equal(isOnboardingDismissed(storage, 'u1', 'h1'), true);
  assert.equal(isOnboardingDismissed(storage, 'u2', 'h1'), false);
});

test('actor UID 只翻译为你、成员名或家庭成员，从不原样显示', () => {
  const members = [{ uid:'u2', displayName:'妈妈', email:'mom@example.com' }];
  assert.equal(actorLabel('u1', 'u1', members), '你');
  assert.equal(actorLabel('u2', 'u1', members), '妈妈');
  assert.equal(actorLabel('legacy-secret-uid', 'u1', members), '家庭成员');
});
