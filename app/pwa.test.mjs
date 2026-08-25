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
  for (const asset of ['index.html', 'styles.css', 'main.js', 'ledger.js', 'items.js', 'item-media.js', 'items-view.js', 'cloud-sync.js', 'backup-restore.js', 'wallet-features.js', 'firebase-config.js', 'firebase-client.js']) assert.match(worker, new RegExp(asset.replace('.', '\\.')));
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
  assert.match(worker, /family-wallet-v2-cloud-23/);
});

test('Apple/iPhone 壳层保留五项导航与中央圆形新增入口', async () => {
  const [html, styles] = await Promise.all([readFile(app('./index.html'), 'utf8'), readFile(app('./styles.css'), 'utf8')]);
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">/);
  assert.match(html, /<meta name="apple-mobile-web-app-capable" content="yes">/);
  assert.match(html, /<meta name="apple-mobile-web-app-status-bar-style" content="default">/);
  assert.match(html, /<meta name="apple-mobile-web-app-title" content="Family Wallet">/);

  const nav = html.match(/<nav class="bottom-nav"[^>]*>[\s\S]*?<\/nav>/)?.[0] ?? '';
  assert.deepEqual([...nav.matchAll(/data-view-target="([^"]+)"/g)].map(match => match[1]), ['overview', 'accounts', 'entries', 'items']);
  assert.equal((nav.match(/data-view-target=/g) || []).length, 4);
  assert.equal((nav.match(/<button\b/g) || []).length, 5);
  const quickAdd = nav.match(/<button[^>]*id="newEntryButton"[^>]*>[\s\S]*?<\/button>/)?.[0] ?? '';
  assert.match(quickAdd, /class="nav-item quick-add"/);
  assert.match(quickAdd, /aria-label="新增账目"/);
  assert.doesNotMatch(quickAdd, /data-view-target|<span>|新增账目<\/span>/);
  assert.ok(nav.indexOf('id="accountsNav"') < nav.indexOf('id="newEntryButton"'));
  assert.ok(nav.indexOf('id="newEntryButton"') < nav.indexOf('data-view-target="entries"'));
  assert.doesNotMatch(html, /newEntryAccessory|new-entry-accessory/);
  assert.match(styles, /\.bottom-nav\s*\{[^}]*grid-template-columns:\s*repeat\(5, minmax\(48px, 1fr\)\)/s);
  assert.match(styles, /\.quick-add\s*\{[^}]*width:\s*54px[^}]*height:\s*54px[^}]*border-radius:\s*50%/s);
  assert.match(styles, /\.workspace-select\s*\{[^}]*min-height:\s*44px/s);
  assert.match(styles, /\.topbar-actions \.icon-button\s*\{[^}]*width:\s*44px[^}]*min-height:\s*44px/s);

  for (const token of ['placeholder-ink', 'nav-inactive', 'text-caption', 'text-label', 'text-body']) {
    assert.match(styles, new RegExp(`--${token}:`));
  }
  assert.match(styles, /\.field input::placeholder(?:,\s*\.field textarea::placeholder)?\s*\{[^}]*color:\s*var\(--placeholder-ink\)/s);
  assert.match(styles, /\.nav-item\s*\{[^}]*color:\s*var\(--nav-inactive\)/s);
  assert.match(styles, /font-size:\s*var\(--text-(?:caption|label|body)\)/);
});

test('顶栏更多按钮打开 action sheet，再从菜单进入邀请或设置', async () => {
  const [html, main] = await Promise.all([readFile(app('./index.html'), 'utf8'), readFile(app('./main.js'), 'utf8')]);
  const moreTag = html.match(/<button[^>]*id="moreButton"[^>]*>/)?.[0] ?? '';
  const actionsDialog = html.match(/<dialog[^>]*id="topbarActionsDialog"[^>]*>[\s\S]*?<\/dialog>/)?.[0] ?? '';
  assert.match(moreTag, /aria-haspopup="dialog"/);
  assert.match(moreTag, /aria-controls="topbarActionsDialog"/);
  assert.doesNotMatch(moreTag, /onclick=/);
  assert.match(actionsDialog, /class="topbar-actions-panel"/);
  assert.match(actionsDialog, /id="inviteMemberButton"/);
  assert.match(actionsDialog, /id="openSettingsButton"/);
  assert.doesNotMatch(actionsDialog, /onclick=/);
  assert.match(main, /\$\('#moreButton'\)\.addEventListener\('click', \(\) => \{\s*showDialog\(\$\('#topbarActionsDialog'\)\);/s);
  assert.match(main, /\$\('#openSettingsButton'\)\.addEventListener\('click',[\s\S]*dismissDialog\(\$\('#topbarActionsDialog'\), \(\) => \{[\s\S]*showDialog\(\$\('#settingsDialog'\)\)/);
  assert.match(main, /function openInviteDialog\(\)[\s\S]*showDialog\(\$\('#inviteDialog'\)\)/);
  assert.match(main, /\$\('#inviteMemberButton'\)\.addEventListener\('click',[\s\S]*dismissDialog\(\$\('#topbarActionsDialog'\), openInviteDialog\)/);
  assert.match(main, /inviteMemberButton'\)\.hidden = currentHousehold\.ownerId !== cloudUser\?\.uid/);
  assert.match(main, /inviteMemberButton'\)\.hidden = true/);
  assert.match(main, /dialog\.addEventListener\('cancel'[\s\S]*requestDialogClose\(dialog\)/);
});

test('Service Worker 强制更新资源、导航走网络，并把刷新交给有表单保护的页面', async () => {
  const [main, worker] = await Promise.all([readFile(app('./main.js'), 'utf8'), readFile(app('./service-worker.js'), 'utf8')]);
  assert.match(main, /register\('\.\/service-worker\.js', \{ updateViaCache:'none' \}\)/);
  assert.match(main, /\.then\(registration => registration\.update\(\)\)/);
  assert.match(main, /navigator\.serviceWorker\.addEventListener\('message', handleWalletUpdateMessage\)/);
  assert.match(main, /document\.querySelector\('dialog\[open\]'\)/);
  assert.match(main, /dialog\.addEventListener\('close', applyPendingWalletUpdate\)/);
  assert.match(main, /location\.replace\(refreshUrl\.href\)/);
  assert.match(worker, /cache\.addAll\(ASSETS\.map\(asset => new Request\(asset, \{ cache:'reload' \}\)\)\)/);
  assert.match(worker, /self\.skipWaiting\(\)/);
  assert.match(worker, /self\.clients\.claim\(\)/);
  assert.match(worker, /client\.postMessage\(\{/);
  assert.match(worker, /type:'FAMILY_WALLET_UPDATE_READY'/);
  assert.match(worker, /event\.request\.mode === 'navigate'/);
  assert.match(worker, /fetch\(event\.request\)/);
  assert.doesNotMatch(worker, /client\.navigate\(/);
});

test('17 个 Dialog（含筛选和恢复预览）共用 preparing/open/closing 生命周期，手机短位移且 Receipt 只淡入淡出', async () => {
  const [html, main, styles] = await Promise.all([readFile(app('./index.html'), 'utf8'), readFile(app('./main.js'), 'utf8'), readFile(app('./styles.css'), 'utf8')]);
  assert.equal((html.match(/<dialog\b/g) || []).length, 17);
  for (const id of ['entryFilterDialog', 'restorePreviewDialog']) {
    assert.match(html, new RegExp(`<dialog[^>]*id="${id}"`));
    assert.match(html, new RegExp(`data-close-dialog="${id}"`));
  }
  assert.match(styles, /\.sheet\[open\]\s*\{[^}]*align-items:\s*center/);
  assert.match(styles, /\.modal\[open\]\s*\{[^}]*align-items:\s*center/);
  assert.match(styles, /@media \(max-width: 759px\)[\s\S]*\.sheet\[open\], \.modal\[open\]\s*\{[^}]*align-items:\s*flex-end/s);
  assert.match(styles, /@media \(max-width: 759px\)[\s\S]*\.sheet\s*>\s*form,\s*\.sheet\s*>\s*div[^}]*\{[^}]*border-radius:\s*20px 20px 0 0/s);
  assert.match(main, /classList\.add\('is-preparing'\);\s*dialog\.showModal\(\)/s);
  assert.match(main, /requestAnimationFrame\(\(\) => requestAnimationFrame\(finishOpen\)\)/);
  assert.match(main, /classList\.remove\('is-preparing'\);\s*dialog\.classList\.add\('is-open'\)/s);
  assert.match(main, /prefersReducedMotion\(\)[\s\S]*finishOpen\(\);\s*return;/);
  assert.match(main, /event\.target !== panel \|\| !\['opacity', 'transform'\]\.includes\(event\.propertyName\)/);
  assert.match(main, /panel\.addEventListener\('transitionend', onTransitionEnd\)/);
  assert.doesNotMatch(main, /addEventListener\('animationend'/);
  assert.match(styles, /dialog\.is-open\s*\{[^}]*background-color:\s*rgba\([^;]*0\.42\)/s);
  assert.match(styles, /dialog::backdrop\s*\{[^}]*background:\s*transparent/s);
  assert.match(styles, /translate3d\(0, 24px, 0\)/);
  assert.doesNotMatch(styles, /translateY\(100%\)|mobile-sheet-enter|mobile-sheet-exit/);
  assert.match(styles, /\.topbar-actions-dialog\.is-open \.topbar-actions-backdrop\s*\{[^}]*opacity:\s*1/s);
  assert.match(styles, /\.receipt-viewer\.is-open \.receipt-viewer-shell\s*\{[^}]*opacity:\s*1/s);
  assert.match(styles, /\.receipt-viewer\[open\]\s*\{[^}]*background-color:\s*rgba\(13,\s*27,\s*24,\s*0\)/s);
  assert.match(styles, /\.receipt-viewer\.is-open\s*\{[^}]*background-color:\s*#0d1b18/s);
  assert.match(main, /if \(afterOpen\) requestAnimationFrame\(afterOpen\)/);
  for (const [dialogId, focusId] of [['newItemDialog', 'newItemName'], ['entryDialog', 'amountInput'], ['accountDialog', 'accountName']]) {
    assert.match(main, new RegExp(`showDialog\\(\\$\\('#${dialogId}'\\), \\(\\) => \\$\\('#${focusId}'\\)\\.focus\\(\\)\\)`));
  }
  assert.match(main, /showDialog\(\$\('#paymentDialog'\), \(\) => \(full \? \$\('#paymentDate'\) : \$\('#paymentAmount'\)\)\.focus\(\)\)/);
  assert.doesNotMatch(main, /showDialog\([^\n]+\);\s*setTimeout\(\(\) => [^\n]*\.focus\(\), 30\)/);
  const receiptOpenRule = styles.match(/\.receipt-viewer\.is-open \.receipt-viewer-shell\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.doesNotMatch(receiptOpenRule, /transform/);
  assert.match(main, /if \(event\.target === dialog\) requestDialogClose\(dialog\)/);
  assert.match(main, /dialog\.addEventListener\('cancel'/);
  assert.equal((html.match(/class="account-picker-grabber"/g) || []).length, 1);
  assert.doesNotMatch(html, /class="(?:sheet-handle|action-sheet-handle)"/);
});

test('视图短暂 crossfade、118px 手机底部预留与安全区 Toast 不改变导航语义', async () => {
  const [main, styles] = await Promise.all([readFile(app('./main.js'), 'utf8'), readFile(app('./styles.css'), 'utf8')]);
  assert.match(main, /activeView = view;[\s\S]*data-view-target[\s\S]*aria-current[\s\S]*setAttribute\('data-view-transition', 'entering'\)/);
  assert.match(main, /setTimeout\(\(\) => activeSection\?\.removeAttribute\('data-view-transition'\), 220\)/);
  assert.match(main, /if \(scroll\) window\.scrollTo\(\{ top:0, behavior:'smooth' \}\)/);
  assert.match(styles, /\.app-view(?:\[data-view-transition="entering"\])?\s*\{[^}]*animation:\s*view-enter/s);
  assert.match(styles, /@keyframes view-enter\s*\{[^}]*opacity:\s*0[^}]*\}[^}]*opacity:\s*1/s);
  assert.match(styles, /\.app-shell\s*\{[^}]*padding:[^;]*calc\(118px \+ env\(safe-area-inset-bottom\)\)/s);
  assert.match(styles, /\.toast\s*\{[^}]*top:\s*auto[^}]*bottom:\s*calc\([^;]*env\(safe-area-inset-bottom\)[^;]*\+\s*82px\)/s);
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

test('五个业务账户 select 共用全局原生 dialog Picker，并保留表单值语义', async () => {
  const [html, main, styles] = await Promise.all([
    readFile(app('./index.html'), 'utf8'), readFile(app('./main.js'), 'utf8'), readFile(app('./styles.css'), 'utf8')
  ]);
  const openTags = [];
  const labelAncestors = new Map();
  const voidTags = new Set(['input', 'meta', 'link', 'img', 'br', 'hr']);
  for (const match of html.matchAll(/<\/?([a-z][a-z0-9-]*)\b[^>]*>/gi)) {
    const token = match[0];
    const tag = match[1].toLowerCase();
    if (token.startsWith('</')) {
      while (openTags.length && openTags.pop() !== tag) {}
      continue;
    }
    const id = token.match(/\bid="([^"]+)"/)?.[1];
    if (id) labelAncestors.set(id, openTags.includes('label'));
    if (!voidTags.has(tag) && !token.endsWith('/>')) openTags.push(tag);
  }

  const selectIds = ['sourceAccount', 'targetAccount', 'repaymentSourceAccount', 'newItemAccount', 'paymentAccount'];
  for (const id of selectIds) {
    assert.equal(labelAncestors.get(id), false, `${id} 不得嵌在 label 内`);
    assert.doesNotMatch(html, new RegExp(`<label[^>]*\\bfor="${id}"`));
    assert.match(html, new RegExp(`<select id="${id}"[^>]*\\bhidden\\b[^>]*\\btabindex="-1"[^>]*><\\/select>`));
    assert.match(html, new RegExp(`id="${id}Trigger"[^>]*aria-labelledby="[^"]+"[^>]*aria-haspopup="listbox"[^>]*aria-expanded="false"[^>]*aria-controls="accountPickerOptions"`));
  }
  assert.equal((html.match(/class="account-picker-trigger"/g) || []).length, 5);
  assert.equal((html.match(/<dialog class="account-picker-dialog" id="accountPickerDialog"/g) || []).length, 1);
  assert.ok(html.indexOf('<dialog class="account-picker-dialog" id="accountPickerDialog"') > html.indexOf('</dialog>', html.indexOf('<dialog id="paymentDialog"')));
  assert.match(html, /id="accountPickerBackdrop"[^>]*aria-label="关闭账户选择"/);
  assert.match(html, /id="accountPickerTitle">选择账户<\/h3>/);
  assert.match(html, /id="accountPickerOptions" role="listbox"/);
  assert.doesNotMatch(html, /entryAccountSheet|entryAccountOptions/);
  assert.match(html, /<select class="workspace-select" id="workspaceSelect"/);
  assert.match(html, /<select id="loanType">/);
  assert.match(html, /<select id="loanCalculationMode">/);
  assert.doesNotMatch(html, /id="(?:workspaceSelect|loanType|loanCalculationMode)Trigger"/);

  assert.equal((main.match(/function createAccountPicker\(/g) || []).length, 1);
  assert.match(main, /showDialog\(dialog, \(\) => \{/);
  assert.match(main, /key:'source'[^\n]*options:kind => entryAccounts\(kind\)/);
  assert.match(main, /key:'target'[^\n]*options:\(\) => assetAccounts\(\)/);
  assert.match(main, /key:'repayment'[^\n]*options:\(\) => assetAccounts\(\)/);
  assert.match(main, /key:'newItem'[^\n]*options:\(\) => itemPaymentAccounts\(\)/);
  assert.match(main, /key:'payment'[^\n]*options:\(\) => itemPaymentAccounts\(\)/);
  for (const key of ['repayment', 'newItem', 'payment']) assert.match(main, new RegExp(`accountPicker\\.setOptions\\('${key}', null\\)`));
  assert.doesNotMatch(main, /\$\('#(?:repaymentSourceAccount|newItemAccount|paymentAccount)'\)\.innerHTML/);
  assert.match(main, /role="option"[^>]*aria-selected=/);
  assert.equal((main.match(/select\.dispatchEvent\(new Event\('change', \{ bubbles:true \}\)\)/g) || []).length, 1);
  assert.match(main, /control\.select\.value = accountId;[\s\S]*control\.select\.dispatchEvent\(new Event\('change', \{ bubbles:true \}\)\);\s*close\(\)/s);
  assert.match(main, /control\.trigger\.disabled = control\.select\.disabled \|\| !selected/);
  assert.match(main, /form\.querySelectorAll\('input, select'\).*control\.disabled = true; \}\);\s*accountPicker\.sync\('repayment'\)/s);
  assert.match(main, /\['entryDialog', 'repaymentDialog', 'newItemDialog', 'paymentDialog'\]/);
  assert.match(main, /dialog\?\.id === 'accountPickerDialog'\) accountPicker\.close\(true\)/);
  assert.match(styles, /\.business-account-field > select\[hidden\]\s*\{[^}]*display:\s*none !important[^}]*pointer-events:\s*none !important/s);
  assert.match(styles, /\.account-picker-trigger\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto auto[^}]*overflow:\s*hidden/s);
  assert.doesNotMatch(styles, /\.account-picker-(?:type|amount)::before[^}]*content:\s*["']｜["']/s);
  assert.match(styles, /\.account-picker-dialog\[open\]\s*\{[^}]*display:\s*grid[^}]*align-items:\s*end/s);
  assert.match(styles, /\.account-picker-options\s*\{[^}]*overflow-x:\s*hidden[^}]*overflow-y:\s*auto/s);

  const submitHandler = main.slice(main.indexOf("$('#entryForm').addEventListener('submit'"), main.indexOf("$('#archiveTransactionButton').addEventListener('click'"));
  assert.match(submitHandler, /const form = new FormData\(event\.currentTarget\)/);
  assert.match(submitHandler, /accountId:form\.get\('accountId'\)/);
  assert.match(submitHandler, /targetAccountId:kind === 'transfer' \? form\.get\('targetAccountId'\) : null/);
});

test('账户 Picker 单一 CSS transform owner，轻拖回弹且阈值关闭不先上跳', async () => {
  const [html, main, styles] = await Promise.all([
    readFile(app('./index.html'), 'utf8'), readFile(app('./main.js'), 'utf8'), readFile(app('./styles.css'), 'utf8')
  ]);
  assert.match(html, /class="account-picker-grabber"/);
  assert.match(main, /dragHandleSelector = '\.account-picker-grabber, \.account-picker-handle, \.account-picker-head'/);
  assert.match(main, /dragCloseDistance = 72/);
  assert.match(main, /dragCloseVelocity = 0\.55/);
  assert.match(main, /panel\.addEventListener\('pointerdown'/);
  assert.match(main, /event\.target\.closest\(dragHandleSelector\)/);
  assert.match(main, /event\.target\.closest\('button, a, input, select, textarea, \[role="button"\]'\)/);
  assert.match(main, /panel\.setPointerCapture\?\.\(event\.pointerId\)/);
  assert.match(main, /const dragY = Math\.max\(0, event\.clientY - dragState\.startY\)/);
  assert.match(main, /style\.setProperty\('--sheet-drag-y', `\$\{dragY\}px`\)/);
  assert.match(main, /releaseVelocity = event\.timeStamp - dragState\.lastTime <= 80 \? dragState\.velocity : 0/);
  assert.match(main, /dragState\.dragY > dragCloseDistance \|\| releaseVelocity > dragCloseVelocity/);
  assert.match(main, /if \(shouldClose\) close\(true, \{ preserveDrag:true \}\);\s*else resetDrag\(true\)/);
  assert.match(main, /panel\.classList\.add\('is-dragging'\)/);
  assert.match(main, /panel\.classList\.remove\('is-dragging'\)/);
  assert.match(main, /panel\.addEventListener\('pointercancel'[\s\S]*resetDrag\(true\)/);
  assert.match(main, /if \(animate && dragY > 0 && !prefersReducedMotion\(\)\) void panel\.offsetHeight;\s*panel\.style\.setProperty\('--sheet-drag-y', '0px'\)/s);
  assert.doesNotMatch(main, /panel\.animate|\.animate\?\.\(/);
  assert.match(main, /if \(preserveDrag\)[\s\S]*panel\.classList\.remove\('is-dragging'\);\s*void panel\.offsetHeight;[\s\S]*dismissDialog\(dialog, finishClose\)/s);
  assert.match(styles, /\.account-picker-dialog\.is-open \.account-picker-panel\s*\{[^}]*transform:\s*translate3d\(0, var\(--sheet-drag-y\), 0\)/s);
  assert.match(styles, /\.account-picker-dialog\.is-closing \.account-picker-panel\s*\{[^}]*calc\(var\(--sheet-drag-y\) \+ 20px\)/s);
  assert.match(styles, /\.account-picker-panel\.is-dragging\s*\{[^}]*transition:\s*none/s);
  assert.match(styles, /\.account-picker-grabber[^}]*touch-action:\s*none/s);
  assert.match(styles, /\.account-picker-options\s*\{[^}]*overflow-y:\s*auto[^}]*touch-action:\s*pan-y/s);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.account-picker-panel\s*\{[^}]*transition:\s*none !important/s);
});

test('物品 Tab、上传控件与封面编辑器保持移动端契约', async () => {
  const [html, main, styles] = await Promise.all([
    readFile(app('./index.html'), 'utf8'), readFile(app('./main.js'), 'utf8'), readFile(app('./styles.css'), 'utf8')
  ]);
  assert.match(styles, /\.items-segmented\s*\{[^}]*width:\s*100%[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)[^}]*padding:\s*4px/s);
  assert.match(styles, /\.items-segmented label, \.items-segmented span\s*\{[^}]*width:\s*100%/s);
  assert.match(html, /id="newItemCover" type="file"[^>]*class="visually-hidden-file"|class="visually-hidden-file" id="newItemCover" type="file"/);
  assert.match(html, /id="newItemReceipt" type="file"[^>]*class="visually-hidden-file"|class="visually-hidden-file" id="newItemReceipt" type="file"/);
  for (const id of ['newItemCoverFileName', 'removeNewItemCover', 'newItemReceiptFileName', 'removeNewItemReceipt', 'newItemCoverEditor', 'newItemCoverViewport', 'newItemCoverZoom']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /name="newItemCoverMode" value="full" checked/);
  assert.match(html, /name="newItemCoverMode" value="crop"/);
  assert.match(main, /compressItemMedia\(file, kind, renderPlan \? \{ renderPlan \} : \{\}\)/);
  assert.match(main, /prepareFormMedia\(\$\('#newItemCover'\), 'cover',[\s\S]*currentNewItemCoverRenderPlan\(\)\)/);
  assert.match(styles, /\.file-upload-row\s*\{[^}]*min-height:\s*58px[^}]*padding:\s*6px[^}]*border:/s);
  assert.match(styles, /\.cover-editor-viewport\s*\{[^}]*aspect-ratio:\s*4\s*\/\s*5[^}]*touch-action:\s*none/s);
});

test('九个 date input（含筛选范围）在 50px Safari shell 内垂直居中且保留系统 Picker', async () => {
  const [html, styles] = await Promise.all([readFile(app('./index.html'), 'utf8'), readFile(app('./styles.css'), 'utf8')]);
  const dateIds = ['dateInput', 'expectedPayoffDate', 'repaymentDate', 'newItemEtaDate', 'newItemDepositDate', 'paymentDate', 'editItemEtaDate', 'entryDateFrom', 'entryDateTo'];
  for (const id of dateIds) {
    assert.match(html, new RegExp(`<span class="date-input-shell">\\s*<input id="${id}"[^>]*type="date"[^>]*>\\s*<\\/span>`));
  }
  assert.equal((html.match(/class="date-input-shell"/g) || []).length, 9);
  assert.doesNotMatch(html, /<span class="date-input-shell">\s*<input id="monthPicker"/);
  const shellRule = styles.match(/\.date-input-shell\s*\{([^}]*)\}/)?.[1] ?? '';
  for (const declaration of [
    /display:\s*flex/, /align-items:\s*center/, /height:\s*50px/, /min-height:\s*50px/,
    /width:\s*100%/, /min-width:\s*0/, /max-width:\s*100%/, /inline-size:\s*100%/,
    /min-inline-size:\s*0/, /max-inline-size:\s*100%/, /overflow:\s*hidden/, /border:/, /background:/
  ]) assert.match(shellRule, declaration);
  const inputRule = styles.match(/\.field \.date-input-shell > input\[type="date"\]\s*\{([^}]*)\}/)?.[1] ?? '';
  for (const declaration of [
    /display:\s*flex/, /align-items:\s*center/, /height:\s*48px/, /min-height:\s*48px/, /padding-block:\s*0/, /line-height:\s*1\.2/,
    /width:\s*100%/, /min-width:\s*0/, /max-width:\s*100%/, /inline-size:\s*100%/,
    /min-inline-size:\s*0/, /box-sizing:\s*border-box/, /border:\s*0/, /background:\s*transparent/,
    /-webkit-appearance:\s*none/, /appearance:\s*none/
  ]) assert.match(inputRule, declaration);
  assert.match(styles, /::-webkit-date-and-time-value,\s*\n\.field \.date-input-shell > input\[type="date"\]::-webkit-datetime-edit\s*\{[^}]*display:\s*flex[^}]*align-items:\s*center[^}]*height:\s*100%[^}]*margin:\s*0[^}]*padding:\s*0[^}]*text-align:\s*left/s);
  assert.match(styles, /::-webkit-calendar-picker-indicator\s*\{[^}]*align-self:\s*center/s);
  assert.doesNotMatch(styles, /::-webkit-calendar-picker-indicator\s*\{[^}]*(?:display:\s*none|visibility:\s*hidden)/s);
});

test('还款资金标题独立于分段框，全部欠款动作位于金额标题行且保持低层级', async () => {
  const [html, styles] = await Promise.all([readFile(app('./index.html'), 'utf8'), readFile(app('./styles.css'), 'utf8')]);
  assert.match(html, /<span class="field-label repayment-funding-label" id="repaymentFundingLabel">还款资金来源<\/span>\s*<fieldset class="segmented repayment-funding-control" aria-labelledby="repaymentFundingLabel">/);
  assert.doesNotMatch(html, /<fieldset class="segmented repayment-funding-control"[^>]*>\s*<legend>/);
  assert.match(html, /name="repaymentFunding" value="asset" checked/);
  assert.match(html, /name="repaymentFunding" value="off_ledger"/);
  assert.match(html, /<div class="repayment-amount-title-row"><label id="repaymentAmountLabel" for="repaymentAmount">[^<]+<\/label><button class="repayment-full-button" id="repaymentFullButton" type="button">填入全部欠款<\/button><\/div>\s*<div class="amount-input"><b>RM<\/b><input id="repaymentAmount"/);
  assert.match(styles, /\.repayment-funding-control\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/s);
  assert.match(styles, /\.repayment-full-button\s*\{[^}]*min-height:\s*44px[^}]*border:\s*0[^}]*background:\s*transparent/s);
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

test('账户明细、筛选结果与月度账目共用排序，但筛选不改变月度摘要', async () => {
  const main = await readFile(app('./main.js'), 'utf8');
  assert.match(main, /compareEntriesNewestFirst/);
  assert.equal((main.match(/\.sort\(compareEntriesNewestFirst\)/g) || []).length, 3);
  assert.match(main, /function filteredEntries\(\)[\s\S]*filterEntries\(liveEntries\(\), \{ \.\.\.entryFilters, month:selectedMonth \}/);
  assert.match(main, /function renderEntryResults\(\)[\s\S]*const entries = filteredEntries\(\)/);
  assert.match(main, /const entries = selectedEntries\(\)\.sort\(compareEntriesNewestFirst\);\s*renderEntryResults\(\);\s*renderCategoryOverview\(entries\)/);
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
  assert.match(styles, /\.bottom-nav(?:, \.new-entry-accessory)?\s*\{\s*width:\s*calc\(100% - 16px\);\s*\}/);
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
  assert.match(styles, /@media \(max-width: 759px\)[\s\S]*\.sheet\[open\], \.modal\[open\]\s*\{[^}]*align-items:\s*flex-end/s);
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

test('删除物品会成组作废付款与关联账目，并在回收站恢复物品', async () => {
  const [html, main, client] = await Promise.all([
    readFile(app('./index.html'), 'utf8'), readFile(app('./main.js'), 'utf8'), readFile(app('./firebase-client.js'), 'utf8')
  ]);
  assert.match(html, /id="deleteItemButton"[^>]*>删除物品</);
  assert.match(main, /async function deleteSelectedItem\(button\)/);
  assert.match(main, /cloud\.loadItemPayments\(currentHousehold\.id, item\.id\)/);
  assert.match(main, /cloud\.voidItemPayment\(/);
  assert.match(main, /cloud\.deleteItem\(/);
  assert.match(main, /deleteLocalItem\(nextState, item\.id/);
  assert.match(main, /filter\(entry => entry\.deletedAt && entry\.sourceType !== 'itemPayment'\)/);
  assert.match(main, /data-restore-deleted-item/);
  assert.match(client, /async function mutateDeletedItem\(input, action\)/);
  assert.match(client, /if \(item\.paidMinor !== 0\) throw new Error\('请先作废此物品的所有付款'\)/);
});

test('已同步状态点按会安全刷新 App，其他状态仍执行同步恢复', async () => {
  const [html, main] = await Promise.all([readFile(app('./index.html'), 'utf8'), readFile(app('./main.js'), 'utf8')]);
  assert.match(html, /id="syncBadge"[^>]*已同步时点按可刷新\s*App/);
  assert.match(main, /synced:'已同步 ↻'/);
  assert.match(main, /state\.status === 'synced' && !itemListenerError/);
  assert.match(main, /if \(hasOpenWalletDialog\(\)\)/);
  assert.match(main, /refreshUrl\.searchParams\.set\('wallet-refresh', String\(Date\.now\(\)\)\)/);
  assert.match(main, /location\.replace\(refreshUrl\.href\)/);
  assert.match(main, /syncCoordinator\.requestRecovery\('manual'\)/);
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

test('所有账户类型的大额明细金额独占整行并按长度缩放，不使用省略号', async () => {
  const [html, main, styles] = await Promise.all([
    readFile(app('./index.html'), 'utf8'), readFile(app('./main.js'), 'utf8'), readFile(app('./styles.css'), 'utf8')
  ]);
  assert.match(html, /class="account-detail-balance" id="accountDetailBalance" data-amount-size="standard"/);
  assert.match(main, /function accountDetailAmountSize\(amountMinor\)/);
  assert.match(main, /detailBalance\.dataset\.amountSize = accountDetailAmountSize\(account\.balanceMinor\)/);
  assert.match(styles, /grid-template-areas:\s*"avatar copy action"\s*"balance balance balance"/);
  assert.match(styles, /\.account-detail-balance\s*\{[^}]*grid-area:\s*balance[^}]*overflow:\s*visible[^}]*white-space:\s*nowrap/s);
  assert.match(styles, /\.account-detail-balance\[data-amount-size="compact"\]/);
  assert.match(styles, /\.account-detail-balance\[data-amount-size="dense"\]/);
  assert.match(styles, /@media \(max-width: 520px\)\s*\{[^}]*grid-template-areas:\s*"avatar copy"\s*"balance balance"\s*"action action"/s);
  const balanceRule = styles.match(/\.account-detail-balance\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.doesNotMatch(balanceRule, /text-overflow|overflow:\s*hidden/);
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
  assert.match(main, /item\.deletedAt \|\| !item\.etaDate \|\| item\.archivedAt/);
  assert.match(main, /item\.etaDate.*data-upcoming-type/s);
  assert.match(html, /class="account-subtype-options"/);
  assert.doesNotMatch(html, /class="segmented account-subtype-control"/);
  assert.match(main, /class="account-groups"/);
  assert.match(main, /class="account-group-heading"/);
  assert.match(html, /id="categoryDonutTotal"/);
  assert.match(html, /id="upcomingActionList"/);
  assert.doesNotMatch(html, /recentTransactionList/);
  assert.match(styles, /\.category-donut\s*\{/);
  assert.match(styles, /\.account-subtype-control\s*\{[^}]*min-inline-size:\s*0[^}]*background:\s*transparent/s);
  assert.match(styles, /\.account-subtype-options\s*\{[^}]*grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\)[^}]*min-width:\s*0/s);
  assert.match(styles, /\.account-subtype-options span\s*\{[^}]*min-height:\s*44px/s);
  assert.match(styles, /\.upcoming-action-row\s*\{/);
});

test('成熟度升级把恢复、成员、筛选、模板、引导与 actor 接到真实 UI 路径', async () => {
  const [html, main, firebase, styles] = await Promise.all([
    readFile(app('./index.html'), 'utf8'), readFile(app('./main.js'), 'utf8'),
    readFile(app('./firebase-client.js'), 'utf8'), readFile(app('./styles.css'), 'utf8')
  ]);
  for (const id of [
    'gettingStarted', 'entrySearchInput', 'allMonthsToggle', 'entryFilterDialog', 'entryKindFilter',
    'entryAccountFilter', 'entryCategoryFilter', 'entryDateFrom', 'entryDateTo', 'copyPreviousEntry',
    'saveEntryTemplate', 'entryTemplateList', 'householdMembersSection', 'memberList', 'restoreFileInput',
    'restorePreviewDialog', 'restorePreview', 'confirmRestoreButton'
  ]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /id="restoreFileInput"[^>]*accept="application\/json,\.json"/);
  assert.match(main, /createBackupPayload\(\{/);
  assert.match(main, /validateBackup\(payload,/);
  assert.match(main, /deterministicImportIdentity\(payload, cloudUser\.uid\)/);
  assert.match(main, /cloud\.restoreBackupCopy\(\{ identity:request\.identity, validated:request\.validated, user:cloudUser \}\)/);
  assert.match(main, /replaceLocalAtomically\(\{[\s\S]*downloadCurrent:\(\) => downloadCurrentBackup/);
  assert.match(main, /function filteredEntries\(\)[\s\S]*filterEntries\(liveEntries\(\)/);
  assert.match(main, /copyPreviousEntry\(liveEntries\(\)\)/);
  assert.match(main, /saveEntryTemplate\(localStorage, scope\.userId, scope\.householdId/);
  assert.match(main, /onboardingState\(\{/);
  assert.ok((main.match(/visibleActor\(/g) || []).length >= 5);
  assert.match(main, /if \(!isCurrentOwner\(\)\) \{[\s\S]*householdPendingInvites = \[\][\s\S]*return;[\s\S]*cloud\.loadPendingInvites\(householdId\)/);
  for (const api of ['subscribeMembers', 'loadPendingInvites', 'setMemberActive', 'cancelInvite', 'restoreBackupCopy']) {
    assert.match(firebase, new RegExp(api));
  }
  assert.match(firebase, /const remaining = await loadPendingInvites\(householdId\)/);
  for (const selector of ['getting-started', 'entry-filter-bar', 'entry-template-list', 'member-list', 'restore-preview']) {
    assert.match(styles, new RegExp(`\\.${selector}`));
  }
});

test('Build、Service Worker 与 GitHub Actions 使用同一 Cloud 23 候选和受支持 runtime', async () => {
  const [build, worker, workflow] = await Promise.all([
    readFile(app('../scripts/build.mjs'), 'utf8'), readFile(app('./service-worker.js'), 'utf8'),
    readFile(app('../.github/workflows/pages.yml'), 'utf8')
  ]);
  for (const module of ['backup-restore.js', 'wallet-features.js']) {
    assert.match(build, new RegExp(module.replace('.', '\\.')));
    assert.match(worker, new RegExp(module.replace('.', '\\.')));
  }
  assert.match(worker, /family-wallet-v2-cloud-23/);
  for (const action of [
    'actions/checkout@v7', 'actions/setup-node@v7', 'actions/setup-java@v6',
    'actions/configure-pages@v6', 'actions/upload-pages-artifact@v5', 'actions/deploy-pages@v5'
  ]) assert.match(workflow, new RegExp(action.replace('/', '\\/')));
});
