import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createThemePreferences, readCachedTheme, normaliseTheme, THEME_STORE } from './theme-preferences.js';
import { matrixGeometry, drawMatrix, MAX_DOTS, PIXEL_BUDGET, mountLoginDotMatrix } from './login-dot-matrix.js';

const confirmed = { fromCache: false, hasPendingWrites: false };
function fixture() {
  const data = new Map();
  const writes = [];
  const storage = { getItem: k => data.get(k), setItem: (k, v) => data.set(k, v) };
  let theme, status;
  const prefs = createThemePreferences({ storage, apply: v => { theme = v; }, onStatus: v => { status = v; },
    save: (uid, value) => new Promise((resolve, reject) => writes.push({ uid, value, resolve, reject })) });
  return { prefs, writes, storage, get theme() { return theme; }, get status() { return status; } };
}

test('first visit is warm; returning/local mode caches without a cloud write; invalid storage is safe', async () => {
  const f = fixture();
  assert.equal(readCachedTheme(f.storage), 'warm');
  f.prefs.beginUser(null);
  await f.prefs.choose('ocean');
  assert.equal(readCachedTheme(f.storage), 'ocean');
  assert.equal(f.writes.length, 0);
  assert.equal(await f.prefs.choose('untrusted-css'), false);
  assert.equal(normaliseTheme({ theme: 'ocean' }), 'warm');
  assert.equal(readCachedTheme({ getItem() { throw Error('disabled'); } }), 'warm');
});

test('login adopts personal cloud theme, never uploads cache; missing theme defaults warm, uid cache isolated', () => {
  const f = fixture();
  f.storage.setItem(THEME_STORE, 'cimb');
  const a = f.prefs.beginUser('a');
  f.prefs.receive({ uid: 'a', theme: 'ocean' }, a, confirmed);
  assert.equal(f.theme, 'ocean');
  const b = f.prefs.beginUser('b');
  assert.equal(f.theme, 'warm');
  f.prefs.receive({ uid: 'b' }, b, confirmed);
  assert.equal(f.theme, 'warm');
  f.prefs.beginUser('a');
  assert.equal(f.theme, 'ocean');
  assert.equal(f.writes.length, 0);
});

test('same user two devices follows snapshots; household member never receives that preference', async () => {
  const a = fixture(), device2 = fixture(), member = fixture();
  const ta = a.prefs.beginUser('a'), t2 = device2.prefs.beginUser('a'), tm = member.prefs.beginUser('b');
  for (const [f, t, uid] of [[a, ta, 'a'], [device2, t2, 'a'], [member, tm, 'b']]) f.prefs.receive({ uid, theme: 'warm' }, t, confirmed);
  const save = a.prefs.choose('teal');
  assert.equal(a.status, 'pending');
  for (const [f, t] of [[a, ta], [device2, t2], [member, tm]]) f.prefs.receive({ uid: 'a', theme: 'teal' }, t, confirmed);
  a.writes[0].resolve(); await save;
  assert.equal(device2.theme, 'teal');
  assert.equal(member.theme, 'warm');
  assert.equal(a.status, 'synced');
});

test('stale cached snapshots, old ACK/failure and offline queue cannot replace latest choice', async () => {
  for (const rejectOld of [false, true]) {
    const f = fixture(); const token = f.prefs.beginUser('a');
    f.prefs.receive({ uid: 'a', theme: 'warm' }, token, confirmed);
    const old = f.prefs.choose('cimb'), latest = f.prefs.choose('ocean');
    f.prefs.receive({ uid: 'a', theme: 'warm' }, token, { fromCache: true });
    assert.equal(f.theme, 'ocean'); assert.equal(f.status, 'pending');
    f.writes[1].resolve(); await latest;
    assert.equal(f.status, 'pending');
    f.writes[0][rejectOld ? 'reject' : 'resolve'](); await old;
    assert.equal(f.theme, 'ocean'); assert.equal(f.status, 'synced');
  }
});

test('failed latest save remains honest and retryable; logout/relogin fences old events and writes', async () => {
  const f = fixture(); const oldToken = f.prefs.beginUser('a');
  f.prefs.receive({ uid: 'a', theme: 'warm' }, oldToken, confirmed);
  const failed = f.prefs.choose('cimb'); f.writes[0].reject(); await failed;
  f.prefs.receive({ uid: 'a', theme: 'warm' }, oldToken, confirmed);
  assert.equal(f.theme, 'cimb'); assert.equal(f.status, 'error');
  const retry = f.prefs.choose('cimb');
  const newToken = f.prefs.beginUser('b');
  f.prefs.receive({ uid: 'b', theme: 'teal' }, newToken, confirmed);
  f.prefs.receive({ uid: 'a', theme: 'ocean' }, oldToken, confirmed);
  f.writes[1].reject(); await retry;
  assert.equal(f.theme, 'teal'); assert.equal(f.status, 'synced');
  assert.deepEqual(f.writes.map(x => x.uid), ['a', 'a']);
  f.prefs.beginUser(null);
  const again = f.prefs.beginUser('a');
  f.prefs.receive({ uid: 'a', theme: 'cimb' }, oldToken, confirmed);
  assert.equal(f.status, 'loading');
  f.prefs.receive({ uid: 'a', theme: 'maybank' }, again, confirmed);
  assert.equal(f.theme, 'maybank');
});

test('saveTheme executes only the authenticated users/{uid} field update and validates theme', async () => {
  const source = await readFile(new URL('./firebase-client.js', import.meta.url), 'utf8');
  const body = source.match(/saveTheme: (\(uid, theme\) => \{[\s\S]*?\n    \}),\n    watchUser/)[1];
  const calls = [];
  const save = vm.runInNewContext(`(${body})`, { auth: { currentUser: { uid: 'a' } }, THEMES: new Set(['warm', 'ocean']), db: 'db', doc: (...args) => args, updateDoc: (...args) => { calls.push(args); return Promise.resolve(); } });
  await save('a', 'ocean');
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [[['db', 'users', 'a'], { theme: 'ocean' }]]);
  await assert.rejects(save('b', 'warm')); await assert.rejects(save('a', 'invalid'));
  assert.equal(calls.length, 1);
});

test('dot matrix preserves MZM motion, bounded geometry, and deterministic reduced motion', () => {
  for (const [width, height] of [[320, 568], [390, 844], [1440, 900], [3840, 2160]]) {
    const geometry = matrixGeometry(width, height, 3);
    assert.ok(geometry.dpr <= 1.5);
    assert.ok(geometry.pixelWidth * geometry.pixelHeight <= PIXEL_BUDGET);
    const points = [];
    const ctx = { clearRect() {}, beginPath() {}, arc: (...p) => points.push(p), fill() {} };
    const args = { width, height, ...geometry, timestamp: 10, reducedMotion: true, color: '#123456' };
    drawMatrix(ctx, args); const first = JSON.stringify(points);
    assert.ok(points.length <= MAX_DOTS); assert.equal(ctx.fillStyle, '#123456');
    points.length = 0; drawMatrix(ctx, { ...args, timestamp: 2000 });
    assert.equal(JSON.stringify(points), first);
    points.length = 0; drawMatrix(ctx, { ...args, timestamp: 2000, reducedMotion: false });
    assert.notEqual(JSON.stringify(points), first);
  }
});

test('dot matrix pauses hidden/reduced-motion/auth-hidden, resumes and disposes listeners', () => {
  let queued = new Map(), seq = 0, draws = 0;
  const events = new Map();
  const eventTarget = prefix => ({ addEventListener: (n, f) => events.set(prefix + n, f), removeEventListener: n => events.delete(prefix + n) });
  const document = { ...eventTarget('doc'), hidden: false, documentElement: {} };
  const motion = { ...eventTarget('motion'), matches: false };
  const gate = { hidden: false };
  let mutation;
  const canvas = { width: 0, height: 0, dataset: {}, getBoundingClientRect: () => ({ width: 390, height: 844 }), getContext: () => ({ clearRect() { draws++; }, beginPath() {}, arc() {}, fill() {}, setTransform() {} }) };
  const source = mountLoginDotMatrix.toString();
  const mount = vm.runInNewContext(`(${source})`, { document, window: eventTarget('win'), matchMedia: () => motion, devicePixelRatio: 3, getComputedStyle: () => ({ color: '#123456' }), performance: { now: () => 0 }, matrixGeometry, drawMatrix, FRAME_INTERVAL: 1000 / 30,
    requestAnimationFrame: f => { queued.set(++seq, f); return seq; }, cancelAnimationFrame: id => queued.delete(id),
    ResizeObserver: class { observe() {} disconnect() {} }, MutationObserver: class { constructor(f) { mutation = f; } observe() {} disconnect() {} } });
  const dispose = mount(canvas, gate);
  assert.equal(queued.size, 1);
  const tick = timestamp => { const callbacks = [...queued.values()]; queued.clear(); callbacks.forEach(f => f(timestamp)); };
  tick(10); assert.equal(draws, 1); tick(40); assert.equal(draws, 2);
  gate.hidden = true; mutation(); assert.equal(queued.size, 0);
  gate.hidden = false; mutation(); assert.equal(queued.size, 1);
  document.hidden = true; events.get('docvisibilitychange')(); assert.equal(queued.size, 0);
  document.hidden = false; motion.matches = true; events.get('motionchange')(); assert.equal(queued.size, 0);
  motion.matches = false; events.get('motionchange')(); assert.equal(queued.size, 1);
  events.get('winpagehide')(); assert.equal(queued.size, 0);
  events.get('winpageshow')(); assert.equal(queued.size, 1);
  dispose(); assert.equal(queued.size, 0); assert.equal(events.size, 0);
});

test('profile theme-only snapshots skip household reads and async auth is fenced before await', async () => {
  const source = await readFile(new URL('./main.js', import.meta.url), 'utf8');
  const profile = source.slice(source.indexOf('async function applyCloudProfile('), source.indexOf('async function handleCloudUser('));
  assert.ok(profile.indexOf('themePreferences.receive') < profile.indexOf('cloud.householdOptions'));
  assert.match(profile, /previousProfile\.selectedHouseholdId === profile\.selectedHouseholdId\) return/);
  const auth = source.slice(source.indexOf('async function handleCloudUser('), source.indexOf('let googleSignInPending'));
  assert.ok(auth.indexOf('const sessionToken = cloudSessionToken') < auth.indexOf('await cloud.ensureWorkspace'));
  assert.match(auth, /if \(sessionToken !== cloudSessionToken \|\| cloudUser\?\.uid !== user.uid\) return/);
  assert.match(source, /if \(generation !== authChangeGeneration\) return/);
});
