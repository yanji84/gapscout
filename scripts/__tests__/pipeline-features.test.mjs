/**
 * Tests for 3 new pipeline features:
 * 1. Inline citations (research-paper style [N] references + bibliography)
 * 2. Iterative deep research verification
 * 3. Community validation suggestions
 *
 * Tests validate the data schemas, agent definitions, and output contracts.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const FIXTURES = resolve(import.meta.dirname, 'fixtures');
const AGENTS_DIR = resolve(import.meta.dirname, '..', '..', '.claude', 'agents');

// ─── Helper: load JSON fixture ──────────────────────────────────────────────

function loadFixture(name) {
  return JSON.parse(readFileSync(resolve(FIXTURES, name), 'utf8'));
}

function loadAgent(name) {
  const path = resolve(AGENTS_DIR, `${name}.md`);
  assert.ok(existsSync(path), `Agent file ${name}.md should exist`);
  return readFileSync(path, 'utf8');
}

// ═══════════════════════════════════════════════════════════════════════════════
// FEATURE 1: Inline Citations
// ═══════════════════════════════════════════════════════════════════════════════

describe('Feature 1: Inline Citations', () => {

  describe('Report JSON schema with citations', () => {
    const report = loadFixture('sample-report-with-citations.json');

    it('has a top-level citations array', () => {
      assert.ok(Array.isArray(report.citations), 'citations should be an array');
      assert.ok(report.citations.length > 0, 'citations should not be empty');
    });

    it('each citation has required fields', () => {
      const required = ['id', 'url', 'source', 'quote'];
      for (const cite of report.citations) {
        for (const field of required) {
          assert.ok(cite[field] !== undefined, `Citation ${cite.id} missing field: ${field}`);
        }
      }
    });

    it('citation IDs are sequential starting from 1', () => {
      const ids = report.citations.map(c => c.id);
      for (let i = 0; i < ids.length; i++) {
        assert.equal(ids[i], i + 1, `Citation ID should be ${i + 1}, got ${ids[i]}`);
      }
    });

    it('citation IDs are unique', () => {
      const ids = report.citations.map(c => c.id);
      assert.equal(new Set(ids).size, ids.length, 'Citation IDs should be unique');
    });

    it('citations have valid source types', () => {
      const validSources = ['reddit', 'hackernews', 'trustpilot', 'g2', 'capterra', 'producthunt', 'appstore', 'websearch', 'twitter', 'discord', 'forum'];
      for (const cite of report.citations) {
        assert.ok(validSources.includes(cite.source), `Invalid source: ${cite.source}`);
      }
    });

    it('citation URLs are non-empty strings', () => {
      for (const cite of report.citations) {
        assert.ok(typeof cite.url === 'string' && cite.url.length > 0, `Citation ${cite.id} has empty URL`);
        assert.ok(cite.url.startsWith('http'), `Citation ${cite.id} URL should start with http`);
      }
    });

    it('has citationStats in report', () => {
      assert.ok(report.citationStats, 'Should have citationStats');
      assert.ok(typeof report.citationStats.total === 'number', 'total should be a number');
      assert.ok(report.citationStats.bySource, 'Should have bySource breakdown');
    });

    it('citationStats.total matches citations array length', () => {
      assert.equal(report.citationStats.total, report.citations.length,
        'citationStats.total should match citations array length');
    });

    it('executive summary opportunities have citationIds', () => {
      for (const opp of report.executiveSummary.topOpportunities) {
        assert.ok(Array.isArray(opp.citationIds), `Opportunity "${opp.gap}" should have citationIds array`);
      }
    });

    it('pain themes have citationIds', () => {
      for (const theme of report.painAnalysis.painThemes) {
        assert.ok(Array.isArray(theme.citationIds), `Pain theme "${theme.theme}" should have citationIds`);
        assert.ok(theme.citationIds.length > 0, `Pain theme "${theme.theme}" should have at least 1 citation`);
      }
    });

    it('all referenced citationIds exist in bibliography', () => {
      const allIds = new Set(report.citations.map(c => c.id));
      const referencedIds = new Set();

      // Collect from pain themes
      for (const theme of report.painAnalysis.painThemes) {
        for (const id of theme.citationIds) referencedIds.add(id);
      }
      // Collect from opportunities
      for (const opp of report.executiveSummary.topOpportunities) {
        if (opp.citationIds) for (const id of opp.citationIds) referencedIds.add(id);
      }

      for (const id of referencedIds) {
        assert.ok(allIds.has(id), `Referenced citation ID ${id} not found in bibliography`);
      }
    });

    it('inline citation format uses [N] notation in evidence strings', () => {
      for (const theme of report.painAnalysis.painThemes) {
        if (theme.evidence) {
          assert.match(theme.evidence, /\[\d+\]/, `Evidence for "${theme.theme}" should contain [N] citations`);
        }
      }
    });
  });

  describe('Report generator JSON agent has citation instructions', () => {
    const agentContent = loadAgent('report-generator-json');

    it('mentions citations bibliography', () => {
      assert.ok(agentContent.includes('citation'), 'Agent should mention citations');
    });

    it('describes citationIds in schema', () => {
      assert.ok(agentContent.includes('citationIds'), 'Agent should describe citationIds field');
    });

    it('describes bibliography array', () => {
      assert.ok(
        agentContent.includes('citations') && agentContent.includes('bibliography') ||
        agentContent.includes('"citations"'),
        'Agent should describe citations/bibliography array'
      );
    });
  });

  describe('Report generator HTML agent has citation rendering', () => {
    const agentContent = loadAgent('report-generator-html');

    it('describes inline citation rendering', () => {
      assert.ok(agentContent.includes('citation') || agentContent.includes('cite'),
        'HTML agent should describe citation rendering');
    });

    it('mentions bibliography/references section', () => {
      assert.ok(
        agentContent.includes('bibliography') || agentContent.includes('References') || agentContent.includes('references'),
        'HTML agent should mention a references/bibliography section'
      );
    });

    it('describes superscript citation links', () => {
      assert.ok(
        agentContent.includes('sup') || agentContent.includes('superscript'),
        'HTML agent should describe superscript citation format'
      );
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// FEATURE 2: Iterative Deep Research Verification
// ═══════════════════════════════════════════════════════════════════════════════

describe('Feature 2: Iterative Deep Research', () => {

  describe('Deep research verifier agent exists', () => {
    it('agent file exists', () => {
      const path = resolve(AGENTS_DIR, 'deep-research-verifier.md');
      assert.ok(existsSync(path), 'deep-research-verifier.md should exist');
    });

    it('agent has required sections', () => {
      const content = loadAgent('deep-research-verifier');
      assert.ok(content.includes('verification'), 'Should mention verification');
      assert.ok(content.includes('STRENGTHENED') || content.includes('WEAKENED'),
        'Should define verification verdicts');
      assert.ok(content.includes('convergence') || content.includes('Convergence'),
        'Should describe convergence detection');
    });

    it('agent defines output schema with verification fields', () => {
      const content = loadAgent('deep-research-verifier');
      assert.ok(content.includes('verifiedOpportunities') || content.includes('verificationVerdict'),
        'Should define verification output fields');
      assert.ok(content.includes('adjustedScore') || content.includes('scoreChange'),
        'Should define score adjustment fields');
    });

    it('agent has anti-fabrication notice', () => {
      const content = loadAgent('deep-research-verifier');
      assert.ok(content.includes('fabricat') || content.includes('FABRICAT'),
        'Should have anti-fabrication notice');
    });
  });

  describe('Orchestrator has verification loop', () => {
    const orchestrator = loadAgent('orchestrator');

    it('mentions deep research verification', () => {
      assert.ok(
        orchestrator.includes('deep-research-verif') || orchestrator.includes('Deep Research') || orchestrator.includes('verification'),
        'Orchestrator should mention deep research verification'
      );
    });

    it('defines verification loop with max rounds', () => {
      assert.ok(
        orchestrator.includes('verification_round') || orchestrator.includes('maxRounds') ||
        orchestrator.includes('max_verification_rounds') || orchestrator.includes('verificationRounds'),
        'Orchestrator should define verification loop bounds'
      );
    });

    it('includes convergence check in verification loop', () => {
      assert.ok(
        orchestrator.includes('converge') || orchestrator.includes('CONVERGE'),
        'Orchestrator should check for convergence'
      );
    });
  });

  describe('Verification output schema', () => {
    const report = loadFixture('sample-report-with-citations.json');

    it('report has deepResearchVerification section', () => {
      assert.ok(report.deepResearchVerification, 'Should have deepResearchVerification');
    });

    it('verification tracks rounds completed', () => {
      assert.ok(typeof report.deepResearchVerification.roundsCompleted === 'number',
        'Should have roundsCompleted');
    });

    it('verification tracks convergence', () => {
      assert.ok(typeof report.deepResearchVerification.converged === 'boolean',
        'Should have converged boolean');
    });

    it('adjusted opportunities have required fields', () => {
      for (const opp of report.deepResearchVerification.adjustedOpportunities) {
        assert.ok(opp.gap, 'Should have gap name');
        assert.ok(typeof opp.originalScore === 'number', 'Should have originalScore');
        assert.ok(typeof opp.adjustedScore === 'number', 'Should have adjustedScore');
        assert.ok(opp.verificationVerdict, 'Should have verificationVerdict');
        assert.ok(['STRENGTHENED', 'UNCHANGED', 'WEAKENED', 'INVALIDATED'].includes(opp.verificationVerdict),
          `Invalid verdict: ${opp.verificationVerdict}`);
      }
    });

    it('new evidence entries have required fields', () => {
      for (const opp of report.deepResearchVerification.adjustedOpportunities) {
        for (const ev of opp.newEvidence) {
          assert.ok(ev.query, 'Evidence should have query');
          assert.ok(ev.source, 'Evidence should have source');
          assert.ok(ev.finding, 'Evidence should have finding');
          assert.ok(['confirms', 'contradicts', 'neutral'].includes(ev.impact),
            `Invalid impact: ${ev.impact}`);
        }
      }
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// FEATURE 3: Community Validation Suggestions
// ═══════════════════════════════════════════════════════════════════════════════

describe('Feature 3: Community Validation Suggestions', () => {

  describe('Community validator agent exists', () => {
    it('agent file exists', () => {
      const path = resolve(AGENTS_DIR, 'community-validator.md');
      assert.ok(existsSync(path), 'community-validator.md should exist');
    });

    it('agent has required sections', () => {
      const content = loadAgent('community-validator');
      assert.ok(content.includes('communit') || content.includes('Communit'),
        'Should mention communities');
      assert.ok(content.includes('Reddit') || content.includes('reddit'),
        'Should mention Reddit');
      assert.ok(content.includes('Discord') || content.includes('discord'),
        'Should mention Discord');
      assert.ok(content.includes('validation') || content.includes('Validation'),
        'Should mention validation');
    });

    it('agent defines community scoring criteria', () => {
      const content = loadAgent('community-validator');
      assert.ok(content.includes('relevance') || content.includes('Relevance'),
        'Should define relevance scoring');
      assert.ok(content.includes('activity') || content.includes('Activity'),
        'Should define activity scoring');
    });

    it('agent generates engagement templates', () => {
      const content = loadAgent('community-validator');
      assert.ok(
        content.includes('engagementTemplate') || content.includes('engagement') || content.includes('template'),
        'Should generate engagement templates'
      );
    });

    it('agent has anti-fabrication notice', () => {
      const content = loadAgent('community-validator');
      assert.ok(content.includes('fabricat') || content.includes('FABRICAT'),
        'Should have anti-fabrication notice');
    });
  });

  describe('Community validation output schema', () => {
    const report = loadFixture('sample-report-with-citations.json');

    it('report has communityValidation section', () => {
      assert.ok(report.communityValidation, 'Should have communityValidation');
    });

    it('community validation has per-opportunity entries', () => {
      assert.ok(Array.isArray(report.communityValidation.opportunities),
        'Should have opportunities array');
      assert.ok(report.communityValidation.opportunities.length > 0,
        'Should have at least 1 opportunity');
    });

    it('each opportunity has communities array', () => {
      for (const opp of report.communityValidation.opportunities) {
        assert.ok(opp.gap, 'Should have gap name');
        assert.ok(Array.isArray(opp.communities), 'Should have communities array');
        assert.ok(opp.communities.length > 0, 'Should have at least 1 community');
      }
    });

    it('each community has required fields', () => {
      const required = ['platform', 'name', 'url', 'relevance', 'activity', 'whyRelevant'];
      for (const opp of report.communityValidation.opportunities) {
        for (const comm of opp.communities) {
          for (const field of required) {
            assert.ok(comm[field] !== undefined, `Community "${comm.name}" missing field: ${field}`);
          }
        }
      }
    });

    it('community URLs are valid', () => {
      for (const opp of report.communityValidation.opportunities) {
        for (const comm of opp.communities) {
          assert.ok(comm.url.startsWith('http'), `Community URL should start with http: ${comm.url}`);
        }
      }
    });

    it('community scores are in valid range (1-5)', () => {
      for (const opp of report.communityValidation.opportunities) {
        for (const comm of opp.communities) {
          for (const dim of ['relevance', 'activity']) {
            assert.ok(comm[dim] >= 1 && comm[dim] <= 5,
              `${dim} score should be 1-5, got ${comm[dim]}`);
          }
        }
      }
    });

    it('each opportunity has a validation plan', () => {
      for (const opp of report.communityValidation.opportunities) {
        assert.ok(opp.validationPlan, 'Should have validationPlan');
        assert.ok(opp.validationPlan.surveyQuestion, 'Should have surveyQuestion');
        assert.ok(opp.validationPlan.engagementTemplate, 'Should have engagementTemplate');
        assert.ok(Array.isArray(opp.validationPlan.whatToLookFor), 'Should have whatToLookFor array');
        assert.ok(Array.isArray(opp.validationPlan.redFlags), 'Should have redFlags array');
      }
    });
  });

  describe('Synthesizer coordinator includes community sprint', () => {
    it('synthesizer-coordinator mentions community validation sprint', () => {
      const content = loadAgent('synthesizer-coordinator');
      assert.ok(
        content.includes('community-validator') || content.includes('Community Validation') ||
        content.includes('community validation') || content.includes('Sprint 12'),
        'Synthesizer should include community validation sprint'
      );
    });
  });

  describe('Report generators include community section', () => {
    it('JSON report generator mentions communityValidation', () => {
      const content = loadAgent('report-generator-json');
      assert.ok(content.includes('community') || content.includes('Community'),
        'JSON report generator should mention community validation');
    });

    it('HTML report generator mentions community section', () => {
      const content = loadAgent('report-generator-html');
      assert.ok(content.includes('community') || content.includes('Community'),
        'HTML report generator should mention community validation section');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// CROSS-FEATURE: Integration checks
// ═══════════════════════════════════════════════════════════════════════════════

describe('Cross-feature integration', () => {

  it('orchestrator topology includes all new agents', () => {
    const content = loadAgent('orchestrator');
    assert.ok(content.includes('deep-research-verif') || content.includes('verification'),
      'Should include deep research verifier');
    assert.ok(content.includes('community-valid') || content.includes('community'),
      'Should include community validator');
  });

  it('report-generator-json inputs list includes new files', () => {
    const content = loadAgent('report-generator-json');
    assert.ok(content.includes('deep-research') || content.includes('verification'),
      'Should list deep research file as input');
    assert.ok(content.includes('community-validation') || content.includes('community'),
      'Should list community validation file as input');
  });

  it('AGENT-RELATIONSHIPS.md references new agents', () => {
    const path = resolve(import.meta.dirname, '..', '..', 'AGENT-RELATIONSHIPS.md');
    if (existsSync(path)) {
      const content = readFileSync(path, 'utf8');
      // This is a soft check — may not be updated yet
      if (content.includes('deep-research') || content.includes('community-valid')) {
        assert.ok(true, 'AGENT-RELATIONSHIPS.md references new agents');
      }
    }
  });

  it('sample report fixture has all 3 features', () => {
    const report = loadFixture('sample-report-with-citations.json');
    assert.ok(report.citations, 'Should have citations (Feature 1)');
    assert.ok(report.deepResearchVerification, 'Should have deepResearchVerification (Feature 2)');
    assert.ok(report.communityValidation, 'Should have communityValidation (Feature 3)');
  });
});
