import test from 'node:test';
import assert from 'node:assert/strict';

import {
  STATE_ICON_ENDPOINTS,
  STATE_ICON_REGISTRY,
  resolveIconEndpoint,
  resolveStateIcon,
  stateIconMarkup,
  staticIconMarkup
} from './state-icon-data.js';
import { startStateIconMotion } from './state-icon-motion.js';
import { createMorph } from './vendor/morphicons/1.7.1/dom.js';

class FakePath {
  constructor(d = '') {
    this.attributes = new Map([['d', d]]);
    this.writes = [];
  }

  setAttribute(name, value) {
    const text = String(value);
    this.attributes.set(name, text);
    this.writes.push([name, text]);
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }
}

class FakeIcon {
  constructor(family, state, { fromState = null, path = new FakePath() } = {}) {
    this.attributes = new Map([
      ['data-state-icon', family],
      ['data-icon-state', state]
    ]);
    if (fromState !== null) this.attributes.set('data-icon-from', fromState);
    this.path = path;
  }

  matches(selector) {
    return selector === '[data-state-icon]';
  }

  querySelector(selector) {
    return selector === '[data-state-icon-path]' ? this.path : null;
  }

  querySelectorAll() {
    return [];
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }
}

class FakeTree {
  constructor(icons = []) {
    this.icons = icons;
  }

  matches() {
    return false;
  }

  querySelectorAll(selector) {
    return selector === '[data-state-icon]' ? [...this.icons] : [];
  }
}

class FakeEventTarget {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type) {
    for (const listener of [...this.listeners.get(type) ?? []]) listener({ type });
  }
}

class FakeDocument extends FakeEventTarget {
  constructor() {
    super();
    this.visibilityState = 'visible';
    this.defaultView = new FakeEventTarget();
  }
}

function motionHarness({ icons = [], reduced = false, hidden = false } = {}) {
  const document = new FakeDocument();
  document.visibilityState = hidden ? 'hidden' : 'visible';
  const root = new FakeTree(icons);
  root.ownerDocument = document;
  const observers = [];
  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.disconnected = false;
      observers.push(this);
    }

    observe(observedRoot, options) {
      this.root = observedRoot;
      this.options = options;
    }

    disconnect() {
      this.disconnected = true;
    }

    emit(...mutations) {
      this.callback(mutations);
    }
  }

  const instances = [];
  const createMorph = (path, initial, options) => {
    path.setAttribute('d', initial);
    const instance = {
      path,
      initial,
      options,
      morphs: [],
      sets: [],
      destroyed: false,
      morphTo(d) {
        this.morphs.push(d);
        path.setAttribute('d', d);
      },
      set(d) {
        this.sets.push(d);
        path.setAttribute('d', d);
      },
      destroy() {
        this.destroyed = true;
      }
    };
    instances.push(instance);
    return instance;
  };

  const controller = startStateIconMotion({
    root,
    document,
    MutationObserver: FakeMutationObserver,
    createMorph,
    matchMedia: query => ({ matches: reduced, media: query })
  });

  return { controller, document, root, observer: observers[0], instances };
}

function emitState(observer, icon, state) {
  icon.setAttribute('data-icon-state', state);
  observer.emit({ type: 'attributes', target: icon, attributeName: 'data-icon-state' });
}

function installFakeAnimationFrame() {
  const originalRaf = globalThis.requestAnimationFrame;
  const originalCancel = globalThis.cancelAnimationFrame;
  const originalMatchMedia = globalThis.matchMedia;
  let nextId = 0;
  const queued = new Map();
  globalThis.requestAnimationFrame = callback => {
    const id = ++nextId;
    queued.set(id, callback);
    return id;
  };
  globalThis.cancelAnimationFrame = id => queued.delete(id);

  return {
    queued,
    setReduced(value) {
      globalThis.matchMedia = query => ({ matches: value, media: query });
    },
    frame(timestamp) {
      const entries = [...queued.entries()];
      queued.clear();
      for (const [, callback] of entries) callback(timestamp);
    },
    settle({ start = 0, step = 16, limit = 1000 } = {}) {
      let timestamp = start;
      let count = 0;
      while (queued.size && count < limit) {
        this.frame(timestamp);
        timestamp += step;
        count += 1;
      }
      assert.ok(count < limit, 'morph animation should settle within the deterministic frame limit');
    },
    restore() {
      if (originalRaf === undefined) delete globalThis.requestAnimationFrame;
      else globalThis.requestAnimationFrame = originalRaf;
      if (originalCancel === undefined) delete globalThis.cancelAnimationFrame;
      else globalThis.cancelAnimationFrame = originalCancel;
      if (originalMatchMedia === undefined) delete globalThis.matchMedia;
      else globalThis.matchMedia = originalMatchMedia;
    }
  };
}

test('registry has canonical static output and every family state resolves locally', () => {
  assert.equal(Object.keys(STATE_ICON_ENDPOINTS).length, 104);
  assert.equal(Object.keys(STATE_ICON_REGISTRY).length, 50);
  assert.ok(Object.isFrozen(STATE_ICON_ENDPOINTS));
  assert.ok(Object.isFrozen(STATE_ICON_REGISTRY));

  const uncovered = [];
  for (const [family, states] of Object.entries(STATE_ICON_REGISTRY)) {
    assert.ok(Object.isFrozen(states), `${family} state map must be frozen`);
    for (const [state, endpoint] of Object.entries(states)) {
      if (!Object.hasOwn(STATE_ICON_ENDPOINTS, endpoint)) uncovered.push(`${family}.${state}:${endpoint}`);
      assert.deepEqual(resolveStateIcon(family, state), {
        family, state, endpoint, d: STATE_ICON_ENDPOINTS[endpoint], valid: true
      });
    }
  }
  assert.deepEqual(uncovered, []);

  const plus = STATE_ICON_ENDPOINTS.plus;
  const check = STATE_ICON_ENDPOINTS.check;
  assert.equal(
    staticIconMarkup('plus'),
    `<svg class="app-icon" data-static-icon="plus" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path data-state-icon-path d="${plus}"/></svg>`
  );
  assert.equal(
    stateIconMarkup('action', 'success', { fromState: 'idle' }),
    `<svg class="app-icon" data-state-icon="action" data-icon-state="success" data-icon-from="idle" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path data-state-icon-path d="${check}"/></svg>`
  );
  assert.match(stateIconMarkup('action', 'success', { fromState: 'idle' }), new RegExp(`d="${check}"`));
});

test('unknown endpoints, families and states fail closed to the static fallback', () => {
  const fallback = STATE_ICON_ENDPOINTS.fallback;
  assert.deepEqual(resolveIconEndpoint('not-an-icon'), { endpoint: 'fallback', d: fallback, valid: false });
  for (const [family, state] of [['missing-family', 'idle'], ['action', 'missing-state'], [null, null]]) {
    assert.deepEqual(resolveStateIcon(family, state), {
      family: 'fallback', state: 'default', endpoint: 'fallback', d: fallback, valid: false
    });
    const markup = stateIconMarkup(family, state, { fromState: 'idle' });
    assert.match(markup, /data-state-icon="fallback" data-icon-state="default"/);
    assert.doesNotMatch(markup, /data-icon-from=/);
    assert.match(markup, new RegExp(`d="${fallback}"`));
  }
});

test('controller performs transitions, skips endpoint no-ops, and forwards interruption/reversal', () => {
  const icon = new FakeIcon('sync', 'cached');
  const { controller, observer, instances } = motionHarness({ icons: [icon] });
  const instance = instances[0];
  assert.equal(instance.options.reducedMotion, 'user');
  assert.equal(instance.initial, STATE_ICON_ENDPOINTS['cloud-clock']);

  emitState(observer, icon, 'pending');
  assert.deepEqual(instance.morphs, [], 'cached and pending share an endpoint and must not restart motion');

  emitState(observer, icon, 'loading');
  emitState(observer, icon, 'cached');
  assert.deepEqual(instance.morphs, [STATE_ICON_ENDPOINTS['cloud-sync'], STATE_ICON_ENDPOINTS['cloud-clock']]);
  assert.equal(controller.size, 1);
  controller.destroy();
});

test('real Morphicons engine settles, reverses an in-flight morph, no-ops at rest, and honors reducedMotion user', () => {
  const animation = installFakeAnimationFrame();
  const path = new FakePath();
  try {
    animation.setReduced(false);
    const morph = createMorph(path, STATE_ICON_ENDPOINTS.plus, { reducedMotion: 'user' });
    assert.equal(path.getAttribute('d'), STATE_ICON_ENDPOINTS.plus);

    morph.morphTo(STATE_ICON_ENDPOINTS.check);
    assert.equal(animation.queued.size, 1);
    animation.settle();
    assert.equal(path.getAttribute('d'), STATE_ICON_ENDPOINTS.check);

    morph.morphTo(STATE_ICON_ENDPOINTS.plus);
    animation.frame(0);
    animation.frame(16);
    const interruptedShape = path.getAttribute('d');
    assert.notEqual(interruptedShape, STATE_ICON_ENDPOINTS.plus);
    assert.notEqual(interruptedShape, STATE_ICON_ENDPOINTS.check);
    morph.morphTo(STATE_ICON_ENDPOINTS.check);
    animation.settle({ start: 32 });
    assert.equal(path.getAttribute('d'), STATE_ICON_ENDPOINTS.check);

    morph.morphTo(STATE_ICON_ENDPOINTS.check);
    assert.equal(animation.queued.size, 0, 'same target at rest must not schedule a frame');

    animation.setReduced(true);
    morph.morphTo(STATE_ICON_ENDPOINTS.plus);
    assert.equal(path.getAttribute('d'), STATE_ICON_ENDPOINTS.plus);
    assert.equal(animation.queued.size, 0, 'user reduced motion must snap without rAF');
    morph.destroy();
  } finally {
    animation.restore();
  }
});

test('reduced-motion users and hidden pages snap instead of animating', () => {
  const reducedIcon = new FakeIcon('action', 'idle');
  const reduced = motionHarness({ icons: [reducedIcon], reduced: true });
  emitState(reduced.observer, reducedIcon, 'pending');
  assert.deepEqual(reduced.instances[0].morphs, []);
  assert.deepEqual(reduced.instances[0].sets, [STATE_ICON_ENDPOINTS['progress-ring']]);
  reduced.controller.destroy();

  const hiddenIcon = new FakeIcon('action', 'idle');
  const hidden = motionHarness({ icons: [hiddenIcon], hidden: true });
  emitState(hidden.observer, hiddenIcon, 'success');
  assert.deepEqual(hidden.instances[0].sets, [STATE_ICON_ENDPOINTS.check]);
  hidden.controller.destroy();

  const foregroundIcon = new FakeIcon('action', 'idle');
  const foreground = motionHarness({ icons: [foregroundIcon] });
  emitState(foreground.observer, foregroundIcon, 'pending');
  assert.deepEqual(foreground.instances[0].morphs, [STATE_ICON_ENDPOINTS['progress-ring']]);
  foreground.document.visibilityState = 'hidden';
  foreground.document.dispatch('visibilitychange');
  assert.deepEqual(foreground.instances[0].sets, [STATE_ICON_ENDPOINTS['progress-ring']]);
  foreground.controller.destroy();
});

test('fromState hydrates progressively, replacement paths reinitialize, and dynamic icons are discovered', () => {
  const icon = new FakeIcon('action', 'success', { fromState: 'idle' });
  const harness = motionHarness({ icons: [icon] });
  const first = harness.instances[0];
  assert.equal(first.initial, STATE_ICON_ENDPOINTS.plus);
  assert.deepEqual(first.morphs, [STATE_ICON_ENDPOINTS.check]);
  assert.equal(icon.getAttribute('data-icon-from'), null);

  const replacement = new FakePath();
  const oldPath = icon.path;
  icon.path = replacement;
  harness.observer.emit({ type: 'childList', target: icon, removedNodes: [oldPath], addedNodes: [replacement] });
  assert.equal(first.destroyed, true);
  assert.equal(harness.instances.length, 2);
  assert.equal(harness.instances[1].initial, STATE_ICON_ENDPOINTS.check);
  assert.deepEqual(harness.instances[1].morphs, []);
  assert.equal(harness.controller.size, 1);

  const added = new FakeIcon('completion', 'complete', { fromState: 'incomplete' });
  harness.root.icons.push(added);
  harness.observer.emit({ type: 'childList', target: harness.root, removedNodes: [], addedNodes: [new FakeTree([added])] });
  assert.equal(harness.instances.length, 3);
  assert.equal(harness.instances[2].initial, STATE_ICON_ENDPOINTS.circle);
  assert.deepEqual(harness.instances[2].morphs, [STATE_ICON_ENDPOINTS['check-circle']]);
  assert.equal(harness.controller.size, 2);
  harness.controller.destroy();
});

test('removed nodes and pagehide destroy instances; observer watches only semantic state', () => {
  const icon = new FakeIcon('action', 'idle');
  const harness = motionHarness({ icons: [icon] });
  assert.deepEqual(harness.observer.options, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['data-icon-state']
  });

  const writesBefore = icon.path.writes.length;
  icon.path.setAttribute('d', 'M0 0');
  assert.equal(harness.instances.length, 1);
  assert.equal(icon.path.writes.length, writesBefore + 1, 'path writes do not create a semantic-state observer loop');

  harness.observer.emit({ type: 'childList', target: harness.root, removedNodes: [icon], addedNodes: [] });
  assert.equal(harness.instances[0].destroyed, true);
  assert.equal(harness.controller.size, 0);

  const replacement = new FakeIcon('action', 'idle');
  harness.observer.emit({ type: 'childList', target: harness.root, removedNodes: [], addedNodes: [replacement] });
  assert.equal(harness.controller.size, 1);
  harness.document.defaultView.dispatch('pagehide');
  assert.equal(harness.instances[1].destroyed, true);
  assert.equal(harness.controller.size, 0);
  assert.equal(harness.observer.disconnected, true);
});
