const NO_STATE = Symbol('no-state');

const defaultClone = value => {
  if (value === undefined || value === null) return value;
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
};

const errorMessage = error => error instanceof Error ? error.message : String(error ?? '同步失败');

/**
 * A Firestore-free state coordinator. All backend work is supplied by the caller.
 * Tokens are generation-fenced: callbacks must return the token created for the
 * session, listener, or write which initiated them.
 */
export function createSyncCoordinator({
  applyOperation = state => state,
  hasOperation = () => false,
  recover = async () => undefined,
  clone = defaultClone,
  onChange = () => {}
} = {}) {
  let sessionGeneration = 0;
  let householdGeneration = 0;
  let writeGeneration = 0;
  let signedIn = false;
  let online = true;
  let currentHouseholdId = null;
  let currentListenerToken = null;
  let activeRecovery = null;
  const households = new Map();
  const writes = new Map();

  const writeKey = (householdId, operationId) => `${householdId}\u0000${operationId}`;

  const ensureHousehold = householdId => {
    if (!households.has(householdId)) {
      households.set(householdId, {
        lastKnownGood: NO_STATE,
        cached: false,
        error: null,
        pendingKeys: new Set()
      });
    }
    return households.get(householdId);
  };

  const currentRecord = () => currentHouseholdId === null ? null : households.get(currentHouseholdId) ?? null;

  const isCurrentSession = token => Boolean(
    signedIn && token?.kind === 'session' && token.sessionGeneration === sessionGeneration
  );

  const isCurrentListener = token => Boolean(
    signedIn &&
    token?.kind === 'listener' &&
    token.sessionGeneration === sessionGeneration &&
    token.householdGeneration === householdGeneration &&
    token.householdId === currentHouseholdId
  );

  const materialize = record => {
    let state = record.lastKnownGood === NO_STATE ? undefined : clone(record.lastKnownGood);
    for (const key of record.pendingKeys) {
      const entry = writes.get(key);
      if (entry) state = applyOperation(state, clone(entry.operation));
    }
    return state;
  };

  const status = record => {
    if (!signedIn || !online) return 'offline';
    if (activeRecovery &&
        activeRecovery.sessionGeneration === sessionGeneration &&
        activeRecovery.householdGeneration === householdGeneration) return 'recovering';
    if (!record) return 'loading';
    if (record.error) return 'error';
    if (record.pendingKeys.size > 0) return 'pending';
    if (record.cached) return 'cached';
    return record.lastKnownGood === NO_STATE ? 'loading' : 'synced';
  };

  const snapshotState = () => {
    const record = currentRecord();
    const pendingWrites = record ? [...record.pendingKeys].map(key => {
      const entry = writes.get(key);
      return {
        householdId: entry.householdId,
        operationId: entry.operationId,
        operation: clone(entry.operation)
      };
    }) : [];
    return {
      signedIn,
      online,
      sessionGeneration,
      householdGeneration,
      householdId: currentHouseholdId,
      status: status(record),
      data: record ? clone(materialize(record)) : undefined,
      lastKnownGood: record && record.lastKnownGood !== NO_STATE ? clone(record.lastKnownGood) : undefined,
      pendingWrites,
      pendingCount: pendingWrites.length,
      error: record?.error ?? null
    };
  };

  const emit = () => {
    const state = snapshotState();
    onChange(state);
    return state;
  };

  const beginSession = () => {
    sessionGeneration += 1;
    householdGeneration += 1;
    signedIn = true;
    currentHouseholdId = null;
    currentListenerToken = null;
    activeRecovery = null;
    households.clear();
    writes.clear();
    const token = Object.freeze({ kind: 'session', sessionGeneration });
    emit();
    return token;
  };

  const activateHousehold = (sessionToken, householdId, options = {}) => {
    if (!isCurrentSession(sessionToken) || typeof householdId !== 'string' || householdId.length === 0) return null;
    // A recovery gate belongs to the listener generation which created it.
    // Release that ownership immediately so the next household can recover
    // without waiting for the stale promise to settle.
    activeRecovery = null;
    householdGeneration += 1;
    currentHouseholdId = householdId;
    const record = ensureHousehold(householdId);
    if (Object.hasOwn(options, 'cachedState')) {
      record.lastKnownGood = clone(options.cachedState);
      record.cached = true;
      record.error = null;
    }
    currentListenerToken = Object.freeze({
      kind: 'listener',
      sessionGeneration,
      householdGeneration,
      householdId
    });
    emit();
    return currentListenerToken;
  };

  const acceptProfile = (sessionToken, profile, options = {}) => {
    if (!isCurrentSession(sessionToken)) return null;
    const householdId = profile?.householdId;
    return activateHousehold(sessionToken, householdId, options);
  };

  const acceptSnapshot = (listenerToken, backendState, options = {}) => {
    if (!isCurrentListener(listenerToken)) return false;
    const record = currentRecord();
    record.lastKnownGood = clone(backendState);
    record.cached = options?.fromCache === true;
    record.error = null;
    if (options?.hasPendingWrites !== true) {
      for (const key of [...record.pendingKeys]) {
        const entry = writes.get(key);
        if (entry && hasOperation(backendState, entry.operationId)) {
          record.pendingKeys.delete(key);
          writes.delete(key);
        }
      }
    }
    emit();
    return true;
  };

  const listenerError = (listenerToken, error) => {
    if (!isCurrentListener(listenerToken)) return false;
    currentRecord().error = errorMessage(error);
    emit();
    return true;
  };

  const registerWrite = (operationId, operation, options = {}) => {
    const householdId = options.householdId ?? currentHouseholdId;
    if (!signedIn || typeof householdId !== 'string' || householdId.length === 0) {
      throw new Error('有效 household 必填');
    }
    if (typeof operationId !== 'string' || operationId.length === 0) {
      throw new Error('稳定 operationId 必填');
    }
    const key = writeKey(householdId, operationId);
    const existing = writes.get(key);
    if (existing) return existing.token;

    const record = ensureHousehold(householdId);
    const token = Object.freeze({
      kind: 'write',
      sessionGeneration,
      householdGeneration,
      householdId,
      operationId,
      writeGeneration: ++writeGeneration
    });
    writes.set(key, { key, token, householdId, operationId, operation: clone(operation) });
    record.pendingKeys.add(key);
    record.error = null;
    if (householdId === currentHouseholdId) emit();
    return token;
  };

  const findWrite = token => {
    if (!signedIn ||
        token?.kind !== 'write' ||
        token.sessionGeneration !== sessionGeneration) return null;
    const entry = writes.get(writeKey(token.householdId, token.operationId));
    return entry && entry.token === token ? entry : null;
  };

  const acknowledgeWrite = (writeToken, authoritativeState = NO_STATE) => {
    const entry = findWrite(writeToken);
    if (!entry) return false;
    const record = households.get(entry.householdId);
    if (authoritativeState !== NO_STATE) {
      record.lastKnownGood = clone(authoritativeState);
      record.cached = false;
    } else if (record.lastKnownGood === NO_STATE || !hasOperation(record.lastKnownGood, entry.operationId)) {
      const base = record.lastKnownGood === NO_STATE ? undefined : clone(record.lastKnownGood);
      record.lastKnownGood = clone(applyOperation(base, clone(entry.operation)));
      record.cached = false;
    }
    record.pendingKeys.delete(entry.key);
    record.error = null;
    writes.delete(entry.key);
    if (entry.householdId === currentHouseholdId) emit();
    return true;
  };

  const rejectWrite = (writeToken, error) => {
    const entry = findWrite(writeToken);
    if (!entry) return false;
    const record = households.get(entry.householdId);
    record.pendingKeys.delete(entry.key);
    record.error = errorMessage(error);
    writes.delete(entry.key);
    if (entry.householdId === currentHouseholdId) emit();
    return true;
  };

  const setOnline = value => {
    const next = Boolean(value);
    if (online === next) return snapshotState();
    online = next;
    return emit();
  };

  const applyRecoveryResult = (result, listenerToken) => {
    if (!result || typeof result !== 'object') return;
    if (Object.hasOwn(result, 'snapshot')) {
      acceptSnapshot(listenerToken, result.snapshot, result.snapshotOptions ?? result.metadata);
    }
    for (const token of result.acknowledgedWrites ?? []) acknowledgeWrite(token);
    for (const rejected of result.rejectedWrites ?? []) rejectWrite(rejected.token, rejected.error);
  };

  // focus, online, and pageshow all call this gate; callers receive the same promise.
  const requestRecovery = trigger => {
    if (activeRecovery) return activeRecovery.promise;
    if (!signedIn || !online || !currentListenerToken) return Promise.resolve(false);

    const listenerToken = currentListenerToken;
    const fence = {
      sessionGeneration,
      householdGeneration,
      householdId: currentHouseholdId
    };
    const context = {
      trigger,
      listenerToken,
      state: snapshotState()
    };
    const promise = Promise.resolve().then(() => recover(context)).then(result => {
      const ownsGate = activeRecovery?.promise === promise;
      const current = ownsGate &&
        signedIn &&
        fence.sessionGeneration === sessionGeneration &&
        fence.householdGeneration === householdGeneration &&
        fence.householdId === currentHouseholdId;
      if (ownsGate) activeRecovery = null;
      if (!current) return false;
      applyRecoveryResult(result, listenerToken);
      emit();
      return true;
    }, error => {
      const ownsGate = activeRecovery?.promise === promise;
      const current = ownsGate &&
        signedIn &&
        fence.sessionGeneration === sessionGeneration &&
        fence.householdGeneration === householdGeneration &&
        fence.householdId === currentHouseholdId;
      if (ownsGate) activeRecovery = null;
      if (!current) return false;
      currentRecord().error = errorMessage(error);
      emit();
      return false;
    });
    activeRecovery = { ...fence, promise };
    emit();
    return promise;
  };

  const signOut = () => {
    sessionGeneration += 1;
    householdGeneration += 1;
    signedIn = false;
    currentHouseholdId = null;
    currentListenerToken = null;
    activeRecovery = null;
    households.clear();
    writes.clear();
    return emit();
  };

  return Object.freeze({
    getState: snapshotState,
    beginSession,
    acceptProfile,
    activateHousehold,
    acceptSnapshot,
    listenerError,
    registerWrite,
    acknowledgeWrite,
    rejectWrite,
    setOnline,
    requestRecovery,
    signOut
  });
}

export const SYNC_STATUSES = Object.freeze([
  'loading', 'cached', 'pending', 'synced', 'offline', 'recovering', 'error'
]);
