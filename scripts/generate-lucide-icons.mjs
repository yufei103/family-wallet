import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { n as iconToCubics, r as cubicsToPathD } from '../app/vendor/morphicons/1.7.1/normalize-CYnN3Npw.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const version = '1.38.0';
const packageRoot = resolve(root, 'node_modules/lucide-static');
const output = resolve(root, 'app/lucide-icon-data.js');
const selected = Object.freeze({
  home:'house',
  'home-active':'house-heart',
  wallet:'wallet',
  'wallet-active':'wallet-cards',
  receipt:'receipt',
  'receipt-active':'receipt-text',
  item:'package',
  'item-active':'package-check',
  plus:'plus',
  check:'check',
  circle:'circle',
  'check-circle':'circle-check-big',
  close:'x',
  'x-circle':'circle-x',
  'chevron-down':'chevron-down',
  'chevron-up':'chevron-up',
  'chevron-left':'chevron-left',
  'chevron-right':'chevron-right',
  'menu-ellipsis':'ellipsis',
  'progress-ring':'loader-circle',
  'info-circle':'info',
  'alert-circle':'circle-alert',
  'error-circle':'circle-x',
  'alert-triangle':'triangle-alert',
  refresh:'refresh-cw',
  'cloud-sync':'cloud-sync',
  cloud:'cloud',
  'cloud-check':'cloud-check',
  'cloud-clock':'cloud-cog',
  'cloud-off':'cloud-off',
  'refresh-cloud':'cloud-cog',
  'download-ready':'cloud-download',
  calendar:'calendar-days',
  'calendar-check':'calendar-check',
  filter:'funnel',
  'filter-check':'list-filter-plus',
  'archive-box':'archive',
  restore:'archive-restore',
  'restore-arrow':'undo-2',
  'recycle-bin':'trash-2',
  trash:'trash-2',
  eye:'eye',
  download:'download',
  settings:'settings-2',
  'category-salary':'hand-coins',
  'category-shopping':'shopping-bag',
  'category-medical':'heart-pulse',
  'category-mortgage':'house',
  'category-electric':'zap',
  'category-tax':'receipt-text',
  'category-fuel':'fuel',
  'category-car':'car',
  'category-other':'tag',
  'income-arrow':'arrow-up',
  'expense-arrow':'arrow-down',
  'transfer-arrows':'arrow-left-right'
});

function parseIconNode(svg, name) {
  const nodes = [];
  const supported = /<(path|line|circle|ellipse|rect|polyline|polygon)\b([^>]*)\/>/g;
  for (const match of svg.matchAll(supported)) {
    const attrs = {};
    for (const attr of match[2].matchAll(/([\w:-]+)="([^"]*)"/g)) attrs[attr[1]] = attr[2];
    nodes.push([match[1], attrs]);
  }
  if (!nodes.length) throw new Error(`Lucide icon has no supported stroke nodes: ${name}`);
  return nodes;
}

const endpoints = {};
for (const [endpoint, icon] of Object.entries(selected)) {
  const svg = await readFile(resolve(packageRoot, 'icons', `${icon}.svg`), 'utf8');
  endpoints[endpoint] = cubicsToPathD(iconToCubics(parseIconNode(svg, icon)));
}

const generated = `/**\n * Generated from lucide-static ${version} (ISC).\n * Run: npm run icons:lucide\n */\nexport const LUCIDE_ICON_VERSION = '${version}';\nexport const LUCIDE_ICON_SOURCES = Object.freeze(${JSON.stringify(selected, null, 2)});\nexport const LUCIDE_ICON_ENDPOINTS = Object.freeze(${JSON.stringify(endpoints, null, 2)});\n`;

if (process.argv.includes('--check')) {
  const current = await readFile(output, 'utf8');
  if (current !== generated) throw new Error('app/lucide-icon-data.js is stale; run npm run icons:lucide');
  console.log(`Lucide ${version} endpoint data is current (${Object.keys(endpoints).length} selected icons).`);
} else {
  await writeFile(output, generated);
  console.log(`Generated ${Object.keys(endpoints).length} Lucide ${version} endpoints.`);
}
