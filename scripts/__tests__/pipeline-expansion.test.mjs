/**
 * Tests for pipeline expansion features:
 * 1. Resume-from-existing-report mode
 * 2. Expanded source breadth
 * 3. Deeper scanning depth
 * 4. Deeper synthesis analysis (market sizing, causal chains, strategic narrative)
 * 5. More insightful report
 * 6. Delta summary for re-runs
 * 7. Per-post trust scoring and recency weighting
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const FIXTURES = resolve(import.meta.dirname, 'fixtures');
const AGENTS_DIR = resolve(import.meta.dirname, '..', '..', '.claude', 'agents');

function loadFixture(name) {
  return JSON.parse(readFileSync(resolve(FIXTURES, name), 'utf8'));
}

function loadAgent(name) {
  const path = resolve(AGENTS_DIR, `${name}.md`);
  assert.ok(existsSync(path), `Agent file ${name}.md should exist at ${path}`);
  return readFileSync(path, 'utf8');
}

function agentExists(name) {
  return existsSync(resolve(AGENTS_DIR, `${name}.md`));
}

// ═══════════════════════════════════════════════════════════════════════════════
// FEATURE 1: Resume from Existing Report
// ═══════════════════════════════════════════════════════════════════════════════

describe('Feature 1: Resume from Existing Report', () => {

  it('scan-resumption agent exists', () => {
    assert.ok(agentExists('scan-resumption'), 'scan-resumption.md should exist');
  });

  it('scan-resumption agent has required sections', () => {
    const content = loadAgent('scan-resumption');
    assert.ok(content.includes('previousScanDir') || content.includes('previous'), 'Should reference previous scan');
    assert.ok(content.includes('resumption-plan') || content.includes('resumptionPlan'), 'Should output resumption plan');
    assert.ok(content.includes('EXPAND') || content.includes('SKIP') || content.includes('DEEPEN'), 'Should define action types');
  });

  it('orchestrator supports resume mode', () => {
    const content = loadAgent('orchestrator');
    assert.ok(
      content.includes('resume') || content.includes('Resume') || content.includes('RESUME'),
      'Orchestrator should support resume mode'
    );
    assert.ok(
      content.includes('previousScan') || content.includes('previous scan') || content.includes('.prev'),
      'Orchestrator should reference previous scan data'
    );
  });

  it('orchestrator has resume mode in config schema', () => {
    const content = loadAgent('orchestrator');
    assert.ok(
      content.includes('resumeMode') || content.includes('resume_mode') || content.includes('resumption'),
      'Orchestrator config should include resume mode settings'
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// FEATURE 2: Expanded Source Breadth
// ═══════════════════════════════════════════════════════════════════════════════

describe('Feature 2: Expanded Source Breadth', () => {

  it('planner includes additional sources', () => {
    const content = loadAgent('planner');
    // Should mention at least some new sources
    const newSources = ['linkedin', 'youtube', 'stackoverflow', 'github-discussions', 'quora', 'medium', 'dev.to', 'indie'];
    const foundSources = newSources.filter(s => content.toLowerCase().includes(s.toLowerCase()));
    assert.ok(foundSources.length >= 3,
      `Planner should mention at least 3 new sources, found: ${foundSources.join(', ')}`);
  });

  it('websearch scanner supports expanded sources', () => {
    const content = loadAgent('scanner-websearch');
    assert.ok(
      content.includes('linkedin') || content.includes('LinkedIn') ||
      content.includes('youtube') || content.includes('YouTube'),
      'Websearch scanner should mention expanded sources'
    );
  });

  it('query generator has expanded categories', () => {
    const content = loadAgent('query-generator');
    assert.ok(
      content.includes('workflow') || content.includes('pricing') || content.includes('deep mode') || content.includes('Deep Mode'),
      'Query generator should have expanded query categories'
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// FEATURE 3: Deeper Scanning Depth
// ═══════════════════════════════════════════════════════════════════════════════

describe('Feature 3: Deeper Scanning', () => {

  it('planner defines deep mode parameters', () => {
    const content = loadAgent('planner');
    assert.ok(
      content.includes('deep') || content.includes('Deep'),
      'Planner should define deep mode'
    );
  });

  it('reddit scanner has deep mode', () => {
    const content = loadAgent('scanner-reddit');
    assert.ok(
      content.includes('deep') || content.includes('Deep') || content.includes('comment thread') || content.includes('second-pass'),
      'Reddit scanner should have deep mode parameters'
    );
  });

  it('HN scanner has deep mode', () => {
    const content = loadAgent('scanner-hn');
    assert.ok(
      content.includes('deep') || content.includes('Deep') || content.includes('comment depth'),
      'HN scanner should have deep mode'
    );
  });

  it('scan-orchestrator supports expanded broadening', () => {
    const content = loadAgent('scan-orchestrator');
    assert.ok(
      content.includes('deep') || content.includes('Deep') || content.includes('4') || content.includes('broadening'),
      'Scan orchestrator should support deep mode broadening'
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// FEATURE 4: Deeper Synthesis Analysis
// ═══════════════════════════════════════════════════════════════════════════════

describe('Feature 4: Deeper Synthesis Analysis', () => {

  it('market sizing agent exists', () => {
    assert.ok(agentExists('synthesis-market-sizing'), 'synthesis-market-sizing.md should exist');
  });

  it('market sizing agent has TAM/SAM/SOM', () => {
    const content = loadAgent('synthesis-market-sizing');
    assert.ok(content.includes('TAM'), 'Should include TAM');
    assert.ok(content.includes('SAM'), 'Should include SAM');
    assert.ok(content.includes('SOM'), 'Should include SOM');
    assert.ok(content.includes('pricing') || content.includes('Pricing'), 'Should include pricing strategy');
    assert.ok(content.includes('go-to-market') || content.includes('GTM') || content.includes('Go-to-Market'), 'Should include GTM');
  });

  it('causal chains agent exists', () => {
    assert.ok(agentExists('synthesis-causal-chains'), 'synthesis-causal-chains.md should exist');
  });

  it('causal chains agent traces root causes', () => {
    const content = loadAgent('synthesis-causal-chains');
    assert.ok(content.includes('root cause') || content.includes('Root Cause') || content.includes('causalChain'), 'Should trace root causes');
    assert.ok(content.includes('structural') || content.includes('Structural'), 'Should analyze structural forces');
    assert.ok(content.includes('second-order') || content.includes('Second-Order') || content.includes('secondOrder'), 'Should analyze second-order effects');
  });

  it('strategic narrative agent exists', () => {
    assert.ok(agentExists('synthesis-strategic-narrative'), 'synthesis-strategic-narrative.md should exist');
  });

  it('strategic narrative produces actionable recommendations', () => {
    const content = loadAgent('synthesis-strategic-narrative');
    assert.ok(content.includes('BUILD') || content.includes('build'), 'Should have BUILD recommendations');
    assert.ok(content.includes('WATCH') || content.includes('watch'), 'Should have WATCH recommendations');
    assert.ok(content.includes('AVOID') || content.includes('avoid'), 'Should have AVOID recommendations');
    assert.ok(content.includes('contrarian') || content.includes('Contrarian'), 'Should surface contrarian insights');
    assert.ok(content.includes('kill') || content.includes('Kill') || content.includes('experiment'), 'Should have kill-shot tests');
  });

  it('synthesizer-coordinator includes sprints 13-15', () => {
    const content = loadAgent('synthesizer-coordinator');
    assert.ok(
      content.includes('Sprint 13') || content.includes('market-sizing') || content.includes('Market Sizing'),
      'Should include Sprint 13 (market sizing)'
    );
    assert.ok(
      content.includes('Sprint 14') || content.includes('causal-chains') || content.includes('Causal Chain'),
      'Should include Sprint 14 (causal chains)'
    );
    assert.ok(
      content.includes('Sprint 15') || content.includes('strategic-narrative') || content.includes('Strategic Narrative'),
      'Should include Sprint 15 (strategic narrative)'
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// FEATURE 5: More Insightful Report
// ═══════════════════════════════════════════════════════════════════════════════

describe('Feature 5: More Insightful Report', () => {

  it('report JSON includes new synthesis sections', () => {
    const content = loadAgent('report-generator-json');
    assert.ok(content.includes('marketSizing') || content.includes('market-sizing') || content.includes('Market Sizing'),
      'Should include market sizing section');
    assert.ok(content.includes('causalChains') || content.includes('causal-chains') || content.includes('Causal Chain'),
      'Should include causal chains section');
    assert.ok(content.includes('strategicNarrative') || content.includes('strategic-narrative') || content.includes('Strategic Narrative'),
      'Should include strategic narrative section');
  });

  it('report HTML renders new insight sections', () => {
    const content = loadAgent('report-generator-html');
    assert.ok(
      content.includes('Market Sizing') || content.includes('TAM') || content.includes('market sizing'),
      'HTML should render market sizing'
    );
    assert.ok(
      content.includes('Strategic') || content.includes('strategic') || content.includes('BUILD'),
      'HTML should render strategic recommendations'
    );
  });

  it('report summary includes strategic verdict', () => {
    const content = loadAgent('report-summary');
    assert.ok(
      content.includes('strategicVerdict') || content.includes('strategic') || content.includes('BUILD') || content.includes('build'),
      'Summary should include strategic verdict'
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// FEATURE 6: Delta Summary
// ═══════════════════════════════════════════════════════════════════════════════

describe('Feature 6: Delta Summary', () => {

  it('delta-summarizer agent exists', () => {
    assert.ok(agentExists('delta-summarizer'), 'delta-summarizer.md should exist');
  });

  it('delta-summarizer compares old vs new', () => {
    const content = loadAgent('delta-summarizer');
    assert.ok(content.includes('.prev') || content.includes('previous') || content.includes('Previous'),
      'Should reference previous data');
    assert.ok(content.includes('delta') || content.includes('Delta'),
      'Should produce delta output');
    assert.ok(content.includes('narrativeSummary') || content.includes('narrative'),
      'Should produce narrative summary');
  });

  it('delta summary fixture validates schema', () => {
    const delta = loadFixture('sample-delta-summary.json');

    assert.ok(delta.narrativeSummary, 'Should have narrative summary');
    assert.ok(delta.competitorDelta, 'Should have competitor delta');
    assert.ok(Array.isArray(delta.competitorDelta.added), 'Should list added competitors');
    assert.ok(Array.isArray(delta.opportunityDelta), 'Should list opportunity changes');
    assert.ok(delta.stats, 'Should have stats');
    assert.ok(typeof delta.stats.totalNewEvidence === 'number', 'Should count new evidence');
  });

  it('delta opportunity entries have required fields', () => {
    const delta = loadFixture('sample-delta-summary.json');
    for (const opp of delta.opportunityDelta) {
      assert.ok(opp.gap, 'Should have gap name');
      assert.ok(typeof opp.previousScore === 'number', 'Should have previous score');
      assert.ok(typeof opp.newScore === 'number', 'Should have new score');
      assert.ok(opp.scoreChange, 'Should have score change');
      assert.ok(opp.summary, 'Should have change summary');
    }
  });

  it('orchestrator spawns delta-summarizer in resume mode', () => {
    const content = loadAgent('orchestrator');
    assert.ok(
      content.includes('delta-summarizer') || content.includes('delta_summarizer') || content.includes('deltaSummarizer'),
      'Orchestrator should spawn delta-summarizer'
    );
  });

  it('report generators include delta section', () => {
    const jsonAgent = loadAgent('report-generator-json');
    const htmlAgent = loadAgent('report-generator-html');
    assert.ok(
      jsonAgent.includes('delta') || jsonAgent.includes('Delta'),
      'JSON report should include delta section'
    );
    assert.ok(
      htmlAgent.includes('delta') || htmlAgent.includes('Delta') || htmlAgent.includes('What Changed'),
      'HTML report should include delta section'
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// FEATURE 7: Per-Post Trust Scoring and Recency Weighting
// ═══════════════════════════════════════════════════════════════════════════════

describe('Feature 7: Post Trust & Recency Weighting', () => {

  it('signal strength agent has per-post trust scoring', () => {
    const content = loadAgent('synthesis-signal-strength');
    assert.ok(
      content.includes('postTrustScore') || content.includes('post trust') || content.includes('Per-Post Trust') || content.includes('per-post trust'),
      'Should define per-post trust scoring'
    );
  });

  it('signal strength agent has recency decay', () => {
    const content = loadAgent('synthesis-signal-strength');
    assert.ok(
      content.includes('recencyMultiplier') || content.includes('recency decay') || content.includes('Recency Decay') || content.includes('recencyWeight'),
      'Should define recency decay function'
    );
  });

  it('scorer has recency-weighted and trust-weighted dimensions', () => {
    const content = loadAgent('synthesis-scorer');
    assert.ok(
      content.includes('recencyWeightedPain') || content.includes('recency-weighted') || content.includes('Recency-weighted'),
      'Scorer should have recency-weighted pain dimension'
    );
    assert.ok(
      content.includes('trustWeightedEvidence') || content.includes('trust-weighted') || content.includes('Trust-weighted'),
      'Scorer should have trust-weighted evidence dimension'
    );
  });

  it('scorer has trend velocity dimension', () => {
    const content = loadAgent('synthesis-scorer');
    assert.ok(
      content.includes('trendVelocity') || content.includes('trend velocity') || content.includes('Trend') || content.includes('accelerat'),
      'Scorer should have trend velocity dimension'
    );
  });

  it('scorer outputs enhanced score alongside original', () => {
    const content = loadAgent('synthesis-scorer');
    assert.ok(
      content.includes('enhancedScore') || content.includes('enhanced') || content.includes('v2') || content.includes('scoringVersion'),
      'Scorer should output both original and enhanced scores'
    );
  });

  it('pain merger has trust and recency weighting', () => {
    const content = loadAgent('synthesis-pain-merger');
    assert.ok(
      content.includes('trustWeight') || content.includes('trust weight') || content.includes('Trust-Weighted') || content.includes('trust-weighted'),
      'Pain merger should apply trust weighting'
    );
    assert.ok(
      content.includes('recencyWeight') || content.includes('recency weight') || content.includes('Recency') || content.includes('recency'),
      'Pain merger should apply recency weighting'
    );
  });

  it('needs merger has trust and recency weighting', () => {
    const content = loadAgent('synthesis-needs-merger');
    assert.ok(
      content.includes('trust') || content.includes('Trust') || content.includes('recency') || content.includes('Recency'),
      'Needs merger should mention trust or recency weighting'
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Cross-feature Integration
// ═══════════════════════════════════════════════════════════════════════════════

describe('Cross-feature integration', () => {

  it('orchestrator topology includes all new phases', () => {
    const content = loadAgent('orchestrator');
    const hasResume = content.includes('resumption') || content.includes('Resume') || content.includes('resume');
    const hasVerification = content.includes('deep-research') || content.includes('verification');
    const hasDelta = content.includes('delta') || content.includes('Delta');
    assert.ok(hasResume, 'Should include resume phase');
    assert.ok(hasVerification, 'Should include verification phase');
    assert.ok(hasDelta, 'Should include delta summarizer');
  });

  it('all new agent files exist', () => {
    const newAgents = [
      'scan-resumption',
      'delta-summarizer',
      'synthesis-market-sizing',
      'synthesis-causal-chains',
      'synthesis-strategic-narrative'
    ];
    for (const agent of newAgents) {
      assert.ok(agentExists(agent), `${agent}.md should exist`);
    }
  });

  it('CLAUDE.md reflects expanded agent count', () => {
    const claude = readFileSync(resolve(import.meta.dirname, '..', '..', 'CLAUDE.md'), 'utf8');
    // Should mention the expanded sprint count (15 instead of 12)
    assert.ok(
      claude.includes('15') || claude.includes('market-sizing') || claude.includes('strategic-narrative'),
      'CLAUDE.md should reflect expanded pipeline'
    );
  });
});
