import { readFile, readdir } from 'node:fs/promises';
import { extname, resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const roots = ['app', '.github', 'scripts', 'README.md', 'SECURITY.md', 'firestore.rules', 'firebase.json', 'package.json'];
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
    const stat = await import('node:fs/promises').then(module => module.stat(full));
    if (stat.isDirectory()) await collect(full);
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

if (issues.length) {
  const uniqueIssues = [...new Set(issues)];
  console.error(`Public audit failed (${uniqueIssues.length} issue${uniqueIssues.length === 1 ? '' : 's'}):`);
  for (const issue of uniqueIssues) console.error(`- ${issue}`);
  process.exitCode = 1;
} else {
  console.log(`Public audit passed: ${new Set(files).size} text files, no credential or personal-email artifacts found.`);
}
