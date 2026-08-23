import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js';
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-app-check.js';
import {
  GoogleAuthProvider, connectAuthEmulator, createUserWithEmailAndPassword, getAuth,
  onAuthStateChanged, signInWithEmailAndPassword, signInWithPopup, signInWithRedirect, signOut
} from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js';
import {
  arrayUnion, collection, connectFirestoreEmulator, doc, getDoc, initializeFirestore,
  onSnapshot, persistentLocalCache, persistentMultipleTabManager, setDoc, updateDoc, writeBatch
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

const transactionRecord = (entry, householdId, actorUid) => cleanRecord({
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
});

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
    const values = await Promise.all(householdIds.map(async householdId => {
      try {
        const snapshot = await getDoc(doc(db, 'households', householdId));
        return snapshot.exists() ? { id: householdId, ...snapshot.data() } : null;
      } catch {
        return null;
      }
    }));
    return values.filter(Boolean);
  }

  function subscribeHousehold(householdId, onData, onError) {
    const state = { household: null, accounts: null, transactions: null };
    const emit = () => {
      if (state.household && state.accounts && state.transactions) onData(cleanRecord(state));
    };
    const fail = error => onError?.(error);
    const stops = [
      onSnapshot(doc(db, 'households', householdId), snapshot => {
        state.household = snapshot.exists() ? { id: snapshot.id, ...snapshot.data() } : null;
        emit();
      }, fail),
      onSnapshot(collection(db, 'households', householdId, 'accounts'), snapshot => {
        state.accounts = snapshot.docs.map(item => ({ id: item.id, ...item.data() }));
        emit();
      }, fail),
      onSnapshot(collection(db, 'households', householdId, 'transactions'), snapshot => {
        state.transactions = snapshot.docs.map(item => ({ id: item.id, ...item.data() })).filter(item => !item.purgedAt);
        emit();
      }, fail)
    ];
    return () => stops.forEach(stop => stop());
  }

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
