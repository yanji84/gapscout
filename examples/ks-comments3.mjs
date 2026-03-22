import puppeteer from 'puppeteer-core';
import http from 'node:http';

async function run() {
  const wsUrl = await new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:9222/json/version', res => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => { try { resolve(JSON.parse(b).webSocketDebuggerUrl); } catch(e) { reject(e); } });
    }).on('error', reject);
  });

  const browser = await puppeteer.connect({ browserWSEndpoint: wsUrl });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36');

  await page.goto('https://www.kickstarter.com/projects/magpietech/vh-80a-auto-calibration-dual-laser-distance-meter/comments', { waitUntil: 'networkidle2', timeout: 45000 });
  await new Promise(r => setTimeout(r, 4000));

  // Click the comments tab
  await page.evaluate(() => {
    const link = document.querySelector('a.js-load-project-comments, a[data-content="comments"]');
    if (link) link.click();
  });
  await new Promise(r => setTimeout(r, 4000));

  // Scroll to load more
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await new Promise(r => setTimeout(r, 2000));

  const result = await page.evaluate(() => {
    // The actual comment LI items
    const items = document.querySelectorAll('#react-project-comments li');
    const sample = Array.from(items).slice(0, 5).map(li => ({
      html: li.outerHTML.substring(0, 500),
      textContent: li.textContent.trim().substring(0, 200),
    }));

    return {
      totalLiItems: items.length,
      sample,
    };
  });

  console.error(JSON.stringify(result, null, 2));
  await page.close();
}

run().then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1); });
