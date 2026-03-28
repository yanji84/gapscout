import { Router } from 'express';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getScan, getOrCreateChatSession, updateChatSessionClaudeId, addChatMessage, getChatMessages } from '../db.mjs';

const CHAT_TIMEOUT_MS = 120_000; // 2 minutes

export function createChatRouter(db, dataDir) {
  const router = Router();

  // GET /scans/:scanId/chat — get chat history
  router.get('/scans/:scanId/chat', (req, res) => {
    try {
      const scan = getScan(db, req.params.scanId);
      if (!scan) return res.status(404).json({ error: 'Scan not found' });

      const session = getOrCreateChatSession(db, scan.id);
      const messages = getChatMessages(db, session.id);
      res.json({ session, messages });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /scans/:scanId/chat — send a message, get response
  router.post('/scans/:scanId/chat', (req, res) => {
    try {
      const scan = getScan(db, req.params.scanId);
      if (!scan) return res.status(404).json({ error: 'Scan not found' });

      const { message } = req.body;
      if (!message || !message.trim()) return res.status(400).json({ error: 'Message required' });

      const session = getOrCreateChatSession(db, scan.id);

      console.log('[chat] scan_id:', scan.id, 'domain:', scan.domain, 'scan_dir:', scan.scan_dir);
      console.log('[chat] session.claude_session_id:', session.claude_session_id);

      // Save user message
      addChatMessage(db, { sessionId: session.id, userId: req.user.id, role: 'user', content: message });

      // Build report context for first message
      let reportContext = '';
      if (!session.claude_session_id) {
        const scanDir = scan.scan_dir;
        console.log('[chat] First message path — scanDir:', scanDir);
        if (scanDir) {
          const reportPath = join(scanDir, 'report.json');
          const rawPath = join(scanDir, 'raw-scan.json');

          if (existsSync(reportPath)) {
            try {
              const report = JSON.parse(readFileSync(reportPath, 'utf8'));
              const data = report.data || report;

              console.log('[chat] Report loaded from:', reportPath);
              console.log('[chat] report.data exists:', 'data' in report);
              console.log('[chat] data keys (first 5):', Object.keys(data).slice(0, 5));
              console.log('[chat] Has competitiveMap:', !!data.competitiveMap, 'painAnalysis:', !!data.painAnalysis, 'executiveSummary:', !!data.executiveSummary);

              if (data.competitiveMap || data.painAnalysis || data.executiveSummary) {
                // Deep scan format — include whole sections, trimmed to 50KB budget.
                // Sub-keys vary between markets so we avoid picking specific fields.
                const contextObj = {
                  domain: scan.domain,
                  executiveSummary: data.executiveSummary,
                  competitiveMap: data.competitiveMap,
                  painAnalysis: data.painAnalysis,
                  opportunities: Array.isArray(data.opportunities) ? data.opportunities.slice(0, 8) : data.opportunities,
                  unmetNeeds: data.unmetNeeds,
                  switchingAnalysis: data.switchingAnalysis,
                  gapSummary: data.gapMatrix?.gapSummary || data.gapMatrix?.gaps,
                };
                reportContext = JSON.stringify(contextObj, null, 0);
                // Trim to 50KB to stay within reasonable prompt size
                if (reportContext.length > 50000) {
                  reportContext = reportContext.slice(0, 50000) + '..."}}';
                }
                console.log('[chat] Deep scan context:', reportContext.length, 'bytes');
              } else {
                // Quick scan format
                reportContext = JSON.stringify({
                  domain: scan.domain,
                  groups: (data.groups || []).map(g => ({
                    category: g.category, postCount: g.postCount, depth: g.depth,
                    buildScore: g.buildScore, verdict: g.verdict,
                    topQuotes: (g.topQuotes || []).slice(0, 3),
                    sourceNames: g.sourceNames,
                  })),
                  meta: data.meta,
                }, null, 0);
              }
            } catch (err) {
              console.error('[chat] Report parse/context error:', err.message);
            }
          } else if (existsSync(rawPath)) {
            try {
              const raw = JSON.parse(readFileSync(rawPath, 'utf8'));
              reportContext = JSON.stringify({
                domain: scan.domain,
                postCount: (raw.data?.posts || []).length,
                posts: (raw.data?.posts || []).slice(0, 20).map(p => ({
                  title: p.title, score: p.score, source: p._source,
                })),
              }, null, 0);
            } catch {}
          }
        }
      }

      console.log('[chat] reportContext length:', reportContext.length, 'bytes, starts with:', reportContext.slice(0, 100));

      // Build the prompt
      let prompt;
      if (!session.claude_session_id) {
        prompt = `You are a market intelligence analyst helping a team understand scan results for the "${scan.domain}" market.

Here is the scan data:
${reportContext || 'No report data available yet.'}

The team will ask you questions about competitors, pain points, opportunities, and market gaps. Be specific, cite data from the report, and give actionable insights. Keep responses concise.

First question from the team:
${message}`;
      } else {
        prompt = message;
      }

      // Build claude CLI args — use --resume <session-id> for follow-ups
      const args = ['-p', '--output-format', 'json', '--verbose'];

      let chatCwd;
      if (session.claude_session_id) {
        // Follow-up: resume the specific session (cwd doesn't matter for --resume)
        args.push('--resume', session.claude_session_id);
        chatCwd = '/tmp';
      } else {
        // First message: use /tmp as cwd to prevent Claude CLI from auto-resuming
        // a previous session in the project tree. Report data is passed in the prompt.
        chatCwd = '/tmp';
      }

      const child = spawn('/usr/bin/claude', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: chatCwd,
        env: { ...process.env, HOME: '/root' },
      });

      // Write prompt and close stdin
      child.stdin.write(prompt);
      child.stdin.end();

      let stdoutData = '';
      let stderrData = '';
      let responded = false;

      child.stdout.on('data', (chunk) => { stdoutData += chunk.toString(); });
      child.stderr.on('data', (chunk) => { stderrData += chunk.toString(); });

      // Timeout — kill the process if it takes too long
      const timeout = setTimeout(() => {
        if (!responded) {
          responded = true;
          child.kill('SIGTERM');
          const errMsg = 'AI response timed out. Please try again.';
          addChatMessage(db, { sessionId: session.id, userId: null, role: 'assistant', content: errMsg });
          res.json({ role: 'assistant', content: errMsg, ok: false, timeout: true });
        }
      }, CHAT_TIMEOUT_MS);

      child.on('close', (code, signal) => {
        clearTimeout(timeout);
        if (responded) return; // already timed out
        responded = true;

        let fullResponse = '';
        let claudeSessionId = session.claude_session_id;

        if (code !== 0 && code !== null) {
          console.error('[chat] claude exit code=' + code + ' signal=' + signal + ' stderr=' + stderrData.slice(0, 300));
        }

        // Parse JSON output
        try {
          const events = JSON.parse(stdoutData);
          const evtArray = Array.isArray(events) ? events : [events];

          for (const evt of evtArray) {
            if (evt.session_id && !claudeSessionId) {
              claudeSessionId = evt.session_id;
              updateChatSessionClaudeId(db, session.id, claudeSessionId);
            }
            if (evt.type === 'result' && evt.result) {
              fullResponse = evt.result;
            }
            if (evt.type === 'assistant' && evt.message?.content) {
              for (const block of evt.message.content) {
                if (block.type === 'text' && block.text) {
                  fullResponse += block.text;
                }
              }
            }
          }
        } catch {
          fullResponse = stdoutData.trim() || '';
        }

        // If resume/continue failed (session not found), clear the session ID so next attempt starts fresh
        if (code !== 0 && session.claude_session_id && !fullResponse) {
          console.error('[chat] Session resume failed, clearing session ID for fresh start');
          updateChatSessionClaudeId(db, session.id, null);
          const errMsg = stderrData.includes('No conversation found')
            ? 'Chat session expired. Please send your message again to start a new conversation.'
            : 'AI encountered an error. Please try again.';
          addChatMessage(db, { sessionId: session.id, userId: null, role: 'assistant', content: errMsg });
          res.json({ role: 'assistant', content: errMsg, ok: false });
          return;
        }

        if (fullResponse.trim()) {
          addChatMessage(db, { sessionId: session.id, userId: null, role: 'assistant', content: fullResponse.trim() });
        }

        res.json({ role: 'assistant', content: fullResponse.trim() || 'No response.', ok: code === 0 });
      });

      child.on('error', (err) => {
        clearTimeout(timeout);
        if (responded) return;
        responded = true;
        console.error('[chat] spawn error:', err.message);
        res.status(500).json({ error: 'Failed to start AI: ' + err.message });
      });

    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({ error: err.message });
      }
    }
  });

  return router;
}
