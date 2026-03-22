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

  console.error('[inspect] loading search page...');
  await page.goto('https://www.kickstarter.com/discover/advanced?term=project+management&sort=most_backed', { waitUntil: 'networkidle2', timeout: 45000 });
  await new Promise(r => setTimeout(r, 3000));

  const result = await page.evaluate(() => {
    const sel = (s) => document.querySelectorAll(s).length;
    const links = [...document.querySelectorAll('a[href*="/projects/"]')];
    const projectLinks = links.map(l => {
      const m = l.href.match(/\/projects\/([^/]+)\/([^/?#]+)/);
      return m ? { href: l.href.split('?')[0], text: l.textContent.trim().substring(0,80) } : null;
    }).filter(Boolean);
    const unique = [...new Map(projectLinks.map(x=>[x.href,x])).values()];

    // Find what wraps these links
    const firstLink = links.find(l => l.href.match(/\/projects\/([^/]+)\/([^/?#]+)/));
    let cardHtml = 'none';
    let cardSelector = 'none';
    if (firstLink) {
      // Walk up to find the project card container
      let el = firstLink;
      for (let i = 0; i < 6; i++) {
        el = el.parentElement;
        if (!el) break;
        cardHtml = el.outerHTML.substring(0, 800);
        cardSelector = el.tagName + (el.className ? '.' + el.className.trim().split(/\s+/).join('.') : '');
        if (el.className && (el.className.includes('project') || el.className.includes('card') || el.className.includes('Project'))) {
          break;
        }
      }
    }

    // Sample 3 unique links
    return {
      '[data-pid]': sel('[data-pid]'),
      '[class*=ProjectCard]': sel('[class*="ProjectCard"]'),
      '[class*=project-card]': sel('[class*="project-card"]'),
      '[class*=js-react-proj]': sel('[class*="js-react-proj"]'),
      'a[href*/projects/]': links.length,
      uniqueProjectLinks: unique.length,
      sampleLinks: unique.slice(0,5),
      firstCardHTML: cardHtml,
      firstCardSelector: cardSelector,
    };
  });

  process.stderr.write(JSON.stringify(result, null, 2) + '\n');

  // Also capture a snippet of the project grid HTML
  const gridHtml = await page.evaluate(() => {
    // Try to find the project grid container
    const candidates = [
      document.querySelector('[class*="project-grid"]'),
      document.querySelector('[class*="results"]'),
      document.querySelector('ul'),
      document.querySelector('ol'),
    ].filter(Boolean);
    return candidates.map(el => ({
      tag: el.tagName,
      cls: el.className.substring(0,100),
      html: el.outerHTML.substring(0, 600),
    }));
  });
  process.stderr.write('\nGrid candidates:\n' + JSON.stringify(gridHtml.slice(0,3), null, 2) + '\n');

  await page.close();
}

run().then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1); });
