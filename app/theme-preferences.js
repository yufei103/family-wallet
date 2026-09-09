export const THEME_STORE = 'family-wallet-v2-theme';
export const DEFAULT_THEME = 'warm';
export const THEMES = new Set(['warm', 'teal', 'maybank', 'cimb', 'ocean']);
export const normaliseTheme = value => THEMES.has(value) ? value : DEFAULT_THEME;

export function readCachedTheme(storage) {
  try { return normaliseTheme(storage.getItem(THEME_STORE)); }
  catch { return DEFAULT_THEME; }
}

// One device cache for the pre-login shell; users/{uid}.theme is personal authority.
// Never upload the device cache on login or copy one family member's preference.
export function createThemePreferences({ storage, apply, save, onStatus = () => {} }) {
  let session = null;
  let revision = 0;
  let pending = 0;
  let ready = false;
  let latestProfile = null;
  let latestResult = null;
  const show = value => {
    const theme = normaliseTheme(value);
    apply(theme);
    try {
      storage.setItem(THEME_STORE, theme);
      if (session) storage.setItem(`${THEME_STORE}:${session.uid}`, theme);
    } catch { /* Cloud still works without a device cache. */ }
    return theme;
  };
  const status = metadata => onStatus(metadata?.hasPendingWrites ? 'pending' : metadata?.fromCache === false ? 'synced' : 'cached');
  const settle = () => {
    if (pending) return;
    if (latestResult === false) { onStatus('error'); return; }
    if (latestProfile?.metadata?.fromCache === false && !latestProfile.metadata.hasPendingWrites) show(latestProfile.theme);
    onStatus('synced');
  };
  return {
    beginUser(uid) {
      session = uid ? { uid } : null;
      ready = false;
      pending = 0;
      revision = 0;
      latestProfile = null;
      latestResult = null;
      if (session) {
        let cached;
        try { cached = storage.getItem(`${THEME_STORE}:${session.uid}`); } catch { /* Default remains available. */ }
        show(normaliseTheme(cached));
      }
      onStatus(uid ? 'loading' : 'local');
      return session;
    },
    receive(profile, token, metadata) {
      if (!token || token !== session || profile?.uid !== token.uid) return;
      ready = true;
      latestProfile = { theme: normaliseTheme(profile.theme), metadata };
      if (!pending && latestResult !== false) {
        show(latestProfile.theme);
        status(metadata);
      }
    },
    error(token) {
      if (token && token === session) onStatus('error');
    },
    async choose(value) {
      if (!THEMES.has(value)) return false;
      const token = session;
      if (token && !ready) { onStatus('loading'); return false; }
      show(value);
      if (!token) { onStatus('local'); return true; }
      const change = ++revision;
      latestProfile = null;
      latestResult = null;
      pending += 1;
      onStatus('pending');
      try {
        // Capture uid before awaiting; a later login can never redirect this write.
        await save(token.uid, value);
        if (token !== session) return true;
        pending -= 1;
        if (change === revision) latestResult = true;
        settle();
        return true;
      } catch {
        if (token === session) {
          pending -= 1;
          if (change === revision) latestResult = false;
          settle();
        }
        return false;
      }
    }
  };
}
