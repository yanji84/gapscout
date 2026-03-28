import { Router } from 'express';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getScan } from '../db.mjs';

function renderErrorPage(title, message, scanName, basePath) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — GapScout</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0a0a0a; color: #fafafa; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
  .card { background: #111; border: 1px solid #222; border-radius: 12px; padding: 48px; max-width: 480px; text-align: center; }
  h1 { font-size: 20px; margin-bottom: 12px; font-weight: 700; }
  p { color: #888; font-size: 14px; line-height: 1.6; margin-bottom: 24px; }
  .scan-name { color: #3b82f6; }
  a { display: inline-block; padding: 8px 20px; background: #3b82f6; color: #fff; border-radius: 8px; text-decoration: none; font-size: 13px; font-weight: 500; }
  a:hover { background: #2563eb; }
</style></head><body><div class="card">
  <h1>${title}</h1>
  <p>${message}</p>
  <a href="${basePath || ''}/">Back to Dashboard</a>
</div></body></html>`;
}

export function createReportsRouter(db, dataDir) {
  const router = Router();
  const basePath = process.env.BASE_PATH || '';

  // GET /:id — Get report JSON for a scan
  router.get('/:id', async (req, res) => {
    try {
      const scan = await getScan(db, req.params.id);
      if (!scan) {
        return res.status(404).json({ error: 'Scan not found' });
      }

      if (!scan.scan_dir || !existsSync(scan.scan_dir)) {
        return res.status(404).json({ error: 'Report not yet available' });
      }

      const reportPath = join(scan.scan_dir, 'report.json');
      if (!existsSync(reportPath)) {
        return res.status(404).json({ error: 'Report not yet available' });
      }

      const raw = readFileSync(reportPath, 'utf-8');
      const report = JSON.parse(raw);
      res.json(report);
    } catch (err) {
      console.error('GET /reports/:id error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /:id/html — Get report as HTML
  router.get('/:id/html', async (req, res) => {
    try {
      const scan = await getScan(db, req.params.id);
      if (!scan) {
        return res.status(404).type('html').send(renderErrorPage(
          'Scan Not Found',
          'This scan does not exist or has been deleted.',
          null, basePath
        ));
      }

      if (!scan.scan_dir || !existsSync(scan.scan_dir)) {
        return res.status(404).type('html').send(renderErrorPage(
          'Report Not Available',
          `The scan <span class="scan-name">${scan.name || scan.domain}</span> completed but no report data was generated. The scan directory may be missing.`,
          scan.name, basePath
        ));
      }

      const htmlPath = join(scan.scan_dir, 'report.html');
      if (existsSync(htmlPath)) {
        const html = readFileSync(htmlPath, 'utf-8');
        res.set('Content-Type', 'text/html');
        return res.send(html);
      }

      const jsonPath = join(scan.scan_dir, 'report.json');
      if (existsSync(jsonPath)) {
        const raw = readFileSync(jsonPath, 'utf-8');
        const reportData = JSON.parse(raw);
        const data = reportData.data || reportData;

        // Check if report has the grouped format needed for HTML generation
        if (!data.groups || !data.groups.length) {
          return res.status(422).type('html').send(renderErrorPage(
            'Insufficient Data',
            `The scan <span class="scan-name">${scan.name || scan.domain}</span> completed but did not collect enough data to generate a visual report. This can happen when sources return no results or encounter errors. Try running the scan again.`,
            scan.name, basePath
          ));
        }

        try {
          const { generateHtml } = await import('../../scripts/web-report.mjs');
          const html = generateHtml(reportData);
          res.set('Content-Type', 'text/html');
          return res.send(html);
        } catch (htmlErr) {
          console.error('HTML generation error:', htmlErr.message);
          return res.status(500).type('html').send(renderErrorPage(
            'Report Generation Failed',
            `An error occurred while generating the HTML report for <span class="scan-name">${scan.name || scan.domain}</span>. The raw JSON data may still be available via the API.`,
            scan.name, basePath
          ));
        }
      }

      return res.status(404).type('html').send(renderErrorPage(
        'Report Not Available',
        `The scan <span class="scan-name">${scan.name || scan.domain}</span> completed but no report was generated. This may indicate the scan process failed silently. Try running the scan again.`,
        scan.name, basePath
      ));
    } catch (err) {
      console.error('GET /reports/:id/html error:', err);
      res.status(500).type('html').send(renderErrorPage(
        'Internal Error',
        'Something went wrong while loading this report. Please try again.',
        null, basePath
      ));
    }
  });

  return router;
}
