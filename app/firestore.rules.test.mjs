import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { arrayUnion, doc, getDoc, setDoc, writeBatch } from 'firebase/firestore';

const projectId = 'family-wallet-v2-emulator';
const householdId = 'home-kris';
const ownerEmail = 'owner@gmail.com';
const memberEmail = 'member@gmail.com';
let env;

const authDb = (uid, email) => env.authenticatedContext(uid, { email }).firestore();
const memberRecord = (uid, email, role) => ({ uid, email, displayName: uid, role, active: true, joinedAt: '2026-08-22T00:00:00.000Z' });

before(async () => {
  env = await initializeTestEnvironment({ projectId, firestore: { host: '127.0.0.1', port: 8080, rules: await readFile('firestore.rules', 'utf8') } });
});
after(async () => env.cleanup());
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async context => {
    await setDoc(doc(context.firestore(), 'access', 'owner-a'), { role: 'owner', active: true });
  });
  const owner = authDb('owner-a', ownerEmail);
  await assertSucceeds(setDoc(doc(owner, 'households', householdId), { ownerId: 'owner-a', name: '家庭账本', kind: 'shared', createdAt: '2026-08-22T00:00:00.000Z' }));
  await assertSucceeds(setDoc(doc(owner, 'households', householdId, 'members', 'owner-a'), memberRecord('owner-a', ownerEmail, 'owner')));
  await assertSucceeds(setDoc(doc(owner, 'users', 'owner-a'), {
    uid: 'owner-a', email: ownerEmail, displayName: 'Owner', householdIds: [householdId],
    selectedHouseholdId: householdId, createdAt: '2026-08-22T00:00:00.000Z'
  }));
  await assertSucceeds(setDoc(doc(owner, 'invites', memberEmail), {
    email: memberEmail, householdId, householdName: '家庭账本', ownerUid: 'owner-a', status: 'pending',
    createdAt: '2026-08-22T00:00:00.000Z', acceptedBy: null, acceptedAt: null
  }));
  const member = authDb('member-b', memberEmail);
  await assertSucceeds(setDoc(doc(member, 'users', 'member-b'), {
    uid: 'member-b', email: memberEmail, displayName: 'Member', householdIds: [],
    selectedHouseholdId: null, createdAt: '2026-08-22T00:00:00.000Z'
  }));
  const batch = writeBatch(member);
  batch.set(doc(member, 'households', householdId, 'members', 'member-b'), memberRecord('member-b', memberEmail, 'member'));
  batch.update(doc(member, 'invites', memberEmail), { status: 'accepted', acceptedBy: 'member-b', acceptedAt: '2026-08-22T01:00:00.000Z' });
  await assertSucceeds(batch.commit());
});

test('受邀 Gmail 可加入并读写同一个家庭账本', async () => {
  const member = authDb('member-b', memberEmail);
  const membership = await assertSucceeds(getDoc(doc(member, 'households', householdId, 'members', 'member-b')));
  assert.equal(membership.data().active, true);
  const account = doc(member, 'households', householdId, 'accounts', 'mbb');
  await assertSucceeds(setDoc(account, { id: 'mbb', householdId, name: 'Maybank', kind: 'asset', openingBalanceMinor: 500000 }));
  await assertSucceeds(getDoc(account));
  await assertSucceeds(setDoc(doc(member, 'households', householdId, 'transactions', 't1'), {
    id: 't1', householdId, actorUid: 'member-b', kind: 'expense', accountId: 'mbb', amountMinor: 1250
  }));
});

test('Owner 可原子建立新的家庭账本并邀请 Gmail，同时保留个人账本', async () => {
  const owner = authDb('owner-a', ownerEmail);
  const familyId = 'family-owner-a-new';
  const inviteEmail = 'wife@gmail.com';
  const batch = writeBatch(owner);
  batch.set(doc(owner, 'households', familyId), { ownerId: 'owner-a', name: '家庭账本', kind: 'shared', createdAt: '2026-08-22T02:00:00.000Z' });
  batch.set(doc(owner, 'households', familyId, 'members', 'owner-a'), memberRecord('owner-a', ownerEmail, 'owner'));
  batch.update(doc(owner, 'users', 'owner-a'), { householdIds: arrayUnion(familyId), selectedHouseholdId: familyId });
  batch.set(doc(owner, 'invites', inviteEmail), {
    email: inviteEmail, householdId: familyId, householdName: '家庭账本', ownerUid: 'owner-a', status: 'pending',
    createdAt: '2026-08-22T02:00:00.000Z', acceptedBy: null, acceptedAt: null
  });
  await assertSucceeds(batch.commit());
  const profile = await getDoc(doc(owner, 'users', 'owner-a'));
  assert.deepEqual(profile.data().householdIds.sort(), [familyId, householdId].sort());
});

test('非受邀 Gmail 不能读取邀请、加入或猜测家庭路径', async () => {
  const stranger = authDb('stranger-c', 'stranger@gmail.com');
  await assertFails(getDoc(doc(stranger, 'invites', memberEmail)));
  await assertFails(getDoc(doc(stranger, 'households', householdId, 'accounts', 'mbb')));
  await assertFails(setDoc(doc(stranger, 'households', householdId, 'members', 'stranger-c'), memberRecord('stranger-c', 'stranger@gmail.com', 'member')));
  await assertFails(setDoc(doc(stranger, 'households', householdId, 'transactions', 'forged'), { householdId, actorUid: 'stranger-c', amountMinor: 1 }));
});

test('未批准且未受邀的 Google 帐号不能建立个人账本或消耗写入配额', async () => {
  const stranger = authDb('stranger-c', 'stranger@gmail.com');
  await assertFails(setDoc(doc(stranger, 'users', 'stranger-c'), {
    uid: 'stranger-c', email: 'stranger@gmail.com', displayName: 'Stranger',
    householdIds: ['personal-stranger-c'], selectedHouseholdId: 'personal-stranger-c'
  }));
  await assertFails(setDoc(doc(stranger, 'households', 'personal-stranger-c'), {
    ownerId: 'stranger-c', name: '我的账本', kind: 'personal'
  }));
  await assertFails(setDoc(doc(stranger, 'access', 'stranger-c'), { role: 'owner', active: true }));
});

test('批准 owner 可读取自己的授权但不能由客户端改写授权', async () => {
  const owner = authDb('owner-a', ownerEmail);
  const access = await assertSucceeds(getDoc(doc(owner, 'access', 'owner-a')));
  assert.equal(access.data().active, true);
  await assertFails(setDoc(doc(owner, 'access', 'owner-a'), { role: 'owner', active: false }));
});

test('不能拿自己的邀请加入另一个家庭', async () => {
  const member = authDb('member-b', memberEmail);
  await assertFails(setDoc(doc(member, 'households', 'other-home', 'members', 'member-b'), memberRecord('member-b', memberEmail, 'member')));
});

test('成员不能伪造或改写交易的 actorUid/householdId', async () => {
  const member = authDb('member-b', memberEmail);
  const transaction = doc(member, 'households', householdId, 'transactions', 'owned-by-member');
  await assertSucceeds(setDoc(transaction, { householdId, actorUid: 'member-b', amountMinor: 1 }));
  await assertFails(setDoc(doc(member, 'households', householdId, 'transactions', 'forged-actor'), { householdId, actorUid: 'owner-a', amountMinor: 1 }));
  await assertFails(setDoc(doc(member, 'households', householdId, 'transactions', 'forged-household'), { householdId: 'other-home', actorUid: 'member-b', amountMinor: 1 }));
  await assertFails(setDoc(transaction, { householdId, actorUid: 'owner-a', amountMinor: 2 }));
  await assertFails(setDoc(transaction, { householdId: 'other-home', actorUid: 'member-b', amountMinor: 2 }));
});

test('成员不能通过账户写入伪造或跨家庭改写 householdId', async () => {
  const member = authDb('member-b', memberEmail);
  const account = doc(member, 'households', householdId, 'accounts', 'mbb');
  await assertSucceeds(setDoc(account, { householdId, name: 'Maybank', openingBalanceMinor: 500000 }));
  await assertFails(setDoc(doc(member, 'households', householdId, 'accounts', 'forged-household'), { householdId: 'other-home', name: 'Forged', openingBalanceMinor: 1 }));
  await assertFails(setDoc(account, { householdId: 'other-home', name: 'Maybank', openingBalanceMinor: 500000 }));
});

test('停用成员即时失去家庭账本访问权', async () => {
  const owner = authDb('owner-a', ownerEmail);
  await assertSucceeds(setDoc(doc(owner, 'households', householdId, 'members', 'member-b'), { ...memberRecord('member-b', memberEmail, 'member'), active: false }));
  const member = authDb('member-b', memberEmail);
  await assertFails(getDoc(doc(member, 'households', householdId, 'accounts', 'mbb')));
  await assertFails(setDoc(doc(member, 'households', householdId, 'accounts', 'mbb'), { householdId, name: 'Maybank' }));
});

test('只有 owner 可以邀请或变更成员', async () => {
  const member = authDb('member-b', memberEmail);
  await assertFails(setDoc(doc(member, 'invites', 'other@gmail.com'), {
    email: 'other@gmail.com', householdId, householdName: '家庭账本', ownerUid: 'member-b', status: 'pending'
  }));
  await assertFails(setDoc(doc(member, 'households', householdId, 'members', 'owner-a'), memberRecord('owner-a', ownerEmail, 'owner')));
});

test('用户资料只能由本人创建和读取，邮箱与 UID 不可篡改', async () => {
  const member = authDb('member-b', memberEmail);
  await assertSucceeds(getDoc(doc(member, 'users', 'member-b')));
  await assertFails(getDoc(doc(member, 'users', 'owner-a')));
  await assertFails(setDoc(doc(member, 'users', 'member-b'), { uid: 'owner-a', email: memberEmail }));
});
