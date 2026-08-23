export const firebaseConfig = {
  apiKey: '',
  authDomain: '',
  projectId: '',
  storageBucket: '',
  messagingSenderId: '',
  appCheckSiteKey: '',
  appId: ''
};

export const firebaseConfigured = Boolean(
  firebaseConfig.apiKey && firebaseConfig.authDomain && firebaseConfig.projectId
    && firebaseConfig.appId && firebaseConfig.appCheckSiteKey
);
