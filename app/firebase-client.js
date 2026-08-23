import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js';
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-app-check.js';
import {
  GoogleAuthProvider, connectAuthEmulator, createUserWithEmailAndPassword, getAuth,
  onAuthStateChanged, signInWithEmailAndPassword, signInWithPopup, signInWithRedirect, signOut
} from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js';
import {
  arrayUnion, collection, connectFirestoreEmulator, doc, getDoc, initializeFirestore,
  onSnapshot, persistentLocalCache, persistentMultipleTabManager, query, runTransaction, setDoc,
  updateDoc, where, writeBatch
} from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js';

const now = () => new Date().toISOString();
const cleanEmail = email => String(email ?? '').trim().toLowerCase();
const cleanRecord = value => JSON.parse(JSON.stringify(value));
const personalHouseholdId = uid => `personal-${uid}`;

const accountRecord = (account, householdId) => cleanRecord({
  id: account.id,
  householdId,
  name: account.name,
  kind: account.kind,
  openingBalanceMinor: account.openingBalanceMinor ?? 0,
  includeInTotal: account.includeInTotal !== false,
  photoDataUrl: account.photoDataUrl ?? null,
  archivedAt: account.archivedAt ?? null
});

const transactionRecord = (entry, householdId, actorUid) => {
  const record = {
  id: entry.id,
  householdId,
  operationId: entry.operationId,
  actorUid: entry.actorUid ?? actorUid,
  kind: entry.kind,
  accountId: entry.accountId,
  targetAccountId: entry.targetAccountId ?? null,
  amountMinor: entry.amountMinor,
  category: entry.category ?? null,
  note: entry.note ?? '',
  occurredAt: entry.occurredAt,
  createdAt: entry.createdAt,
  deletedAt: entry.deletedAt ?? null,
  purgedAt: entry.purgedAt ?? null,
  lastOperationId: entry.lastOperationId ?? entry.operationId
  };
  // Optional linked provenance must survive persistence without changing the
  // document shape of ordinary legacy transactions.
  if (entry.sourceType !== undefined) record.sourceType = entry.sourceType;
  if (entry.sourceItemId !== undefined) record.sourceItemId = entry.sourceItemId;
  if (entry.sourcePaymentId !== undefined) record.sourcePaymentId = entry.sourcePaymentId;
  return cleanRecord(record);
};

export async function createFirebaseWallet({ config, useEmulators = false }) {
  const app = initializeApp(useEmulators ? {
    apiKey: 'demo-family-wallet-v2',
    authDomain: 'demo-family-wallet-v2.firebaseapp.com',
    projectId: 'family-wallet-v2-emulator',
    appId: '1:123:web:family-wallet-v2'
  } : config);
  if (!useEmulators) {
    if (!config.appCheckSiteKey) throw new Error('Firebase App Check 尚未配置');
    initializeAppCheck(app, {
      provider: new ReCaptchaEnterpriseProvider(config.appCheckSiteKey),
      isTokenAutoRefreshEnabled: true
    });
  }
  const auth = getAuth(app);
  const db = initializeFirestore(app, {
    ignoreUndefinedProperties: true,
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
  });
  if (useEmulators) {
    connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
    connectFirestoreEmulator(db, '127.0.0.1', 8080);
  }

  const googleProvider = new GoogleAuthProvider();
  googleProvider.setCustomParameters({ prompt: 'select_account' });

  async function signInGoogle() {
    try {
      return await signInWithPopup(auth, googleProvider);
    } catch (error) {
      if (!['auth/popup-blocked', 'auth/cancelled-popup-request', 'auth/web-storage-unsupported'].includes(error.code)) throw error;
      return signInWithRedirect(auth, googleProvider);
    }
  }

  async function ensureWorkspace(user) {
    const email = cleanEmail(user.email);
    if (!email) throw new Error('Google 帐号没有可用邮箱');
    const userRef = doc(db, 'users', user.uid);
    const existing = await getDoc(userRef);
    if (!existing.exists()) {
      const [accessSnapshot, inviteSnapshot] = await Promise.all([
        getDoc(doc(db, 'access', user.uid)),
        getDoc(doc(db, 'invites', email))
      ]);
      const access = accessSnapshot.exists() ? accessSnapshot.data() : null;
      const invite = inviteSnapshot.exists() ? inviteSnapshot.data() : null;
      if (invite?.status === 'pending' && invite.email === email) {
        await setDoc(userRef, {
          uid: user.uid, email, displayName: user.displayName ?? '',
          householdIds: [], selectedHouseholdId: null, createdAt: now()
        });
      } else if (access?.active === true && access.role === 'owner') {
      const householdId = personalHouseholdId(user.uid);
      const createdAt = now();
      const batch = writeBatch(db);
      batch.set(doc(db, 'households', householdId), {
        ownerId: user.uid, name: '我的账本', kind: 'personal', createdAt
      });
      batch.set(doc(db, 'households', householdId, 'members', user.uid), {
        uid: user.uid, email, displayName: user.displayName ?? '', role: 'owner', active: true, joinedAt: createdAt
      });
      batch.set(userRef, {
        uid: user.uid, email, displayName: user.displayName ?? '',
        householdIds: [householdId], selectedHouseholdId: householdId, createdAt
      });
      await batch.commit();
      } else {
        throw new Error(`此帐号尚未获准使用。授权编号：${user.uid}`);
      }
    }
    const current = await getDoc(userRef);
    return current.data();
  }

  async function householdOptions(householdIds = []) {
    if (!householdIds.length) return [];
    const results = await Promise.allSettled(householdIds.map(householdId => getDoc(doc(db, 'households', householdId))));
    const successful = results.filter(result => result.status === 'fulfilled');
    if (!successful.length) {
      const error = new Error('无法读取任何家庭账本选项');
      error.name = 'HouseholdOptionsError';
      error.causes = results.map(result => result.reason);
      throw error;
    }
    return successful
      .map(result => result.value)
      .filter(snapshot => snapshot.exists())
      .map(snapshot => ({ id: snapshot.id, ...snapshot.data() }));
  }

  function subscribeHousehold(householdId, onData, onError) {
    const state = { household: null, accounts: [], transactions: [] };
    const ready = { household: false, accounts: false, transactions: false };
    const snapshots = { household: null, accounts: null, transactions: null };
    const stops = [];
    let stopped = false;
    const emit = () => {
      if (stopped || !Object.values(ready).every(Boolean)) return;
      const metadata = {
        fromCache: Object.values(snapshots).some(snapshot => snapshot.metadata.fromCache),
        hasPendingWrites: Object.values(snapshots).some(snapshot => snapshot.metadata.hasPendingWrites)
      };
      onData(cleanRecord({ ...state, metadata }));
    };
    const stop = () => {
      if (stopped) return;
      stopped = true;
      stops.splice(0).forEach(unsubscribe => unsubscribe());
    };
    const fail = error => {
      if (stopped) return;
      stop();
      onError?.(error);
    };
    const listen = (reference, key, accept) => {
      if (stopped) return;
      const unsubscribe = onSnapshot(reference, { includeMetadataChanges: true }, snapshot => {
        if (stopped) return;
        snapshots[key] = snapshot;
        ready[key] = true;
        accept(snapshot);
        emit();
      }, fail);
      if (stopped) unsubscribe();
      else stops.push(unsubscribe);
    };
    listen(doc(db, 'households', householdId), 'household', snapshot => {
        if (!snapshot.exists()) {
          const error = new Error('家庭账本不存在或已被移除');
          error.name = 'HouseholdNotFoundError';
          fail(error);
          return;
        }
        state.household = { id: snapshot.id, ...snapshot.data() };
      });
    listen(collection(db, 'households', householdId, 'accounts'), 'accounts', snapshot => {
        state.accounts = snapshot.docs.map(item => ({ id: item.id, ...item.data() }));
      });
    listen(collection(db, 'households', householdId, 'transactions'), 'transactions', snapshot => {
        state.transactions = snapshot.docs.map(item => ({ id: item.id, ...item.data() })).filter(item => !item.purgedAt);
      });
    return stop;
  }

  const itemRef = (householdId, itemId) => doc(db, 'households', householdId, 'items', itemId);
  const paymentRef = (householdId, paymentId) => doc(db, 'households', householdId, 'itemPayments', paymentId);
  const mediaRef = (householdId, mediaId) => doc(db, 'households', householdId, 'itemMedia', mediaId);
  const ledgerRef = (householdId, paymentId) => doc(db, 'households', householdId, 'transactions', `item-payment-${paymentId}`);
  const requiredId = (value, label) => {
    const result = String(value ?? '').trim();
    if (!result) throw new Error(`${label} 必填`);
    return result;
  };
  const positiveMinor = (value, label = '金额') => {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label}必须是大于零的安全整数 sen`);
    return value;
  };
  const currentActor = requested => {
    const uid = requiredId(requested ?? auth.currentUser?.uid, 'actorUid');
    if (auth.currentUser && uid !== auth.currentUser.uid) throw new Error('actorUid 必须是当前登录成员');
    return uid;
  };
  const requireOnline = () => {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new Error('此操作需要联网');
  };
  const assertRevision = (item, expectedRevision) => {
    if (expectedRevision !== undefined && item.revision !== expectedRevision) {
      const error = new Error(`物品已由其他成员更新（当前 revision ${item.revision}）`);
      error.code = 'revision-conflict';
      throw error;
    }
  };
  const snapshotMetadata = snapshot => ({
    fromCache: snapshot.metadata.fromCache,
    hasPendingWrites: snapshot.metadata.hasPendingWrites
  });
  const sameFields = (actual, expected, fields) => fields.every(field => (actual[field] ?? null) === (expected[field] ?? null));

  function mediaRecord(media, { householdId, itemId, paymentId = null, kind, actorUid, createdAt }) {
    if (!media) return null;
    const id = requiredId(media.id ?? media.mediaId, 'mediaId');
    const dataUrl = String(media.dataUrl ?? '');
    const cap = kind === 'cover' ? 80000 : 180000;
    if (!dataUrl.startsWith('data:image/jpeg;base64,') || dataUrl.length > cap) throw new Error(`${kind} JPEG Data URL 无效或过大`);
    if (media.dataUrlLength !== undefined && media.dataUrlLength !== dataUrl.length) throw new Error('dataUrlLength 与 Data URL 不一致');
    if (!Number.isSafeInteger(media.width) || media.width <= 0 || !Number.isSafeInteger(media.height) || media.height <= 0) {
      throw new Error('媒体尺寸无效');
    }
    return {
      id, householdId, itemId, paymentId, kind, dataUrl, dataUrlLength: dataUrl.length,
      width: media.width, height: media.height, createdByUid: actorUid, createdAt, updatedAt: createdAt
    };
  }

  function itemPaymentRecord(input, { householdId, itemId, paymentId, actorUid, createdAt, operationId }) {
    const ledgerMode = input.ledgerMode ?? input.mode ?? 'independent';
    if (!['linked', 'independent'].includes(ledgerMode)) throw new Error('ledgerMode 必须是 linked 或 independent');
    const type = input.type ?? 'payment';
    if (!['deposit', 'payment'].includes(type)) throw new Error('type 必须是 deposit 或 payment');
    const transactionId = ledgerMode === 'linked' ? `item-payment-${paymentId}` : null;
    return {
      id: paymentId,
      householdId,
      itemId,
      type,
      amountMinor: positiveMinor(input.amountMinor, '付款金额'),
      occurredAt: input.occurredAt ?? createdAt,
      note: String(input.note ?? ''),
      receiptMediaId: input.receiptMedia ? requiredId(input.receiptMedia.id ?? input.receiptMedia.mediaId, 'receiptMediaId') : (input.receiptMediaId ?? null),
      ledgerMode,
      accountId: ledgerMode === 'linked' ? requiredId(input.accountId, '联动账户 ID') : null,
      transactionId,
      status: 'active',
      actorUid,
      createdAt,
      updatedByUid: actorUid,
      updatedAt: createdAt,
      voidedAt: null,
      lastOperationId: operationId
    };
  }

  function linkedTransactionRecord(payment) {
    if (payment.ledgerMode !== 'linked') return null;
    return {
      id: payment.transactionId,
      householdId: payment.householdId,
      operationId: payment.lastOperationId,
      actorUid: payment.actorUid,
      kind: 'expense',
      accountId: payment.accountId,
      targetAccountId: null,
      amountMinor: payment.amountMinor,
      category: '购物',
      note: payment.note,
      occurredAt: payment.occurredAt,
      createdAt: payment.createdAt,
      deletedAt: null,
      purgedAt: null,
      lastOperationId: payment.lastOperationId,
      sourceType: 'itemPayment',
      sourceItemId: payment.itemId,
      sourcePaymentId: payment.id
    };
  }

  /** Metadata-only item listener. Media bytes are loaded only by loadItemMedia. */
  function subscribeItems(householdId, onData, onError) {
    return onSnapshot(collection(db, 'households', householdId, 'items'), { includeMetadataChanges: true }, snapshot => {
      onData({ items: snapshot.docs.map(item => ({ id: item.id, ...item.data() })), metadata: snapshotMetadata(snapshot) });
    }, error => onError?.(error));
  }

  /** Payment listener scoped to the currently opened item; never reads media. */
  function subscribeItemPayments(householdId, itemId, onData, onError) {
    const payments = query(collection(db, 'households', householdId, 'itemPayments'), where('itemId', '==', itemId));
    return onSnapshot(payments, { includeMetadataChanges: true }, snapshot => {
      onData({ payments: snapshot.docs.map(item => ({ id: item.id, ...item.data() })), metadata: snapshotMetadata(snapshot) });
    }, error => onError?.(error));
  }

  async function loadItemMedia(householdId, mediaId) {
    const snapshot = await getDoc(mediaRef(householdId, mediaId));
    return snapshot.exists() ? { id: snapshot.id, ...snapshot.data() } : null;
  }

  /**
   * Create an item, optional cover and optional first deposit atomically.
   * Input IDs are caller-stable. A linked deposit additionally needs accountId.
   */
  async function createItem(input) {
    requireOnline();
    const householdId = requiredId(input.householdId, 'householdId');
    const id = requiredId(input.itemId ?? input.id, 'itemId');
    const operationId = requiredId(input.operationId, 'operationId');
    const actorUid = currentActor(input.actorUid);
    const fullPriceMinor = positiveMinor(input.fullPriceMinor, '物品全价');
    const name = String(input.name ?? '').trim();
    if (!name) throw new Error('物品名称必填');
    const createdAt = input.createdAt ?? now();
    const cover = mediaRecord(input.coverMedia, { householdId, itemId: id, kind: 'cover', actorUid, createdAt });
    const depositInput = input.deposit && input.deposit.amountMinor !== 0 ? input.deposit : null;
    const paymentId = depositInput ? requiredId(depositInput.paymentId ?? depositInput.id, 'paymentId') : null;
    const paymentOperationId = depositInput ? requiredId(depositInput.operationId ?? operationId, '付款 operationId') : null;
    const payment = depositInput ? itemPaymentRecord({ ...depositInput, type: 'deposit' }, {
      householdId, itemId: id, paymentId, actorUid, createdAt: depositInput.createdAt ?? createdAt, operationId: paymentOperationId
    }) : null;
    if (payment && payment.amountMinor > fullPriceMinor) throw new Error('订金不能超过物品全价');
    const receipt = payment ? mediaRecord(depositInput.receiptMedia, {
      householdId, itemId: id, paymentId, kind: 'receipt', actorUid, createdAt: payment.createdAt
    }) : null;
    const item = {
      id, householdId, name, note: String(input.note ?? ''), fullPriceMinor,
      paidMinor: payment?.amountMinor ?? 0,
      status: payment?.amountMinor === fullPriceMinor ? 'completed' : 'active',
      coverMediaId: cover?.id ?? input.coverMediaId ?? null,
      createdByUid: actorUid, createdAt, updatedByUid: actorUid, updatedAt: createdAt,
      archivedAt: null, revision: 1, lastOperationId: operationId,
      lastPaymentId: paymentId
    };
    if (item.coverMediaId && !cover) throw new Error('新封面引用必须随 coverMedia 一起写入');
    const linked = payment ? linkedTransactionRecord(payment) : null;
    return runTransaction(db, async transaction => {
      const existingItem = await transaction.get(itemRef(householdId, id));
      const existingPayment = payment ? await transaction.get(paymentRef(householdId, paymentId)) : null;
      if (existingItem.exists()) {
        const data = existingItem.data();
        const sameItem = data.lastOperationId === operationId && sameFields(data, item, [
          'id', 'householdId', 'name', 'note', 'fullPriceMinor', 'coverMediaId', 'createdByUid', 'lastPaymentId'
        ]);
        const samePayment = !payment || (existingPayment.exists() && existingPayment.data().lastOperationId === paymentOperationId
          && sameFields(existingPayment.data(), payment, ['id', 'itemId', 'type', 'amountMinor', 'occurredAt', 'note', 'receiptMediaId', 'ledgerMode', 'accountId', 'transactionId', 'actorUid']));
        if (sameItem && samePayment) return { item: { id: existingItem.id, ...data }, payment: existingPayment?.data() ?? null, duplicate: true };
        throw new Error('itemId/operationId 已用于不同载荷');
      }
      if (existingPayment?.exists()) throw new Error('paymentId 已存在');
      transaction.set(itemRef(householdId, id), item);
      if (cover) transaction.set(mediaRef(householdId, cover.id), cover);
      if (payment) transaction.set(paymentRef(householdId, paymentId), payment);
      if (receipt) transaction.set(mediaRef(householdId, receipt.id), receipt);
      if (linked) transaction.set(ledgerRef(householdId, paymentId), linked);
      return { item, payment, transaction: linked, duplicate: false };
    });
  }

  async function addItemPayment(input) {
    requireOnline();
    const householdId = requiredId(input.householdId, 'householdId');
    const itemId = requiredId(input.itemId, 'itemId');
    const paymentId = requiredId(input.paymentId ?? input.id, 'paymentId');
    const operationId = requiredId(input.operationId, 'operationId');
    const actorUid = currentActor(input.actorUid);
    const createdAt = input.createdAt ?? now();
    const payment = itemPaymentRecord(input, { householdId, itemId, paymentId, actorUid, createdAt, operationId });
    const receipt = mediaRecord(input.receiptMedia, { householdId, itemId, paymentId, kind: 'receipt', actorUid, createdAt });
    if (payment.receiptMediaId && !receipt) throw new Error('新收据引用必须随 receiptMedia 一起写入');
    const linked = linkedTransactionRecord(payment);
    return runTransaction(db, async transaction => {
      const [itemSnapshot, existingPayment] = await Promise.all([
        transaction.get(itemRef(householdId, itemId)),
        transaction.get(paymentRef(householdId, paymentId))
      ]);
      if (!itemSnapshot.exists()) throw new Error('物品不存在');
      const item = itemSnapshot.data();
      if (existingPayment.exists()) {
        const data = existingPayment.data();
        if (data.lastOperationId === operationId && sameFields(data, payment, [
          'id', 'itemId', 'type', 'amountMinor', 'occurredAt', 'note', 'receiptMediaId', 'ledgerMode', 'accountId', 'transactionId', 'actorUid'
        ])) return { item, payment: data, duplicate: true };
        throw new Error('paymentId/operationId 已用于不同载荷');
      }
      assertRevision(item, input.expectedRevision);
      if (item.archivedAt || item.status === 'archived') throw new Error('已归档物品必须先恢复');
      if (item.paidMinor + payment.amountMinor > item.fullPriceMinor) throw new Error('付款会超过物品全价');
      const nextItem = {
        ...item,
        paidMinor: item.paidMinor + payment.amountMinor,
        status: item.paidMinor + payment.amountMinor === item.fullPriceMinor ? 'completed' : 'active',
        updatedByUid: actorUid,
        updatedAt: createdAt,
        revision: item.revision + 1,
        lastOperationId: operationId,
        lastPaymentId: paymentId
      };
      transaction.set(itemRef(householdId, itemId), nextItem);
      transaction.set(paymentRef(householdId, paymentId), payment);
      if (receipt) transaction.set(mediaRef(householdId, receipt.id), receipt);
      if (linked) transaction.set(ledgerRef(householdId, paymentId), linked);
      return { item: nextItem, payment, transaction: linked, duplicate: false };
    });
  }

  async function mutatePayment(input, action) {
    requireOnline();
    const householdId = requiredId(input.householdId, 'householdId');
    const itemId = requiredId(input.itemId, 'itemId');
    const paymentId = requiredId(input.paymentId, 'paymentId');
    const operationId = requiredId(input.operationId, 'operationId');
    const actorUid = currentActor(input.actorUid);
    const updatedAt = input.updatedAt ?? now();
    return runTransaction(db, async transaction => {
      const [itemSnapshot, paymentSnapshot] = await Promise.all([
        transaction.get(itemRef(householdId, itemId)), transaction.get(paymentRef(householdId, paymentId))
      ]);
      if (!itemSnapshot.exists() || !paymentSnapshot.exists()) throw new Error('物品或付款不存在');
      const item = itemSnapshot.data();
      const payment = paymentSnapshot.data();
      const targetStatus = action === 'void' ? 'voided' : 'active';
      if (payment.lastOperationId === operationId && payment.status === targetStatus) return { item, payment, duplicate: true };
      assertRevision(item, input.expectedRevision);
      if (payment.itemId !== itemId) throw new Error('付款不属于指定物品');
      if (item.archivedAt || item.status === 'archived') throw new Error('已归档物品必须先恢复');
      if (action === 'void' && payment.status !== 'active') throw new Error('付款已作废');
      if (action === 'restore' && payment.status !== 'voided') throw new Error('付款未作废');
      const paidMinor = action === 'void' ? item.paidMinor - payment.amountMinor : item.paidMinor + payment.amountMinor;
      if (paidMinor < 0 || paidMinor > item.fullPriceMinor) throw new Error('付款变更会产生无效已付金额');
      const nextPayment = {
        ...payment,
        status: targetStatus,
        updatedByUid: actorUid,
        updatedAt,
        voidedAt: action === 'void' ? updatedAt : null,
        lastOperationId: operationId
      };
      const nextItem = {
        ...item,
        paidMinor,
        status: paidMinor === item.fullPriceMinor ? 'completed' : 'active',
        updatedByUid: actorUid,
        updatedAt,
        revision: item.revision + 1,
        lastOperationId: operationId,
        lastPaymentId: paymentId
      };
      let nextTransaction = null;
      if (payment.ledgerMode === 'linked') {
        const linkedSnapshot = await transaction.get(ledgerRef(householdId, paymentId));
        if (!linkedSnapshot.exists()) throw new Error('联动账目不存在');
        // actorUid deliberately remains the original payment actor. The spouse
        // performing this correction is attributed on payment.updatedByUid.
        nextTransaction = {
          ...linkedSnapshot.data(),
          deletedAt: action === 'void' ? updatedAt : null,
          lastOperationId: operationId
        };
      }
      transaction.set(itemRef(householdId, itemId), nextItem);
      transaction.set(paymentRef(householdId, paymentId), nextPayment);
      if (nextTransaction) transaction.set(ledgerRef(householdId, paymentId), nextTransaction);
      return { item: nextItem, payment: nextPayment, transaction: nextTransaction, duplicate: false };
    });
  }

  const voidItemPayment = input => mutatePayment(input, 'void');
  const restoreItemPayment = input => mutatePayment(input, 'restore');

  async function editItem(input) {
    requireOnline();
    const householdId = requiredId(input.householdId, 'householdId');
    const itemId = requiredId(input.itemId, 'itemId');
    const operationId = requiredId(input.operationId, 'operationId');
    const actorUid = currentActor(input.actorUid);
    const updatedAt = input.updatedAt ?? now();
    const changes = input.changes ?? input;
    const cover = mediaRecord(input.coverMedia, { householdId, itemId, kind: 'cover', actorUid, createdAt: updatedAt });
    return runTransaction(db, async transaction => {
      const snapshot = await transaction.get(itemRef(householdId, itemId));
      if (!snapshot.exists()) throw new Error('物品不存在');
      const item = snapshot.data();
      const fullPriceMinor = changes.fullPriceMinor === undefined ? item.fullPriceMinor : positiveMinor(changes.fullPriceMinor, '物品全价');
      if (fullPriceMinor < item.paidMinor) throw new Error('物品全价不能低于已付金额');
      const name = changes.name === undefined ? item.name : String(changes.name).trim();
      if (!name) throw new Error('物品名称必填');
      const requestedCoverId = cover?.id ?? (changes.coverMediaId === undefined ? item.coverMediaId : changes.coverMediaId);
      const requestedBusinessPayload = {
        name,
        note: changes.note === undefined ? item.note : String(changes.note),
        fullPriceMinor,
        status: item.paidMinor === fullPriceMinor ? 'completed' : 'active',
        coverMediaId: requestedCoverId ?? null
      };
      if (item.lastOperationId === operationId) {
        if (sameFields(item, requestedBusinessPayload, ['name', 'note', 'fullPriceMinor', 'status', 'coverMediaId'])) {
          return { item, duplicate: true };
        }
        const error = new Error('operationId 已用于不同编辑载荷');
        error.code = 'operation-conflict';
        throw error;
      }
      if (requestedCoverId && requestedCoverId !== item.coverMediaId && !cover) throw new Error('新封面引用必须随 coverMedia 一起写入');
      assertRevision(item, input.expectedRevision);
      if (item.archivedAt || item.status === 'archived') throw new Error('已归档物品必须先恢复');
      const nextItem = {
        ...item,
        ...requestedBusinessPayload,
        updatedByUid: actorUid,
        updatedAt,
        revision: item.revision + 1,
        lastOperationId: operationId
      };
      transaction.set(itemRef(householdId, itemId), nextItem);
      if (cover) transaction.set(mediaRef(householdId, cover.id), cover);
      if (item.coverMediaId && item.coverMediaId !== nextItem.coverMediaId) transaction.delete(mediaRef(householdId, item.coverMediaId));
      return { item: nextItem, duplicate: false };
    });
  }

  async function mutateArchive(input, action) {
    requireOnline();
    const householdId = requiredId(input.householdId, 'householdId');
    const itemId = requiredId(input.itemId, 'itemId');
    const operationId = requiredId(input.operationId, 'operationId');
    const actorUid = currentActor(input.actorUid);
    const updatedAt = input.updatedAt ?? now();
    return runTransaction(db, async transaction => {
      const snapshot = await transaction.get(itemRef(householdId, itemId));
      if (!snapshot.exists()) throw new Error('物品不存在');
      const item = snapshot.data();
      const targetArchived = action === 'archive';
      if (item.lastOperationId === operationId && Boolean(item.archivedAt) === targetArchived) return { item, duplicate: true };
      assertRevision(item, input.expectedRevision);
      if (targetArchived) {
        if (item.archivedAt) throw new Error('物品已归档');
        if (item.paidMinor !== item.fullPriceMinor || item.status !== 'completed') throw new Error('只有已结清物品可以归档');
      } else if (!item.archivedAt || item.status !== 'archived') throw new Error('物品未归档');
      const nextItem = {
        ...item,
        status: targetArchived ? 'archived' : (item.paidMinor === item.fullPriceMinor ? 'completed' : 'active'),
        archivedAt: targetArchived ? updatedAt : null,
        updatedByUid: actorUid,
        updatedAt,
        revision: item.revision + 1,
        lastOperationId: operationId
      };
      transaction.set(itemRef(householdId, itemId), nextItem);
      return { item: nextItem, duplicate: false };
    });
  }

  const archiveItem = input => mutateArchive(input, 'archive');
  const restoreItem = input => mutateArchive(input, 'restore');

  async function inviteMember({ householdId, email, ownerUid, ownerEmail, ownerDisplayName }) {
    const emailLower = cleanEmail(email);
    if (!emailLower || !emailLower.includes('@')) throw new Error('请输入有效的 Gmail');
    if (emailLower === cleanEmail(ownerEmail)) throw new Error('不能邀请当前登录帐号');
    const householdSnapshot = await getDoc(doc(db, 'households', householdId));
    if (!householdSnapshot.exists() || householdSnapshot.data().ownerId !== ownerUid) throw new Error('只有家庭账本建立者可以邀请成员');

    const createdAt = now();
    let targetHouseholdId = householdId;
    let targetHouseholdName = householdSnapshot.data().name;
    const batch = writeBatch(db);
    if (householdSnapshot.data().kind === 'personal') {
      targetHouseholdId = `family-${ownerUid}-${crypto.randomUUID()}`;
      targetHouseholdName = '家庭账本';
      batch.set(doc(db, 'households', targetHouseholdId), {
        ownerId: ownerUid, name: targetHouseholdName, kind: 'shared', createdAt
      });
      batch.set(doc(db, 'households', targetHouseholdId, 'members', ownerUid), {
        uid: ownerUid,
        email: cleanEmail(ownerEmail),
        displayName: ownerDisplayName ?? '',
        role: 'owner',
        active: true,
        joinedAt: createdAt
      });
      batch.update(doc(db, 'users', ownerUid), {
        householdIds: arrayUnion(targetHouseholdId), selectedHouseholdId: targetHouseholdId
      });
    }
    batch.set(doc(db, 'invites', emailLower), {
      email: emailLower,
      householdId: targetHouseholdId,
      householdName: targetHouseholdName,
      ownerUid,
      status: 'pending',
      createdAt,
      acceptedBy: null,
      acceptedAt: null
    });
    await batch.commit();
    return targetHouseholdId;
  }

  function watchInvite(email, onInvite, onError) {
    const emailLower = cleanEmail(email);
    if (!emailLower) return () => {};
    return onSnapshot(doc(db, 'invites', emailLower), snapshot => {
      const invite = snapshot.exists() && snapshot.data().status === 'pending'
        ? { id: snapshot.id, ...snapshot.data() }
        : null;
      onInvite(invite);
    }, error => onError?.(error));
  }

  async function acceptInvite({ invite, user }) {
    const email = cleanEmail(user.email);
    if (!invite || invite.email !== email) throw new Error('这份家庭邀请不属于当前帐号');
    const acceptedAt = now();
    const batch = writeBatch(db);
    batch.set(doc(db, 'households', invite.householdId, 'members', user.uid), {
      uid: user.uid, email, displayName: user.displayName ?? '', role: 'member', active: true, joinedAt: acceptedAt
    });
    batch.update(doc(db, 'users', user.uid), {
      householdIds: arrayUnion(invite.householdId), selectedHouseholdId: invite.householdId
    });
    batch.update(doc(db, 'invites', email), {
      status: 'accepted', acceptedBy: user.uid, acceptedAt
    });
    await batch.commit();
  }

  return {
    onAuthChanged: callback => onAuthStateChanged(auth, callback),
    signInGoogle,
    registerTestUser: (email, password) => createUserWithEmailAndPassword(auth, cleanEmail(email), password),
    signInTestUser: (email, password) => signInWithEmailAndPassword(auth, cleanEmail(email), password),
    logout: () => signOut(auth),
    ensureWorkspace,
    watchUser: (uid, onData, onError) => onSnapshot(doc(db, 'users', uid), snapshot => onData(snapshot.data()), error => onError?.(error)),
    householdOptions,
    subscribeHousehold,
    // Item APIs intentionally keep Data URLs out of list listeners/core docs.
    subscribeItems,
    subscribeItemPayments,
    loadItemMedia,
    createItem,
    addItemPayment,
    voidItemPayment,
    restoreItemPayment,
    editItem,
    archiveItem,
    restoreItem,
    selectHousehold: (uid, householdId) => updateDoc(doc(db, 'users', uid), { selectedHouseholdId: householdId }),
    inviteMember,
    watchInvite,
    acceptInvite,
    saveAccount: (householdId, account) => setDoc(doc(db, 'households', householdId, 'accounts', account.id), accountRecord(account, householdId)),
    saveTransaction: (householdId, entry, actorUid) => setDoc(doc(db, 'households', householdId, 'transactions', entry.id), transactionRecord(entry, householdId, actorUid)),
    purgeTransaction: (householdId, transactionId, operationId) => updateDoc(doc(db, 'households', householdId, 'transactions', transactionId), {
      purgedAt: now(), lastOperationId: operationId
    })
  };
}
