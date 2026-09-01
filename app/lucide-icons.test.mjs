import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { createMorph } from './vendor/morphicons/1.7.1/dom.js';
import { LUCIDE_ICON_ENDPOINTS, LUCIDE_ICON_SOURCES, LUCIDE_ICON_VERSION } from './lucide-icon-data.js';
import { STATE_ICON_ENDPOINTS, STATE_ICON_REGISTRY } from './state-icon-data.js';

const app = relative => new URL(relative, import.meta.url);

class FakePath {
  constructor() { this.d = ''; }
  setAttribute(name, value) { if (name === 'd') this.d = String(value); }
}

test('Lucide 1.38.0 endpoint set is exact, curated and self-hosted', async () => {
  const [packageText, provenanceText, license, worker] = await Promise.all([
    readFile(app('../package.json'), 'utf8'),
    readFile(app('./vendor/lucide/1.38.0/provenance.json'), 'utf8'),
    readFile(app('./vendor/lucide/1.38.0/LICENSE'), 'utf8'),
    readFile(app('./service-worker.js'), 'utf8')
  ]);
  const packageData = JSON.parse(packageText);
  const provenance = JSON.parse(provenanceText);
  assert.equal(LUCIDE_ICON_VERSION, '1.38.0');
  assert.equal(packageData.devDependencies['lucide-static'], '1.38.0');
  assert.equal(provenance.package.npmIntegrity, 'sha512-/pRaHJceXrQyAMzWfwhWPMwZeiZEIejZ+Ko226AqI52QbLVgowyGAp7OzZIaQEf7XB+LuRGWqUGqTfu3LJ0CQQ==');
  assert.equal(Object.keys(LUCIDE_ICON_ENDPOINTS).length, 56);
  assert.equal(Object.keys(LUCIDE_ICON_SOURCES).length, 56);
  assert.match(license, /ISC License[\s\S]*Lucide Icons and Contributors/);
  assert.match(worker, /lucide-icon-data\.js/);
  assert.match(worker, /vendor\/lucide\/1\.38\.0\/LICENSE/);
});

test('visible navigation, state and category endpoints resolve to generated Lucide paths', () => {
  const expectedSources = {
    home:'house', 'home-active':'house-heart', wallet:'wallet', 'wallet-active':'wallet-cards',
    receipt:'receipt', 'receipt-active':'receipt-text', item:'package', 'item-active':'package-check',
    'menu-ellipsis':'ellipsis', close:'x', filter:'funnel', 'filter-check':'list-filter-plus',
    'category-shopping':'shopping-bag', 'category-electric':'zap', 'category-medical':'heart-pulse',
    'category-mortgage':'house', 'category-other':'tag'
  };
  for (const [endpoint, source] of Object.entries(expectedSources)) {
    assert.equal(LUCIDE_ICON_SOURCES[endpoint], source);
    assert.equal(STATE_ICON_ENDPOINTS[endpoint], LUCIDE_ICON_ENDPOINTS[endpoint]);
    assert.match(STATE_ICON_ENDPOINTS[endpoint], /^M/);
    assert.doesNotMatch(STATE_ICON_ENDPOINTS[endpoint], /NaN|undefined/);
  }
  assert.equal(STATE_ICON_REGISTRY['nav-home'].idle, 'home');
  assert.equal(STATE_ICON_REGISTRY['nav-home'].active, 'home-active');
  assert.equal(STATE_ICON_REGISTRY.menu.closed, 'menu-ellipsis');
  assert.equal(STATE_ICON_REGISTRY.menu.open, 'close');
});

test('selected Lucide pairs produce finite, distinct halfway morphs', () => {
  const pairs = [
    ['home', 'home-active'], ['wallet', 'wallet-active'], ['receipt', 'receipt-active'],
    ['item', 'item-active'], ['menu-ellipsis', 'close'], ['filter', 'filter-check'],
    ['cloud', 'cloud-check'], ['plus', 'check-circle']
  ];
  for (const [from, to] of pairs) {
    const path = new FakePath();
    const handle = createMorph(path, STATE_ICON_ENDPOINTS[from]);
    const start = path.d;
    handle.seek(STATE_ICON_ENDPOINTS[to], 0.5);
    assert.notEqual(path.d, start, `${from} → ${to} must visibly move`);
    assert.notEqual(path.d, STATE_ICON_ENDPOINTS[to], `${from} → ${to} must have a real intermediate shape`);
    assert.doesNotMatch(path.d, /NaN|Infinity|undefined/);
    handle.destroy();
  }
});
