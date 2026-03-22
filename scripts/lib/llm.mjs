/**
 * llm.mjs — LLM-based pain signal augmentation (Claude Code agent mode)
 *
 * Instead of calling the Anthropic API directly, this module provides:
 *   - buildAnalysisPrompt(): generates a structured prompt for Claude Code to analyze
 *   - parseAnalysisResponse(): parses Claude Code's JSON response into the expected format
 *   - blendLLMScores(): merges LLM analysis into existing pain scores
 *
 * The actual LLM analysis is performed by the Claude Code agent (the synthesizer
 * teammate) reading posts and applying its own intelligence — no SDK or API key needed.
 *
 * How it works:
 *   1. The CLI `llm augment` command reads scan data and outputs a structured prompt
 *   2. The Claude Code agent reads the prompt, analyzes the posts, and produces JSON
 *   3. The CLI `llm apply` command takes the agent's JSON output and merges it into scan data
 */

import { log } from './utils.mjs';

// ─── prompt builder ──────────────────────────────────────────────────────────

/**
 * Build the analysis prompt for a batch of posts.
 * This prompt is meant to be read and answered by the Claude Code agent itself.
 *
 * @param {object[]} posts - Array of post objects
 * @param {string} domain - Domain context for analysis
 * @returns {string} Structured prompt for Claude Code agent
 */
export function buildAnalysisPrompt(posts, domain) {
  const postDescriptions = posts.map((p, i) => {
    const title = (p.title || '').slice(0, 200);
    const body = (p.selftext_excerpt || p.selftext || '').slice(0, 500);
    return `--- Post ${i + 1} (id: ${p.id}) ---
Title: ${title}
Body: ${body}
Source: ${p.subreddit || p.source || 'unknown'}
Score: ${p.score || 0} | Comments: ${p.num_comments || 0}`;
  }).join('\n\n');

  return `Analyze these ${posts.length} user posts from the "${domain}" domain.

For each post, detect signals that simple keyword matching misses:

1. **Implicit pain signals**: sarcasm ("love how it crashes every time"), learned helplessness ("I've gotten used to the bugs"), switching signals ("finally switched after 5 years"), lock-in indicators ("we have no choice but to use it")

2. **Pain depth**: classify as:
   - "surface" = venting/complaining but not actively seeking a fix
   - "active" = seeking solutions, comparing alternatives, asking for help
   - "urgent" = spending money/time to solve, deadline pressure, business impact

3. **Pain intensity** (0-10): how strongly the person feels the pain, factoring in emotional language, duration of suffering, and impact described

4. **WTP (willingness-to-pay) signals**: time investment mentions, opportunity cost references, switching cost indicators, premium tier mentions, "shut up and take my money" style signals. Score 0-10.

5. **Unspoken pain**: the real frustration underneath the surface complaint. What are they REALLY upset about?

6. **Target persona**: based on context clues, who specifically feels this pain? Be specific (e.g., "mid-size SaaS engineering managers" not just "developers")

7. **Sarcasm detection**: is the post using sarcasm or irony to express pain?

8. **Sentiment score**: -1.0 (very negative) to 1.0 (very positive)

Posts to analyze:

${postDescriptions}

Respond with ONLY valid JSON in this exact format (no markdown, no explanation):
{
  "posts": [
    {
      "id": "post_id_here",
      "painDepth": "surface|active|urgent",
      "painIntensity": 0,
      "implicitPain": [],
      "wtpSignals": [],
      "wtpScore": 0,
      "unspokenPain": "",
      "targetPersona": "",
      "sarcasmDetected": false,
      "sentimentScore": 0.0
    }
  ]
}

Rules:
- implicitPain values should be descriptive strings like "learned helplessness", "switching signal", "lock-in indicator", "sarcastic frustration", "resignation", "exhaustion"
- wtpSignals values should be descriptive like "time investment", "premium mention", "switching cost", "opportunity cost mention", "budget allocation"
- unspokenPain should be one sentence capturing the deeper frustration
- targetPersona should be specific and descriptive
- Return one entry per post, in the same order as the input
- If a post has no pain signals at all, set painIntensity to 0 and painDepth to "surface"`;
}

// ─── response parser ─────────────────────────────────────────────────────────

/**
 * Parse the Claude Code agent's JSON response into the expected format.
 *
 * @param {string} responseText - Raw JSON string from Claude Code agent
 * @returns {object} Parsed { posts: [...] } object
 */
export function parseAnalysisResponse(responseText) {
  let jsonStr = responseText.trim();

  // Handle possible markdown wrapping
  if (jsonStr.startsWith('```')) {
    jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }

  const parsed = JSON.parse(jsonStr);

  // Validate structure
  if (!parsed.posts || !Array.isArray(parsed.posts)) {
    throw new Error('Invalid response: expected { posts: [...] }');
  }

  return parsed;
}

// ─── augmentation merger ─────────────────────────────────────────────────────

/**
 * Merge LLM analysis results into posts.
 *
 * @param {object[]} posts - Original post objects
 * @param {object} analysisResult - Parsed { posts: [...] } from Claude Code agent
 * @returns {object[]} Posts with llmAugmentation field added
 */
export function mergeAugmentation(posts, analysisResult) {
  const augmentedIds = new Map();

  for (const augPost of analysisResult.posts || []) {
    augmentedIds.set(augPost.id, augPost);
  }

  const result = posts.map(post => {
    const aug = augmentedIds.get(post.id);
    if (!aug) return post;

    return {
      ...post,
      llmAugmentation: {
        painDepth: aug.painDepth,
        painIntensity: aug.painIntensity,
        implicitPain: aug.implicitPain || [],
        wtpSignals: aug.wtpSignals || [],
        wtpScore: aug.wtpScore,
        unspokenPain: aug.unspokenPain || '',
        targetPersona: aug.targetPersona || '',
        sarcasmDetected: aug.sarcasmDetected || false,
        sentimentScore: aug.sentimentScore || 0,
      },
    };
  });

  const augmentedCount = [...augmentedIds.keys()].length;
  log(`[llm] Merged augmentation for ${augmentedCount}/${posts.length} posts`);

  return result;
}

// ─── score blending ──────────────────────────────────────────────────────────

/**
 * Blend LLM augmentation into a post's painScore.
 *
 * When LLM data is present:
 *   finalPainScore = (regexScore * 0.4) + (llmIntensity * 0.6)
 *   (llmIntensity is normalized from 0-10 to the same scale as regexScore)
 *
 * Also merges implicit pain signals and WTP signals.
 *
 * @param {object} post - Post with optional llmAugmentation field
 * @returns {object} Post with blended scores
 */
export function blendLLMScores(post) {
  if (!post.llmAugmentation) return post;

  const llm = post.llmAugmentation;
  const regexScore = post.painScore || 0;

  // Normalize llmIntensity (0-10) to roughly the same scale as regexScore
  // Typical regexScore range is roughly -5 to 20, with most pain posts 3-15
  const llmScoreNormalized = llm.painIntensity * 1.5; // maps 0-10 to 0-15

  // Blend: 40% regex + 60% LLM
  const blendedScore = Math.round(((regexScore * 0.4) + (llmScoreNormalized * 0.6)) * 10) / 10;

  // Merge implicit pain signals into the existing signal list
  const mergedPainSignals = [
    ...(post.painSignals || []),
    ...(llm.implicitPain || []).map(s => `[llm] ${s}`),
  ];

  // Merge WTP signals
  const mergedWtpSignals = [
    ...(post.wtpSignals || []),
    ...(llm.wtpSignals || []).map(s => `[llm] ${s}`),
  ];

  return {
    ...post,
    painScore: blendedScore,
    _regexPainScore: regexScore,
    painSignals: mergedPainSignals,
    wtpSignals: mergedWtpSignals,
  };
}
