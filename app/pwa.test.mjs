import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const app = relative => new URL(relative, import.meta.url);

test('PWA 声明与离线 worker 引用所有首屏模块', async () => {
  const [html, manifest, worker, styles] = await Promise.all([
    readFile(app('./index.html'), 'utf8'), readFile(app('./manifest.webmanifest'), 'utf8'), readFile(app('./service-worker.js'), 'utf8'), readFile(app('./styles.css'), 'utf8')
  ]);
  assert.match(html, /rel="manifest"/);
  assert.match(html, /type="module" src="\.\/main\.js"/);
  assert.equal(JSON.parse(manifest).display, 'standalone');
  for (const asset of ['index.html', 'styles.css', 'main.js', 'ledger.js', 'firebase-config.js', 'firebase-client.js']) assert.match(worker, new RegExp(asset.replace('.', '\\.')));
  assert.match(worker, /self\.skipWaiting\(\)/);
  assert.match(worker, /caches\.keys\(\).*cacheName !== CACHE/s);
  assert.match(worker, /event\.request\.method !== 'GET'/);
  assert.match(worker, /event\.request\.mode === 'navigate'.*caches\.match\('\.\/index\.html'\)/s);
  assert.match(styles, /dialog\s*\{[^}]*position:\s*fixed/);
  assert.match(styles, /\.sheet>form,\.sheet>div\s*\{[^}]*overflow-y:\s*auto/);
});

test('Premium Mobile UI 保留真实三视图、洞察层级与移动材质', async () => {
  const [html, main, styles, worker] = await Promise.all([
    readFile(app('./index.html'), 'utf8'), readFile(app('./main.js'), 'utf8'),
    readFile(app('./styles.css'), 'utf8'), readFile(app('./service-worker.js'), 'utf8')
  ]);
  for (const view of ['overview', 'entries', 'accounts']) {
    assert.match(html, new RegExp(`data-view="${view}"`));
    assert.match(html, new RegExp(`data-view-target="${view}"`));
  }
  assert.match(html, /id="categoryInsightList"/);
  assert.match(html, /id="recentTransactionList"/);
  assert.match(main, /function setView\(view,/);
  assert.match(main, /function spendingCategories\(entries\)/);
  assert.match(styles, /\.bottom-nav\s*\{[^}]*backdrop-filter:/s);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(styles, /env\(safe-area-inset-bottom\)/);
  assert.match(worker, /family-wallet-v2-cloud-6/);
});

test('中央新增按钮不会把 click event 当成交易 ID', async () => {
  const main = await readFile(app('./main.js'), 'utf8');
  assert.match(main, /\$\('#newEntryButton'\)\.addEventListener\('click', \(\) => openEntry\(\)\)/);
  assert.doesNotMatch(main, /\$\('#newEntryButton'\)\.addEventListener\('click', openEntry\)/);
  assert.match(main, /const entryId = typeof id === 'string' \? id : null/);
});

test('新增账目会按支出、收入与转账分别记住有效账户', async () => {
  const main = await readFile(app('./main.js'), 'utf8');
  assert.match(main, /ENTRY_PREFS_STORE = 'family-wallet-v2-entry-preferences'/);
  assert.match(main, /byKind:\{ expense:\{\}, income:\{\}, transfer:\{\} \}/);
  assert.match(main, /function rememberEntryPreferences\(kind, accountId, targetAccountId\)/);
  assert.match(main, /function applyRememberedAccounts\(kind\)/);
  assert.match(main, /rememberEntryPreferences\(kind, changes\.accountId, changes\.targetAccountId\)/);
  assert.match(main, /account\.id !== sourceId/);
});

test('账目显示账户流向，账户点击先打开当月明细再进入编辑', async () => {
  const [html, main] = await Promise.all([readFile(app('./index.html'), 'utf8'), readFile(app('./main.js'), 'utf8')]);
  for (const id of ['accountDetailDialog', 'accountDetailTransactionList', 'editAccountFromDetailButton']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(main, /function accountFlowLabel\(entry\)/);
  assert.match(main, /return `\$\{source\} → \$\{target\}`/);
  assert.match(main, /function openAccountDetail\(accountId\)/);
  assert.match(main, /openAccountDetail\(button\.dataset\.accountId\)/);
  assert.match(main, /entry\.accountId === account\.id \|\| entry\.targetAccountId === account\.id/);
});

test('账户明细、全部账目和首页最近账目共用日期与新增时间排序', async () => {
  const main = await readFile(app('./main.js'), 'utf8');
  assert.match(main, /compareEntriesNewestFirst/);
  assert.equal((main.match(/\.sort\(compareEntriesNewestFirst\)/g) || []).length, 3);
  assert.doesNotMatch(main, /\.sort\(\(a, b\) => b\.occurredAt\.localeCompare\(a\.occurredAt\)\)/);
});

test('账户照片在本机压缩、预览、保存与移除', async () => {
  const [html, main, ledger, styles] = await Promise.all([
    readFile(app('./index.html'), 'utf8'), readFile(app('./main.js'), 'utf8'),
    readFile(app('./ledger.js'), 'utf8'), readFile(app('./styles.css'), 'utf8')
  ]);
  assert.match(html, /id="accountPhotoInput" type="file" accept="image\/jpeg,image\/png,image\/webp"/);
  assert.match(html, /id="removeAccountPhotoButton"/);
  assert.match(main, /async function compressAccountPhoto\(file\)/);
  assert.match(main, /drawSquarePhoto\(image, 256, 0\.82\)/);
  assert.match(main, /photoDataUrl:pendingAccountPhotoDataUrl/);
  assert.match(ledger, /normaliseAccountPhoto/);
  assert.match(styles, /\.account-photo-preview img\s*\{[^}]*object-fit:\s*cover/);
});

test('桌面断点使用左侧导航与宽内容区，手机规则保持独立', async () => {
  const styles = await readFile(app('./styles.css'), 'utf8');
  assert.match(styles, /@media \(min-width: 1024px\)\s*\{/);
  assert.match(styles, /width:\s*min\(calc\(100% - 190px\), 1180px\)/);
  assert.match(styles, /\.bottom-nav\s*\{[^}]*grid-template-columns:\s*1fr/s);
  assert.match(styles, /@media \(max-width: 420px\)\s*\{/);
  assert.match(styles, /\.bottom-nav\s*\{ width:\s*calc\(100% - 16px\); \}/);
});

test('账目明细可从列表进入编辑，并在编辑表单中安全移入回收站', async () => {
  const [html, main] = await Promise.all([
    readFile(app('./index.html'), 'utf8'), readFile(app('./main.js'), 'utf8')
  ]);
  assert.match(html, /id="editingTransactionId" type="hidden"/);
  assert.match(html, /id="archiveTransactionButton" type="button" hidden>移入回收站/);
  assert.match(main, /updateTransaction/);
  assert.match(main, /openEntry\(button\.dataset\.transactionId\)/);
  assert.match(main, /updateTransaction\(ledger, editingTransactionId,/);
});

test('月度摘要和明细可切换到指定月份，而非只显示当前月份', async () => {
  const [html, main] = await Promise.all([
    readFile(app('./index.html'), 'utf8'), readFile(app('./main.js'), 'utf8')
  ]);
  assert.match(html, /id="monthPicker" type="month"/);
  assert.match(main, /let selectedMonth = today\(\)\.slice\(0, 7\)/);
  assert.match(main, /monthlySummary\(ledger, selectedMonth\)/);
  assert.match(main, /entry\.occurredAt\.slice\(0, 7\) === selectedMonth/);
  assert.match(main, /\$\('#monthPicker'\)\.addEventListener\('change'/);
});

test('Auth Emulator 登录页仅限 localhost，并具备注册、登录和登出状态回读', async () => {
  const login = await readFile(app('./emulator-login.html'), 'utf8');
  assert.match(login, /\['127\.0\.0\.1','localhost'\]\.includes\(location\.hostname\)/);
  assert.match(login, /connectAuthEmulator\(auth,'http:\/\/127\.0\.0\.1:9099'/);
  assert.match(login, /createUserWithEmailAndPassword/);
  assert.match(login, /signInWithEmailAndPassword/);
  assert.match(login, /signOut\(auth\)/);
  assert.match(login, /onAuthStateChanged\(auth,u=>status\(u\?'当前测试 UID：'\+u\.uid:'未登录。可注册或登录测试帐号。'\)\)/);
});

test('正式入口包含 Google 登录、个人/家庭账本选择、Gmail 邀请和受邀接受流程', async () => {
  const [html, main, client, config] = await Promise.all([
    readFile(app('./index.html'), 'utf8'), readFile(app('./main.js'), 'utf8'),
    readFile(app('./firebase-client.js'), 'utf8'), readFile(app('./firebase-config.js'), 'utf8')
  ]);
  for (const id of ['authGate', 'googleSignInButton', 'workspaceSelect', 'inviteMemberButton', 'inviteDialog', 'inviteEmail', 'pendingInvitePanel', 'acceptInviteButton']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(main, /firebaseConfigured/);
  assert.match(main, /cloud\.ensureWorkspace\(user\)/);
  assert.match(main, /cloud\.inviteMember/);
  assert.match(main, /cloud\.acceptInvite/);
  assert.match(client, /GoogleAuthProvider/);
  assert.match(client, /signInWithPopup/);
  assert.match(client, /initializeAppCheck/);
  assert.match(client, /ReCaptchaEnterpriseProvider/);
  assert.match(client, /getDoc\(doc\(db, 'access', user\.uid\)\)/);
  assert.match(client, /此帐号尚未获准使用。授权编号/);
  assert.match(client, /personalHouseholdId/);
  assert.match(client, /householdIds:\s*arrayUnion/);
  assert.match(client, /family-\$\{ownerUid\}-\$\{crypto\.randomUUID\(\)\}/);
  assert.doesNotMatch(config, /private_key|serviceAccount|accessToken/i);
});

test('云端同步按账户和每笔账目分开保存，余额由账目重算而非共享覆盖', async () => {
  const [main, client, ledger] = await Promise.all([
    readFile(app('./main.js'), 'utf8'), readFile(app('./firebase-client.js'), 'utf8'), readFile(app('./ledger.js'), 'utf8')
  ]);
  assert.match(main, /deriveLedger\(\{ accounts: state\.accounts, transactions: state\.transactions \}\)/);
  assert.match(client, /collection\(db, 'households', householdId, 'transactions'\)/);
  assert.match(client, /saveTransaction:/);
  const accountRecordBody = client.match(/const accountRecord = \(account, householdId\) => cleanRecord\(\{([\s\S]*?)\}\);/)?.[1] || '';
  assert.doesNotMatch(accountRecordBody, /balanceMinor:/);
  assert.match(ledger, /export function deriveLedger/);
});

test('GitHub Pages 流程先跑测试、Rules Emulator 和 Build，再发布静态 dist', async () => {
  const [workflow, build] = await Promise.all([
    readFile(new URL('../.github/workflows/pages.yml', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/build.mjs', import.meta.url), 'utf8')
  ]);
  assert.match(workflow, /npm test/);
  assert.match(workflow, /npm run test:rules:emulator/);
  assert.match(workflow, /npm run audit:public/);
  assert.match(workflow, /npm run build/);
  assert.match(workflow, /secrets\.FIREBASE_API_KEY/);
  assert.match(workflow, /secrets\.FIREBASE_APP_CHECK_SITE_KEY/);
  assert.match(workflow, /path: dist/);
  assert.doesNotMatch(workflow, /service.?account|private.?key|access.?token/i);
  assert.match(build, /FIREBASE_API_KEY/);
  assert.doesNotMatch(build, /cp\(source, output/);
  assert.doesNotMatch(build, /emulator-login\.html|\.test\.mjs/);
});
