import test from 'node:test';
import assert from 'node:assert/strict';
import { createLedger } from './ledger.js';
import {
  BACKUP_SCHEMA_VERSION, MAX_BACKUP_BYTES, chunkImportRecords, createBackupPayload,
  deterministicImportIdentity, replaceLocalAtomically, validateBackup
} from './backup-restore.js';

const T0 = '2026-08-25T00:00:00.000Z';
const ledger = () => createLedger({ accounts:[
  { id:'cash', name:'现金', kind:'asset', subtype:'asset', openingBalanceMinor:10000, balanceMinor:10000, includeInTotal:true, photoDataUrl:'data:image/jpeg;base64,AAAA', archivedAt:null }
], transactions:[
  { id:'tx-1', operationId:'op-1', actorUid:'old-user', kind:'expense', accountId:'cash', targetAccountId:null, amountMinor:1000, category:'购物', note:'午餐', occurredAt:T0, createdAt:T0, deletedAt:null, purgedAt:null, lastOperationId:'op-1' }
], appliedOperationIds:['op-1'] });
const item = { id:'bike', name:'脚踏车', note:'', fullPriceMinor:5000, paidMinor:1000, status:'active', coverMediaId:'cover-secret', createdByUid:'old-user', createdAt:T0, updatedByUid:'old-user', updatedAt:T0, archivedAt:null, revision:1, lastOperationId:'item-op', lastPaymentId:'pay-1' };
const payment = { id:'pay-1', itemId:'bike', type:'payment', amountMinor:1000, occurredAt:T0, note:'', receiptMediaId:'receipt-secret', ledgerMode:'independent', accountId:null, transactionId:null, status:'active', actorUid:'old-user', createdAt:T0, updatedByUid:'old-user', updatedAt:T0, voidedAt:null, lastOperationId:'pay-op' };

async function backup() {
  return createBackupPayload({ householdName:'家用', ledger:ledger(), items:[item], itemPayments:[payment], exportedAt:T0 });
}

test('安全 manifest/count/checksum 且不导出身份或媒体资料', async () => {
  const payload = await createBackupPayload({
    householdName:'家用', ledger:ledger(),
    items:[{ ...item, balanceMinor:4000, progress:20, payments:[payment], timeline:[{ type:'payment', paymentId:'pay-1', at:T0 }] }],
    itemPayments:[payment], exportedAt:T0
  });
  assert.equal(payload.schemaVersion, BACKUP_SCHEMA_VERSION);
  assert.deepEqual(payload.manifest.counts, { accounts:1, transactions:1, items:1, itemPayments:1 });
  const text = JSON.stringify(payload);
  assert.doesNotMatch(text, /data:image|old-user|actorUid|createdByUid|cover-secret|receipt-secret/);
  for (const field of ['balanceMinor', 'progress', 'payments', 'timeline']) assert.equal(Object.hasOwn(payload.items[0], field), false);
  const validated = await validateBackup(payload, { destinationHouseholdId:'restored-home', ownerUid:'owner-a' });
  assert.equal(validated.accounts[0].householdId, 'restored-home');
  assert.equal(validated.transactions[0].actorUid, 'owner-a');
  assert.equal(validated.items[0].coverMediaId, null);
  assert.equal(validated.itemPayments[0].receiptMediaId, null);
});

test('schema v2 可读；未知 schema、损坏引用、重复 ID、非整数金额、伪日期与身份/Data URL 拒绝', async () => {
  const payload = await backup();
  const { manifest, ...v2 } = payload;
  v2.schemaVersion = 2;
  await assert.doesNotReject(validateBackup(v2, { ownerUid:'owner-a' }));
  await assert.rejects(validateBackup({ ...v2, schemaVersion:99 }), /不支持/);
  await assert.rejects(validateBackup({ ...v2, ledger:{ ...v2.ledger, transactions:[{ ...v2.ledger.transactions[0], accountId:'missing' }] } }), /不存在账户/);
  await assert.rejects(validateBackup({ ...v2, ledger:{ ...v2.ledger, accounts:[v2.ledger.accounts[0], v2.ledger.accounts[0]] } }), /重复/);
  await assert.rejects(validateBackup({ ...v2, ledger:{ ...v2.ledger, transactions:[{ ...v2.ledger.transactions[0], amountMinor:1.5 }] } }), /安全整数/);
  await assert.rejects(validateBackup({ ...v2, ledger:{ ...v2.ledger, transactions:[{ ...v2.ledger.transactions[0], occurredAt:'2026-02-30' }] } }), /日期.*无效/);
  await assert.rejects(validateBackup({ ...v2, access:{ role:'owner' } }), /禁止字段/);
  await assert.rejects(validateBackup({ ...v2, extra:'data:image/png;base64,AAAA' }), /Data URL/);
  await assert.rejects(validateBackup(JSON.stringify(v2), { byteLength:MAX_BACKUP_BYTES + 1 }), /5MB/);
});

test('正式旧版 v2 的 household/actor/media bookkeeping 可读但会重绑身份并清除媒体', async () => {
  const payload = await backup();
  const { manifest:unused, ...v2 } = payload;
  v2.schemaVersion = 2;
  v2.household.id = 'old-home';
  v2.ledger.accounts[0].householdId = 'old-home';
  v2.ledger.transactions[0].householdId = 'old-home';
  v2.ledger.transactions[0].actorUid = 'old-user';
  v2.items[0].householdId = 'old-home';
  v2.items[0].createdByUid = 'old-user';
  v2.items[0].updatedByUid = 'old-user';
  v2.items[0].coverMediaId = 'old-cover-reference';
  v2.items[0].balanceMinor = 4000;
  v2.items[0].progress = 20;
  v2.items[0].payments = [structuredClone(v2.itemPayments[0])];
  v2.items[0].timeline = [{ type:'payment', paymentId:'pay-1', at:T0 }];
  v2.itemPayments[0].householdId = 'old-home';
  v2.itemPayments[0].actorUid = 'old-user';
  v2.itemPayments[0].updatedByUid = 'old-user';
  v2.itemPayments[0].receiptMediaId = 'old-receipt-reference';
  const restored = await validateBackup(v2, { destinationHouseholdId:'new-home', ownerUid:'new-owner' });
  assert.equal(restored.accounts[0].householdId, 'new-home');
  assert.equal(restored.transactions[0].actorUid, 'new-owner');
  assert.equal(restored.items[0].createdByUid, 'new-owner');
  assert.equal(restored.items[0].coverMediaId, null);
  assert.equal(restored.itemPayments[0].actorUid, 'new-owner');
  assert.equal(restored.itemPayments[0].receiptMediaId, null);
});

test('checksum 被修改会拒绝，未来 manifest 新字段保持向后兼容', async () => {
  const payload = await backup();
  payload.manifest.futureSafeField = { ignored:true };
  await assert.doesNotReject(validateBackup(payload, { ownerUid:'owner-a' }));
  payload.ledger.transactions[0].note = 'tampered';
  await assert.rejects(validateBackup(payload, { ownerUid:'owner-a' }), /checksum/);
});

test('确定性 import 身份、低于 500 的分批与幂等重试不产生第二目的地', async () => {
  const payload = await backup();
  const first = await deterministicImportIdentity(payload, 'owner-a');
  const retry = await deterministicImportIdentity(payload, 'owner-a');
  assert.deepEqual(first, retry);
  const validated = await validateBackup(payload, { destinationHouseholdId:first.householdId, ownerUid:'owner-a' });
  const chunks = chunkImportRecords(validated, 2);
  assert.equal(chunks.flat().length, 4);
  assert.ok(chunks.every(chunk => chunk.length <= 2 && chunk.length < 500));
});

test('本机恢复先备份、原子替换、reload 可读；写失败回滚原资料', async () => {
  let value = JSON.stringify({ old:true });
  let downloaded = false;
  const storage = { getItem:() => value, setItem:(_key,next) => { value = next; }, removeItem:() => { value = null; } };
  const payload = await backup();
  const validated = await validateBackup(payload, { destinationHouseholdId:'local', ownerUid:'local' });
  await replaceLocalAtomically({ storage, storeKey:'wallet', validated, downloadCurrent:async () => { downloaded = true; } });
  assert.equal(downloaded, true);
  assert.equal(JSON.parse(value).ledger.transactions.length, 1);
  const previous = JSON.stringify({ untouched:true });
  value = previous;
  let attempts = 0;
  const failing = { ...storage, setItem:(_key,next) => { attempts += 1; if (attempts === 1) throw new Error('quota'); value = next; } };
  await assert.rejects(replaceLocalAtomically({ storage:failing, storeKey:'wallet', validated, downloadCurrent:async () => {} }), /quota/);
  assert.equal(value, previous);
});
