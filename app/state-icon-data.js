import { LUCIDE_ICON_ENDPOINTS } from './lucide-icon-data.js';

const APP_ICON_VIEW_BOX = '0 0 24 24';
const SAFE_ENDPOINT = 'fallback';

const endpointPaths = {
  fallback: 'M5 5h14v14H5zM9 9l6 6M15 9l-6 6',
  neutral: 'M5 12h14',
  'refresh-checking': 'M20 7v5h-5M4 17v-5h5M6.1 8a7 7 0 0 1 11.7-2L20 8M4 16l2.2 2a7 7 0 0 0 8.8.4',
  'google-account': 'M12 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM4 21a8 8 0 0 1 16 0M18 5h3M19.5 3.5v3',
  'wallet-check': 'M4 7h15v12H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h11M15 12h6v4h-6a2 2 0 0 1 0-4zM7 12l2 2 4-4',
  'invite-mail': 'M3 6h14v12H3V6zM3 7l7 6 7-6M19 10v6M16 13h6',
  'household-check': 'M4 20v-2a4 4 0 0 1 4-4h2M8 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM15 8h6v6M16 11l2 2 3-4',
  'wallet-plus': 'M4 7h15v12H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h11M15 12h6v4h-6a2 2 0 0 1 0-4zM8 11v5M5.5 13.5h5',
  'receipt-plus': 'M5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16l-3-2-2 2-2-2-2 2-2-2-3 2M12 7v7M8.5 10.5h7',
  'user-plus': 'M9 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM2 21a7 7 0 0 1 14 0M18 8v6M15 11h6',
  'empty-chart': 'M4 20h16M6 17v-3M12 17V9M18 17V5',
  'category-chart': 'M4 20h16M6 17v-5M12 17V7M18 17V3M5 8l6-4 6 2',
  'credit-card': 'M3 6h18v13H3V6zM3 10h18M7 15h4',
  'loan-calendar': 'M3 10l9-7 9 7M5 9v11h14V9M9 20v-6h6v6M16 5v3M8 5v3',
  'package-clock': 'M4 7l8-4 8 4-8 4-8-4zM4 7v10l8 4 8-4V7M12 11v10M16 12v3l2 1',
  'package-check': 'M4 7l8-4 8 4-8 4-8-4zM4 7v10l8 4 8-4V7M12 11v10M14.5 15l2 2 4-5',
  pencil: 'M4 20l4.5-1 10-10a2.1 2.1 0 0 0-3-3l-10 10L4 20zM14 7l3 3',
  'category-outline': 'M4 4h7l9 9-7 7-9-9V4zM8 8h.01',
  'category-selected': 'M4 4h7l9 9-7 7-9-9V4zM8 8h.01M10 13l2 2 4-5',
  'template-copy': 'M8 8h11v12H8V8zM5 4h11v4M5 4v12h3',
  'template-save': 'M4 4h14l2 2v14H4V4zM8 4v6h8V4M8 16h8',
  'calculator-check': 'M5 3h14v18H5V3zM8 7h8M8 12h.01M12 12h.01M8 16l2 2 5-6',
  'calculator-off': 'M3 3l18 18M5 3h14v14M5 7v14h14M8 7h8M8 12h.01M12 16h.01',
  loan: 'M3 10l9-7 9 7M5 9v11h14V9M9 20v-6h6v6',
  'payment-arrow': 'M4 7h12M12 3l4 4-4 4M20 17H8M12 13l-4 4 4 4',
  'photo-plus': 'M4 5h4l2-2h4l2 2h4v15H4V5zM8 13a4 4 0 1 0 8 0 4 4 0 0 0-8 0M18 8v4M16 10h4',
  'image-check': 'M4 5h16v14H4V5zM4 16l5-5 4 4 2-2 5 5M15 8h.01M8 17l2 2 5-6',
  'expand-arrows': 'M8 3H3v5M3 3l6 6M16 3h5v5M21 3l-6 6M8 21H3v-5M3 21l6-6M16 21h5v-5M21 21l-6-6',
  heart: 'M12 20S4 15 4 9a4 4 0 0 1 7-2l1 1 1-1a4 4 0 0 1 7 2c0 6-8 11-8 11z',
  bookmark: 'M6 3h12v18l-6-4-6 4V3z',
  image: 'M4 5h16v14H4V5zM4 16l5-5 4 4 2-2 5 5M15 8h.01',
  'image-off': 'M3 3l18 18M4 5h2M11 5h9v14h-2M4 9v10h10M5 16l4-4 2 2',
  'image-plus': 'M4 5h16v14H4V5zM4 16l5-5 4 4 2-2 5 5M15 8h.01M8 7v4M6 9h4',
  'receipt-check': 'M5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16l-3-2-2 2-2-2-2 2-2-2-3 2M8 12l2 2 5-6',
  'save-item': 'M4 5h16v14H4V5zM8 9h8M8 13h8M8 17h5M16 2v6M13 5h6',
  'wallet-payment': 'M4 7h15v12H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h11M15 12h6v4h-6a2 2 0 0 1 0-4zM7 13h5M10 10l2 3-2 3',
  'void-circle': 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM6 6l12 12',
  swatch: 'M4 4h16v16H4V4zM4 12h16M12 4v16',
  'swatch-check': 'M4 4h16v16H4V4zM4 12h16M12 4v16M7 16l2 2 4-5',
  crown: 'M4 7l4 4 4-7 4 7 4-4-2 12H6L4 7zM7 16h10',
  'user-check': 'M9 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM2 21a7 7 0 0 1 14 0M15 13l2 2 4-5',
  'user-off': 'M3 3l18 18M9 4a4 4 0 0 1 4 6M6.5 12A4 4 0 0 1 9 4M2 21a7 7 0 0 1 11-5.7M16 17a7 7 0 0 1 2 4',
  'mail-clock': 'M3 6h14v12H3V6zM3 7l7 6 7-6M20 10v4l2 1M20 8a5 5 0 1 0 0 10 5 5 0 0 0 0-10z',
  'mail-plus': 'M3 6h14v12H3V6zM3 7l7 6 7-6M20 10v6M17 13h6',
  'mail-check': 'M3 6h14v12H3V6zM3 7l7 6 7-6M17 14l2 2 4-5',
  'file-check': 'M6 3h8l4 4v14H6V3zM14 3v5h5M9 14l2 2 4-5',
  'upload-file': 'M6 3h8l4 4v14H6V3zM14 3v5h5M12 18V9M9 12l3-3 3 3',
  'shield-check': 'M12 3l8 3v6c0 5-3.5 8-8 10-4.5-2-8-5-8-10V6l8-3zM8 12l3 3 5-6',
  ...LUCIDE_ICON_ENDPOINTS
};

export const STATE_ICON_ENDPOINTS = Object.freeze({ ...endpointPaths });

const families = {
  action: { idle: 'plus', pending: 'progress-ring', success: 'check', error: 'error-circle' },
  sync: { idle: 'cloud', loading: 'cloud-sync', cached: 'cloud-clock', pending: 'cloud-clock', synced: 'cloud-check', offline: 'cloud-off', recovering: 'refresh-cloud', error: 'alert-circle', update: 'download-ready' },
  completion: { incomplete: 'circle', complete: 'check-circle', error: 'error-circle' },
  disclosure: { down: 'chevron-down', up: 'chevron-up', left: 'chevron-left', right: 'chevron-right', close: 'close' },
  menu: { closed: 'menu-ellipsis', open: 'close' },
  feedback: { neutral: 'info-circle', pending: 'progress-ring', success: 'check-circle', warning: 'alert-triangle', error: 'error-circle' },
  authentication: { idle: 'google-account', pending: 'progress-ring', success: 'wallet-check', error: 'error-circle' },
  invitation: { idle: 'invite-mail', pending: 'progress-ring', accepted: 'household-check', queued: 'mail-clock', add: 'mail-plus', sent: 'mail-check', error: 'error-circle' },
  onboarding: { incomplete: 'circle', complete: 'check-circle', wallet: 'wallet-plus', entry: 'receipt-plus', member: 'user-plus' },
  'nav-home': { idle: 'home', active: 'home-active' },
  'nav-accounts': { idle: 'wallet', active: 'wallet-active' },
  'nav-entries': { idle: 'receipt', active: 'receipt-active' },
  'nav-items': { idle: 'item', active: 'item-active' },
  workspace: { idle: 'chevron-down', switching: 'progress-ring', rollback: 'alert-circle' },
  reconciliation: { checking: 'refresh-checking', balanced: 'check-circle', mismatch: 'alert-circle' },
  'category-overview': { empty: 'empty-chart', ready: 'category-chart' },
  credit: { idle: 'credit-card', resolved: 'check-circle', payment: 'payment-arrow' },
  loan: { idle: 'loan', scheduled: 'loan-calendar', resolved: 'check-circle', payment: 'payment-arrow' },
  package: { pending: 'package-clock', complete: 'package-check' },
  month: { idle: 'calendar', selected: 'calendar-check' },
  filter: { idle: 'filter', active: 'filter-check', clear: 'x-circle' },
  entry: { add: 'receipt-plus', edit: 'pencil', pending: 'progress-ring', success: 'check-circle', error: 'error-circle', archive: 'archive-box', recycled: 'recycle-bin' },
  category: { idle: 'category-outline', selected: 'category-selected', complete: 'check' },
  template: { copy: 'template-copy', save: 'template-save', complete: 'check' },
  calculator: { included: 'calculator-check', excluded: 'calculator-off' },
  account: { idle: 'wallet', edit: 'pencil', loan: 'loan', credit: 'credit-card', payment: 'payment-arrow' },
  photo: { add: 'photo-plus', ready: 'image-check', error: 'error-circle' },
  repayment: { idle: 'payment-arrow', full: 'expand-arrows', pending: 'progress-ring', success: 'check-circle', review: 'eye', recycle: 'archive-box' },
  'item-filter': { active: 'heart', saved: 'bookmark', archive: 'archive-box' },
  'item-cover': { idle: 'image', add: 'image-plus', ready: 'image-check', error: 'image-off', pending: 'progress-ring' },
  'item-save': { idle: 'save-item', pending: 'progress-ring', success: 'check-circle' },
  'item-lifecycle': { idle: 'bookmark', complete: 'check-circle', archive: 'archive-box', restore: 'restore', deleting: 'progress-ring', trash: 'trash' },
  'item-payment': { idle: 'wallet-payment', pending: 'progress-ring', success: 'receipt-check' },
  receipt: { idle: 'receipt', pending: 'progress-ring', view: 'eye', download: 'download', success: 'receipt-check', error: 'error-circle', retry: 'refresh' },
  correction: { active: 'receipt', void: 'void-circle', restore: 'restore-arrow' },
  recycle: { idle: 'recycle-bin', restore: 'restore-arrow', restored: 'check-circle', pending: 'progress-ring', trash: 'trash' },
  theme: { idle: 'swatch', selected: 'swatch-check' },
  member: { owner: 'crown', active: 'user-check', disabled: 'user-off', pending: 'mail-clock', invite: 'mail-plus', invited: 'mail-check', refresh: 'refresh', loading: 'progress-ring' },
  file: { download: 'download', pending: 'progress-ring', ready: 'file-check', upload: 'upload-file', verified: 'shield-check', restore: 'restore', error: 'error-circle' },
  validation: { neutral: 'neutral', valid: 'check', invalid: 'error-circle' },
  settings: { idle: 'settings' },
  'category-salary': { idle: 'category-salary', selected: 'category-selected' },
  'category-shopping': { idle: 'category-shopping', selected: 'category-selected' },
  'category-medical': { idle: 'category-medical', selected: 'category-selected' },
  'category-mortgage': { idle: 'category-mortgage', selected: 'category-selected' },
  'category-electric': { idle: 'category-electric', selected: 'category-selected' },
  'category-tax': { idle: 'category-tax', selected: 'category-selected' },
  'category-fuel': { idle: 'category-fuel', selected: 'category-selected' },
  'category-car': { idle: 'category-car', selected: 'category-selected' },
  'category-other': { idle: 'category-other', selected: 'category-selected' }
};

export const STATE_ICON_REGISTRY = Object.freeze(Object.fromEntries(
  Object.entries(families).map(([name, states]) => [name, Object.freeze({ ...states })])
));
export const STATE_ICON_ENDPOINT_NAMES = Object.freeze(Object.keys(STATE_ICON_ENDPOINTS));
export const STATE_ICON_FAMILY_NAMES = Object.freeze(Object.keys(STATE_ICON_REGISTRY));

function hasOwn(record, key) {
  return typeof key === 'string' && Object.hasOwn(record, key);
}

export function resolveIconEndpoint(endpointName) {
  const valid = hasOwn(STATE_ICON_ENDPOINTS, endpointName);
  const endpoint = valid ? endpointName : SAFE_ENDPOINT;
  return Object.freeze({ endpoint, d: STATE_ICON_ENDPOINTS[endpoint], valid });
}

export function resolveStateIcon(familyName, stateName) {
  const familyValid = hasOwn(STATE_ICON_REGISTRY, familyName);
  const family = familyValid ? STATE_ICON_REGISTRY[familyName] : null;
  const stateValid = family !== null && hasOwn(family, stateName);
  if (!stateValid) {
    return Object.freeze({ family: 'fallback', state: 'default', endpoint: SAFE_ENDPOINT, d: STATE_ICON_ENDPOINTS[SAFE_ENDPOINT], valid: false });
  }
  const endpoint = family[stateName];
  return Object.freeze({ family: familyName, state: stateName, endpoint, d: STATE_ICON_ENDPOINTS[endpoint], valid: true });
}

export function staticIconMarkup(endpointName) {
  const icon = resolveIconEndpoint(endpointName);
  return `<svg class="app-icon" data-static-icon="${icon.endpoint}" viewBox="${APP_ICON_VIEW_BOX}" aria-hidden="true" focusable="false"><path data-state-icon-path d="${icon.d}"/></svg>`;
}

export function stateIconMarkup(familyName, stateName, options = {}) {
  const icon = resolveStateIcon(familyName, stateName);
  const from = resolveStateIcon(icon.family, options?.fromState);
  const fromMarker = from.valid && from.state !== icon.state ? ` data-icon-from="${from.state}"` : '';
  return `<svg class="app-icon" data-state-icon="${icon.family}" data-icon-state="${icon.state}"${fromMarker} viewBox="${APP_ICON_VIEW_BOX}" aria-hidden="true" focusable="false"><path data-state-icon-path d="${icon.d}"/></svg>`;
}

export const STATE_ICON_VIEW_BOX = APP_ICON_VIEW_BOX;
