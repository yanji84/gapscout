/**
 * setup.mjs -- Persistent, incremental setup for gapscout
 *
 * Auto-detects available tokens, persists to ~/.pain-pointsrc,
 * and shows instructions for tokens that need manual setup.
 *
 * Usage:
 *   node scripts/cli.mjs setup              — Full setup (auto-detect + status + instructions)
 *   node scripts/cli.mjs setup --set KEY=VALUE  — Set a token manually
 *   node scripts/cli.mjs setup --status     — Show what's configured vs missing
 *   node scripts/cli.mjs setup --reset      — Clear all saved tokens
 *   node scripts/cli.mjs setup --help       — Show help
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

const RC_PATH = resolve(homedir(), '.pain-pointsrc');

// ─── token definitions ──────────────────────────────────────────────────────

// Resolve the project root so printed commands use an absolute path and work
// regardless of which directory the user runs the command from.
const PROJECT_ROOT = resolve(import.meta.dirname, '..');
const CLI_CMD = `node ${resolve(PROJECT_ROOT, 'scripts', 'cli.mjs')}`;

const TOKENS = [
  {
    keys: ['GITHUB_TOKEN'],
    label: 'GITHUB_TOKEN',
    benefit: '83x GitHub rate boost',
    autoDetect: true,
    instructions: null, // auto-detected only
  },
  {
    keys: ['STACKEXCHANGE_KEY'],
    label: 'STACKEXCHANGE_KEY',
    benefit: '10,000 req/day',
    autoDetect: false,
    instructions: [
      '1. Go to https://stackapps.com/apps/oauth/register',
      '2. Fill in app name (anything), description, website',
      '3. Copy the "Key" (not secret)',
      `4. Run: ${CLI_CMD} setup --set STACKEXCHANGE_KEY=<your-key>`,
    ],
    getUrl: 'https://stackapps.com/apps/oauth/register',
    get setCmd() { return `${CLI_CMD} setup --set STACKEXCHANGE_KEY=<your-key>`; },
  },
  {
    keys: ['PRODUCTHUNT_TOKEN'],
    label: 'PRODUCTHUNT_TOKEN',
    benefit: 'eliminates browser for Product Hunt',
    autoDetect: false,
    instructions: [
      '1. Go to https://www.producthunt.com/v2/oauth/applications',
      '2. Click "Add an Application"',
      '3. Fill in name and redirect URI (http://localhost)',
      '4. Copy the "Developer Token" from the app page',
      `5. Run: ${CLI_CMD} setup --set PRODUCTHUNT_TOKEN=<your-token>`,
    ],
    getUrl: 'https://producthunt.com/v2/oauth/applications',
    get setCmd() { return `${CLI_CMD} setup --set PRODUCTHUNT_TOKEN=<token>`; },
  },
];

// ─── rc file helpers ─────────────────────────────────────────────────────────

function loadRc() {
  try {
    const raw = readFileSync(RC_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function saveRc(rc) {
  writeFileSync(RC_PATH, JSON.stringify(rc, null, 2) + '\n', 'utf8');
}

function getRcTokens(rc) {
  return (rc && rc.tokens) || {};
}

function setRcToken(rc, key, value) {
  if (!rc.tokens) rc.tokens = {};
  rc.tokens[key] = value;
}

// ─── auto-detection ──────────────────────────────────────────────────────────

async function autoDetectGithubToken() {
  const ghConfigPath = resolve(homedir(), '.config', 'gh', 'hosts.yml');
  try {
    const raw = readFileSync(ghConfigPath, 'utf8');
    // Simple YAML parsing — look for oauth_token line
    const match = raw.match(/oauth_token:\s*(.+)/);
    if (match && match[1]) {
      return match[1].trim();
    }
  } catch {
    // gh CLI not configured
  }
  return null;
}

async function probeSearxng() {
  try {
    const { execSync } = (await import('node:child_process'));
    execSync('curl -s --connect-timeout 2 http://localhost:8888/', {
      stdio: 'pipe',
      timeout: 5000,
    });
    return 'http://localhost:8888';
  } catch {
    return null;
  }
}

// ─── output helpers ──────────────────────────────────────────────────────────

function line(str = '') {
  process.stdout.write(str + '\n');
}

// ─── parse --set flags from raw argv ─────────────────────────────────────────

function parseSetFlags(argv) {
  const sets = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--set' && i + 1 < argv.length) {
      const val = argv[i + 1];
      const eqIdx = val.indexOf('=');
      if (eqIdx > 0) {
        const key = val.substring(0, eqIdx);
        const value = val.substring(eqIdx + 1);
        sets[key] = value;
      }
      i++; // skip value
    }
  }
  return sets;
}

// ─── commands ────────────────────────────────────────────────────────────────

async function runSet(argv) {
  const sets = parseSetFlags(argv);
  if (Object.keys(sets).length === 0) {
    line(`Usage: ${CLI_CMD} setup --set KEY=VALUE [--set KEY2=VALUE2]`);
    process.exit(1);
  }

  const rc = loadRc();
  for (const [key, value] of Object.entries(sets)) {
    setRcToken(rc, key, value);
    line(`  Set ${key}`);
  }
  saveRc(rc);
  line(`\nConfig saved to: ~/.pain-pointsrc`);
}

async function runReset() {
  const rc = loadRc();
  rc.tokens = {};
  saveRc(rc);
  line('All saved tokens cleared.');
  line(`Config saved to: ~/.pain-pointsrc`);
}

async function runStatus() {
  const rc = loadRc();
  const tokens = getRcTokens(rc);

  line('gapscout setup');
  line('========================');
  line('');

  for (const def of TOKENS) {
    const allSet = def.keys.every(k => !!tokens[k] || !!process.env[k]);
    const label = def.keys.length > 1 ? def.keys.join(' + ') : def.label;

    if (allSet) {
      line(`  [ok] ${label} -- ${def.benefit}`);
    } else {
      line(`  [ ] ${label} -- ${def.benefit}`);
    }
  }

  line('');
  line(`Config file: ~/.pain-pointsrc`);
}

async function runFull() {
  const rc = loadRc();
  const tokens = getRcTokens(rc);
  let changed = false;

  const autoDetected = [];
  const alreadyConfigured = [];
  const notConfigured = [];

  // --- Auto-detect GITHUB_TOKEN ---
  if (tokens.GITHUB_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_TOKEN) {
    alreadyConfigured.push({
      label: 'GITHUB_TOKEN',
      detail: '83x GitHub rate boost',
    });
  } else {
    const ghToken = await autoDetectGithubToken();
    if (ghToken) {
      setRcToken(rc, 'GITHUB_TOKEN', ghToken);
      changed = true;
      autoDetected.push({
        label: 'GITHUB_TOKEN',
        detail: 'saved from gh CLI (83x GitHub rate boost)',
      });
    } else {
      notConfigured.push({
        label: 'GITHUB_TOKEN',
        benefit: '83x GitHub rate boost',
        getUrl: 'https://github.com/settings/tokens',
        get setCmd() { return `${CLI_CMD} setup --set GITHUB_TOKEN=<token>`; },
        instructions: [
          'Install gh CLI and run `gh auth login`, or:',
          'Create a PAT at https://github.com/settings/tokens',
          `Then run: ${CLI_CMD} setup --set GITHUB_TOKEN=<token>`,
        ],
      });
    }
  }

  // --- Check remaining tokens ---
  for (const def of TOKENS) {
    if (def.keys[0] === 'GITHUB_TOKEN') continue;

    const allSet = def.keys.every(k => !!tokens[k] || !!process.env[k]);
    if (allSet) {
      alreadyConfigured.push({
        label: def.keys.length > 1 ? def.keys.join(' + ') : def.label,
        detail: def.benefit,
      });
    } else {
      notConfigured.push(def);
    }
  }

  // Save if anything was auto-detected
  if (changed) {
    saveRc(rc);
  }

  // --- Print output ---
  line('gapscout setup');
  line('========================');
  line('');

  if (autoDetected.length > 0) {
    line('Auto-detected:');
    for (const item of autoDetected) {
      line(`  [ok] ${item.label} -- ${item.detail}`);
    }
    line('');
  }

  if (alreadyConfigured.length > 0) {
    line('Already configured:');
    for (const item of alreadyConfigured) {
      line(`  [ok] ${item.label} -- ${item.detail}`);
    }
    line('');
  }

  if (notConfigured.length > 0) {
    line('Not configured (optional):');
    for (const item of notConfigured) {
      const label = item.keys ? (item.keys.length > 1 ? item.keys.join(' + ') : item.label) : item.label;
      line(`  [ ] ${label} -- ${item.benefit}`);
      if (item.getUrl) {
        line(`    -> Get one at: ${item.getUrl}`);
      }
      if (item.setCmd) {
        line(`    -> Then run: ${item.setCmd}`);
      }
      if (item.instructions) {
        for (const inst of item.instructions) {
          line(`    ${inst}`);
        }
      }
      line('');
    }
  }

  if (changed) {
    line(`Config saved to: ~/.pain-pointsrc`);
  } else if (autoDetected.length === 0 && notConfigured.length === 0) {
    line('All tokens are configured. You are all set!');
  }
}

// ─── main entry point ────────────────────────────────────────────────────────

export async function runSetup(args, rawArgv) {
  // Help
  if (args && (args.help || args['--help'])) {
    line('gapscout setup -- Persistent, incremental token configuration');
    line('');
    line('Usage:');
    line(`  ${CLI_CMD} setup                  Full setup (auto-detect + status + instructions)`);
    line(`  ${CLI_CMD} setup --set KEY=VALUE   Set a token manually`);
    line(`  ${CLI_CMD} setup --status          Show what is configured vs missing`);
    line(`  ${CLI_CMD} setup --reset           Clear all saved tokens`);
    line(`  ${CLI_CMD} setup --help            Show this help`);
    line('');
    line('Tokens are persisted to ~/.pain-pointsrc (JSON).');
    line('On subsequent runs, already-configured tokens are skipped.');
    return;
  }

  // --set: parse from rawArgv to support multiple --set flags
  if (rawArgv && rawArgv.some(a => a === '--set')) {
    await runSet(rawArgv);
    return;
  }
  if (args && args.set) {
    // Fallback if rawArgv not passed — single --set
    const eqIdx = String(args.set).indexOf('=');
    if (eqIdx > 0) {
      const rc = loadRc();
      const key = String(args.set).substring(0, eqIdx);
      const value = String(args.set).substring(eqIdx + 1);
      setRcToken(rc, key, value);
      saveRc(rc);
      line(`  Set ${key}`);
      line(`\nConfig saved to: ~/.pain-pointsrc`);
    } else {
      line(`Usage: ${CLI_CMD} setup --set KEY=VALUE`);
    }
    return;
  }

  // --reset
  if (args && args.reset) {
    await runReset();
    return;
  }

  // --status
  if (args && args.status) {
    await runStatus();
    return;
  }

  // Full setup
  await runFull();
}
