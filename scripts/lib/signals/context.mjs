/**
 * signals/context.mjs — Context analysis for signal matching
 *
 * Extracted from scoring.mjs for modularity.
 */

// ─── sentiment context ──────────────────────────────────────────────────────

const POSITIVE_CONTEXT = [
  'happy', 'glad', 'love', 'great', 'best', 'worth it', 'no issues',
  'no problems', 'amazing', 'perfect', 'excellent', 'fantastic',
  'recommend', 'impressed', 'enjoy', 'smooth', 'solid',
];
const NEGATIVE_CONTEXT = [
  'hate', 'regret', 'waste', 'terrible', 'awful', 'not worth',
  'unfortunately', 'disappointed', 'annoying', 'broken', 'sucks',
  'horrible', 'useless', 'worse', 'painful', 'unacceptable',
];

export function sentimentMultiplier(text, keywordIndex, windowSize = 80) {
  if (!text) return 1.0;
  const start = Math.max(0, keywordIndex - windowSize);
  const end = Math.min(text.length, keywordIndex + windowSize);
  const window = text.slice(start, end).toLowerCase();
  const posHits = POSITIVE_CONTEXT.filter(w => window.includes(w)).length;
  const negHits = NEGATIVE_CONTEXT.filter(w => window.includes(w)).length;
  if (posHits > negHits) return 0.2;
  if (negHits > posHits) return 1.5;
  return 1.0;
}

// ─── negation detection ─────────────────────────────────────────────────────

const NEGATION_WORDS = ['not', 'no', "n't", 'never', 'neither', 'nor', 'without', 'barely'];

export function isNegated(text, keywordIndex) {
  if (!text || keywordIndex < 3) return false;
  const before = text.slice(Math.max(0, keywordIndex - 20), keywordIndex).toLowerCase();
  return NEGATION_WORDS.some(neg => before.includes(neg));
}

// ─── WTP first-person check ─────────────────────────────────────────────────

const FIRST_PERSON_WORDS = ["i'd", "i would", "i'll", "i am", "i'm", 'i need', 'i want', 'i have', 'we need', 'we want', 'we have', "we'd", 'our budget', 'my budget'];

export function isWtpFirstPerson(text, kwIndex) {
  if (!text) return false;
  const start = Math.max(0, kwIndex - 60);
  const window = text.slice(start, kwIndex + 20).toLowerCase();
  return FIRST_PERSON_WORDS.some(w => window.includes(w));
}

// ─── WTP context check ─────────────────────────────────────────────────────

export function isWtpContextual(text, kwIndex) {
  if (!text) return false;
  const start = Math.max(0, kwIndex - 100);
  const end = Math.min(text.length, kwIndex + 100);
  const window = text.slice(start, end).toLowerCase();
  const contextWords = [
    'frustrated', 'annoying', 'terrible', 'broken', 'hate', 'awful',
    'alternative', 'switched', 'workaround', 'fix', 'solution',
    'wasted', 'waste of', 'not worth', 'overpriced', 'ripoff',
  ];
  return contextWords.some(w => window.includes(w));
}
