import test from 'node:test';
import assert from 'node:assert/strict';
import { createSyncCoordinator, SYNC_STATUSES } from './cloud-sync.js';

const backend = (amount, operations = []) => ({ amount, operations: [...operations] });
const createCoordinator = options => createSyncCoordinator({
  applyOperation(state = backend(0), operation) {
    if (state.operations.includes(operation.id)) return state;
    return {
      amount: state.amount + operation.delta,
      operations: [...state.operations, operation.id]
    };
  },
  hasOperation(state, operationId) {
    return state?.operations?.includes(operationId) ?? false;
  },
  ...options
});

const openHousehold = (coordinator, householdId, options) => {
  const session = coordinator.beginSession();
  const listener = coordinator.acceptProfile(session, { householdId }, options);
  return { session, listener };
};

test('状态模型公开 loading/cached/pending/synced/offline/recovering/error', async () => {
  assert.deepEqual(SYNC_STATUSES, ['loading', 'cached', 'pending', 'synced', 'offline', 'recovering', 'error']);
  const coordinator = createCoordinator();
  const session = coordinator.beginSession();
  assert.equal(coordinator.getState().status, 'loading');
  const listener = coordinator.acceptProfile(session, { householdId: 'A' }, { cachedState: backend(4) });
  assert.equal(coordinator.getState().status, 'cached');
  coordinator.acceptSnapshot(listener, backend(5));
  assert.equal(coordinator.getState().status, 'synced');
  const write = coordinator.registerWrite('op-1', { id: 'op-1', delta: 2 });
  assert.equal(coordinator.getState().status, 'pending');
  coordinator.setOnline(false);
  assert.equal(coordinator.getState().status, 'offline');
  coordinator.setOnline(true);
  coordinator.rejectWrite(write, new Error('denied'));
  assert.equal(coordinator.getState().status, 'error');
});

test('A→B 后忽略 A 的迟到快照/profile，但迟到写拒绝会清理 A 且不影响 B', () => {
  const changes = [];
  const coordinator = createCoordinator({ onChange: state => changes.push(state) });
  const session = coordinator.beginSession();
  const listenerA = coordinator.acceptProfile(session, { householdId: 'A' });
  coordinator.acceptSnapshot(listenerA, backend(10));
  const rejectedWriteA = coordinator.registerWrite('A-rejected', { id: 'A-rejected', delta: 5 });
  const acknowledgedWriteA = coordinator.registerWrite('A-acknowledged', { id: 'A-acknowledged', delta: 2 });

  const listenerB = coordinator.acceptProfile(session, { householdId: 'B' });
  coordinator.acceptSnapshot(listenerB, backend(100));
  const generationB = coordinator.getState().householdGeneration;
  assert.ok(generationB > listenerA.householdGeneration);

  assert.equal(coordinator.acceptSnapshot(listenerA, backend(999)), false);
  const emissionsBeforeWriteResults = changes.length;
  assert.equal(coordinator.acknowledgeWrite(acknowledgedWriteA), true);
  assert.equal(coordinator.rejectWrite(rejectedWriteA, new Error('A denied')), true);
  assert.equal(changes.length, emissionsBeforeWriteResults, '清理非当前 household 不应发出 B 的状态变更');
  assert.deepEqual(coordinator.getState().data, backend(100));
  assert.equal(coordinator.getState().householdId, 'B');
  assert.equal(coordinator.getState().householdGeneration, generationB);

  coordinator.acceptProfile(session, { householdId: 'A' });
  assert.deepEqual(coordinator.getState().data, backend(12, ['A-acknowledged']));
  assert.equal(coordinator.getState().pendingCount, 0);
  assert.equal(coordinator.getState().status, 'error');
  assert.equal(coordinator.getState().error, 'A denied');

  const newerSession = coordinator.beginSession();
  assert.equal(coordinator.acceptProfile(session, { householdId: 'stale-profile' }), null);
  assert.equal(coordinator.getState().householdId, null);
  assert.ok(newerSession.sessionGeneration > session.sessionGeneration);
});

test('本地保存期间配偶快照到达时，在最新后端快照上重放 pending 本地回声', () => {
  const coordinator = createCoordinator();
  const { listener } = openHousehold(coordinator, 'family');
  coordinator.acceptSnapshot(listener, backend(10, ['initial']));
  const write = coordinator.registerWrite('mine', { id: 'mine', delta: 5 });
  assert.deepEqual(coordinator.getState().data, backend(15, ['initial', 'mine']));

  coordinator.acceptSnapshot(listener, backend(20, ['initial', 'spouse']));
  assert.deepEqual(coordinator.getState().lastKnownGood, backend(20, ['initial', 'spouse']));
  assert.deepEqual(coordinator.getState().data, backend(25, ['initial', 'spouse', 'mine']));
  assert.equal(coordinator.getState().status, 'pending');

  coordinator.acknowledgeWrite(write);
  assert.deepEqual(coordinator.getState().lastKnownGood, backend(25, ['initial', 'spouse', 'mine']));
  assert.equal(coordinator.getState().status, 'synced');
});

test('含本地写的 pending snapshot 更新可见数据，但 metadata 确认前保持 pending', () => {
  const coordinator = createCoordinator();
  const { listener } = openHousehold(coordinator, 'family');
  coordinator.acceptSnapshot(listener, backend(10), { fromCache: true, hasPendingWrites: false });
  assert.equal(coordinator.getState().status, 'cached');
  coordinator.registerWrite('mine', { id: 'mine', delta: 5 });

  coordinator.acceptSnapshot(
    listener,
    backend(15, ['mine']),
    { fromCache: true, hasPendingWrites: true }
  );
  assert.deepEqual(coordinator.getState().data, backend(15, ['mine']));
  assert.equal(coordinator.getState().pendingCount, 1);
  assert.equal(coordinator.getState().status, 'pending');

  coordinator.acceptSnapshot(
    listener,
    backend(15, ['mine']),
    { fromCache: false, hasPendingWrites: false }
  );
  assert.equal(coordinator.getState().pendingCount, 0);
  assert.equal(coordinator.getState().status, 'synced');
});

test('离线写保持 local echo，联网且后端确认后由 pending 进入 synced', () => {
  const coordinator = createCoordinator();
  const { listener } = openHousehold(coordinator, 'family');
  coordinator.acceptSnapshot(listener, backend(7));
  coordinator.setOnline(false);
  const write = coordinator.registerWrite('offline-save', { id: 'offline-save', delta: 3 });
  const duplicate = coordinator.registerWrite('offline-save', { id: 'offline-save', delta: 999 });
  assert.strictEqual(duplicate, write);
  assert.equal(coordinator.getState().status, 'offline');
  assert.deepEqual(coordinator.getState().data, backend(10, ['offline-save']));
  assert.equal(coordinator.getState().pendingCount, 1);

  coordinator.setOnline(true);
  assert.equal(coordinator.getState().status, 'pending');
  coordinator.acknowledgeWrite(write);
  assert.equal(coordinator.getState().status, 'synced');
  assert.equal(coordinator.getState().pendingCount, 0);
  assert.deepEqual(coordinator.getState().data, backend(10, ['offline-save']));
});

test('写入被拒绝时只移除该 local echo，不回滚其后收到的更新快照', () => {
  const coordinator = createCoordinator();
  const { listener } = openHousehold(coordinator, 'family');
  coordinator.acceptSnapshot(listener, backend(10));
  const write = coordinator.registerWrite('rejected', { id: 'rejected', delta: 5 });
  coordinator.acceptSnapshot(listener, backend(30, ['spouse-newer']));
  assert.deepEqual(coordinator.getState().data, backend(35, ['spouse-newer', 'rejected']));

  coordinator.rejectWrite(write, new Error('permission denied'));
  assert.deepEqual(coordinator.getState().lastKnownGood, backend(30, ['spouse-newer']));
  assert.deepEqual(coordinator.getState().data, backend(30, ['spouse-newer']));
  assert.equal(coordinator.getState().status, 'error');
  assert.equal(coordinator.getState().error, 'permission denied');
});

test('focus/online/pageshow 恢复请求合并为同一个并发任务', async () => {
  let calls = 0;
  let finish;
  const recovery = new Promise(resolve => { finish = resolve; });
  const coordinator = createCoordinator({
    recover: async () => {
      calls += 1;
      return recovery;
    }
  });
  openHousehold(coordinator, 'family', { cachedState: backend(1) });

  const focus = coordinator.requestRecovery('focus');
  const online = coordinator.requestRecovery('online');
  const pageshow = coordinator.requestRecovery('pageshow');
  assert.strictEqual(focus, online);
  assert.strictEqual(online, pageshow);
  assert.equal(coordinator.getState().status, 'recovering');
  assert.equal(calls, 0, '恢复依赖在微任务中启动');

  await Promise.resolve();
  assert.equal(calls, 1);
  finish({ snapshot: backend(8, ['recovered']) });
  assert.equal(await focus, true);
  assert.equal(coordinator.getState().status, 'synced');
  assert.deepEqual(coordinator.getState().data, backend(8, ['recovered']));
});

test('切换 household 会立即释放旧恢复 gate，且 A 的迟到结果不影响 B 的恢复', async () => {
  const finishes = [];
  let calls = 0;
  const coordinator = createCoordinator({
    recover: () => {
      calls += 1;
      return new Promise(resolve => finishes.push(resolve));
    }
  });
  const { session } = openHousehold(coordinator, 'A', { cachedState: backend(1) });
  const recoveryA = coordinator.requestRecovery('focus');
  await Promise.resolve();
  const listenerB = coordinator.acceptProfile(session, { householdId: 'B' });
  coordinator.acceptSnapshot(listenerB, backend(100));
  const recoveryB = coordinator.requestRecovery('pageshow');
  assert.notStrictEqual(recoveryB, recoveryA);
  await Promise.resolve();
  assert.equal(calls, 2, 'B 的恢复不应等待 A 完成');

  finishes[0]({ snapshot: backend(999) });
  assert.equal(await recoveryA, false);
  assert.deepEqual(coordinator.getState().data, backend(100));
  assert.equal(coordinator.getState().status, 'recovering', 'A 的迟到结果不得释放 B 的 gate');

  finishes[1]({ snapshot: backend(200, ['B-recovered']) });
  assert.equal(await recoveryB, true);
  assert.deepEqual(coordinator.getState().data, backend(200, ['B-recovered']));
});

test('sign-out 单调推进 generation 并使 profile/listener/write/recovery token 全部失效', async () => {
  let finish;
  const recovery = new Promise(resolve => { finish = resolve; });
  const coordinator = createCoordinator({ recover: () => recovery });
  const { session, listener } = openHousehold(coordinator, 'A');
  coordinator.acceptSnapshot(listener, backend(2));
  const write = coordinator.registerWrite('save-before-signout', { id: 'save-before-signout', delta: 3 });
  const recovering = coordinator.requestRecovery('focus');
  const before = coordinator.getState();

  const signedOut = coordinator.signOut();
  assert.ok(signedOut.sessionGeneration > before.sessionGeneration);
  assert.ok(signedOut.householdGeneration > before.householdGeneration);
  assert.equal(signedOut.signedIn, false);
  assert.equal(signedOut.status, 'offline');
  assert.equal(signedOut.householdId, null);
  assert.equal(signedOut.data, undefined);
  assert.equal(signedOut.pendingCount, 0);
  assert.equal(coordinator.acceptProfile(session, { householdId: 'stale' }), null);
  assert.equal(coordinator.acceptSnapshot(listener, backend(999)), false);
  assert.equal(coordinator.acknowledgeWrite(write), false);
  assert.equal(coordinator.rejectWrite(write, 'late reject'), false);

  finish({ snapshot: backend(777) });
  assert.equal(await recovering, false);
  assert.equal(coordinator.getState().signedIn, false);
  assert.equal(coordinator.getState().data, undefined);
});
