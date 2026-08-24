import test from 'node:test';
import assert from 'node:assert/strict';
import { createLedger } from './ledger.js';
import { createItemsState, createItem, recordItemPayment } from './items.js';
import {
  LOCAL_SCHEMA_VERSION, describeEtaDate, displayItemsFromLocal, hydrateLocalEnvelope, mergePendingLedgerPatch,
  normaliseDisplayItem, rawSnapshotHasOperation, renderItemCards, serialiseLocalEnvelope,
  withoutMediaDataUrls
} from './items-view.js';

const ledger = () => createLedger({
  accounts:[{ id:'cash', name:'现金', kind:'asset', openingBalanceMinor:100000, includeInTotal:true }],
  transactions:[], appliedOperationIds:[]
});

test('本机 v2 envelope 往返并兼容旧裸账本', () => {
  const item = createItem(createItemsState(), {
    id:'camera', operationId:'create-camera', name:'相机', fullPriceMinor:50000
  });
  const envelope = serialiseLocalEnvelope(ledger(), item.state, [{ id:'cover', dataUrl:'data:image/jpeg;base64,/9j/2Q==' }]);
  assert.equal(envelope.schemaVersion, LOCAL_SCHEMA_VERSION);
  const hydrated = hydrateLocalEnvelope(JSON.stringify(envelope), ledger());
  assert.equal(hydrated.ledger.accounts[0].id, 'cash');
  assert.equal(displayItemsFromLocal(hydrated.itemsState)[0].name, '相机');
  assert.equal(hydrated.itemMedia[0].id, 'cover');

  const legacy = hydrateLocalEnvelope(JSON.stringify({ ...envelope.ledger }), ledger());
  assert.equal(legacy.ledger.accounts[0].id, 'cash');
  assert.equal(displayItemsFromLocal(legacy.itemsState).length, 0);
});

test('待同步 patch 总是在最新 snapshot 上按稳定 ID 合并', () => {
  const raw = { household:{ id:'home' }, accounts:[{ id:'cash', name:'旧名称' }], transactions:[{ id:'tx-1', amountMinor:100 }] };
  const account = mergePendingLedgerPatch(raw, { kind:'accountPatch', record:{ id:'cash', name:'新名称' } });
  const transaction = mergePendingLedgerPatch(account, { kind:'transactionPatch', record:{ id:'tx-1', amountMinor:250, lastOperationId:'edit-1' } });
  assert.equal(transaction.accounts[0].name, '新名称');
  assert.equal(transaction.transactions[0].amountMinor, 250);
  assert.equal(raw.accounts[0].name, '旧名称');
  assert.equal(raw.transactions[0].amountMinor, 100);
});

test('snapshot operation 只从交易持久字段确认', () => {
  assert.equal(rawSnapshotHasOperation({ transactions:[{ operationId:'create-1' }] }, 'create-1'), true);
  assert.equal(rawSnapshotHasOperation({ transactions:[{ lastOperationId:'edit-1' }] }, 'edit-1'), true);
  assert.equal(rawSnapshotHasOperation({ transactions:[] }, 'missing'), false);
});

test('橱窗派生余额、进度与归档状态正确', () => {
  let state = createItem(createItemsState(), {
    id:'lens', operationId:'create-lens', name:'镜头', fullPriceMinor:100000
  }).state;
  state = recordItemPayment(state, 'lens', {
    paymentId:'pay-1', operationId:'pay-op-1', amountMinor:25000, mode:'independent', occurredAt:'2026-08-23T12:00:00.000Z'
  }).state;
  const item = normaliseDisplayItem(displayItemsFromLocal(state)[0]);
  assert.deepEqual([item.paidMinor, item.balanceMinor, item.progress, item.status], [25000, 75000, 25, 'active']);
});

test('橱窗卡片保持两端安全转义并只渲染独立媒体缓存', () => {
  const item = normaliseDisplayItem({ id:'x" onclick="bad', name:'<相机>', fullPriceMinor:10000, paidMinor:2000, coverMediaId:'cover-1' });
  const noMedia = renderItemCards([item], { formatMoney:value => `RM ${(value / 100).toFixed(2)}`, householdId:'home' });
  assert.match(noMedia, /data-cover-media-id="cover-1"/);
  assert.doesNotMatch(noMedia, /<相机>/);
  const withMedia = renderItemCards([item], {
    formatMoney:value => `RM ${(value / 100).toFixed(2)}`,
    householdId:'home',
    mediaCache:new Map([['home/cover-1', { dataUrl:'data:image/jpeg;base64,/9j/2Q==' }]])
  });
  assert.match(withMedia, /loading="lazy"/);
  assert.match(withMedia, /data:image\/jpeg;base64/);
});

test('到货日期说明只比较 YYYY-MM-DD 字段，不依赖时区解析', () => {
  assert.equal(describeEtaDate('2026-09-12', '2026-09-10'), '预计 9月12日到货');
  assert.equal(describeEtaDate('2026-09-12', '2026-09-12'), '预计今天到货');
  assert.equal(describeEtaDate('2026-09-12', '2026-09-13'), '原预计 9月12日');
  assert.equal(describeEtaDate(null, '2026-09-13'), '');
});

test('物品卡片以不同文字标示三种状态，待付含余额，ETA 保持低层级且输出安全转义', () => {
  const html = renderItemCards([
    { id:'active', name:'<书桌>', fullPriceMinor:10000, paidMinor:2000, etaDate:'2026-09-12' },
    { id:'completed', name:'相机', fullPriceMinor:5000, paidMinor:5000 },
    { id:'archived', name:'旧手机', fullPriceMinor:3000, paidMinor:3000, archivedAt:'2026-09-01T00:00:00.000Z' }
  ], {
    formatMoney:value => `RM ${(value / 100).toFixed(2)}`,
    todayDate:'2026-09-10'
  });
  assert.match(html, /<small class="item-eta">预计 9月12日到货<\/small>/);
  assert.match(html, /data-item-status="active">待付 RM 80\.00<\/em>/);
  assert.match(html, /data-item-status="completed">已付清<\/em>/);
  assert.match(html, /data-item-status="archived">已归档<\/em>/);
  assert.doesNotMatch(html, />余额 RM/);
  assert.doesNotMatch(html, /<书桌>/);

  const escapedMoney = renderItemCards([
    { id:'safe', name:'安全', fullPriceMinor:100, paidMinor:0 }
  ], { formatMoney:() => 'RM <script>alert(1)</script>', todayDate:'2026-09-10' });
  assert.doesNotMatch(escapedMoney, /<script>/);
  assert.match(escapedMoney, /待付 RM &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('备份递归移除照片 Data URL 与图片字段但保留业务元数据', () => {
  const safe = withoutMediaDataUrls({
    account:{ id:'cash', photoDataUrl:'data:image/jpeg;base64,/9j/' },
    item:{ id:'camera', coverMediaId:'cover-1' },
    nested:[{ dataUrl:'data:image/jpeg;base64,/9j/', amountMinor:1000 }]
  });
  assert.deepEqual(safe, {
    account:{ id:'cash' }, item:{ id:'camera', coverMediaId:'cover-1' }, nested:[{ amountMinor:1000 }]
  });
});
