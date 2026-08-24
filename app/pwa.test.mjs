import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const app = relative => new URL(relative, import.meta.url);

test('PWA 声明与离线 worker 引用所有首屏模块', async () => {
  const [html, manifest, worker, styles] = await Promise.all([
    readFile(app('./index.html'), 'utf8'), readFile(app('./manifest.webmanifest'), 'utf8'), readFile(app('./service-worker.js'), 'utf8'), readFile(app('./styles.css'), 'utf8')
  ]);
  assert.match(html, /rel="manifest"/);
  assert.match(html, /rel="apple-touch-icon"[^>]*icons\/apple-touch-icon\.png/);
  assert.match(html, /rel="icon"[^>]*icons\/favicon-32\.png/);
  assert.match(html, /type="module" src="\.\/main\.js"/);
  const manifestData = JSON.parse(manifest);
  assert.equal(manifestData.display, 'standalone');
  assert.deepEqual(manifestData.icons.map(icon => icon.sizes), ['192x192', '512x512', '512x512']);
  for (const asset of ['index.html', 'styles.css', 'main.js', 'ledger.js', 'items.js', 'item-media.js', 'items-view.js', 'cloud-sync.js', 'firebase-config.js', 'firebase-client.js']) assert.match(worker, new RegExp(asset.replace('.', '\\.')));
  for (const icon of ['favicon-32.png', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png']) assert.match(worker, new RegExp(icon.replace('.', '\\.')));
  assert.match(worker, /self\.skipWaiting\(\)/);
  assert.match(worker, /caches\.keys\(\).*cacheName !== CACHE/s);
  assert.match(worker, /event\.request\.method !== 'GET'/);
  assert.match(worker, /event\.request\.mode === 'navigate'.*caches\.match\('\.\/index\.html'\)/s);
  assert.match(styles, /dialog\s*\{[^}]*position:\s*fixed/);
  assert.match(styles, /\.sheet>form,\.sheet>div\s*\{[^}]*overflow-y:\s*auto/);
});

test('Premium Mobile UI 保留主要视图、洞察层级与移动材质', async () => {
  const [html, main, styles, worker] = await Promise.all([
    readFile(app('./index.html'), 'utf8'), readFile(app('./main.js'), 'utf8'),
    readFile(app('./styles.css'), 'utf8'), readFile(app('./service-worker.js'), 'utf8')
  ]);
  for (const view of ['overview', 'entries', 'accounts', 'items']) {
    assert.match(html, new RegExp(`data-view="${view}"`));
    assert.match(html, new RegExp(`data-view-target="${view}"`));
  }
  assert.match(html, /id="categoryInsightList"/);
  assert.match(html, /id="categoryDonut"/);
  assert.match(html, /id="upcomingActionList"/);
  assert.doesNotMatch(html, /id="recentTransactionList"/);
  assert.match(main, /function setView\(view,/);
  assert.match(main, /function spendingCategories\(entries\)/);
  assert.match(styles, /\.bottom-nav\s*\{[^}]*backdrop-filter:/s);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(styles, /env\(safe-area-inset-bottom\)/);
  assert.match(worker, /family-wallet-v2-cloud-12/);
});

test('手机记账和账户明细使用中心悬浮层，可点空白或 Escape 动态关闭', async () => {
  const [main, styles] = await Promise.all([readFile(app('./main.js'), 'utf8'), readFile(app('./styles.css'), 'utf8')]);
  assert.match(styles, /\.sheet\[open\]\s*\{[^}]*align-items:\s*center/);
  assert.doesNotMatch(styles, /\.sheet\[open\]\s*\{[^}]*align-items:\s*flex-end/);
  assert.match(styles, /@keyframes modal-enter/);
  assert.match(styles, /@keyframes modal-exit/);
  assert.match(main, /if \(event\.target === dialog\) requestDialogClose\(dialog\)/);
  assert.match(main, /dialog\.addEventListener\('cancel'/);
});

test('快速分类提供指定 Icon 标签与其它自定义输入，备注仍保持可选', async () => {
  const [html, main] = await Promise.all([readFile(app('./index.html'), 'utf8'), readFile(app('./main.js'), 'utf8')]);
  for (const category of ['薪水', '购物', '医疗', '房贷', '电费', '税费', '打油', '汽车', '其它']) {
    assert.match(html, new RegExp(`data-category="${category}"`));
  }
  assert.match(html, /id="customCategoryInput"/);
  assert.match(html, /备注（可选）/);
  assert.match(main, /function selectCategory\(value = '', focusCustom = false\)/);
  assert.match(main, /请选择分类，或在“其它”填写自定义分类/);
});

test('账户明细按手机 6 笔、桌面 10 笔分页并保留新到旧排序', async () => {
  const [html, main] = await Promise.all([readFile(app('./index.html'), 'utf8'), readFile(app('./main.js'), 'utf8')]);
  for (const id of ['accountDetailPagination', 'accountDetailPrevPage', 'accountDetailPageLabel', 'accountDetailNextPage']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(main, /const accountDetailPageSize = \(\) => innerWidth < 600 \? 6 : 10/);
  assert.match(main, /\.sort\(compareEntriesNewestFirst\)/);
  assert.match(main, /entries\.slice\(pageStart, pageStart \+ pageSize\)/);
  assert.match(main, /pagination\.hidden = totalPages <= 1/);
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

test('账户明细与全部账目共用日期和新增时间排序，首页不再复制交易列表', async () => {
  const main = await readFile(app('./main.js'), 'utf8');
  assert.match(main, /compareEntriesNewestFirst/);
  assert.equal((main.match(/\.sort\(compareEntriesNewestFirst\)/g) || []).length, 2);
  assert.doesNotMatch(main, /recentTransactionList/);
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
  assert.match(client, /watchUser:[\s\S]*includeMetadataChanges:\s*true[\s\S]*snapshotMetadata\(snapshot\)/);
  assert.match(client, /family-\$\{ownerUid\}-\$\{crypto\.randomUUID\(\)\}/);
  assert.match(client, /initializeApp\(useEmulators \? \{/);
  assert.match(client, /\} : config\)/);
  assert.match(client, /async function signInGoogle\(\)/);
  assert.match(client, /signInWithPopup\(auth, googleProvider\)/);
  assert.doesNotMatch(client, /authDomain:\s*globalThis\.location\.hostname/);
  assert.doesNotMatch(client, /finishRedirectSignIn|getRedirectResult/);
  assert.match(main, /let googleSignInPending = false/);
  assert.match(main, /button\.setAttribute\('aria-busy', 'true'\)/);
  assert.match(main, /Google 登录窗口已打开，请在该窗口完成登录/);
  assert.match(main, /正在检查 Google 登录状态/);
  assert.match(main, /cloud\.onAuthChanged\(user => \{[\s\S]*googleSignInButton'\)\.hidden = Boolean\(user\)/);
  assert.doesNotMatch(config, /private_key|serviceAccount|accessToken/i);
});

test('云端同步按账户和每笔账目分开保存，余额由账目重算而非共享覆盖', async () => {
  const [main, client, ledger] = await Promise.all([
    readFile(app('./main.js'), 'utf8'), readFile(app('./firebase-client.js'), 'utf8'), readFile(app('./ledger.js'), 'utf8')
  ]);
  assert.match(main, /deriveLedger\(\{ accounts:raw\.accounts, transactions:raw\.transactions \}\)/);
  assert.match(client, /collection\(db, 'households', householdId, 'transactions'\)/);
  assert.match(client, /saveTransaction:/);
  const accountRecordBody = client.match(/const accountRecord = \(account, householdId\) => cleanRecord\(\{([\s\S]*?)\}\);/)?.[1] || '';
  assert.doesNotMatch(accountRecordBody, /balanceMinor:/);
  assert.match(ledger, /export function deriveLedger/);
});

test('物品橱窗、设置导出与同步恢复均接入真实运行路径', async () => {
  const [html, main, styles, client, itemsView] = await Promise.all([
    readFile(app('./index.html'), 'utf8'), readFile(app('./main.js'), 'utf8'),
    readFile(app('./styles.css'), 'utf8'), readFile(app('./firebase-client.js'), 'utf8'),
    readFile(app('./items-view.js'), 'utf8')
  ]);
  for (const id of [
    'moreButton', 'settingsDialog', 'exportButton', 'itemsGrid', 'newItemDialog', 'itemDetailDialog',
    'paymentDialog', 'editItemDialog', 'archiveItemButton', 'restoreItemButton'
  ]) assert.match(html, new RegExp(`id="${id}"`));
  assert.doesNotMatch(html, /data-view-target="backup"/);
  assert.match(html, /data-view-target="items"/);
  assert.match(main, /cloud\.createItem\(/);
  assert.match(main, /cloud\.addItemPayment\(/);
  assert.match(main, /cloud\[action === 'void' \? 'voidItemPayment' : 'restoreItemPayment'\]/);
  assert.match(main, /cloud\[action === 'archive' \? 'archiveItem' : 'restoreItem'\]/);
  assert.match(main, /openItemFromLedger\(entry\.sourceItemId, entry\.sourcePaymentId\)/);
  assert.match(main, /entry\?\.sourceType === 'itemPayment'/);
  assert.match(main, /new IntersectionObserver/);
  assert.match(client, /async function loadItemMedia/);
  assert.match(client, /async function loadAllItemPayments/);
  assert.match(itemsView, /schemaVersion:LOCAL_SCHEMA_VERSION/);
  assert.match(itemsView, /withoutMediaDataUrls/);
  assert.match(styles, /\.items-grid\s*\{[^}]*repeat\(2,/s);
  assert.match(styles, /@media \(min-width: 1024px\)[\s\S]*\.items-grid\s*\{[^}]*repeat\(4,/);
  assert.match(styles, /\.modal\[open\]\s*\{[^}]*align-items:\s*center/);
  assert.doesNotMatch(styles, /\.modal\[open\]\s*\{[^}]*align-items:\s*flex-end/);
});

test('同步状态区分缓存、待同步、离线和恢复，并在前台事件后重订阅', async () => {
  const main = await readFile(app('./main.js'), 'utf8');
  for (const status of ['cached', 'pending', 'synced', 'offline', 'recovering', 'error']) {
    assert.match(main, new RegExp(`${status}:`));
  }
  assert.match(main, /syncCoordinator\.registerWrite/);
  assert.match(main, /syncCoordinator\.acceptSnapshot\(listenerToken, raw, metadata\)/);
  assert.match(main, /window\.addEventListener\('online'/);
  assert.match(main, /window\.addEventListener\('offline'/);
  assert.match(main, /window\.addEventListener\('focus'/);
  assert.match(main, /window\.addEventListener\('pageshow'/);
  assert.match(main, /document\.addEventListener\('visibilitychange'/);
  assert.match(main, /syncCoordinator\.requestRecovery\(trigger\)/);
  assert.match(main, /switchCloudHousehold\(event\.target\.value, \{ persistSelection:true \}\)/);
  assert.doesNotMatch(main, /ledger = previous/);
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
  for (const runtime of ['items.js', 'item-media.js', 'items-view.js', 'cloud-sync.js']) assert.match(build, new RegExp(runtime.replace('.', '\\.')));
  assert.doesNotMatch(build, /cp\(source, output/);
  assert.doesNotMatch(build, /emulator-login\.html|\.test\.mjs/);
});

test('付款凭证使用独立按需 viewer，并提供关闭与下载', async () => {
  const [html, main] = await Promise.all([readFile(app('./index.html'), 'utf8'), readFile(app('./main.js'), 'utf8')]);
  for (const id of ['receiptViewerDialog', 'receiptViewerImage', 'receiptViewerMeta', 'saveReceiptButton']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(main, /loadMediaOnce\(currentMediaHouseholdId\(\), payment\.receiptMediaId\)/);
  assert.match(main, /saveLink\.download = `family-wallet-/);
  assert.match(main, /closeReceiptViewerButton'\)\.addEventListener\('click', closeReceiptViewer\)/);
  assert.doesNotMatch(main, /receiptPreview|closeReceiptButton/);
});

test('物品 ETA 在本机与云端新增、编辑及详情路径完整传递', async () => {
  const main = await readFile(app('./main.js'), 'utf8');
  assert.match(main, /etaDate:\$\('#newItemEtaDate'\)\.value \|\| null/);
  assert.match(main, /\$\('#editItemEtaDate'\)\.value = item\.etaDate \|\| ''/);
  assert.match(main, /etaDate:\$\('#editItemEtaDate'\)\.value \|\| null/);
  assert.match(main, /describeEtaDate\(item\.etaDate, today\(\)\)/);
});

test('账户子类型驱动选择范围、分组、详情指标与保存元数据', async () => {
  const main = await readFile(app('./main.js'), 'utf8');
  assert.match(main, /function entryAccounts\(kind\)/);
  assert.match(main, /\['asset', 'credit_card', 'generic_liability'\]/);
  assert.match(main, /function itemPaymentAccounts\(\)/);
  assert.match(main, /function renderAccountGroups\(accounts\)/);
  assert.match(main, /remainingPayoffMonths\(account\)/);
  assert.match(main, /const kind = subtype === 'asset' \? 'asset' : 'liability'/);
  assert.doesNotMatch(main, /name="accountKind"/);
});

test('还款使用单一 ledger operation 与正常 transaction 同步路径', async () => {
  const main = await readFile(app('./main.js'), 'utf8');
  assert.match(main, /function openRepayment\(accountId, transactionId = null, returnAccountId = null\)/);
  assert.match(main, /kind:'repayment'/);
  assert.match(main, /const breakdown = currentRepaymentBreakdown\(account\)/);
  assert.match(main, /amountMinor:breakdown\.amountMinor/);
  assert.match(main, /principalMinor:breakdown\.principalMinor/);
  assert.match(main, /interestMinor:breakdown\.interestMinor/);
  assert.match(main, /applyLedgerOperation\(ledger, \{ id:pendingRepayment\.operationId, \.\.\.changes \}\)/);
  assert.match(main, /saveTransactionRecord\(next, transactionId\)/);
  assert.match(main, /moveToRecycleBin\(ledger, pendingRepayment\.transactionId/);
  assert.match(main, /既有还款不能直接覆写，请移入回收站后重新记录/);
  assert.match(main, /saveRepaymentButton'\)\.hidden = reviewing/);
  assert.match(main, /form\.querySelectorAll\('input, select'\).*control\.disabled = true/s);
  assert.match(main, /function openRepaymentFromDetail\(accountId, transactionId = null\)/);
  assert.match(main, /dismissDialog\(\$\('#accountDetailDialog'\), \(\) => openRepayment\(accountId, transactionId, accountId\)\)/);
  assert.match(main, /function closeRepayment\(\{ returnToDetail = false \} = \{\}\)/);
  assert.match(main, /else if \(dialog\?\.id === 'repaymentDialog'\) closeRepayment\(\{ returnToDetail:true \}\)/);
  assert.match(main, /openRepaymentButton'\)\.addEventListener\('click', \(\) => openRepaymentFromDetail\(selectedAccountDetailId\)\)/);
  assert.doesNotMatch(main, /openRepaymentButton'\)\.addEventListener\('click', \(\) => openRepayment\(selectedAccountDetailId\)\)/);
});

test('用户反馈界面：账户可辨识、排除总额不冻结、贷款留白与皮肤设置完整', async () => {
  const [html, main, styles] = await Promise.all([
    readFile(app('./index.html'), 'utf8'), readFile(app('./main.js'), 'utf8'), readFile(app('./styles.css'), 'utf8')
  ]);
  assert.match(main, /\$\{escapeHtml\(account\.name\)\} ｜ \$\{escapeHtml\(type\)\} ｜ \$\{escapeHtml\(balance\)\}/);
  assert.match(main, /account\.kind === 'liability' \? `欠款/);
  assert.match(main, /class="account-total-status excluded">不计入总额/);
  assert.match(styles, /\.account-row\.excluded\s*\{\s*opacity:\s*1/);
  assert.match(main, /class="account-detail-metric"/);
  assert.match(styles, /\.account-detail-metrics\s*\{[^}]*gap:\s*10px[^}]*margin:\s*0 0 24px/s);
  for (const theme of ['teal', 'maybank', 'cimb', 'ocean']) {
    assert.match(html, new RegExp(`name="appTheme" value="${theme}"`));
  }
  assert.match(main, /const THEME_STORE = 'family-wallet-v2-theme'/);
  assert.match(main, /localStorage\.setItem\(THEME_STORE, selected\)/);
  assert.match(styles, /:root\[data-theme="maybank"\]/);
  assert.match(styles, /:root\[data-theme="cimb"\]/);
  assert.match(styles, /:root\[data-theme="ocean"\]/);
});

test('马来西亚还款表单使用总额输入并自动采用信用卡全额或贷款计划月供', async () => {
  const [html, main] = await Promise.all([readFile(app('./index.html'), 'utf8'), readFile(app('./main.js'), 'utf8')]);
  assert.match(html, /id="repaymentAmount"/);
  assert.doesNotMatch(html, /id="repaymentPrincipal"/);
  assert.match(main, /const suggestion = suggestedRepayment\(account\)/);
  assert.match(main, /默认一次还清/);
  assert.match(main, /默认月供/);
  assert.match(main, /estimatedMonthlyInterestMinor\(account\)/);
  assert.match(main, /loanCalculationMode:subtype === 'loan'/);
  assert.match(main, /annualInterestRateBps:subtype === 'loan'/);
});

test('概览圆环统计真实消费并呈现近期负债与 ETA 事项', async () => {
  const [html, main, styles] = await Promise.all([
    readFile(app('./index.html'), 'utf8'),
    readFile(app('./main.js'), 'utf8'),
    readFile(app('./styles.css'), 'utf8')
  ]);
  assert.match(main, /entry\.kind === 'repayment'.*entry\.interestMinor/s);
  assert.match(main, /category = '贷款利息与费用'/);
  assert.match(main, /sorted\.slice\(0, 4\)/);
  assert.match(main, /donut\.style\.background = `conic-gradient/);
  assert.match(main, /renderCategoryOverview\(entries\);\s*renderItemsView\(\);\s*renderUpcomingActions\(\);/);
  assert.match(main, /subtype === 'credit_card'.*account\.dueDay/s);
  assert.match(main, /subtype === 'loan'.*account\.scheduledPaymentMinor/s);
  assert.match(main, /item\.etaDate.*data-upcoming-type/s);
  assert.match(main, /class="account-groups"/);
  assert.match(main, /class="account-group-heading"/);
  assert.match(html, /id="categoryDonutTotal"/);
  assert.match(html, /id="upcomingActionList"/);
  assert.doesNotMatch(html, /recentTransactionList/);
  assert.match(styles, /\.category-donut\s*\{/);
  assert.match(styles, /\.upcoming-action-row\s*\{/);
});
