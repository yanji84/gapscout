import { spawn } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdirSync, readFileSync, existsSync, writeFileSync, appendFileSync } from 'node:fs';
import { updateScan, getRunningScans } from './db.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = resolve(__dirname, '..', 'scripts', 'cli.mjs');
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_SCANS) || 3;

/** scanId -> ChildProcess */
const children = new Map();

/** scanId -> { lines: [{ts, text}], cursor: number, totalCount: number } */
const logs = new Map();
const MAX_LOG_LINES = 500;

/**
 * Persist a log line to disk so logs survive server restarts.
 */
function persistLogLine(scanDir, line) {
  if (!scanDir) return;
  try {
    appendFileSync(join(scanDir, 'scan.log'), JSON.stringify(line) + '\n', 'utf8');
  } catch {}
}

/**
 * Append a log line to an in-memory log entry, maintaining MAX_LOG_LINES cap
 * and tracking absolute totalCount for correct cursor math.
 */
function appendLog(logEntry, line) {
  logEntry.lines.push(line);
  logEntry.totalCount++;
  if (logEntry.lines.length > MAX_LOG_LINES) {
    logEntry.lines.shift();
  }
}

function writePhaseTimeline(scanDir, phases) {
  if (!scanDir) return;
  try {
    writeFileSync(join(scanDir, 'phase-timeline.json'), JSON.stringify({ phases, updatedAt: Date.now() }) + '\n', 'utf8');
  } catch {}
}

/** Queued scan configs waiting for a slot */
const queue = [];

/**
 * Start a quick scan as a child process, or enqueue it if at capacity.
 */
function startQuickScan(db, { id, domain, sources, scanDir, timeout }) {
  if (children.size >= MAX_CONCURRENT) {
    queue.push({ id, domain, sources, scanDir, timeout, mode: 'quick' });
    return;
  }

  const args = ['all', 'scan', '--domain', domain, '--scan-dir', scanDir, '--scan-id', id];

  if (sources) {
    args.push('--sources', sources);
  }
  if (timeout) {
    args.push('--timeout', String(timeout));
  }

  const child = spawn(process.execPath, [CLI_PATH, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });

  children.set(id, child);

  updateScan(db, id, {
    status: 'running',
    pid: child.pid,
    started_at: new Date().toISOString(),
  });

  // Initialize log buffer for this scan
  logs.set(id, { lines: [], cursor: 0, totalCount: 0 });

  const logEntry = logs.get(id);
  if (logEntry) {
    const startMsg = { ts: Date.now(), text: '[gapscout] Scan started — domain: ' + domain };
    appendLog(logEntry, startMsg);
    persistLogLine(scanDir, startMsg);
    if (sources) {
      const srcMsg = { ts: Date.now(), text: '[gapscout] Sources: ' + sources };
      appendLog(logEntry, srcMsg);
      persistLogLine(scanDir, srcMsg);
    } else {
      const srcMsg = { ts: Date.now(), text: '[gapscout] Running all available sources' };
      appendLog(logEntry, srcMsg);
      persistLogLine(scanDir, srcMsg);
    }
  }

  // Progress monitor — adds log messages when sources complete
  const progressInterval = setInterval(() => {
    try {
      const progress = checkProgress(scanDir);
      const logEntry = logs.get(id);
      if (logEntry && progress.completedSources) {
        const lastLogged = logEntry._lastSourceCount || 0;
        if (progress.completedSources.length > lastLogged) {
          const newSources = progress.completedSources.slice(lastLogged);
          for (const src of newSources) {
            const srcMsg = { ts: Date.now(), text: '[gapscout] ✓ Source complete: ' + src.replace('-result.json', '') };
            appendLog(logEntry, srcMsg);
            persistLogLine(scanDir, srcMsg);
          }
          logEntry._lastSourceCount = progress.completedSources.length;
          const progMsg = { ts: Date.now(), text: '[gapscout] Progress: ' + progress.detail };
          appendLog(logEntry, progMsg);
          persistLogLine(scanDir, progMsg);
        }
      }
    } catch {}
  }, 3000);

  let stdout = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });

  let stderr = '';
  let stderrBuf = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
    stderrBuf += chunk.toString();
    const parts = stderrBuf.split('\n');
    stderrBuf = parts.pop(); // keep incomplete line
    const logEntry = logs.get(id);
    if (logEntry) {
      for (const line of parts) {
        if (line.trim()) {
          const logLine = { ts: Date.now(), text: line };
          appendLog(logEntry, logLine);
          persistLogLine(scanDir, logLine);
        }
      }
    }
  });

  child.on('close', (code) => {
    clearInterval(progressInterval);

    // Flush any remaining partial line in stderrBuf
    if (stderrBuf.trim()) {
      const logEntry = logs.get(id);
      if (logEntry) {
        const flushLine = { ts: Date.now(), text: stderrBuf };
        appendLog(logEntry, flushLine);
        persistLogLine(scanDir, flushLine);
      }
      stderrBuf = '';
    }

    children.delete(id);
    if (code === 0) {
      // Save raw coordinator output, then aggregate into proper report format
      try {
        // Step 1: Save raw scan output
        const rawPath = join(scanDir, 'raw-scan.json');
        writeFileSync(rawPath, stdout, 'utf8');

        // Log progress
        const logEntry = logs.get(id);
        if (logEntry) {
          const genMsg = { ts: Date.now(), text: '[server] Scan complete. Generating report...' };
          appendLog(logEntry, genMsg);
          persistLogLine(scanDir, genMsg);
        }

        // Step 2: Run report aggregator to transform raw -> grouped
        const reportChild = spawn(process.execPath, [
          resolve(__dirname, '..', 'scripts', 'report.mjs'),
          '--files', rawPath,
          '--format', 'json'
        ], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });

        let reportStdout = '';
        let reportStderr = '';
        reportChild.stdout.on('data', chunk => { reportStdout += chunk; });
        reportChild.stderr.on('data', chunk => { reportStderr += chunk; });

        reportChild.on('close', (reportCode) => {
          const reportPath = join(scanDir, 'report.json');

          if (reportCode === 0 && reportStdout.trim()) {
            // Save aggregated report
            writeFileSync(reportPath, reportStdout, 'utf8');

            if (logEntry) {
              const aggMsg = { ts: Date.now(), text: '[server] Report aggregated. Generating HTML...' };
              appendLog(logEntry, aggMsg);
              persistLogLine(scanDir, aggMsg);
            }

            // Step 3: Generate HTML from the proper report
            const htmlChild = spawn(process.execPath, [
              resolve(__dirname, '..', 'scripts', 'web-report.mjs'),
              '--input', reportPath,
              '--output', join(scanDir, 'report.html')
            ], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });

            htmlChild.on('close', (htmlCode) => {
              if (logEntry) {
                const htmlMsg = {
                  ts: Date.now(),
                  text: htmlCode === 0
                    ? '[server] \u2713 HTML report generated successfully'
                    : '[server] HTML report generation failed, JSON report available',
                };
                appendLog(logEntry, htmlMsg);
                persistLogLine(scanDir, htmlMsg);
              }
              updateScan(db, id, { status: 'completed', progress_pct: 100, progress_detail: 'Report generated', completed_at: new Date().toISOString() });
              drainQueue(db);
            });

            htmlChild.on('error', () => {
              if (logEntry) {
                const errMsg = { ts: Date.now(), text: '[server] HTML generation error, JSON report available' };
                appendLog(logEntry, errMsg);
                persistLogLine(scanDir, errMsg);
              }
              updateScan(db, id, { status: 'completed', progress_pct: 100, completed_at: new Date().toISOString() });
              drainQueue(db);
            });
          } else {
            // Aggregation failed -- save raw output as fallback
            writeFileSync(reportPath, stdout, 'utf8');
            if (logEntry) {
              const failMsg = { ts: Date.now(), text: '[server] Report aggregation failed: ' + (reportStderr || '').slice(0, 200) };
              appendLog(logEntry, failMsg);
              persistLogLine(scanDir, failMsg);
            }
            updateScan(db, id, { status: 'completed', progress_pct: 100, completed_at: new Date().toISOString() });
            drainQueue(db);
          }
        });

        reportChild.on('error', (err) => {
          // Aggregator failed to spawn -- save raw
          const reportPath = join(scanDir, 'report.json');
          writeFileSync(reportPath, stdout, 'utf8');
          if (logEntry) {
            const spawnErrMsg = { ts: Date.now(), text: '[server] Report generation failed: ' + err.message };
            appendLog(logEntry, spawnErrMsg);
            persistLogLine(scanDir, spawnErrMsg);
          }
          updateScan(db, id, { status: 'completed', progress_pct: 100, completed_at: new Date().toISOString() });
          drainQueue(db);
        });
      } catch (err) {
        const entry = logs.get(id);
        if (entry) {
          const saveErrMsg = { ts: Date.now(), text: `[server] Report save error: ${err.message}` };
          appendLog(entry, saveErrMsg);
          persistLogLine(scanDir, saveErrMsg);
        }
        updateScan(db, id, {
          status: 'completed',
          progress_pct: 100,
          completed_at: new Date().toISOString(),
        });
        drainQueue(db);
      }
    } else {
      const logEntry = logs.get(id);
      if (logEntry) {
        const failMsg = { ts: Date.now(), text: '[gapscout] ✗ Scan failed: ' + (stderr || '').slice(0, 200) };
        appendLog(logEntry, failMsg);
        persistLogLine(scanDir, failMsg);
      }
      updateScan(db, id, {
        status: 'failed',
        error: stderr.slice(0, 2000) || `Process exited with code ${code}`,
        completed_at: new Date().toISOString(),
      });
      drainQueue(db);
    }
  });

  child.on('error', (err) => {
    children.delete(id);
    updateScan(db, id, {
      status: 'failed',
      error: err.message,
      completed_at: new Date().toISOString(),
    });
    drainQueue(db);
  });
}

/**
 * Start a deep scan using the claude CLI orchestrator agent (~225 agents).
 */
function startDeepScan(db, { id, domain, scanDir, timeout }) {
  if (children.size >= MAX_CONCURRENT) {
    queue.push({ id, domain, scanDir, timeout, mode: 'full' });
    return;
  }

  // Initialize log buffer
  logs.set(id, { lines: [], cursor: 0, totalCount: 0 });
  const logEntry = logs.get(id);

  const startMsg = { ts: Date.now(), text: '[gapscout] Deep scan started — domain: ' + domain };
  appendLog(logEntry, startMsg);
  persistLogLine(scanDir, startMsg);

  const modeMsg = { ts: Date.now(), text: '[gapscout] Mode: Full pipeline (~225 agents) — this will take 1-4 hours' };
  appendLog(logEntry, modeMsg);
  persistLogLine(scanDir, modeMsg);

  // Spawn claude CLI with orchestrator agent
  const child = spawn('/usr/bin/claude', [
    '--agent', 'orchestrator',
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--max-budget-usd', '200'
  ], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      SCAN_DIR: scanDir,
      SCAN_ID: id,
    },
    cwd: resolve(__dirname, '..'),
    timeout: timeout || 4 * 60 * 60 * 1000, // 4 hour default timeout
  });

  // Send the market scan prompt to stdin
  child.stdin.write(`Scan the "${domain}" market. Write all output files to ${scanDir}. Use scan ID ${id}.`);
  child.stdin.end();

  children.set(id, child);

  updateScan(db, id, {
    status: 'running',
    pid: child.pid,
    started_at: new Date().toISOString(),
  });

  // Capture stderr for live logs (claude CLI outputs progress to stderr)
  let stderrBuf = '';
  child.stderr.on('data', (chunk) => {
    stderrBuf += chunk.toString();
    const parts = stderrBuf.split('\n');
    stderrBuf = parts.pop();
    const logEntry = logs.get(id);
    if (logEntry) {
      for (const line of parts) {
        if (line.trim()) {
          const logLine = { ts: Date.now(), text: line };
          appendLog(logEntry, logLine);
          persistLogLine(scanDir, logLine);
        }
      }
    }
  });

  // Capture stdout — stream-json format gives us real-time events
  let stdout = '';
  let stdoutBuf = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
    stdoutBuf += chunk.toString();
    const lines = stdoutBuf.split('\n');
    stdoutBuf = lines.pop();
    const logEntry = logs.get(id);
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const evt = JSON.parse(line);
        // Extract useful info from stream-json events
        if (evt.type === 'assistant' && evt.message?.content) {
          for (const block of evt.message.content) {
            if (block.type === 'text' && block.text && logEntry) {
              // Show agent text output (trimmed)
              const text = block.text.trim().slice(0, 300);
              if (text) {
                const logLine = { ts: Date.now(), text: text };
                appendLog(logEntry, logLine);
                persistLogLine(scanDir, logLine);
              }
            } else if (block.type === 'tool_use' && logEntry) {
              // Extract detailed info from tool calls
              const toolName = block.name || 'unknown';
              const inp = block.input || {};
              let detail = '';
              let skip = false;

              switch (toolName) {
                case 'Agent': {
                  detail = ' → ' + (inp.description || inp.subagent_type || 'sub-agent');
                  if (inp.name) detail += ' (' + inp.name + ')';
                  // Track agent count
                  logEntry._agentCount = (logEntry._agentCount || 0) + 1;
                  break;
                }
                case 'TaskCreate': {
                  const subject = inp.subject || '';
                  detail = ' → ' + subject;
                  // Track phase in timeline
                  const phaseMatch = subject.match(/phase\s*(\d+)/i);
                  if (phaseMatch || subject.toLowerCase().includes('planning') || subject.toLowerCase().includes('discovery') || subject.toLowerCase().includes('scanning') || subject.toLowerCase().includes('synthesis') || subject.toLowerCase().includes('report')) {
                    const phaseData = {
                      name: subject,
                      status: 'in_progress',
                      startedAt: Date.now()
                    };
                    logEntry._phases = logEntry._phases || [];
                    logEntry._phases.push(phaseData);
                    writePhaseTimeline(scanDir, logEntry._phases);
                  }
                  break;
                }
                case 'TaskUpdate': {
                  const status = inp.status || '';
                  const subject = inp.subject || '';
                  detail = ' [' + status + ']' + (subject ? ' ' + subject : '');
                  // Update phase status
                  if (status === 'completed' && logEntry._phases) {
                    const last = logEntry._phases.findLast(p => p.status === 'in_progress');
                    if (last) {
                      last.status = 'completed';
                      last.completedAt = Date.now();
                      last.duration = last.completedAt - last.startedAt;
                      writePhaseTimeline(scanDir, logEntry._phases);
                    }
                  }
                  break;
                }
                case 'WebSearch':
                  detail = ' → "' + (inp.query || '').slice(0, 100) + '"';
                  break;
                case 'WebFetch':
                  detail = ' → ' + (inp.url || '').slice(0, 100);
                  break;
                case 'Bash':
                  detail = ' → ' + (inp.command || '').slice(0, 120);
                  break;
                case 'Write':
                  detail = ' → ' + (inp.file_path || '').split('/').pop();
                  break;
                case 'Edit':
                  detail = ' → ' + (inp.file_path || '').split('/').pop();
                  break;
                case 'Read':
                  detail = ' → ' + (inp.file_path || '').split('/').pop();
                  break;
                case 'Glob':
                  detail = ' → ' + (inp.pattern || '');
                  break;
                case 'Grep':
                  detail = ' → "' + (inp.pattern || '').slice(0, 60) + '"' + (inp.path ? ' in ' + inp.path.split('/').pop() : '');
                  break;
                case 'SendMessage':
                  detail = ' → to ' + (inp.to || 'agent');
                  break;
                case 'ToolSearch':
                  // These are noisy and low-value, skip them
                  skip = true;
                  break;
                default:
                  detail = inp.description ? ' → ' + inp.description.slice(0, 80) : '';
              }

              if (!skip) {
                const logLine = { ts: Date.now(), text: '[tool] ' + toolName + detail };
                appendLog(logEntry, logLine);
                persistLogLine(scanDir, logLine);
              }
            }
          }
        }
      } catch {
        // Not JSON — show as plain text
        if (logEntry && line.trim()) {
          const logLine = { ts: Date.now(), text: line };
          appendLog(logEntry, logLine);
          persistLogLine(scanDir, logLine);
        }
      }
    }
  });

  child.on('close', (code) => {
    children.delete(id);
    const logEntry = logs.get(id);

    if (code === 0) {
      if (logEntry) {
        const doneMsg = { ts: Date.now(), text: '[gapscout] \u2713 Deep scan pipeline complete' };
        appendLog(logEntry, doneMsg);
        persistLogLine(scanDir, doneMsg);
      }
      // The orchestrator should have written report files to scanDir
      // Check if report.json and report.html exist
      const reportJsonExists = existsSync(join(scanDir, 'report.json'));
      const reportHtmlExists = existsSync(join(scanDir, 'report.html'));

      if (logEntry) {
        const filesMsg = { ts: Date.now(), text: '[gapscout] Report files: JSON=' + reportJsonExists + ' HTML=' + reportHtmlExists };
        appendLog(logEntry, filesMsg);
        persistLogLine(scanDir, filesMsg);
      }

      updateScan(db, id, {
        status: 'completed',
        progress_pct: 100,
        progress_detail: 'Deep scan complete',
        completed_at: new Date().toISOString()
      });
    } else {
      if (logEntry) {
        const failMsg = { ts: Date.now(), text: '[gapscout] \u2717 Deep scan failed (exit code ' + code + ')' };
        appendLog(logEntry, failMsg);
        persistLogLine(scanDir, failMsg);
      }
      updateScan(db, id, {
        status: 'failed',
        error: 'Deep scan exited with code ' + code,
        completed_at: new Date().toISOString()
      });
    }
    drainQueue(db);
  });

  child.on('error', (err) => {
    children.delete(id);
    const logEntry = logs.get(id);
    if (logEntry) {
      const errMsg = { ts: Date.now(), text: '[gapscout] \u2717 Failed to start deep scan: ' + err.message };
      appendLog(logEntry, errMsg);
      persistLogLine(scanDir, errMsg);
    }
    updateScan(db, id, {
      status: 'failed',
      error: err.message,
      completed_at: new Date().toISOString()
    });
    drainQueue(db);
  });
}

/**
 * Start a scan — routes to quick or deep mode.
 * @param {string} mode - 'quick' for CLI-based scan, 'full' for orchestrator agent pipeline (default: 'full')
 */
export function startScan(db, { id, domain, sources, scanDir, timeout, mode = 'full' }) {
  if (mode === 'quick') {
    startQuickScan(db, { id, domain, sources, scanDir, timeout });
  } else {
    startDeepScan(db, { id, domain, scanDir, timeout });
  }
}

/**
 * Cancel a running or queued scan.
 */
export function cancelScan(db, scanId) {
  const child = children.get(scanId);
  if (child) {
    child.kill('SIGTERM');
    children.delete(scanId);
    updateScan(db, scanId, {
      status: 'cancelled',
      completed_at: new Date().toISOString(),
    });
    return;
  }

  const idx = queue.findIndex((item) => item.id === scanId);
  if (idx !== -1) {
    queue.splice(idx, 1);
    updateScan(db, scanId, {
      status: 'cancelled',
      completed_at: new Date().toISOString(),
    });
  }
}

/**
 * Check scan progress by inspecting files written to scanDir.
 */
export function checkProgress(scanDir) {
  if (!existsSync(scanDir)) {
    return { pct: 0, detail: 'Initializing...' };
  }

  let files;
  try {
    files = readdirSync(scanDir);
  } catch {
    return { pct: 0, detail: 'Initializing...' };
  }

  const resultFiles = files.filter((f) => f.endsWith('-result.json'));
  const resultCount = resultFiles.length;

  // For deep scans, check phase timeline
  const timelinePath = join(scanDir, 'phase-timeline.json');
  if (existsSync(timelinePath)) {
    try {
      const timeline = JSON.parse(readFileSync(timelinePath, 'utf8'));
      const phases = timeline.phases || [];
      const completed = phases.filter(p => p.status === 'completed').length;
      const total = Math.max(phases.length, 5); // at least 5 phases expected
      const pct = Math.round((completed / total) * 100);
      const current = phases.findLast(p => p.status === 'in_progress');
      const detail = current ? current.name : (completed === total ? 'Complete' : 'Initializing...');
      return {
        pct,
        detail,
        phases,
        completedSources: resultFiles
      };
    } catch {}
  }

  // For deep scans without phase-timeline.json, synthesize phases from file-based heuristics.
  // Detect deep scans by presence of orchestrator artifacts (scan-spec, competitor-map, orchestration-config, etc.)
  const deepScanMarkers = ['scan-spec.json', 'competitor-map.json', 'orchestration-config.json', 'competitive-landscape.json'];
  const hasDeepScanMarker = files.some(f => deepScanMarkers.includes(f));
  const scanLogPath = join(scanDir, 'scan.log');
  const isDeepScan = hasDeepScanMarker || (existsSync(scanLogPath) && !files.some(f => f === 'manifest.json'));
  if (isDeepScan) {
    // Estimate progress from output files present in the scan directory
    const hasSpec = files.some(f => f === 'scan-spec.json');
    const hasCompMap = files.some(f => f === 'competitor-map.json' || f === 'competitive-landscape.json');
    const hasScanData = files.some(f => f.includes('-result.json') || f.includes('pain') || f.includes('reddit') || f.includes('trustpilot') || f.includes('hn-'));
    const hasSynthesis = files.some(f => f.includes('synthesis') || f.includes('unmet-needs') || f.includes('gap-matrix') || f.includes('opportunities'));
    const hasReport = files.some(f => f === 'report.json' || f === 'report.html');

    const phaseNames = ['Planning', 'Discovery', 'Scanning', 'Synthesis', 'Report generation'];
    const phaseStatuses = [
      hasSpec ? 'completed' : (files.length > 1 ? 'in_progress' : 'pending'),
      hasCompMap ? 'completed' : (hasSpec ? 'in_progress' : 'pending'),
      hasSynthesis ? 'completed' : (hasCompMap && hasScanData ? 'in_progress' : (hasScanData ? 'in_progress' : 'pending')),
      hasReport ? 'completed' : (hasSynthesis ? 'in_progress' : 'pending'),
      hasReport ? 'completed' : 'pending',
    ];

    const phases = phaseNames.map((name, i) => ({ name, status: phaseStatuses[i] }));
    const completedCount = phaseStatuses.filter(s => s === 'completed').length;
    const currentPhase = phases.find(p => p.status === 'in_progress');
    const pct = Math.round((completedCount / 5) * 100);
    const detail = currentPhase ? currentPhase.name : (completedCount === 5 ? 'Complete' : 'Initializing...');

    return {
      pct: Math.max(pct, resultCount > 0 ? 5 : 0),
      detail,
      phases,
      completedSources: resultFiles,
    };
  }

  let manifest = null;
  const manifestPath = resolve(scanDir, 'manifest.json');
  if (existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch {
      // manifest not yet fully written
    }
  }

  if (manifest && Array.isArray(manifest.expectedSources) && manifest.expectedSources.length > 0) {
    const total = manifest.expectedSources.length;
    const pct = Math.round((resultCount / total) * 100);
    const completedSources = resultFiles.map((f) => f.replace(/-result\.json$/, ''));
    return {
      pct,
      detail: `${resultCount}/${total} sources complete`,
      completedSources,
    };
  }

  // No manifest or no expectedSources — approximate from any .json files
  const jsonFiles = files.filter((f) => f.endsWith('.json') && f !== 'manifest.json');
  const count = jsonFiles.length;
  return {
    pct: count > 0 ? Math.min(Math.round(count * 10), 95) : 0,
    detail: count > 0 ? `${count} results so far` : 'Initializing...',
    completedSources: resultFiles.map((f) => f.replace(/-result\.json$/, '')),
  };
}

/**
 * Start queued scans when slots are available.
 */
function drainQueue(db) {
  while (children.size < MAX_CONCURRENT && queue.length > 0) {
    const next = queue.shift();
    if (next.mode === 'quick') {
      startQuickScan(db, next);
    } else {
      startDeepScan(db, next);
    }
  }
}

/**
 * Mark stale running scans as failed on startup (e.g. after server crash).
 */
export function cleanupStale(db) {
  const running = getRunningScans(db);
  for (const scan of running) {
    if (scan.pid) {
      try {
        process.kill(scan.pid, 0);
        // Process is still alive — leave it alone
      } catch {
        // Process is gone
        updateScan(db, scan.id, {
          status: 'failed',
          error: 'Server restarted during scan',
          completed_at: new Date().toISOString(),
        });
      }
    } else {
      updateScan(db, scan.id, {
        status: 'failed',
        error: 'Server restarted during scan',
        completed_at: new Date().toISOString(),
      });
    }
  }
}

/**
 * Return the number of currently running scans.
 */
export function getActiveCount() {
  return children.size;
}

/**
 * Return the number of scans waiting in the queue.
 */
export function getQueueLength() {
  return queue.length;
}

/**
 * Get log lines for a scan, optionally starting from a cursor position.
 * Returns { lines: [{ts, text}], cursor: number }
 */
export function getScanLogs(scanId, fromCursor = 0) {
  const entry = logs.get(scanId);
  if (entry && entry.lines.length > 0) {
    // Convert absolute cursor to array index.
    // totalCount tracks all lines ever added; lines.length is the current buffer size.
    // The oldest line in the buffer has absolute index (totalCount - lines.length).
    const bufferStart = entry.totalCount - entry.lines.length;
    const arrayIndex = Math.max(0, fromCursor - bufferStart);
    const newLines = entry.lines.slice(arrayIndex);
    return { lines: newLines, cursor: entry.totalCount };
  }

  // Fall back to disk — find scan.log in the scan directory
  return getLogsFromDisk(scanId, fromCursor);
}

function getLogsFromDisk(scanId, fromCursor) {
  const scanDir = join(resolve(process.env.DATA_DIR || './data'), 'scans', scanId);
  const logPath = join(scanDir, 'scan.log');

  try {
    if (!existsSync(logPath)) return { lines: [], cursor: 0 };

    const content = readFileSync(logPath, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);

    const sliced = lines.slice(fromCursor);
    return { lines: sliced, cursor: lines.length };
  } catch {
    return { lines: [], cursor: 0 };
  }
}

/**
 * Check if a scan has any logs (in memory or on disk).
 */
export function hasScanLogs(scanId) {
  const entry = logs.get(scanId);
  if (entry && entry.lines.length > 0) return true;

  const scanDir = join(resolve(process.env.DATA_DIR || './data'), 'scans', scanId);
  const logPath = join(scanDir, 'scan.log');
  return existsSync(logPath);
}

const LOG_RETENTION_MS = 60 * 60 * 1000;
setInterval(() => {
  // Only clean up logs for scans not in children map (completed/failed)
  for (const [scanId, entry] of logs) {
    if (!children.has(scanId) && entry.lines.length > 0) {
      const lastTs = entry.lines[entry.lines.length - 1].ts;
      if (Date.now() - lastTs > LOG_RETENTION_MS) {
        logs.delete(scanId);
      }
    }
  }
}, 10 * 60 * 1000).unref();
