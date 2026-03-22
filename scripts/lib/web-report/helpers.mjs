/**
 * web-report/helpers.mjs — Shared HTML helpers
 */

export function escHtml(s) {
  if (!s) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function stripHtml(s) {
  if (!s) return '';
  return String(s).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

export function truncate(s, n = 200) {
  const clean = stripHtml(s);
  if (clean.length <= n) return clean;
  return clean.slice(0, n).replace(/\s\S*$/, '') + '\u2026';
}

export const DEPTH_COLOR = {
  urgent:  { css: 'var(--color-urgent)',  label: 'Urgent',  hex: '#ef4444' },
  active:  { css: 'var(--color-active)',  label: 'Active',  hex: '#f59e0b' },
  surface: { css: 'var(--color-surface)', label: 'Surface', hex: '#3b82f6' },
};

export const VERDICT_META = {
  validated:      { label: 'VALIDATED',       cls: 'badge-green'  },
  needs_evidence: { label: 'NEEDS EVIDENCE',  cls: 'badge-amber'  },
  too_weak:       { label: 'TOO WEAK',        cls: 'badge-red'    },
};

export const MATRIX_LABELS = {
  primary:    { label: 'Primary Target',    quadrant: 'top-right',    cls: 'q-primary'    },
  hidden_gem: { label: 'Hidden Gem',        quadrant: 'bottom-right', cls: 'q-hidden'     },
  background: { label: 'Background Noise',  quadrant: 'top-left',     cls: 'q-background' },
  ignore:     { label: 'Ignore',            quadrant: 'bottom-left',  cls: 'q-ignore'     },
};

export const SOURCE_ICONS = {
  reddit:     'R',
  hackernews: 'Y',
  google:     'G',
  appstore:   'A',
  twitter:    'T',
  producthunt:'P',
  crowdfunding:'K',
  trustpilot: 'TP',
  reviews:    'RV',
  unknown:    '?',
};
