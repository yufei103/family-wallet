import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const source = resolve(root, 'app');
const output = resolve(root, 'dist');
const required = ['index.html', 'styles.css', 'main.js', 'ledger.js', 'firebase-client.js', 'service-worker.js', 'manifest.webmanifest'];
const iconFiles = ['favicon-32.png', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png'];
const configKeys = {
  apiKey: 'FIREBASE_API_KEY',
  authDomain: 'FIREBASE_AUTH_DOMAIN',
  projectId: 'FIREBASE_PROJECT_ID',
  storageBucket: 'FIREBASE_STORAGE_BUCKET',
  messagingSenderId: 'FIREBASE_MESSAGING_SENDER_ID',
  appId: 'FIREBASE_APP_ID',
  appCheckSiteKey: 'FIREBASE_APP_CHECK_SITE_KEY'
};

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const file of required) {
  await copyFile(resolve(source, file), resolve(output, file));
  await readFile(resolve(output, file));
}
await mkdir(resolve(output, 'icons'), { recursive: true });
for (const file of iconFiles) await copyFile(resolve(source, 'icons', file), resolve(output, 'icons', file));

const config = Object.fromEntries(Object.entries(configKeys).map(([key, envName]) => [key, process.env[envName] || '']));
await writeFile(resolve(output, 'firebase-config.js'), `export const firebaseConfig = ${JSON.stringify(config, null, 2)};\n\nexport const firebaseConfigured = Boolean(\n  firebaseConfig.apiKey && firebaseConfig.authDomain && firebaseConfig.projectId\n    && firebaseConfig.appId && firebaseConfig.appCheckSiteKey\n);\n`);
console.log(`Built ${required.length + iconFiles.length + 1} public runtime assets in dist/`);
