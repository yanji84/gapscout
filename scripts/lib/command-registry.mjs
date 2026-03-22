/**
 * command-registry.mjs — Single source of truth for source name aliases
 *
 * Previously duplicated in cli.mjs, coordinator.mjs, and monitor.mjs.
 * Import SOURCE_ALIASES and resolveSourceName from this module instead.
 */

/**
 * Maps user-facing alias names to canonical source module basenames.
 * e.g. 'api' -> 'reddit-api', 'hn' -> 'hackernews'
 */
export const SOURCE_ALIASES = {
  // Short aliases
  api: 'reddit-api',
  browser: 'reddit-browser',
  google: 'google-autocomplete',
  hn: 'hackernews',
  ph: 'producthunt',
  kickstarter: 'crowdfunding',
  x: 'twitter',
  ws: 'websearch',
  'web-search': 'websearch',
  all: 'coordinator',

  // New source aliases
  so: 'stackoverflow',
  'gh-issues': 'github-issues',

  // Identity mappings (canonical name -> canonical name)
  hackernews: 'hackernews',
  reviews: 'reviews',
  producthunt: 'producthunt',
  crowdfunding: 'crowdfunding',
  appstore: 'appstore',
  twitter: 'twitter',
  trustpilot: 'trustpilot',
  websearch: 'websearch',
  stackoverflow: 'stackoverflow',
  'github-issues': 'github-issues',
  coordinator: 'coordinator',
  'reddit-api': 'reddit-api',
  'reddit-browser': 'reddit-browser',
  'google-autocomplete': 'google-autocomplete',
};

/**
 * Resolve a possibly-aliased source name to its canonical module basename.
 * Returns the input unchanged if no alias is found.
 *
 * @param {string} name - User-provided source name or alias
 * @returns {string} Canonical source module basename
 */
export function resolveSourceName(name) {
  return SOURCE_ALIASES[name] || name;
}
