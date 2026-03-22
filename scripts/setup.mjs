/**
 * setup.mjs -- Interactive setup guide for pain-point-finder
 *
 * Shows which optional tokens are configured and how to set up the missing ones.
 * Does NOT prompt for input or write any files -- purely informational.
 *
 * Usage:
 *   node scripts/cli.mjs setup
 *   node scripts/cli.mjs setup --help
 */

// ─── token definitions ──────────────────────────────────────────────────────

const TOKENS = [
  {
    envVars: ['GITHUB_TOKEN'],
    altEnvVars: ['GH_TOKEN'],
    label: 'GITHUB_TOKEN',
    source: 'GitHub Issues',
    benefit: '60 → 5,000 req/hr (83x improvement)',
    howToSet: [
      'Already available if you use gh CLI:',
      '  export GITHUB_TOKEN=$(grep oauth_token ~/.config/gh/hosts.yml | head -1 | awk \'{print $2}\')',
      '',
      'Or: Create a fine-grained PAT at https://github.com/settings/tokens',
    ],
  },
  {
    envVars: ['STACKEXCHANGE_KEY'],
    altEnvVars: [],
    label: 'STACKEXCHANGE_KEY',
    source: 'Stack Overflow',
    benefit: '300 → 10,000 req/day (33x improvement)',
    howToSet: [
      'Register a free app at https://stackapps.com',
      'No OAuth needed -- just a simple app key.',
    ],
  },
  {
    envVars: ['PRODUCTHUNT_TOKEN'],
    altEnvVars: [],
    label: 'PRODUCTHUNT_TOKEN',
    source: 'Product Hunt',
    benefit: 'Eliminates browser dependency (uses GraphQL API directly)',
    howToSet: [
      'Register at https://producthunt.com/v2/oauth/applications',
      'Create a new application and use the Developer Token.',
    ],
  },
  {
    envVars: ['REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET'],
    altEnvVars: [],
    label: 'REDDIT_CLIENT_ID + REDDIT_CLIENT_SECRET',
    source: 'Reddit (backup when PullPush is down)',
    benefit: 'Fallback data source when PullPush API is unavailable',
    howToSet: [
      'Create a "script" app at https://reddit.com/prefs/apps',
      '  1. Click "create another app..." at the bottom',
      '  2. Choose "script" as the app type',
      '  3. Set redirect URI to http://localhost',
      '  4. Use the client ID (under the app name) and secret',
      '',
      '  export REDDIT_CLIENT_ID="your_client_id"',
      '  export REDDIT_CLIENT_SECRET="your_client_secret"',
    ],
  },
  {
    envVars: ['SEARXNG_URL'],
    altEnvVars: [],
    label: 'SEARXNG_URL',
    source: 'Web search',
    benefit: 'Eliminates browser dependency (uses SearXNG API)',
    howToSet: [
      'Run a local SearXNG instance:',
      '  docker run -d -p 8888:8080 searxng/searxng:latest',
      '',
      'Then:',
      '  export SEARXNG_URL=http://localhost:8888',
    ],
  },
];

// ─── helpers ─────────────────────────────────────────────────────────────────

function isSet(envVars, altEnvVars) {
  const allVars = [...envVars, ...(altEnvVars || [])];
  // For multi-var tokens (like REDDIT_CLIENT_ID + REDDIT_CLIENT_SECRET),
  // all primary vars must be set
  return envVars.every(v => !!process.env[v]) ||
         (altEnvVars && altEnvVars.length > 0 && altEnvVars.every(v => !!process.env[v]));
}

function line(str = '') {
  process.stdout.write(str + '\n');
}

// ─── main ────────────────────────────────────────────────────────────────────

export async function runSetup(args) {
  if (args && (args.help || args['--help'])) {
    line('pain-points setup -- Show token configuration status and setup instructions');
    line('');
    line('Usage:');
    line('  pain-points setup');
    line('  pain-points setup --help');
    line('');
    line('This command checks which optional API tokens are configured and');
    line('shows instructions for setting up the missing ones. It does not');
    line('prompt for input or write any files.');
    return;
  }

  line('==========================================================');
  line('  pain-point-finder -- Setup Guide');
  line('==========================================================');
  line('');
  line('This tool discovers pain points across multiple platforms.');
  line('All tokens below are OPTIONAL -- the tool works without any');
  line('of them. But each token unlocks higher rate limits or removes');
  line('the need for a browser (Chrome/Puppeteer).');
  line('');
  line('----------------------------------------------------------');

  let configured = 0;
  let missing = 0;

  for (const token of TOKENS) {
    const set = isSet(token.envVars, token.altEnvVars);
    line('');
    line(`  ${token.label}`);
    line(`  Source: ${token.source}`);
    line(`  Benefit: ${token.benefit}`);
    line('');

    if (set) {
      configured++;
      line(`  Status: ✓ already configured`);
    } else {
      missing++;
      line(`  Status: not set`);
      line('');
      line('  How to set up:');
      for (const h of token.howToSet) {
        line(`    ${h}`);
      }
    }

    line('');
    line('----------------------------------------------------------');
  }

  line('');
  line('==========================================================');
  line('  Summary');
  line('==========================================================');
  line('');
  line(`  Configured: ${configured}/${TOKENS.length}`);
  line(`  Missing:    ${missing}/${TOKENS.length}`);
  line('');

  if (missing > 0) {
    line('To persist your tokens, add the export lines to your shell');
    line('profile so they are available in every terminal session:');
    line('');
    line('  # bash');
    line('  echo \'export GITHUB_TOKEN="..."\' >> ~/.bashrc');
    line('');
    line('  # zsh');
    line('  echo \'export GITHUB_TOKEN="..."\' >> ~/.zshrc');
    line('');
    line('Replace GITHUB_TOKEN with the relevant variable name and');
    line('value for each token you want to persist.');
  } else {
    line('All optional tokens are configured. You are all set!');
  }

  line('');
}
