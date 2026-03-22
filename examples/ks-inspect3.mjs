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

  // Set a realistic user agent
  await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36');

  console.error('[inspect] navigating to Kickstarter search...');
  try {
    await page.goto('https://www.kickstarter.com/discover/advanced?term=project+management&sort=most_backed', { waitUntil: 'networkidle2', timeout: 45000 });
  } catch(e) {
    console.error('[inspect] goto error:', e.message);
  }
  await new Promise(r => setTimeout(r, 5000));

  const result = await page.evaluate(() => {
    return {
      url: window.location.href,
      title: document.title,
      bodyLength: document.body ? document.body.innerHTML.length : 0,
      bodySnippet: document.body ? document.body.innerHTML.substring(0, 1000) : 'no body',
      // All classes on div elements
      divClasses: Array.from(document.querySelectorAll('div[class]')).slice(0,20).map(d => d.className.substring(0,100)),
      // Check for challenge/error page
      isChallenge: document.title.includes('moment') || document.title.includes('challenge'),
    };
  });

  process.stderr.write(JSON.stringify(result, null, 2) + '\n');
  await page.close();
}

run().then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1); });
