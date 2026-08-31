import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(root, 'app');
const output = resolve(root, 'dist');
const required = [
  'index.html', 'styles.css', 'main.js', 'ledger.js', 'items.js', 'item-media.js',
  'items-view.js', 'cloud-sync.js', 'backup-restore.js', 'wallet-features.js',
  'firebase-client.js', 'service-worker.js', 'manifest.webmanifest',
  'state-icon-data.js', 'state-icon-motion.js'
];
const iconFiles = ['favicon-32.png', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png'];
const vendorRelative = 'vendor/morphicons/1.7.1';
const vendorFiles = Object.freeze({
  'dom.js': 'ce2915838dbc547d9b74207d8776627f69d6ed8014f5a91fe82e30a645009655',
  'spring-CFHloqPP.js': 'd107c0752f72e6b6b5acb8016f3c5fa2adfebf661eb85e61562240b87dea9ae7',
  'normalize-CYnN3Npw.js': '7da2964e74cff390949302e7c771dc89eaf6daa107cd8f5356865277542cc9c3',
  LICENSE: 'bca713965691c297a4fc7e17eb115b373b7d08db4975c1968df7f7707267a4be',
  'provenance.json': null
});
const configKeys = {
  apiKey: 'FIREBASE_API_KEY',
  authDomain: 'FIREBASE_AUTH_DOMAIN',
  projectId: 'FIREBASE_PROJECT_ID',
  storageBucket: 'FIREBASE_STORAGE_BUCKET',
  messagingSenderId: 'FIREBASE_MESSAGING_SENDER_ID',
  appId: 'FIREBASE_APP_ID',
  appCheckSiteKey: 'FIREBASE_APP_CHECK_SITE_KEY'
};

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const vendorSource = resolve(source, vendorRelative);
const actualVendorFiles = (await readdir(vendorSource)).sort();
const allowedVendorFiles = Object.keys(vendorFiles).sort();
if (JSON.stringify(actualVendorFiles) !== JSON.stringify(allowedVendorFiles)) {
  throw new Error(`Unexpected Morphicons vendor closure: ${actualVendorFiles.join(', ')}`);
}
for (const [file, expectedHash] of Object.entries(vendorFiles)) {
  const bytes = await readFile(resolve(vendorSource, file));
  if (expectedHash && sha256(bytes) !== expectedHash) throw new Error(`Morphicons hash mismatch: ${file}`);
}
const provenance = JSON.parse(await readFile(resolve(vendorSource, 'provenance.json'), 'utf8'));
if (provenance.package?.version !== '1.7.1'
  || provenance.package?.tarballSha256 !== '455276d20395d23d8fdbf387fc14eb53d6c22f98c06f311b3680cf98e0c16034'
  || JSON.stringify([...provenance.runtimeClosure.allowedFiles].sort()) !== JSON.stringify(allowedVendorFiles)) {
  throw new Error('Morphicons provenance does not match the pinned 1.7.1 closure');
}

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const file of required) {
  await copyFile(resolve(source, file), resolve(output, file));
  await readFile(resolve(output, file));
}
await mkdir(resolve(output, 'icons'), { recursive: true });
for (const file of iconFiles) await copyFile(resolve(source, 'icons', file), resolve(output, 'icons', file));
await mkdir(resolve(output, vendorRelative), { recursive: true });
for (const file of allowedVendorFiles) await copyFile(resolve(vendorSource, file), resolve(output, vendorRelative, file));

const config = Object.fromEntries(Object.entries(configKeys).map(([key, envName]) => [key, process.env[envName] || '']));
await writeFile(resolve(output, 'firebase-config.js'), `export const firebaseConfig = ${JSON.stringify(config, null, 2)};\n\nexport const firebaseConfigured = Boolean(\n  firebaseConfig.apiKey && firebaseConfig.authDomain && firebaseConfig.projectId\n    && firebaseConfig.appId && firebaseConfig.appCheckSiteKey\n);\n`);
const emittedAssetCount = required.length + iconFiles.length + allowedVendorFiles.length + 1;
console.log(`Built ${emittedAssetCount} public runtime assets in dist/`);
