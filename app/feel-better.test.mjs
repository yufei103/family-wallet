import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const app = path => new URL(path, import.meta.url);
const sources = async () => {
  const [html, main, styles] = await Promise.all([
    readFile(app('./index.html'), 'utf8'),
    readFile(app('./main.js'), 'utf8'),
    readFile(app('./styles.css'), 'utf8')
  ]);
  return { html, main, styles };
};

function callArguments(source, name) {
  const calls = [];
  const needle = `${name}(`;
  let cursor = 0;
  while ((cursor = source.indexOf(needle, cursor)) >= 0) {
    const prefix = source.slice(Math.max(0, cursor - 12), cursor);
    if (/function\s*$/.test(prefix)) { cursor += needle.length; continue; }
    let depth = 1;
    let quote = null;
    let escaped = false;
    let templateExpressionDepth = 0;
    let index = cursor + needle.length;
    for (; index < source.length && depth; index += 1) {
      const char = source[index];
      if (escaped) { escaped = false; continue; }
      if (quote) {
        if (char === '\\') { escaped = true; continue; }
        if (quote === '`' && char === '$' && source[index + 1] === '{') { templateExpressionDepth += 1; index += 1; continue; }
        if (quote === '`' && char === '}' && templateExpressionDepth) { templateExpressionDepth -= 1; continue; }
        if (char === quote && !templateExpressionDepth) quote = null;
        continue;
      }
      if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
      if (char === '(') depth += 1;
      else if (char === ')') depth -= 1;
    }
    calls.push(source.slice(cursor + needle.length, index - 1));
    cursor = index;
  }
  return calls;
}

function hasTopLevelComma(argumentsSource) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = 0; index < argumentsSource.length; index += 1) {
    const char = argumentsSource[index];
    if (escaped) { escaped = false; continue; }
    if (quote) {
      if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') quote = char;
    else if ('([{'.includes(char)) depth += 1;
    else if (')]}'.includes(char)) depth -= 1;
    else if (char === ',' && depth === 0) return true;
  }
  return false;
}

test('Stage 2B1 typed Toast has local icon/text, explicit tone, correct roles and bounded timing', async () => {
  const { html, main, styles } = await sources();
  assert.match(html, /id="toast"[^>]*>[\s\S]*data-feedback-icon[\s\S]*data-toast-text/);
  assert.match(main, /const TOAST_DURATIONS\s*=\s*Object\.freeze\(\{[^}]*neutral:2800[^}]*success:2800[^}]*warning:4500[^}]*error:4500/s);
  assert.match(main, /function showToast\(message, tone\)/);
  assert.match(main, /toast\.dataset\.tone = tone/);
  assert.match(main, /toast\.setAttribute\('role',\s*actionFailure \? 'alert' : 'status'\)/);
  assert.match(main, /const repeated = [^;]+/);
  assert.match(main, /clearTimeout\(toastTimer\)[\s\S]*TOAST_DURATIONS\[tone\]/);
  assert.match(styles, /\.toast\s*\{[^}]*transition:[^;]*var\(--motion-fast\)/s);
  assert.match(styles, /\.toast\.is-hiding\s*\{[^}]*transition-duration:\s*120ms/s);
  for (const tone of ['neutral', 'success', 'warning', 'error']) assert.match(styles, new RegExp(`\\.toast\\[data-tone="${tone}"\\]`));
  const toastCalls = callArguments(main, 'showToast');
  assert.ok(toastCalls.length >= 25, 'major actions should use the typed toast');
  assert.deepEqual(toastCalls.filter(call => !hasTopLevelComma(call)), [], 'every showToast call site must pass an explicit tone');
});

test('Stage 2B1 FeedbackRow centralizes tone, stable icon, ARIA association and stale-state clearing', async () => {
  const { html, main, styles } = await sources();
  assert.ok((html.match(/class="[^"]*form-message/g) || []).length >= 10);
  assert.match(main, /function setFeedback\(target, message, tone/);
  assert.match(main, /function clearFeedback\(target/);
  assert.match(main, /data-feedback-icon/);
  assert.match(main, /aria-describedby/);
  assert.match(main, /aria-invalid/);
  assert.match(main, /feedback\.dataset\.tone = tone/);
  assert.match(main, /feedback\.setAttribute\('role',\s*tone === 'error' \? 'alert' : 'status'\)/);
  assert.match(main, /document\.querySelectorAll\('\.form-message/);
  assert.match(styles, /\.form-message,[\s\S]*min-height:/);
  assert.match(styles, /\.feedback-row\[data-tone="error"\]/);
  assert.doesNotMatch(main, /classList\.(?:add|remove)\('success'\)/, 'tone cleanup must not depend on stale success classes');
});

test('Stage 2B1 one action-state helper covers every major promise lifecycle and always unlocks', async () => {
  const { main, styles } = await sources();
  assert.match(main, /function setActionButtonState\(button, state/);
  assert.match(main, /function releaseActionButton\(button/);
  assert.match(main, /button\.innerHTML = `\$\{stateIconMarkup\('action', 'idle'\)\}<span data-action-label>/);
  assert.match(main, /setStateIcon\(button, state\)/);
  assert.doesNotMatch(main + styles, /actionStateIconMarkup|data-action-icon-state|action-state-spin|\binfinite\b/);
  assert.match(main, /button\.setAttribute\('aria-busy', 'true'\)/);
  assert.match(main, /button\.removeAttribute\('aria-busy'\)/);
  assert.match(main, /button\.disabled = previousDisabled/);
  for (const state of ['idle', 'pending', 'success', 'error']) {
    assert.match(styles, new RegExp(`\\[data-action-state="${state}"\\]`));
  }
  for (const id of [
    'googleSignInButton', 'acceptInviteButton', 'sendInviteButton', 'saveEntryButton', 'saveAccountButton',
    'saveRepaymentButton', 'saveNewItemButton', 'savePaymentButton', 'saveEditItemButton', 'exportButton',
    'confirmRestoreButton', 'refreshMembersButton', 'archiveItemButton', 'restoreItemButton', 'deleteItemButton'
  ]) assert.match(main, new RegExp(`setActionButtonState\\(\\$\\('#${id}'\\)|setActionButtonState\\(button`, 's'), `${id} must use the shared action state`);
  assert.ok((main.match(/finally\s*\{[\s\S]{0,180}releaseActionButton\(/g) || []).length >= 10, 'major async actions must unlock in finally');
});

test('Stage 2B1 Balanced Handoff uses stable IDs, one 220ms wash and real completed mutations', async () => {
  const { main, styles } = await sources();
  assert.match(main, /function queueBalancedHandoff\(kind, id\)/);
  assert.match(main, /function applyBalancedHandoffs\(\)/);
  assert.match(main, /data-transaction-id=/);
  assert.match(main, /data-account-id=/);
  assert.match(main, /setAttribute\('data-item-id', item\.id\)/);
  assert.match(main, /data-payment-id=/);
  assert.match(styles, /\.balanced-handoff\s*\{[^}]*animation:[^;]*220ms/s);
  assert.match(styles, /@keyframes balanced-handoff-wash/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.balanced-handoff\s*\{[^}]*animation:\s*none !important/s);
  for (const kind of ['transaction', 'account', 'item', 'payment']) assert.match(main, new RegExp(`queueBalancedHandoff\\('${kind}'`));
  assert.doesNotMatch(styles + main, /confetti|bounce|elastic|countUp|odometer/i);
});

test('Stage 2B1 presentation wiring does not move business calls before validation or success before await', async () => {
  const { main } = await sources();
  const newItem = main.slice(main.indexOf("$('#newItemForm').addEventListener('submit'"), main.indexOf("$('#paymentForm').addEventListener('submit'"));
  assert.ok(newItem.indexOf("amountToSen($('#newItemFullPrice').value)") < newItem.indexOf('await cloud.createItem('));
  assert.ok(newItem.indexOf('await cloud.createItem(') < newItem.indexOf("setActionButtonState(button, 'success'"));
  const payment = main.slice(main.indexOf("$('#paymentForm').addEventListener('submit'"), main.indexOf("$('#editItemForm').addEventListener('submit'"));
  assert.ok(payment.indexOf('amountMinor > item.balanceMinor') < payment.indexOf('await cloud.addItemPayment(input)'));
  assert.ok(payment.indexOf('await cloud.addItemPayment(input)') < payment.indexOf("setActionButtonState(button, 'success'"));
  const entry = main.slice(main.indexOf("$('#entryForm').addEventListener('submit'"), main.indexOf("$('#archiveTransactionButton').addEventListener('click'"));
  assert.ok(entry.indexOf("if (kind !== 'transfer' && !category)") < entry.indexOf('await applyLedgerChange('));
  assert.ok(entry.indexOf('await applyLedgerChange(') < entry.indexOf("setActionButtonState(button, 'success'"));
  const restore = main.slice(main.indexOf('async function prepareRestoreFile'), main.indexOf('function closeRepayment'));
  assert.ok(restore.indexOf('await validateBackup(') < restore.indexOf("setActionButtonState(button, 'success'"));
  assert.ok(restore.indexOf('await cloud.restoreBackupCopy(') < restore.indexOf('location.replace('));
});

test('Stage 2B2 ledger writes keep local echo but cannot acknowledge or show success before the write settles', async () => {
  const { main } = await sources();
  const helper = main.slice(main.indexOf('async function applyLedgerChange'), main.indexOf('function activeAccounts'));
  assert.ok(helper.indexOf('ledger = nextLedger;') < helper.indexOf('render();'));
  assert.ok(helper.indexOf('render();') < helper.indexOf('await Promise.resolve(writePromise)'));
  assert.match(helper, /const acknowledgement = await Promise\.resolve\(writePromise\);[\s\S]*syncCoordinator\.acknowledgeWrite\(token\);[\s\S]*return acknowledgement/);
  assert.match(helper, /catch \(error\) \{[\s\S]*syncCoordinator\.rejectWrite\(token, error\);[\s\S]*throw error;[\s\S]*\}/);
  assert.doesNotMatch(helper, /Promise\.resolve\(writePromise\)\.then/);

  const allCalls = [...main.matchAll(/applyLedgerChange\(/g)].map(match => main.slice(main.lastIndexOf('\n', match.index) + 1, main.indexOf('\n', match.index)));
  assert.ok(allCalls.length >= 8);
  assert.deepEqual(allCalls.filter(line => !line.includes('function applyLedgerChange') && !line.includes('await applyLedgerChange')), [], 'every ledger mutation call must be awaited');
  for (const match of main.matchAll(/await applyLedgerChange\(/g)) {
    assert.match(main.slice(match.index, match.index + 1100), /setActionButtonState\(button, 'success'\)/, 'success state must follow each awaited ledger write');
  }
});

test('Stage 2B2 action lifecycle uses one registry icon and has no loop animation', async () => {
  const { main, styles } = await sources();
  const initializer = main.slice(main.indexOf('function ensureActionButton'), main.indexOf('function setActionButtonState'));
  assert.match(initializer, /stateIconMarkup\('action', 'idle'\)/);
  assert.equal((initializer.match(/stateIconMarkup\('action', 'idle'\)/g) || []).length, 1);
  assert.match(main, /button\.dataset\.actionState = state;\s*setStateIcon\(button, state\);/s);
  assert.match(styles, /\[data-action-state\] > \.app-icon\s*\{[^}]*width:\s*18px[^}]*height:\s*18px/s);
  assert.doesNotMatch(main + styles, /actionStateIconMarkup|data-action-icon-state|action-state-spin|\binfinite\b|\bspinner\b/i);
});

test('save-entry relabeling preserves the enhanced Action Morphicons subtree', async () => {
  const { main } = await sources();
  const openEntry = main.slice(main.indexOf('function openEntry'), main.indexOf('function renderAccountPhotoPreview'));
  const formReset = openEntry.indexOf("$('#entryForm').reset()");
  const titleSetup = openEntry.indexOf("$('#entryDialogTitle').textContent = entry ? '编辑账目' : '新增账目'");
  const safeRelabel = openEntry.indexOf("resetActionButton($('#saveEntryButton'), entry ? '保存修改' : '保存账目')");
  assert.ok(formReset >= 0 && formReset < titleSetup && titleSetup < safeRelabel, 'save-entry relabeling must happen through resetActionButton after form/title setup');
  assert.doesNotMatch(openEntry, /\$\('#saveEntryButton'\)\.textContent\s*=/, 'direct textContent replacement destroys the already-enhanced icon subtree');
  assert.equal((openEntry.match(/resetActionButton\(\$\('#saveEntryButton'\)/g) || []).length, 1);

  class FakeButton {
    constructor(label) {
      this.dataset = {};
      this.disabled = false;
      this.attributes = new Map();
      this.icon = null;
      this.label = null;
      this._text = label;
    }
    get textContent() { return this.label ? this.label.textContent : this._text; }
    set textContent(value) {
      this._text = String(value);
      this.icon = null;
      this.label = null;
    }
    set innerHTML(value) {
      const label = value.match(/<span data-action-label>([\s\S]*)<\/span>/)?.[1] ?? '';
      this._text = '';
      this.icon = value.includes('data-state-icon') ? { dataset:{ state:'idle' } } : null;
      this.label = { textContent:label };
    }
    querySelector(selector) {
      if (selector === '[data-action-label]') return this.label;
      if (selector === '[data-state-icon]') return this.icon;
      return null;
    }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    removeAttribute(name) { this.attributes.delete(name); }
  }

  const helperSource = main.slice(main.indexOf('function ensureActionButton'), main.indexOf('function initializeActionButtons'));
  const helpers = Function('stateIconMarkup', 'escapeHtml', 'setStateIcon', `${helperSource}; return { setActionButtonState, resetActionButton };`)(
    (_name, state) => `<svg data-state-icon data-state="${state}"></svg>`,
    value => String(value),
    (button, state) => { button.querySelector('[data-state-icon]').dataset.state = state; }
  );
  const button = new FakeButton('保存账目');
  helpers.setActionButtonState(button, 'pending', { label:'保存中…' });
  helpers.resetActionButton(button, '保存修改');
  assert.equal(button.querySelector('[data-action-label]').textContent, '保存修改');
  assert.equal(button.querySelector('[data-state-icon]').dataset.state, 'idle', 'idle icon markup must remain available for the next action state');

  const knownWrong = new FakeButton('保存账目');
  helpers.resetActionButton(knownWrong, '保存账目');
  knownWrong.textContent = '保存修改';
  assert.equal(knownWrong.querySelector('[data-state-icon]'), null, 'the regression must distinguish the known-wrong direct textContent overwrite');
});

test('Stage 2B2 item, payment, member and invite reads distinguish loading/error from verified empty with generation fencing', async () => {
  const { main, styles } = await sources();
  assert.match(main, /itemReadState = \{ householdId, generation, hasSnapshot:false, error:null \}/);
  assert.match(main, /generation !== itemReadState\.generation[\s\S]*householdId !== desiredHouseholdId/);
  assert.match(main, /awaitingFirstSnapshot && !visible\.length[\s\S]*renderItemsLoadingState\('正在载入物品，请稍候。'\)[\s\S]*renderItemCards\(visible/);
  assert.match(main, /itemPaymentReadState = \{ householdId, itemId, generation, hasSnapshot:false, error:null \}/);
  assert.match(main, /generation !== itemPaymentReadState\.generation[\s\S]*selectedItemId !== itemId/);
  assert.match(main, /awaitingPayments[\s\S]*timeline-read-state[\s\S]*paymentTimelineMarkup\(currentItemPayments\)/);
  assert.match(main, /memberReadState = \{[\s\S]*membersKnown:false, invitesKnown:!owner/);
  assert.match(main, /generation !== memberReadGeneration \|\| householdId !== desiredHouseholdId/);
  assert.match(main, /if \(!owner\) \{[\s\S]*householdPendingInvites = \[\][\s\S]*invitesReady = Promise\.resolve\(\{ ok:true \}\)/);
  assert.match(main, /invitesReady = cloud\.loadPendingInvites\(householdId\)/);
  assert.match(main, /const readsKnown = memberReadState\.membersKnown && \(!owner \|\| memberReadState\.invitesKnown\);[\s\S]*rows\.join\(''\) \|\| \(readsKnown[\s\S]*尚无成员资料/);
  assert.match(styles, /\.items-loading-state,[\s\S]*\.timeline-read-state,[\s\S]*\.member-read-state\s*\{/);
});

test('Stage 2B2 media phases expose validating/compressing/ready/error and cover retry without motion loops', async () => {
  const { main, styles } = await sources();
  const media = main.slice(main.indexOf('const MEDIA_STATUS_COPY'), main.indexOf('function clearPendingNewItemMedia'));
  const prepare = main.slice(main.indexOf('async function prepareFormMedia'), main.indexOf('function clearPendingNewItemMedia'));
  for (const phase of ['validating', 'compressing', 'ready', 'error']) {
    assert.match(media, new RegExp(`setMediaStatus\\(statusElement, kind, '${phase}'\\)|${phase}:`));
    assert.match(styles, new RegExp(`\\.media-status\\[data-media-phase="${phase}"\\]`));
  }
  assert.ok(prepare.indexOf("setMediaStatus(statusElement, kind, 'validating')") < prepare.indexOf('validateSelectedMediaFile(file)'));
  assert.ok(prepare.indexOf("setMediaStatus(statusElement, kind, 'compressing')") < prepare.indexOf('await compressItemMedia('));
  assert.ok(prepare.indexOf('await compressItemMedia(') < prepare.indexOf("setMediaStatus(statusElement, kind, 'ready')", prepare.indexOf('await compressItemMedia(')));
  assert.match(main, /data-retry-cover/);
  assert.match(main, /data-retry-detail-cover/);
  assert.match(styles, /\.item-cover-error \.minor-button,\s*\.item-cover-retry\s*\{[^}]*min-width:\s*44px;\s*min-height:\s*44px/s);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.media-status\s*\{[^}]*transition:\s*none !important/s);
});

test('Stage 2B2 submit errors focus the mapped invalid control without scrolling', async () => {
  const { main } = await sources();
  const report = main.slice(main.indexOf('function reportSubmitError'), main.indexOf('function initializeFeedbackRows'));
  assert.match(report, /form\?\.querySelector\?\.\(':invalid'\)/);
  assert.match(report, /setFeedback\(feedbackTarget, error\.message, 'error', control\)/);
  assert.match(report, /control\.focus\(\{ preventScroll:true \}\)/);
  assert.match(report, /catch \{ control\.focus\(\); \}/);
});

test('Stage 2B2 destructive confirms run before IDs, derivation, mutation state or pending UI', async () => {
  const { main } = await sources();
  const permanentDelete = main.slice(main.indexOf("document.querySelectorAll('[data-delete]')"), main.indexOf('async function currentBackupPayload'));
  const deleteConfirm = permanentDelete.indexOf("confirm('永久删除这笔账目？此操作无法撤销。')");
  assert.ok(deleteConfirm >= 0);
  for (const later of ["uid('delete')", 'permanentlyDelete(', "setActionButtonState(button, 'pending'"]) assert.ok(deleteConfirm < permanentDelete.indexOf(later), `${later} must occur after irreversible confirmation`);

  const archive = main.slice(main.indexOf("$('#archiveAccountButton').addEventListener"), main.indexOf('function stopItemListeners'));
  const archiveConfirm = archive.indexOf("confirm('归档后，这个账户会被隐藏并从家庭净额排除；目前没有恢复入口。确定继续吗？')");
  assert.ok(archiveConfirm >= 0);
  assert.ok(archiveConfirm < archive.indexOf('archiveAccount(ledger, id)'));
  assert.ok(archiveConfirm < archive.indexOf("setActionButtonState(button, 'pending'"));
  assert.match(archive, /if \(!confirm\([^)]+\)\) return;/);
});

test('Stage 2B2 payment correction menu clamps its actual post-layout rect to the visual viewport', async () => {
  const { main, styles } = await sources();
  const portal = main.slice(main.indexOf('let paymentMenuPortal'), main.indexOf('function paymentTimelineMarkup'));
  const clamping = main.slice(main.indexOf('function paymentMenuViewportBounds'), main.indexOf('function portalPaymentMenu'));
  assert.match(portal, /\$\('#itemDetailDialog'\)\.append\(popover\)/);
  assert.match(portal, /popover\.style\.position = 'fixed'/);
  assert.match(portal, /const viewport = paymentMenuViewportBounds\(\)/);
  assert.match(portal, /popover\.style\.visibility = 'visible';\s*clampPaymentMenuToViewport\(popover\)/);
  assert.match(clamping, /window\.visualViewport/);
  assert.match(clamping, /window\.innerWidth/);
  assert.match(clamping, /window\.innerHeight/);
  assert.match(clamping, /popover\.getBoundingClientRect\(\)/);
  assert.match(clamping, /for \(let pass = 0; pass < 2; pass \+= 1\)/);

  const visualWindow = { innerWidth:900, innerHeight:900, visualViewport:{ width:390, height:844, offsetLeft:0, offsetTop:0 } };
  const clamp = Function('window', `${clamping}; return clampPaymentMenuToViewport;`)(visualWindow);
  const style = { left:'250px', top:'790px' };
  let rectReads = 0;
  const popover = {
    style,
    getBoundingClientRect() {
      rectReads += 1;
      const width = Math.min(150, Number.parseFloat(style.maxWidth) || Infinity);
      const height = Math.min(54, Number.parseFloat(style.maxHeight) || Infinity);
      const left = Number.parseFloat(style.left) + 10;
      const top = Number.parseFloat(style.top) + 21.703125;
      return { left, top, right:left + width, bottom:top + height, width, height };
    }
  };
  clamp(popover);
  const corrected = popover.getBoundingClientRect();
  assert.ok(rectReads >= 3, 'must measure after layout and verify a bounded correction pass');
  assert.equal(corrected.right, 382);
  assert.equal(corrected.bottom, 836);
  assert.ok(corrected.left >= 8 && corrected.top >= 8);

  const oversizedStyle = { left:'8px', top:'8px' };
  const oversized = {
    style:oversizedStyle,
    getBoundingClientRect() {
      const width = Math.min(500, Number.parseFloat(oversizedStyle.maxWidth) || Infinity);
      const height = Math.min(900, Number.parseFloat(oversizedStyle.maxHeight) || Infinity);
      const left = Number.parseFloat(oversizedStyle.left);
      const top = Number.parseFloat(oversizedStyle.top);
      return { left, top, right:left + width, bottom:top + height, width, height };
    }
  };
  clamp(oversized);
  assert.equal(oversizedStyle.maxWidth, '374px');
  assert.equal(oversizedStyle.maxHeight, '828px');
  assert.deepEqual(oversized.getBoundingClientRect(), { left:8, top:8, right:382, bottom:836, width:374, height:828 });

  assert.match(portal, /restorePaymentMenuPortal\(\)[\s\S]*owner\.open = false/);
  assert.match(main, /document\.addEventListener\('pointerdown',[\s\S]*\.payment-menu-popover[\s\S]*\.payment-menu[\s\S]*closePaymentCorrectionMenus\(\)/);
  assert.match(main, /window\.addEventListener\('resize', closePaymentCorrectionMenus\)/);
  assert.match(main, /window\.addEventListener\('scroll', closePaymentCorrectionMenus, true\)/);
  assert.match(styles, /\.payment-row-actions \[data-view-receipt\], \.payment-menu > summary\s*\{[^}]*min-width:\s*44px[^}]*min-height:\s*44px/s);
  assert.match(styles, /\.payment-menu-popover button\s*\{[^}]*min-height:\s*44px/s);
});

test('Stage 2B2 deferred update uses the sync anchor, exact protocol and no second toast or banner', async () => {
  const { main, styles } = await sources();
  const handler = main.slice(main.indexOf('function handleWalletUpdateMessage'), main.indexOf('function requestDialogClose'));
  assert.match(handler, /event\.data\?\.type !== 'FAMILY_WALLET_UPDATE_READY'/);
  assert.match(handler, /pendingWalletUpdateCache = String\(event\.data\.cache \|\| 'latest'\)/);
  assert.match(handler, /if \(hasOpenWalletDialog\(\)\) \{[\s\S]*setSyncState\('更新就绪，完成当前操作后刷新', false, 'update'\)[\s\S]*setAttribute\('role', 'status'\)[\s\S]*setAttribute\('aria-live', 'polite'\)[\s\S]*return;/);
  assert.doesNotMatch(handler, /showToast|toast|banner/i);
  assert.match(handler, /applyPendingWalletUpdate\(\);/);
  assert.match(main, /dialog\.addEventListener\('close',[\s\S]*applyPendingWalletUpdate\(\)/);
  assert.match(styles, /\.local-badge\[data-state="update"\]/);
});

test('Stage 2B2 320px layout, 44px correction/retry targets and reduced motion remain explicit', async () => {
  const { styles } = await sources();
  const narrow = styles.slice(styles.indexOf('@media (max-width: 359px)'), styles.indexOf('@media (max-width: 759px) and (orientation: landscape)'));
  assert.match(narrow, /\.items-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/s);
  assert.match(narrow, /\.payment-row\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/s);
  assert.match(styles, /\.item-cover-retry\s*\{[^}]*min-width:\s*44px;\s*min-height:\s*44px/s);
  const reduced = styles.slice(styles.indexOf('@media (prefers-reduced-motion: reduce)'), styles.indexOf('@media (prefers-reduced-transparency: reduce)'));
  assert.match(reduced, /\.balanced-handoff\s*\{[^}]*animation:\s*none !important/s);
  assert.match(reduced, /\.media-status\s*\{[^}]*transition:\s*none !important/s);
  assert.doesNotMatch(styles, /\binfinite\b|action-state-spin/);
});

test('saved entries reuse the fixed editor category icons and never fall back to the crossed square', async () => {
  const { main } = await sources();
  const iconData = await readFile(app('./state-icon-data.js'), 'utf8');
  const iconBlock = main.slice(main.indexOf('const CATEGORY_ICON_ENDPOINTS'), main.indexOf('const hydratedLocal'));
  const endpointFor = Function(`${iconBlock}; return entryIconEndpoint;`)();

  assert.deepEqual({
    salary:endpointFor({ kind:'income', category:'薪水' }),
    shopping:endpointFor({ kind:'expense', category:'购物' }),
    medical:endpointFor({ kind:'expense', category:'医疗' }),
    mortgage:endpointFor({ kind:'expense', category:'房贷' }),
    electric:endpointFor({ kind:'expense', category:'电费' }),
    tax:endpointFor({ kind:'expense', category:'税费' }),
    fuel:endpointFor({ kind:'expense', category:'打油' }),
    car:endpointFor({ kind:'expense', category:'汽车' }),
    custom:endpointFor({ kind:'expense', category:'自定义旧分类' }),
    transfer:endpointFor({ kind:'transfer', category:null }),
    repayment:endpointFor({ kind:'repayment', category:null }),
    item:endpointFor({ kind:'expense', category:'购物', sourceType:'itemPayment' })
  }, {
    salary:'category-salary', shopping:'category-shopping', medical:'category-medical', mortgage:'category-mortgage',
    electric:'category-electric', tax:'category-tax', fuel:'category-fuel', car:'category-car', custom:'category-other',
    transfer:'transfer-arrows', repayment:'payment-arrow', item:'package-check'
  });

  for (const endpoint of ['category-salary', 'category-shopping', 'category-medical', 'category-mortgage', 'category-electric', 'category-tax', 'category-fuel', 'category-car', 'category-other']) {
    assert.match(iconData, new RegExp(`['"]${endpoint}['"]\\s*:`), `${endpoint} must resolve to a fixed local SVG endpoint`);
  }
  assert.ok((main.match(/transactionIconMarkup\(entry\)/g) || []).length >= 3, 'ledger rows, repayments and recycle rows must share the safe mapper');
  assert.doesNotMatch(main, /stateIconMarkup\('transaction'/, 'the missing transaction family previously rendered the crossed-square fallback');
});
