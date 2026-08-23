import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { arrayUnion, doc, getDoc, runTransaction, setDoc, updateDoc, writeBatch } from 'firebase/firestore';

const projectId = 'family-wallet-v2-emulator';
const householdId = 'home-kris';
const ownerEmail = 'owner@gmail.com';
const memberEmail = 'member@gmail.com';
const T0 = '2026-08-22T00:00:00.000Z';
const T1 = '2026-08-22T01:00:00.000Z';
const T2 = '2026-08-22T02:00:00.000Z';
const JPEG = 'data:image/jpeg;base64,/9j/2Q==';
let env;

const authDb = (uid, email) => env.authenticatedContext(uid, { email }).firestore();
const memberRecord = (uid, email, role) => ({ uid, email, displayName: uid, role, active: true, joinedAt: T0 });
const itemRecord = (id, overrides = {}) => ({
  id,
  householdId,
  name: '脚踏车',
  note: '',
  fullPriceMinor: 10000,
  paidMinor: 0,
  status: 'active',
  coverMediaId: null,
  createdByUid: 'owner-a',
  createdAt: T0,
  updatedByUid: 'owner-a',
  updatedAt: T0,
  archivedAt: null,
  revision: 1,
  lastOperationId: `create-${id}`,
  lastPaymentId: null,
  ...overrides
});
const paymentRecord = (id, itemId, overrides = {}) => {
  const ledgerMode = overrides.ledgerMode ?? 'independent';
  const accountId = Object.hasOwn(overrides, 'accountId')
    ? overrides.accountId
    : (ledgerMode === 'linked' ? 'mbb' : null);
  return {
    id,
    householdId,
    itemId,
    type: 'payment',
    amountMinor: 1000,
    occurredAt: T1,
    note: '',
    receiptMediaId: null,
    ledgerMode,
    accountId,
    transactionId: ledgerMode === 'linked' ? `item-payment-${id}` : null,
    status: 'active',
    actorUid: 'owner-a',
    createdAt: T1,
    updatedByUid: 'owner-a',
    updatedAt: T1,
    voidedAt: null,
    lastOperationId: `pay-${id}`,
    ...overrides
  };
};
const transactionRecord = (payment, accountId = payment.accountId, overrides = {}) => ({
  id: payment.transactionId,
  householdId,
  operationId: payment.lastOperationId,
  actorUid: payment.actorUid,
  kind: 'expense',
  accountId,
  targetAccountId: null,
  amountMinor: payment.amountMinor,
  category: '购物',
  note: payment.note,
  occurredAt: payment.occurredAt,
  createdAt: payment.createdAt,
  deletedAt: payment.voidedAt,
  purgedAt: null,
  lastOperationId: payment.lastOperationId,
  sourceType: 'itemPayment',
  sourceItemId: payment.itemId,
  sourcePaymentId: payment.id,
  ...overrides
});
const mediaRecord = (id, itemId, kind, overrides = {}) => ({
  id,
  householdId,
  itemId,
  paymentId: kind === 'receipt' ? overrides.paymentId : null,
  kind,
  dataUrl: JPEG,
  dataUrlLength: JPEG.length,
  width: kind === 'cover' ? 256 : 800,
  height: kind === 'cover' ? 256 : 600,
  createdByUid: overrides.createdByUid ?? 'owner-a',
  createdAt: overrides.createdAt ?? T0,
  updatedAt: overrides.createdAt ?? T0,
  ...overrides
});

async function createPlainItem(db, id = 'bike', overrides = {}) {
  const value = itemRecord(id, overrides);
  await assertSucceeds(setDoc(doc(db, 'households', householdId, 'items', id), value));
  return value;
}

async function addPaymentAtomic(db, item, payment, linked = false) {
  const nextItem = {
    ...item,
    paidMinor: item.paidMinor + payment.amountMinor,
    status: item.paidMinor + payment.amountMinor === item.fullPriceMinor ? 'completed' : 'active',
    updatedByUid: payment.actorUid,
    updatedAt: payment.updatedAt,
    revision: item.revision + 1,
    lastOperationId: payment.lastOperationId,
    lastPaymentId: payment.id
  };
  const batch = writeBatch(db);
  batch.set(doc(db, 'households', householdId, 'items', item.id), nextItem);
  batch.set(doc(db, 'households', householdId, 'itemPayments', payment.id), payment);
  if (linked) batch.set(doc(db, 'households', householdId, 'transactions', payment.transactionId), transactionRecord(payment));
  await assertSucceeds(batch.commit());
  return { item: nextItem, payment };
}

before(async () => {
  env = await initializeTestEnvironment({
    projectId,
    firestore: { host: '127.0.0.1', port: 8080, rules: await readFile('firestore.rules', 'utf8') }
  });
});
after(async () => env.cleanup());
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async context => {
    await setDoc(doc(context.firestore(), 'access', 'owner-a'), { role: 'owner', active: true });
  });
  const owner = authDb('owner-a', ownerEmail);
  await assertSucceeds(setDoc(doc(owner, 'households', householdId), { ownerId: 'owner-a', name: '家庭账本', kind: 'shared', createdAt: T0 }));
  await assertSucceeds(setDoc(doc(owner, 'households', householdId, 'members', 'owner-a'), memberRecord('owner-a', ownerEmail, 'owner')));
  await assertSucceeds(setDoc(doc(owner, 'users', 'owner-a'), {
    uid: 'owner-a', email: ownerEmail, displayName: 'Owner', householdIds: [householdId], selectedHouseholdId: householdId, createdAt: T0
  }));
  await assertSucceeds(setDoc(doc(owner, 'households', householdId, 'accounts', 'mbb'), {
    id: 'mbb', householdId, name: 'Maybank', kind: 'asset', openingBalanceMinor: 500000
  }));
  await assertSucceeds(setDoc(doc(owner, 'households', householdId, 'accounts', 'cash'), {
    id: 'cash', householdId, name: 'Cash', kind: 'asset', openingBalanceMinor: 10000
  }));
  await assertSucceeds(setDoc(doc(owner, 'invites', memberEmail), {
    email: memberEmail, householdId, householdName: '家庭账本', ownerUid: 'owner-a', status: 'pending',
    createdAt: T0, acceptedBy: null, acceptedAt: null
  }));
  const member = authDb('member-b', memberEmail);
  await assertSucceeds(setDoc(doc(member, 'users', 'member-b'), {
    uid: 'member-b', email: memberEmail, displayName: 'Member', householdIds: [], selectedHouseholdId: null, createdAt: T0
  }));
  const batch = writeBatch(member);
  batch.set(doc(member, 'households', householdId, 'members', 'member-b'), memberRecord('member-b', memberEmail, 'member'));
  batch.update(doc(member, 'invites', memberEmail), { status: 'accepted', acceptedBy: 'member-b', acceptedAt: T1 });
  await assertSucceeds(batch.commit());
});

test('现有 owner/member/invite/access 行为保持可用', async () => {
  const member = authDb('member-b', memberEmail);
  assert.equal((await assertSucceeds(getDoc(doc(member, 'households', householdId)))).data().ownerId, 'owner-a');
  await assertSucceeds(updateDoc(doc(member, 'users', 'member-b'), { householdIds: arrayUnion(householdId), selectedHouseholdId: householdId }));
  const owner = authDb('owner-a', ownerEmail);
  assert.equal((await assertSucceeds(getDoc(doc(owner, 'access', 'owner-a')))).data().active, true);
  await assertFails(setDoc(doc(owner, 'access', 'owner-a'), { role: 'owner', active: false }));
});

test('Owner 可原子建立新家庭并邀请 Gmail；成员不能邀请或改写 owner', async () => {
  const owner = authDb('owner-a', ownerEmail);
  const familyId = 'family-owner-a-new';
  const batch = writeBatch(owner);
  batch.set(doc(owner, 'households', familyId), { ownerId: 'owner-a', name: '家庭账本', kind: 'shared', createdAt: T2 });
  batch.set(doc(owner, 'households', familyId, 'members', 'owner-a'), memberRecord('owner-a', ownerEmail, 'owner'));
  batch.update(doc(owner, 'users', 'owner-a'), { householdIds: arrayUnion(familyId), selectedHouseholdId: familyId });
  batch.set(doc(owner, 'invites', 'wife@gmail.com'), {
    email: 'wife@gmail.com', householdId: familyId, householdName: '家庭账本', ownerUid: 'owner-a', status: 'pending',
    createdAt: T2, acceptedBy: null, acceptedAt: null
  });
  await assertSucceeds(batch.commit());
  const member = authDb('member-b', memberEmail);
  await assertFails(setDoc(doc(member, 'invites', 'other@gmail.com'), {
    email: 'other@gmail.com', householdId, householdName: '家庭账本', ownerUid: 'member-b', status: 'pending'
  }));
  await assertFails(setDoc(doc(member, 'households', householdId, 'members', 'owner-a'), memberRecord('owner-a', ownerEmail, 'owner')));
});

test('owner 与 member 可读写物品元数据；Data URL 不允许进入 core doc', async () => {
  const owner = authDb('owner-a', ownerEmail);
  const item = await createPlainItem(owner);
  const member = authDb('member-b', memberEmail);
  await assertSucceeds(getDoc(doc(member, 'households', householdId, 'items', item.id)));
  await assertSucceeds(setDoc(doc(member, 'households', householdId, 'items', item.id), {
    ...item, note: '共同购买', updatedByUid: 'member-b', updatedAt: T1, revision: 2, lastOperationId: 'edit-bike'
  }));
  await assertFails(setDoc(doc(member, 'households', householdId, 'items', 'bad-core-media'), {
    ...itemRecord('bad-core-media', { createdByUid: 'member-b', updatedByUid: 'member-b' }), dataUrl: JPEG
  }));
});

test('封面与收据媒体必须同请求引用，且 owner/member 均可读取', async () => {
  const owner = authDb('owner-a', ownerEmail);
  const cover = mediaRecord('cover-bike', 'bike', 'cover');
  const item = itemRecord('bike', { coverMediaId: cover.id });
  const createBatch = writeBatch(owner);
  createBatch.set(doc(owner, 'households', householdId, 'items', 'bike'), item);
  createBatch.set(doc(owner, 'households', householdId, 'itemMedia', cover.id), cover);
  await assertSucceeds(createBatch.commit());

  const member = authDb('member-b', memberEmail);
  await assertSucceeds(getDoc(doc(member, 'households', householdId, 'itemMedia', cover.id)));
  const payment = paymentRecord('p-receipt', 'bike', {
    actorUid: 'member-b', updatedByUid: 'member-b', receiptMediaId: 'receipt-p', createdAt: T1, updatedAt: T1
  });
  const receipt = mediaRecord('receipt-p', 'bike', 'receipt', { paymentId: payment.id, createdByUid: 'member-b', createdAt: T1 });
  const nextItem = { ...item, paidMinor: 1000, updatedByUid: 'member-b', updatedAt: T1, revision: 2, lastOperationId: payment.lastOperationId, lastPaymentId: payment.id };
  const batch = writeBatch(member);
  batch.set(doc(member, 'households', householdId, 'items', 'bike'), nextItem);
  batch.set(doc(member, 'households', householdId, 'itemPayments', payment.id), payment);
  batch.set(doc(member, 'households', householdId, 'itemMedia', receipt.id), receipt);
  await assertSucceeds(batch.commit());
  await assertSucceeds(getDoc(doc(owner, 'households', householdId, 'itemPayments', payment.id)));
});

test('媒体严格限制 JPEG、字段、尺寸与 cover/receipt 字符上限', async () => {
  const owner = authDb('owner-a', ownerEmail);
  const prefix = 'data:image/jpeg;base64,';
  const atCap = prefix + 'A'.repeat(80000 - prefix.length);
  const legal = mediaRecord('cover-cap', 'cap-item', 'cover', { dataUrl: atCap, dataUrlLength: atCap.length });
  const batch = writeBatch(owner);
  batch.set(doc(owner, 'households', householdId, 'items', 'cap-item'), itemRecord('cap-item', { coverMediaId: legal.id }));
  batch.set(doc(owner, 'households', householdId, 'itemMedia', legal.id), legal);
  await assertSucceeds(batch.commit());

  const badCases = [
    mediaRecord('bad-png', 'bad-item', 'cover', { dataUrl: 'data:image/png;base64,AAAA', dataUrlLength: 26 }),
    mediaRecord('bad-length', 'bad-item', 'cover', { dataUrlLength: JPEG.length + 1 }),
    mediaRecord('bad-size', 'bad-item', 'cover', { width: 513 }),
    mediaRecord('bad-extra', 'bad-item', 'cover', { extra: true })
  ];
  for (const media of badCases) {
    const attempt = writeBatch(owner);
    attempt.set(doc(owner, 'households', householdId, 'items', 'bad-item'), itemRecord('bad-item', { coverMediaId: media.id }));
    attempt.set(doc(owner, 'households', householdId, 'itemMedia', media.id), media);
    await assertFails(attempt.commit());
  }
  const over = prefix + 'A'.repeat(80001 - prefix.length);
  const overMedia = mediaRecord('over-cover', 'over-item', 'cover', { dataUrl: over, dataUrlLength: over.length });
  const overBatch = writeBatch(owner);
  overBatch.set(doc(owner, 'households', householdId, 'items', 'over-item'), itemRecord('over-item', { coverMediaId: overMedia.id }));
  overBatch.set(doc(owner, 'households', householdId, 'itemMedia', overMedia.id), overMedia);
  await assertFails(overBatch.commit());
});

test('linked 付款与确定性购物账目可合法原子创建', async () => {
  const owner = authDb('owner-a', ownerEmail);
  const item = await createPlainItem(owner);
  const payment = paymentRecord('linked-1', item.id, { ledgerMode: 'linked' });
  const result = await addPaymentAtomic(owner, item, payment, true);
  assert.equal(result.item.paidMinor, 1000);
  const saved = await getDoc(doc(owner, 'households', householdId, 'transactions', payment.transactionId));
  assert.deepEqual(
    [result.payment.accountId, saved.data().accountId, saved.data().sourceType, saved.data().sourceItemId, saved.data().sourcePaymentId, saved.data().category],
    ['mbb', 'mbb', 'itemPayment', item.id, payment.id, '购物']
  );
});

test('新物品与订金可在同一请求使用独立 operationId', async () => {
  const owner = authDb('owner-a', ownerEmail);
  const payment = paymentRecord('deposit-distinct-op', 'new-with-deposit', {
    type: 'deposit', amountMinor: 2000, createdAt: T0, updatedAt: T0,
    lastOperationId: 'record-distinct-deposit'
  });
  const item = itemRecord('new-with-deposit', {
    paidMinor: 2000,
    lastPaymentId: payment.id,
    lastOperationId: 'create-new-with-deposit'
  });
  const batch = writeBatch(owner);
  batch.set(doc(owner, 'households', householdId, 'items', item.id), item);
  batch.set(doc(owner, 'households', householdId, 'itemPayments', payment.id), payment);
  await assertSucceeds(batch.commit());
  assert.notEqual(item.lastOperationId, payment.lastOperationId);
});

test('伪造或未配对 itemPayment 来源账目一律拒绝', async () => {
  const member = authDb('member-b', memberEmail);
  const forgedPayment = paymentRecord('forged-source', 'bike', {
    ledgerMode: 'linked', actorUid: 'member-b', updatedByUid: 'member-b'
  });
  await assertFails(setDoc(doc(member, 'households', householdId, 'transactions', forgedPayment.transactionId), transactionRecord(forgedPayment)));

  const owner = authDb('owner-a', ownerEmail);
  const item = await createPlainItem(owner);

  const missingAccountPayment = paymentRecord('missing-account', item.id, { ledgerMode: 'linked', accountId: null });
  const missingAccountItem = {
    ...item, paidMinor: 1000, updatedAt: T1, revision: 2,
    lastOperationId: missingAccountPayment.lastOperationId, lastPaymentId: missingAccountPayment.id
  };
  const missingAccount = writeBatch(owner);
  missingAccount.set(doc(owner, 'households', householdId, 'items', item.id), missingAccountItem);
  missingAccount.set(doc(owner, 'households', householdId, 'itemPayments', missingAccountPayment.id), missingAccountPayment);
  missingAccount.set(
    doc(owner, 'households', householdId, 'transactions', missingAccountPayment.transactionId),
    transactionRecord(missingAccountPayment, 'mbb')
  );
  await assertFails(missingAccount.commit());

  const payment = paymentRecord('unpaired', item.id, { ledgerMode: 'linked' });
  const nextItem = { ...item, paidMinor: 1000, updatedAt: T1, revision: 2, lastOperationId: payment.lastOperationId, lastPaymentId: payment.id };
  const unpaired = writeBatch(owner);
  unpaired.set(doc(owner, 'households', householdId, 'items', item.id), nextItem);
  unpaired.set(doc(owner, 'households', householdId, 'itemPayments', payment.id), payment);
  await assertFails(unpaired.commit());

  const mismatched = writeBatch(owner);
  mismatched.set(doc(owner, 'households', householdId, 'items', item.id), nextItem);
  mismatched.set(doc(owner, 'households', householdId, 'itemPayments', payment.id), payment);
  mismatched.set(doc(owner, 'households', householdId, 'transactions', payment.transactionId), transactionRecord(payment, 'mbb', { sourceItemId: 'other-item' }));
  await assertFails(mismatched.commit());

  const accountMismatchPayment = paymentRecord('account-mismatch', item.id, { ledgerMode: 'linked', accountId: 'mbb' });
  const accountMismatchItem = {
    ...item, paidMinor: 1000, updatedAt: T1, revision: 2,
    lastOperationId: accountMismatchPayment.lastOperationId, lastPaymentId: accountMismatchPayment.id
  };
  const accountMismatch = writeBatch(owner);
  accountMismatch.set(doc(owner, 'households', householdId, 'items', item.id), accountMismatchItem);
  accountMismatch.set(doc(owner, 'households', householdId, 'itemPayments', accountMismatchPayment.id), accountMismatchPayment);
  accountMismatch.set(
    doc(owner, 'households', householdId, 'transactions', accountMismatchPayment.transactionId),
    transactionRecord(accountMismatchPayment, 'cash')
  );
  await assertFails(accountMismatch.commit());
});

test('independent 付款不要求 ledger transaction', async () => {
  const owner = authDb('owner-a', ownerEmail);
  const item = await createPlainItem(owner);
  const payment = paymentRecord('independent-1', item.id);
  await addPaymentAtomic(owner, item, payment, false);
  const saved = (await getDoc(doc(owner, 'households', householdId, 'itemPayments', payment.id))).data();
  assert.deepEqual([saved.accountId, saved.transactionId], [null, null]);

  const badItem = await createPlainItem(owner, 'bad-independent-account');
  const badPayment = paymentRecord('bad-independent-account-payment', badItem.id, { accountId: 'mbb' });
  const badBatch = writeBatch(owner);
  badBatch.set(doc(owner, 'households', householdId, 'items', badItem.id), {
    ...badItem, paidMinor: 1000, updatedAt: T1, revision: 2,
    lastOperationId: badPayment.lastOperationId, lastPaymentId: badPayment.id
  });
  badBatch.set(doc(owner, 'households', householdId, 'itemPayments', badPayment.id), badPayment);
  await assertFails(badBatch.commit());
});

test('浏览器客户端保持付款账户、编辑幂等载荷与缺失账本终止契约', async () => {
  const source = await readFile('app/firebase-client.js', 'utf8');
  const paymentSource = source.slice(source.indexOf('function itemPaymentRecord'), source.indexOf('function linkedTransactionRecord'));
  assert.match(paymentSource, /accountId:\s*ledgerMode === 'linked'\s*\? requiredId\(input\.accountId, '联动账户 ID'\)\s*:\s*null/);
  assert.match(source, /accountId:\s*payment\.accountId/);
  assert.ok((source.match(/'ledgerMode', 'accountId', 'transactionId'/g) ?? []).length >= 2);
  assert.match(source, /depositInput\.operationId \?\? operationId/);

  const editSource = source.slice(source.indexOf('async function editItem'), source.indexOf('async function mutateArchive'));
  assert.match(editSource, /const requestedBusinessPayload = \{/);
  assert.match(editSource, /sameFields\(item, requestedBusinessPayload, \['name', 'note', 'fullPriceMinor', 'status', 'coverMediaId'\]\)/);
  assert.match(editSource, /operationId 已用于不同编辑载荷/);
  assert.ok(editSource.indexOf('item.lastOperationId === operationId') < editSource.indexOf('assertRevision(item, input.expectedRevision)'));
  assert.ok(editSource.indexOf('operationId 已用于不同编辑载荷') < editSource.indexOf('新封面引用必须随 coverMedia 一起写入'));

  const subscriptionSource = source.slice(source.indexOf('function subscribeHousehold'), source.indexOf('const itemRef'));
  assert.match(subscriptionSource, /if \(!snapshot\.exists\(\)\) \{[\s\S]*?HouseholdNotFoundError[\s\S]*?fail\(error\);[\s\S]*?return;/);
  assert.doesNotMatch(subscriptionSource, /state\.household = snapshot\.exists\(\) \?/);
});

test('linked 作废与恢复必须同步账目 deletedAt，并保留原 actorUid', async () => {
  const owner = authDb('owner-a', ownerEmail);
  const item = await createPlainItem(owner, 'shared-bike', { fullPriceMinor: 1000 });
  const payment = paymentRecord('shared-pay', item.id, { ledgerMode: 'linked', amountMinor: 1000 });
  const paid = await addPaymentAtomic(owner, item, payment, true);

  const member = authDb('member-b', memberEmail);
  const voidPayment = { ...payment, status: 'voided', voidedAt: T2, updatedByUid: 'member-b', updatedAt: T2, lastOperationId: 'void-shared-pay' };
  const voidItem = { ...paid.item, paidMinor: 0, status: 'active', updatedByUid: 'member-b', updatedAt: T2, revision: 3, lastOperationId: 'void-shared-pay' };
  const voidTx = { ...transactionRecord(payment), deletedAt: T2, lastOperationId: 'void-shared-pay' };
  const voidBatch = writeBatch(member);
  voidBatch.set(doc(member, 'households', householdId, 'items', item.id), voidItem);
  voidBatch.set(doc(member, 'households', householdId, 'itemPayments', payment.id), voidPayment);
  voidBatch.set(doc(member, 'households', householdId, 'transactions', payment.transactionId), voidTx);
  await assertSucceeds(voidBatch.commit());
  assert.equal((await getDoc(doc(member, 'households', householdId, 'transactions', payment.transactionId))).data().actorUid, 'owner-a');

  const restorePayment = { ...voidPayment, status: 'active', voidedAt: null, updatedAt: '2026-08-22T03:00:00.000Z', lastOperationId: 'restore-shared-pay' };
  const restoreItem = { ...voidItem, paidMinor: 1000, status: 'completed', updatedAt: restorePayment.updatedAt, revision: 4, lastOperationId: 'restore-shared-pay' };
  const restoreTx = { ...voidTx, deletedAt: null, lastOperationId: 'restore-shared-pay' };
  const restoreBatch = writeBatch(member);
  restoreBatch.set(doc(member, 'households', householdId, 'items', item.id), restoreItem);
  restoreBatch.set(doc(member, 'households', householdId, 'itemPayments', payment.id), restorePayment);
  restoreBatch.set(doc(member, 'households', householdId, 'transactions', payment.transactionId), restoreTx);
  await assertSucceeds(restoreBatch.commit());
});

test('linked 付款或账目不可单独作废/恢复，付款 actorUid 不可改写', async () => {
  const owner = authDb('owner-a', ownerEmail);
  const item = await createPlainItem(owner);
  const payment = paymentRecord('guarded', item.id, { ledgerMode: 'linked' });
  await addPaymentAtomic(owner, item, payment, true);
  await assertFails(updateDoc(doc(owner, 'households', householdId, 'transactions', payment.transactionId), {
    deletedAt: T2, lastOperationId: 'standalone-void'
  }));
  await assertFails(updateDoc(doc(owner, 'households', householdId, 'itemPayments', payment.id), {
    status: 'voided', voidedAt: T2, updatedAt: T2, lastOperationId: 'standalone-void'
  }));
  await assertFails(updateDoc(doc(owner, 'households', householdId, 'itemPayments', payment.id), { actorUid: 'member-b' }));
});

test('只有已结清 completed 物品可以归档，归档可恢复', async () => {
  const owner = authDb('owner-a', ownerEmail);
  const unpaid = await createPlainItem(owner, 'unpaid');
  await assertFails(setDoc(doc(owner, 'households', householdId, 'items', unpaid.id), {
    ...unpaid, status: 'archived', archivedAt: T1, updatedAt: T1, revision: 2, lastOperationId: 'archive-unpaid'
  }));
  const complete = await createPlainItem(owner, 'complete', { fullPriceMinor: 1000 });
  const paid = await addPaymentAtomic(owner, complete, paymentRecord('complete-pay', complete.id, { amountMinor: 1000 }), false);
  const archived = { ...paid.item, status: 'archived', archivedAt: T2, updatedAt: T2, revision: 3, lastOperationId: 'archive-complete' };
  await assertSucceeds(setDoc(doc(owner, 'households', householdId, 'items', complete.id), archived));
  await assertSucceeds(setDoc(doc(owner, 'households', householdId, 'items', complete.id), {
    ...archived, status: 'completed', archivedAt: null, updatedAt: '2026-08-22T03:00:00.000Z', revision: 4, lastOperationId: 'restore-complete'
  }));
});

test('陌生人、跨家庭字段与停用成员均拒绝 items/payments/media', async () => {
  const owner = authDb('owner-a', ownerEmail);
  await createPlainItem(owner);
  const stranger = authDb('stranger-c', 'stranger@gmail.com');
  for (const collectionName of ['items', 'itemPayments', 'itemMedia']) {
    await assertFails(getDoc(doc(stranger, 'households', householdId, collectionName, 'bike')));
  }
  await assertFails(setDoc(doc(authDb('member-b', memberEmail), 'households', householdId, 'items', 'cross'), itemRecord('cross', {
    householdId: 'other-home', createdByUid: 'member-b', updatedByUid: 'member-b'
  })));
  await assertSucceeds(setDoc(doc(owner, 'households', householdId, 'members', 'member-b'), {
    ...memberRecord('member-b', memberEmail, 'member'), active: false
  }));
  const deactivated = authDb('member-b', memberEmail);
  await assertFails(getDoc(doc(deactivated, 'households', householdId, 'items', 'bike')));
  await assertFails(setDoc(doc(deactivated, 'households', householdId, 'items', 'blocked'), itemRecord('blocked', {
    createdByUid: 'member-b', updatedByUid: 'member-b'
  })));
});

test('两个成员并发争抢最终余额时仅一个 transaction 成功', async () => {
  const owner = authDb('owner-a', ownerEmail);
  await createPlainItem(owner, 'race', { fullPriceMinor: 1000 });
  const member = authDb('member-b', memberEmail);
  const compete = (db, actorUid, paymentId) => runTransaction(db, async transaction => {
    const ref = doc(db, 'households', householdId, 'items', 'race');
    const snapshot = await transaction.get(ref);
    const item = snapshot.data();
    if (item.paidMinor + 1000 > item.fullPriceMinor) throw new Error('overpay');
    const at = actorUid === 'owner-a' ? T1 : T2;
    const payment = paymentRecord(paymentId, 'race', {
      amountMinor: 1000, actorUid, updatedByUid: actorUid, createdAt: at, updatedAt: at, occurredAt: at,
      lastOperationId: `pay-${paymentId}`
    });
    transaction.set(ref, {
      ...item, paidMinor: item.paidMinor + 1000, status: 'completed', updatedByUid: actorUid, updatedAt: at,
      revision: item.revision + 1, lastOperationId: payment.lastOperationId, lastPaymentId: paymentId
    });
    transaction.set(doc(db, 'households', householdId, 'itemPayments', paymentId), payment);
  });
  const results = await Promise.allSettled([compete(owner, 'owner-a', 'race-owner'), compete(member, 'member-b', 'race-member')]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.equal((await getDoc(doc(owner, 'households', householdId, 'items', 'race'))).data().paidMinor, 1000);
});

test('普通账目仍可创建编辑，但不能后补伪造 itemPayment 来源', async () => {
  const owner = authDb('owner-a', ownerEmail);
  const ordinary = {
    id: 'ordinary', householdId, operationId: 'ordinary-create', actorUid: 'owner-a', kind: 'expense',
    accountId: 'mbb', targetAccountId: null, amountMinor: 100, category: '其它', note: '',
    occurredAt: T1, createdAt: T1, deletedAt: null, purgedAt: null, lastOperationId: 'ordinary-create'
  };
  const ref = doc(owner, 'households', householdId, 'transactions', ordinary.id);
  await assertSucceeds(setDoc(ref, ordinary));
  await assertSucceeds(updateDoc(ref, { note: 'edited', lastOperationId: 'ordinary-edit' }));
  await assertFails(updateDoc(ref, { sourceType: 'itemPayment', sourceItemId: 'bike', sourcePaymentId: 'fake' }));
});
