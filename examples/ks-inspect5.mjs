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

  // 1. Search page — full card structure
  console.error('\n=== SEARCH PAGE ===');
  await page.goto('https://www.kickstarter.com/discover/advanced?term=project+management&sort=most_backed', { waitUntil: 'networkidle2', timeout: 45000 });
  await new Promise(r => setTimeout(r, 2000));

  const searchResult = await page.evaluate(() => {
    // data-pid cards
    const cards = [...document.querySelectorAll('[data-pid]')];
    const cardData = cards.slice(0,3).map(card => {
      const titleA = card.querySelector('.project-card__title, a[href*="/projects/"]');
      const blurbEl = card.querySelector('.project-card__blurb, [class*="blurb"]');
      const backerEl = card.querySelector('[class*="backer"], [data-backers]');
      const metaEl = card.querySelector('[class*="meta"], [class*="fund"], [class*="percent"]');
      return {
        pid: card.dataset.pid,
        outerHTMLShort: card.outerHTML.substring(0,1200),
        title: titleA ? titleA.textContent.trim() : null,
        titleHref: titleA ? titleA.href : null,
        blurb: blurbEl ? blurbEl.textContent.trim() : null,
        backer: backerEl ? backerEl.textContent.trim() : null,
        meta: metaEl ? metaEl.textContent.trim() : null,
      };
    });
    return { count: cards.length, cards: cardData };
  });
  process.stderr.write('Search page [data-pid] cards: ' + searchResult.count + '\n');
  process.stderr.write(JSON.stringify(searchResult.cards, null, 2) + '\n');

  // Get first project URL
  const firstProjectUrl = searchResult.cards[0]?.titleHref;
  if (!firstProjectUrl) { console.error('No project URL found'); return; }

  // 2. Project page structure
  console.error('\n=== PROJECT PAGE: ' + firstProjectUrl + ' ===');
  await page.goto(firstProjectUrl, { waitUntil: 'networkidle2', timeout: 45000 });
  await new Promise(r => setTimeout(r, 2000));

  const projectResult = await page.evaluate(() => {
    const sel = (s) => { const el = document.querySelector(s); return el ? el.textContent.trim().substring(0,100) : null; };
    const selAll = (s) => [...document.querySelectorAll(s)].map(el => el.textContent.trim().substring(0,50));

    return {
      h1: sel('h1'),
      title: sel('h1.project-name, h1[class*="title"], h1'),
      // Description selectors
      desc1: sel('#description-and-risks .full-description'),
      desc2: sel('.story-content p'),
      desc3: sel('.story p'),
      desc4: sel('[class*="description"] p'),
      // Backers
      backers1: sel('[class*="backers-count"]'),
      backers2: sel('[data-backers-count]'),
      backers3: sel('.num-backers'),
      backers4: sel('[class*="backer"] b'),
      backers5: sel('[class*="backing"]'),
      backers6: sel('[data-goal]'),
      // Funding
      fund1: sel('[class*="pledged"]'),
      fund2: sel('[data-pledged]'),
      fund3: sel('.money.pledged'),
      fund4: sel('[class*="raised"]'),
      // Comments tab
      commentsTab: sel('a[href*="/comments"]'),
      commentsTabSpan: sel('a[href*="/comments"] span'),
      // Page classes hint
      bodyClasses: document.body.className.substring(0,200),
      // Stats section HTML
      statsHtml: (() => {
        const stats = document.querySelector('[class*="stats"], [class*="Stats"], .project-stats, .NS_projects__featured_rewards');
        return stats ? stats.outerHTML.substring(0, 1000) : 'none';
      })(),
    };
  });
  process.stderr.write(JSON.stringify(projectResult, null, 2) + '\n');

  // 3. Comments page
  const commentsUrl = firstProjectUrl.replace(/\/$/, '') + '/comments';
  console.error('\n=== COMMENTS PAGE: ' + commentsUrl + ' ===');
  await page.goto(commentsUrl, { waitUntil: 'networkidle2', timeout: 45000 });
  await new Promise(r => setTimeout(r, 2000));

  const commentsResult = await page.evaluate(() => {
    const sel = (s) => document.querySelectorAll(s).length;
    const commentEls = [...document.querySelectorAll('[class*="comment"], .comment')];
    const sample = commentEls.slice(0,3).map(el => {
      const body = el.querySelector('[class*="body"], [class*="text"], p');
      return {
        cls: el.className.substring(0,80),
        bodyText: body ? body.textContent.trim().substring(0,100) : el.textContent.trim().substring(0,100),
        html: el.outerHTML.substring(0,400),
      };
    });
    return {
      '[class*=comment]': sel('[class*="comment"]'),
      '.comment': sel('.comment'),
      totalCommentEls: commentEls.length,
      sample,
    };
  });
  process.stderr.write(JSON.stringify(commentsResult, null, 2) + '\n');

  await page.close();
}

run().then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1); });
