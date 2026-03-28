import { Router } from 'express';
import crypto from 'node:crypto';
import { join } from 'node:path';
import { readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { createScan, getScan, listScans, updateScan } from '../db.mjs';
import { startScan, cancelScan, checkProgress, getScanLogs } from '../scanner.mjs';

export function createScansRouter(db, dataDir) {
  const router = Router();

  // POST / — Create and start a scan
  router.post('/', async (req, res) => {
    try {
      const { name, domain, sources, timeout, mode } = req.body;
      const id = crypto.randomUUID();
      const scanDir = join(dataDir, 'scans', id);

      mkdirSync(scanDir, { recursive: true });

      await createScan(db, {
        id,
        name,
        domain,
        sources: sources || 'all',
        mode: mode || 'full',
        scanDir,
        createdBy: req.user.id,
      });

      await startScan(db, { id, domain, sources, scanDir, timeout, mode: mode || 'full' });

      res.status(201).json({ id, status: 'queued' });
    } catch (err) {
      console.error('POST /scans error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET / — List scans
  router.get('/', async (req, res) => {
    try {
      const { status, limit = 20, offset = 0 } = req.query;
      const { scans, total } = await listScans(db, {
        status,
        limit: Number(limit),
        offset: Number(offset),
      });

      const enriched = scans.map((scan) => {
        if (scan.status === 'running') {
          try {
            const progress = checkProgress(scan.scan_dir);
            return { ...scan, progress };
          } catch {
            return scan;
          }
        }
        return scan;
      });

      res.json({ scans: enriched, total });
    } catch (err) {
      console.error('GET /scans error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /:id — Get scan detail with live progress
  router.get('/:id', async (req, res) => {
    try {
      const scan = await getScan(db, req.params.id);
      if (!scan) {
        return res.status(404).json({ error: 'Scan not found' });
      }

      const result = { ...scan };
      if (scan.status === 'running') {
        try {
          const progress = checkProgress(scan.scan_dir);
          Object.assign(result, { progress });
        } catch {
          // progress unavailable, return scan without it
        }
      }

      res.json(result);
    } catch (err) {
      console.error('GET /scans/:id error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // DELETE /:id — Cancel a scan
  router.delete('/:id', async (req, res) => {
    try {
      const scan = await getScan(db, req.params.id);
      if (!scan) {
        return res.status(404).json({ error: 'Scan not found' });
      }

      await cancelScan(db, req.params.id);

      res.json({ status: 'cancelled' });
    } catch (err) {
      console.error('DELETE /scans/:id error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /:id/logs — Get historical log lines for a scan
  router.get('/:id/logs', (req, res) => {
    try {
      const scan = getScan(db, req.params.id);
      if (!scan) return res.status(404).json({ error: 'Scan not found' });

      const fromCursor = parseInt(req.query.cursor) || 0;
      const logData = getScanLogs(req.params.id, fromCursor);
      res.json(logData);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /:id/events — SSE stream for live progress + log lines
  router.get('/:id/events', (req, res) => {
    try {
      const scan = getScan(db, req.params.id);
      if (!scan) return res.status(404).json({ error: 'Scan not found' });

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('\n');

      let logCursor = 0;

      // Immediately flush existing logs on connect (don't wait for first interval tick)
      try {
        const initLogs = getScanLogs(req.params.id, 0);
        if (initLogs.lines.length > 0) {
          res.write(`event: logs\ndata: ${JSON.stringify({ lines: initLogs.lines, cursor: initLogs.cursor })}\n\n`);
          logCursor = initLogs.cursor;
        }
        // Also send initial progress
        if (scan.status === 'running' && scan.scan_dir) {
          const initProgress = checkProgress(scan.scan_dir);
          const progressData = { status: scan.status, pct: initProgress.pct, detail: initProgress.detail };
          if (initProgress.phases) progressData.phases = initProgress.phases;
          res.write(`event: progress\ndata: ${JSON.stringify(progressData)}\n\n`);
        }
      } catch {}

      const interval = setInterval(() => {
        try {
          const current = getScan(db, req.params.id);
          const status = current?.status || 'unknown';
          let pct = current?.progress_pct || 0;
          let detail = current?.progress_detail || '';
          let progress = null;

          if (status === 'running' && current?.scan_dir) {
            progress = checkProgress(current.scan_dir);
            pct = progress.pct;
            detail = progress.detail;
          }

          // Send progress event — include phases if available
          const progressData = { status, pct, detail };
          if (progress && progress.phases) {
            progressData.phases = progress.phases;
          }
          res.write(`event: progress\ndata: ${JSON.stringify(progressData)}\n\n`);

          // Send new log lines
          const logData = getScanLogs(req.params.id, logCursor);
          if (logData.lines.length > 0) {
            res.write(`event: logs\ndata: ${JSON.stringify({ lines: logData.lines, cursor: logData.cursor })}\n\n`);
            logCursor = logData.cursor;
          }

          if (['completed', 'failed', 'cancelled'].includes(status)) {
            // Send final logs flush
            const finalLogs = getScanLogs(req.params.id, logCursor);
            if (finalLogs.lines.length > 0) {
              res.write(`event: logs\ndata: ${JSON.stringify({ lines: finalLogs.lines, cursor: finalLogs.cursor })}\n\n`);
            }
            res.write(`event: done\ndata: ${JSON.stringify({ status })}\n\n`);
            clearInterval(interval);
            res.end();
          }
        } catch (err) {
          // ignore polling errors
        }
      }, 1000); // Poll every 1 second for more responsive updates

      req.on('close', () => {
        clearInterval(interval);
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /:id/artifacts — List scan output files
  router.get('/:id/artifacts', async (req, res) => {
    try {
      const scan = await getScan(db, req.params.id);
      if (!scan) {
        return res.status(404).json({ error: 'Scan not found' });
      }

      let entries;
      try {
        entries = readdirSync(scan.scan_dir);
      } catch {
        return res.json({ files: [] });
      }

      const files = entries.filter((f) => f.endsWith('.json'));
      res.json({ files });
    } catch (err) {
      console.error('GET /scans/:id/artifacts error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /:id/artifacts/:filename — Download a specific artifact file
  router.get('/:id/artifacts/:filename', async (req, res) => {
    try {
      const scan = await getScan(db, req.params.id);
      if (!scan) {
        return res.status(404).json({ error: 'Scan not found' });
      }

      const { filename } = req.params;
      if (filename.includes('..') || filename.includes('/')) {
        return res.status(400).json({ error: 'Invalid filename' });
      }

      const filePath = join(scan.scan_dir, filename);
      let content;
      try {
        content = readFileSync(filePath, 'utf-8');
      } catch {
        return res.status(404).json({ error: 'File not found' });
      }

      res.set('Content-Type', 'application/json');
      res.send(content);
    } catch (err) {
      console.error('GET /scans/:id/artifacts/:filename error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
