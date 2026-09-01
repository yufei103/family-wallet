import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { readFile, readdir, stat } from 'node:fs/promises';
import { extname, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const roots = ['app', '.github', 'scripts', 'README.md', 'THIRD_PARTY_NOTICES.md', 'SECURITY.md', 'firestore.rules', 'firebase.json', 'package.json'];
const skippedDirectories = new Set(['node_modules', 'dist', '.git', '.firebase', 'archive']);
const textExtensions = new Set(['', '.html', '.css', '.js', '.mjs', '.json', '.md', '.rules', '.yml', '.yaml']);
const allowedFixtureEmails = new Set([
  'owner@gmail.com', 'member@gmail.com', 'wife@gmail.com', 'stranger@gmail.com', 'other@gmail.com',
  'owner@example.com', 'member@example.com'
]);
const secretPatterns = [
  ['Google API key', /AIza[0-9A-Za-z_-]{30,}/g],
  ['GitHub token', /gh[oprsu]_[0-9A-Za-z]{30,}/g],
  ['Google OAuth token', /ya29\.[0-9A-Za-z_-]+/g],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ['service account JSON', /"type"\s*:\s*"service_account"/g],
  ['embedded account photo', /data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]{200,}/g]
];
const issues = [];
const files = [];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function collect(path) {
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.github') continue;
    const full = resolve(path, entry.name);
    if (entry.isDirectory()) {
      if (!skippedDirectories.has(entry.name)) await collect(full);
    } else if (textExtensions.has(extname(entry.name))) {
      files.push(full);
    }
  }
}

for (const item of roots) {
  const full = resolve(root, item);
  try {
    const info = await stat(full);
    if (info.isDirectory()) await collect(full);
    else files.push(full);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

for (const file of [...new Set(files)]) {
  const relative = file.slice(root.length + 1);
  const content = await readFile(file, 'utf8');
  for (const [label, pattern] of secretPatterns) {
    pattern.lastIndex = 0;
    if (pattern.test(content)) issues.push(`${relative}: ${label}`);
  }
  const emails = content.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
  for (const email of emails.map(value => value.toLowerCase())) {
    if (!email.endsWith('@example.com') && !allowedFixtureEmails.has(email)) issues.push(`${relative}: non-fixture email address`);
  }
}

const config = await readFile(resolve(root, 'app/firebase-config.js'), 'utf8');
if (!/apiKey:\s*''/.test(config) || !/appCheckSiteKey:\s*''/.test(config)) {
  issues.push('app/firebase-config.js: production values must stay empty in source');
}

const vendorRelative = 'app/vendor/morphicons/1.7.1';
const vendorRoot = resolve(root, vendorRelative);
const expectedVendor = Object.freeze({
  'dom.js': { sha256: 'ce2915838dbc547d9b74207d8776627f69d6ed8014f5a91fe82e30a645009655', bytes: 5113, imports: ['./spring-CFHloqPP.js', './normalize-CYnN3Npw.js'] },
  'spring-CFHloqPP.js': { sha256: 'd107c0752f72e6b6b5acb8016f3c5fa2adfebf661eb85e61562240b87dea9ae7', bytes: 18135, imports: ['./normalize-CYnN3Npw.js'] },
  'normalize-CYnN3Npw.js': { sha256: '7da2964e74cff390949302e7c771dc89eaf6daa107cd8f5356865277542cc9c3', bytes: 13517, imports: [] },
  LICENSE: { sha256: 'bca713965691c297a4fc7e17eb115b373b7d08db4975c1968df7f7707267a4be', bytes: 1066 }
});
const expectedAllowed = [...Object.keys(expectedVendor), 'provenance.json'].sort();
let actualAllowed = [];
try {
  actualAllowed = (await readdir(vendorRoot)).sort();
} catch (error) {
  issues.push(`${vendorRelative}: missing pinned vendor directory (${error.code || error.message})`);
}
if (JSON.stringify(actualAllowed) !== JSON.stringify(expectedAllowed)) {
  issues.push(`${vendorRelative}: expected only ${expectedAllowed.join(', ')}`);
}

const runtimeBuffers = [];
const runtimeSource = new Map();
for (const [name, expected] of Object.entries(expectedVendor)) {
  try {
    const bytes = await readFile(resolve(vendorRoot, name));
    if (sha256(bytes) !== expected.sha256) issues.push(`${vendorRelative}/${name}: pinned SHA-256 mismatch`);
    if (bytes.length !== expected.bytes) issues.push(`${vendorRelative}/${name}: pinned byte length mismatch`);
    if (name.endsWith('.js')) {
      runtimeBuffers.push(bytes);
      runtimeSource.set(name, bytes.toString('utf8'));
    }
  } catch (error) {
    issues.push(`${vendorRelative}/${name}: missing (${error.code || error.message})`);
  }
}

for (const [name, expected] of Object.entries(expectedVendor).filter(([file]) => file.endsWith('.js'))) {
  const source = runtimeSource.get(name) || '';
  const imports = [...source.matchAll(/\bfrom\s+["']([^"']+)["']/g)].map(match => match[1]);
  if (JSON.stringify(imports) !== JSON.stringify(expected.imports)) {
    issues.push(`${vendorRelative}/${name}: relative import graph mismatch`);
  }
  if (imports.some(specifier => !specifier.startsWith('./'))) issues.push(`${vendorRelative}/${name}: bare or non-relative import`);
}

const forbiddenRuntime = [
  ['remote URL', /https?:\/\/|["'`]\/\/[A-Za-z0-9]/],
  ['dynamic import', /\bimport\s*\(/],
  ['dynamic evaluation', /\beval\s*\(|\bnew\s+Function\b/],
  ['network or worker API', /\b(?:fetch|XMLHttpRequest|WebSocket|Worker)\b/],
  ['persistent browser state', /\b(?:localStorage|sessionStorage|indexedDB|cookie)\b/],
  ['document access', /\bdocument\b/]
];
for (const [name, source] of runtimeSource) {
  for (const [label, pattern] of forbiddenRuntime) {
    if (pattern.test(source)) issues.push(`${vendorRelative}/${name}: forbidden ${label}`);
  }
}

try {
  const provenance = JSON.parse(await readFile(resolve(vendorRoot, 'provenance.json'), 'utf8'));
  if (provenance.package?.name !== 'morphicons' || provenance.package?.version !== '1.7.1'
    || provenance.package?.repository !== 'https://github.com/guillermolg00/morphicons'
    || provenance.package?.tarball !== 'https://registry.npmjs.org/morphicons/-/morphicons-1.7.1.tgz'
    || provenance.package?.npmIntegrity !== 'sha512-q5ylxy5/d7vBg0OAzanlooXf05PekovMYDuuQVpr6vAQZxl99lrJbaIi+jJ32PXQf9WEEaDO2pbNBsx1ZhEnFQ=='
    || provenance.package?.tarballSha256 !== '455276d20395d23d8fdbf387fc14eb53d6c22f98c06f311b3680cf98e0c16034') {
    issues.push(`${vendorRelative}/provenance.json: package provenance mismatch`);
  }
  if (provenance.runtimeClosure?.rawBytes !== 36765 || provenance.runtimeClosure?.gzip9Bytes !== 12861
    || JSON.stringify([...provenance.runtimeClosure?.allowedFiles || []].sort()) !== JSON.stringify(expectedAllowed)) {
    issues.push(`${vendorRelative}/provenance.json: closure provenance mismatch`);
  }
  for (const [name, expected] of Object.entries(expectedVendor)) {
    const recorded = provenance.runtimeClosure?.files?.[name];
    if (recorded?.sha256 !== expected.sha256 || recorded?.bytes !== expected.bytes) {
      issues.push(`${vendorRelative}/provenance.json: ${name} hash/size record mismatch`);
    }
  }
} catch (error) {
  issues.push(`${vendorRelative}/provenance.json: invalid or missing (${error.message})`);
}

const license = await readFile(resolve(vendorRoot, 'LICENSE'), 'utf8').catch(() => '');
if (!license.includes('MIT License') || !license.includes('Copyright (c) 2026 Guillermo')
  || !license.includes('THE SOFTWARE IS PROVIDED "AS IS"')) {
  issues.push(`${vendorRelative}/LICENSE: incomplete MIT notice`);
}

const lucideRelative = 'app/vendor/lucide/1.38.0';
const lucideRoot = resolve(root, lucideRelative);
const expectedLucideFiles = ['LICENSE', 'provenance.json'];
try {
  const actual = (await readdir(lucideRoot)).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expectedLucideFiles)) issues.push(`${lucideRelative}: unexpected closure`);
  const lucideLicense = await readFile(resolve(lucideRoot, 'LICENSE'));
  if (sha256(lucideLicense) !== 'b495047bd93a9b06913511076f504daba17d5bbeb3e0650f3bb53a4220329c57') {
    issues.push(`${lucideRelative}/LICENSE: pinned SHA-256 mismatch`);
  }
  const lucideProvenance = JSON.parse(await readFile(resolve(lucideRoot, 'provenance.json'), 'utf8'));
  if (lucideProvenance.package?.name !== 'lucide-static' || lucideProvenance.package?.version !== '1.38.0'
    || lucideProvenance.package?.license !== 'ISC'
    || lucideProvenance.package?.npmIntegrity !== 'sha512-/pRaHJceXrQyAMzWfwhWPMwZeiZEIejZ+Ko226AqI52QbLVgowyGAp7OzZIaQEf7XB+LuRGWqUGqTfu3LJ0CQQ=='
    || lucideProvenance.runtimeClosure?.selectedIconCount !== 56) {
    issues.push(`${lucideRelative}/provenance.json: package provenance mismatch`);
  }
} catch (error) {
  issues.push(`${lucideRelative}: invalid or missing (${error.message})`);
}

const iconProductionFiles = ['app/state-icon-data.js', 'app/lucide-icon-data.js', 'app/state-icon-motion.js'];
const forbiddenIconSource = /https?:\/\/|["'`]\/\/[A-Za-z0-9]|\b(?:React|Vue|Svelte|Iconify|customElements)\b|font-awesome|\.woff2?\b/i;
const iconBuffers = [];
for (const relative of iconProductionFiles) {
  try {
    const bytes = await readFile(resolve(root, relative));
    iconBuffers.push(bytes);
    if (forbiddenIconSource.test(bytes.toString('utf8'))) issues.push(`${relative}: remote, framework or icon-font reference`);
  } catch (error) {
    issues.push(`${relative}: missing (${error.code || error.message})`);
  }
}
const vendorGzip = runtimeBuffers.reduce((total, bytes) => total + gzipSync(bytes, { level: 9, mtime: 0 }).length, 0);
const totalIconGzip = [...runtimeBuffers, ...iconBuffers].reduce((total, bytes) => total + gzipSync(bytes, { level: 9, mtime: 0 }).length, 0);
const vendorGzipBudget = 13 * 1024;
if (runtimeBuffers.length === 3 && vendorGzip > vendorGzipBudget) {
  issues.push(`${vendorRelative}: exceeds 13 KiB gzip-9 budget (${vendorGzip} bytes)`);
}
if (totalIconGzip > 32 * 1024) issues.push(`state icon JavaScript exceeds 32 KiB gzip budget (${totalIconGzip} bytes)`);

if (issues.length) {
  const uniqueIssues = [...new Set(issues)];
  console.error(`Public audit failed (${uniqueIssues.length} issue${uniqueIssues.length === 1 ? '' : 's'}):`);
  for (const issue of uniqueIssues) console.error(`- ${issue}`);
  process.exitCode = 1;
} else {
  console.log(`Public audit passed: ${new Set(files).size} text files; Morphicons 1.7.1 and Lucide 1.38.0 are pinned; icon JavaScript ${totalIconGzip} bytes gzip-9; no credential or personal-email artifacts found.`);
}
