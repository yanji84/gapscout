/**
 * signals/index.mjs — Signal definitions with named profiles
 *
 * The `default` profile contains the same signals as the original scoring.mjs.
 * Additional profiles (b2b_saas, consumer_marketplace, developer_tools) extend
 * or tune the default signals for specific verticals.
 */

// ─── base pain signals (default profile) ────────────────────────────────────

const DEFAULT_PAIN_SIGNALS = {
  frustration: [
    'frustrated', 'frustrating', 'annoying', 'annoyed',
    'fed up', 'sick of', 'tired of', 'giving up', 'nightmare',
    'terrible', 'awful', 'broken', 'buggy', 'unusable',
    'horrible', 'worst', 'garbage', 'trash', 'joke',
    'hate', 'ruining', 'killing', 'destroying',
    'not working', 'keeps breaking', 'keeps crashing',
  ],
  desire: [
    'wish there was', 'looking for', 'alternative to',
    'switched from', 'better than', 'anything else',
    'does anyone know', 'recommendations for',
    'is there a', 'need something',
    'alternatives to', 'replace this', 'replacement for',
    'substitute for', 'switch from', 'switching from',
    'move away from',
  ],
  cost: [
    'too expensive', 'price hike', 'overpriced', 'not worth',
    'hidden fees', 'ripoff', 'rip off', 'gouging',
    'cost went up', 'raised prices',
  ],
  agreement: [
    'same here', 'me too', 'can confirm', 'exactly this',
    'this is why', 'i had the same', 'happened to me',
    'i agree', 'so true', "couldn't agree more",
    'yep same', 'deal breaker for me too',
  ],
  solution: [
    'i switched to', 'i ended up using', 'the workaround is',
    'i built my own', 'i just use', 'try using',
    'we moved to', 'what worked for me', 'i found that',
    'we use', 'i use', 'we went with', 'i went with',
    'check out', 'look into', 'have you tried',
  ],
  willingness_to_pay: [
    'paid for', 'paying for', 'bought', 'purchased', 'subscribed',
    'subscription', 'hired', 'consultant', 'freelancer',
    'wasted hours', 'wasted days', 'wasted weeks', 'spent hours',
    'spent days', 'worth paying', 'shut up and take my money',
    'take my money', 'would pay', "i'd pay", 'happy to pay',
    'gladly pay', 'budget for', 'invested in', 'cost me',
    'money on', 'dollars on', 'per month', 'per year',
    'annual plan', 'monthly plan', 'enterprise plan', 'pro plan',
  ],
  intensity: [
    'literally', 'absolutely', 'completely', 'utterly',
    'beyond frustrated', 'pulling my hair', 'losing my mind',
    'want to scream', 'at my wits end', "can't take it",
    'last straw', 'final straw', 'deal breaker', 'dealbreaker',
    'unacceptable', 'inexcusable', 'ridiculous', 'insane',
    'blows my mind', 'how is this', 'why is this so',
    'every single time', 'constantly', 'always breaks',
    'never works', 'still broken', 'years and still',
  ],
};

// ─── profile-specific overrides ─────────────────────────────────────────────

const B2B_SAAS_EXTENSIONS = {
  frustration: [
    'downtime', 'outage', 'vendor lock-in', 'no api', 'poor documentation',
    'breaking change', 'deprecated', 'migration nightmare',
  ],
  desire: [
    'self-hosted', 'open source alternative', 'better integration',
    'api access', 'better support', 'enterprise features',
  ],
  willingness_to_pay: [
    'enterprise contract', 'annual contract', 'seat license',
    'per-user pricing', 'volume discount', 'procurement',
  ],
};

const CONSUMER_MARKETPLACE_EXTENSIONS = {
  frustration: [
    'scam seller', 'fake listing', 'no refund', 'terrible support',
    'shipping damage', 'never arrived', 'wrong item',
  ],
  desire: [
    'buyer protection', 'verified sellers', 'fair pricing',
    'transparent fees', 'better returns',
  ],
  willingness_to_pay: [
    'premium membership', 'buyer fee', 'seller fee',
    'insurance', 'expedited shipping',
  ],
};

const DEVELOPER_TOOLS_EXTENSIONS = {
  frustration: [
    'poor dx', 'bad documentation', 'no types', 'type errors',
    'slow build', 'bloated', 'memory leak', 'dependency hell',
  ],
  desire: [
    'better cli', 'better tooling', 'type safety',
    'faster builds', 'hot reload', 'better debugging',
  ],
  willingness_to_pay: [
    'pro license', 'team license', 'cloud hosting',
    'managed service', 'support plan',
  ],
};

// ─── profile factory ────────────────────────────────────────────────────────

function mergeSignals(base, extensions) {
  const merged = {};
  for (const key of Object.keys(base)) {
    merged[key] = [...base[key]];
    if (extensions[key]) {
      merged[key] = [...merged[key], ...extensions[key]];
    }
  }
  return merged;
}

const PROFILES = {
  default: DEFAULT_PAIN_SIGNALS,
  b2b_saas: mergeSignals(DEFAULT_PAIN_SIGNALS, B2B_SAAS_EXTENSIONS),
  consumer_marketplace: mergeSignals(DEFAULT_PAIN_SIGNALS, CONSUMER_MARKETPLACE_EXTENSIONS),
  developer_tools: mergeSignals(DEFAULT_PAIN_SIGNALS, DEVELOPER_TOOLS_EXTENSIONS),
};

/**
 * Get signal definitions for a named profile.
 * Falls back to 'default' for unknown profiles.
 *
 * @param {string} [profileName='default']
 * @returns {object} Signal definitions keyed by category
 */
export function getSignalProfile(profileName = 'default') {
  return PROFILES[profileName] || PROFILES.default;
}

/**
 * List all available profile names.
 * @returns {string[]}
 */
export function listProfiles() {
  return Object.keys(PROFILES);
}

// Re-export the default signals for backwards compatibility
export { DEFAULT_PAIN_SIGNALS as PAIN_SIGNALS };
