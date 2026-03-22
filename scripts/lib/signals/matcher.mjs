/**
 * signals/matcher.mjs — Signal matching engine
 *
 * Extracted from scoring.mjs. The SignalMatcher class wraps the matching
 * logic and can be configured with different signal profiles.
 */

import { isNegated, sentimentMultiplier } from './context.mjs';
import { getSignalProfile } from './index.mjs';

export class SignalMatcher {
  /**
   * @param {string} [profileName='default'] - Signal profile name
   */
  constructor(profileName = 'default') {
    this.signals = getSignalProfile(profileName);
    this.profileName = profileName;
  }

  /**
   * Match signals in text for a given category.
   * @param {string} text
   * @param {string} category - Signal category key
   * @returns {string[]} Matched keywords
   */
  match(text, category) {
    if (!text || !this.signals[category]) return [];
    const lower = text.toLowerCase();
    return this.signals[category].filter(kw => lower.includes(kw));
  }

  /**
   * Match signals with negation filtering.
   */
  matchFiltered(text, category) {
    if (!text || !this.signals[category]) return [];
    const lower = text.toLowerCase();
    return this.signals[category].filter(kw => {
      const idx = lower.indexOf(kw);
      return idx >= 0 && !isNegated(lower, idx);
    });
  }

  /**
   * Match signals with sentiment weighting.
   */
  matchWeighted(text, category) {
    if (!text || !this.signals[category]) return { keywords: [], weight: 0 };
    const lower = text.toLowerCase();
    let totalWeight = 0;
    const keywords = [];
    for (const kw of this.signals[category]) {
      const idx = lower.indexOf(kw);
      if (idx >= 0) {
        if (isNegated(lower, idx)) continue;
        const mult = sentimentMultiplier(lower, idx);
        totalWeight += mult;
        keywords.push(kw);
      }
    }
    return { keywords, weight: totalWeight };
  }
}
