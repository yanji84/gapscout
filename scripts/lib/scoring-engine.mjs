/**
 * scoring-engine.mjs — PainScorer class wrapping the scoring pipeline
 *
 * This is the new OO interface for the scoring system. It uses a signal
 * profile under the hood and exposes the same computePainScore/analyzeComments/
 * enrichPost methods.
 *
 * The original scoring.mjs continues to export the same functions for
 * backwards compatibility, using the 'default' profile internally.
 */

import { SignalMatcher } from './signals/matcher.mjs';
import { isNegated, sentimentMultiplier, isWtpFirstPerson, isWtpContextual } from './signals/context.mjs';
import { getSignalProfile } from './signals/index.mjs';
import { excerpt } from './utils.mjs';
import { blendLLMScores } from './llm.mjs';

// These sets need to match the original scoring.mjs exactly for backwards compat
const WTP_STRONG = new Set([
  "i'd pay", 'happy to pay', 'shut up and take my money',
  'take my money', 'worth paying', 'gladly pay',
]);
const WTP_FIRST_PERSON = new Set(['would pay', 'budget for']);
const WTP_GENERIC = new Set([
  'bought', 'purchased', 'paid for', 'paying for', 'subscribed',
  'subscription', 'per month', 'per year',
]);

export class PainScorer {
  /**
   * @param {string} [profileName='default']
   */
  constructor(profileName = 'default') {
    this.matcher = new SignalMatcher(profileName);
    this.profileName = profileName;
    this.signals = getSignalProfile(profileName);
  }

  /**
   * Compute pain score for a post.
   * Identical logic to scoring.mjs computePainScore.
   */
  computePainScore(post) {
    const { computePainScore } = require_scoring();
    return computePainScore(post);
  }

  /**
   * Analyze comments for a post.
   * Identical logic to scoring.mjs analyzeComments.
   */
  analyzeComments(comments, postPainCategories = [], postUrl = '') {
    const { analyzeComments } = require_scoring();
    return analyzeComments(comments, postPainCategories, postUrl);
  }

  /**
   * Enrich a post with pain scoring fields.
   * Identical logic to scoring.mjs enrichPost.
   */
  enrichPost(post, domain = '', domainKeywords = []) {
    const { enrichPost } = require_scoring();
    return enrichPost(post, domain, domainKeywords);
  }
}

// Lazy import to avoid circular dependency
let _scoring = null;
function require_scoring() {
  if (!_scoring) {
    // Dynamic import would be async, so we use a sync pattern
    // The scoring.mjs module is already loaded by the time PainScorer methods are called
    throw new Error('PainScorer methods delegate to scoring.mjs. Import scoring.mjs directly for sync usage.');
  }
  return _scoring;
}

/**
 * Register the scoring module functions for delegation.
 * Called from scoring.mjs to avoid circular dependency.
 */
export function registerScoringFunctions(fns) {
  _scoring = fns;
}
