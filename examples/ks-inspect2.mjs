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

  console.error('[inspect] wsUrl:', wsUrl);
  const browser = await puppeteer.connect({ browserWSEndpoint: wsUrl });
  const page = await browser.newPage();
  console.error('[inspect] navigating...');
  await page.goto('https://www.kickstarter.com/discover/advanced?term=project+management&sort=most_backed', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await new Promise(r => setTimeout(r, 4000));
  console.error('[inspect] page loaded, evaluating...');

  const info = await page.evaluate(() => {
    const sel = (s) => document.querySelectorAll(s).length;
    const links = [...document.querySelectorAll('a[href*="/projects/"]')];
    const matches = links.map(l => {
      const m = l.href.match(/\/projects\/([^/]+)\/([^/?#]+)/);
      return m ? { href: l.href.split('?')[0], text: l.textContent.trim().substring(0,60) } : null;
    }).filter(Boolean);
    const unique = [...new Map(matches.map(x=>[x.href,x])).values()];

    const allEls = document.querySelectorAll('[data-pid], [class*="ProjectCard"], [class*="project-card"], .js-react-proj-card');
    // Also check for list-based layouts
    const liEls = document.querySelectorAll('li');
    const articleEls = document.querySelectorAll('article');

    return {
      dataPid: sel('[data-pid]'),
      ProjectCard: sel('[class*="ProjectCard"]'),
      project_card: sel('[class*="project-card"]'),
      jsReactProjCard: sel('.js-react-proj-card'),
      projectLinks: links.length,
      uniqueProjectLinks: unique.length,
      sampleLinks: unique.slice(0,5),
      sampleCardHTML: allEls[0] ? allEls[0].outerHTML.substring(0,800) : 'none',
      firstListItem: liEls[0] ? liEls[0].outerHTML.substring(0,600) : 'none',
      articles: articleEls.length,
      h1: document.querySelector('h1') ? document.querySelector('h1').textContent.substring(0,100) : null,
    };
  });

  console.log(JSON.stringify(info, null, 2));
  await page.close();
}

run().then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1); });
