import { createMorph } from './vendor/morphicons/1.7.1/dom.js';
import { resolveStateIcon } from './state-icon-data.js';

const STATE_ICON_SELECTOR = '[data-state-icon]';
const PATH_SELECTOR = '[data-state-icon-path]';
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

function matchingRoots(node) {
  const roots = [];
  if (!node || typeof node !== 'object') return roots;
  if (typeof node.matches === 'function' && node.matches(STATE_ICON_SELECTOR)) roots.push(node);
  if (typeof node.querySelectorAll === 'function') roots.push(...node.querySelectorAll(STATE_ICON_SELECTOR));
  return roots;
}

export function startStateIconMotion(options = {}) {
  const root = options.root ?? globalThis.document;
  if (!root || typeof root.querySelectorAll !== 'function') return null;

  const documentRef = options.document ?? root.ownerDocument ?? root;
  const observerType = options.MutationObserver ?? globalThis.MutationObserver;
  const createMorphInstance = options.createMorph ?? createMorph;
  const matchMediaRef = options.matchMedia
    ?? documentRef?.defaultView?.matchMedia?.bind(documentRef.defaultView)
    ?? globalThis.matchMedia?.bind(globalThis);
  const records = new Map();
  let destroyed = false;

  const motionMustBeInstant = () => documentRef?.visibilityState === 'hidden'
    || Boolean(matchMediaRef?.(REDUCED_MOTION_QUERY)?.matches);

  const destroyRecord = iconRoot => {
    const record = records.get(iconRoot);
    if (!record) return;
    records.delete(iconRoot);
    try { record.handle.destroy(); } catch {}
  };

  const readTarget = iconRoot => resolveStateIcon(
    iconRoot.getAttribute?.('data-state-icon'),
    iconRoot.getAttribute?.('data-icon-state')
  );

  const initialize = iconRoot => {
    if (destroyed || !iconRoot || typeof iconRoot.querySelector !== 'function') return;
    const path = iconRoot.querySelector(PATH_SELECTOR);
    if (!path || typeof path.setAttribute !== 'function') {
      destroyRecord(iconRoot);
      return;
    }

    const existing = records.get(iconRoot);
    if (existing?.path === path) return;
    if (existing) destroyRecord(iconRoot);

    const target = readTarget(iconRoot);
    const fromState = iconRoot.getAttribute?.('data-icon-from');
    const from = resolveStateIcon(target.family, fromState);
    const canTransitionFrom = target.valid && from.valid && from.endpoint !== target.endpoint;
    const initial = canTransitionFrom ? from : target;

    let handle;
    try {
      handle = createMorphInstance(path, initial.d, { reducedMotion: 'user' });
    } catch {
      path.setAttribute('d', target.d);
      iconRoot.removeAttribute?.('data-icon-from');
      return;
    }

    const record = { handle, path, state: target.state, endpoint: target.endpoint, d: target.d };
    records.set(iconRoot, record);
    iconRoot.removeAttribute?.('data-icon-from');

    if (canTransitionFrom) {
      if (motionMustBeInstant()) handle.set(target.d);
      else handle.morphTo(target.d);
    }
  };

  const update = iconRoot => {
    if (destroyed) return;
    let record = records.get(iconRoot);
    const currentPath = iconRoot?.querySelector?.(PATH_SELECTOR);
    if (!record || record.path !== currentPath) {
      if (record) destroyRecord(iconRoot);
      initialize(iconRoot);
      record = records.get(iconRoot);
      if (!record) return;
    }

    const target = readTarget(iconRoot);
    if (target.endpoint === record.endpoint) {
      record.state = target.state;
      return;
    }

    record.state = target.state;
    record.endpoint = target.endpoint;
    record.d = target.d;
    try {
      if (motionMustBeInstant()) record.handle.set(target.d);
      else record.handle.morphTo(target.d);
    } catch {
      record.path.setAttribute('d', target.d);
      destroyRecord(iconRoot);
    }
  };

  const cleanupTree = node => {
    for (const iconRoot of matchingRoots(node)) destroyRecord(iconRoot);
  };

  for (const iconRoot of matchingRoots(root)) initialize(iconRoot);

  let observer = null;
  if (typeof observerType === 'function') {
    observer = new observerType(mutations => {
      if (destroyed) return;
      for (const mutation of mutations) {
        if (mutation.type === 'attributes') {
          update(mutation.target);
          continue;
        }
        for (const removed of mutation.removedNodes ?? []) cleanupTree(removed);
        for (const added of mutation.addedNodes ?? []) {
          for (const iconRoot of matchingRoots(added)) initialize(iconRoot);
        }
        if (mutation.target?.matches?.(STATE_ICON_SELECTOR)) update(mutation.target);
      }
    });
    observer.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-icon-state']
    });
  }

  const snapHiddenIcons = () => {
    if (documentRef?.visibilityState !== 'hidden') return;
    for (const record of records.values()) {
      try { record.handle.set(record.d); } catch {}
    }
  };
  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    observer?.disconnect();
    documentRef?.removeEventListener?.('visibilitychange', snapHiddenIcons);
    documentRef?.defaultView?.removeEventListener?.('pagehide', destroy);
    for (const iconRoot of [...records.keys()]) destroyRecord(iconRoot);
  };

  documentRef?.addEventListener?.('visibilitychange', snapHiddenIcons);
  documentRef?.defaultView?.addEventListener?.('pagehide', destroy, { once: true });

  return Object.freeze({ destroy, hydrate: initialize, update, get size() { return records.size; } });
}

let automaticStateIconMotion = null;
if (typeof document !== 'undefined') {
  try { automaticStateIconMotion = startStateIconMotion(); } catch {}
}

export { automaticStateIconMotion };
