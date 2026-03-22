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

  const commentsUrl = 'https://www.kickstarter.com/projects/magpietech/vh-80a-auto-calibration-dual-laser-distance-meter/comments';
  console.error('[inspect] navigating to comments URL: ' + commentsUrl);
  await page.goto(commentsUrl, { waitUntil: 'networkidle2', timeout: 45000 });
  await new Promise(r => setTimeout(r, 3000));

  const state1 = await page.evaluate(() => {
    const section = document.querySelector('.js-project-comments-content');
    const cls = section ? section.className : 'not found';
    const commentEls = document.querySelectorAll('.comment');
    return {
      url: window.location.href,
      title: document.title,
      commentSectionClass: cls,
      commentCount: commentEls.length,
      sampleHTML: commentEls[0] ? commentEls[0].outerHTML.substring(0, 400) : 'none',
    };
  });
  console.error('State after goto:', JSON.stringify(state1, null, 2));

  // Try clicking the comments tab
  await page.evaluate(() => {
    const link = document.querySelector('a.js-load-project-comments, a[data-content="comments"]');
    if (link) { console.log('Clicking link:', link.href || link.className); link.click(); }
    else console.log('No comments link found');
  });
  await new Promise(r => setTimeout(r, 3000));

  const state2 = await page.evaluate(() => {
    const section = document.querySelector('.js-project-comments-content');
    const cls = section ? section.className : 'not found';
    const commentEls = document.querySelectorAll('.comment');
    // All comment-related classes
    const allCommentLike = document.querySelectorAll('[class*="comment"]');
    return {
      commentSectionClass: cls,
      commentCount: commentEls.length,
      allCommentLikeCount: allCommentLike.length,
      sampleHTML: commentEls[0] ? commentEls[0].outerHTML.substring(0, 600) : 'none',
      allCommentClasses: Array.from(allCommentLike).slice(0,5).map(el => ({
        cls: el.className.substring(0,80),
        text: el.textContent.trim().substring(0,60),
      })),
    };
  });
  console.error('State after click:', JSON.stringify(state2, null, 2));

  // Scroll to bottom and check again
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await new Promise(r => setTimeout(r, 2000));
  const state3 = await page.evaluate(() => {
    const commentEls = document.querySelectorAll('.comment');
    return {
      commentCount: commentEls.length,
      sampleComments: Array.from(commentEls).slice(0, 3).map(el => ({
        text: el.textContent.trim().substring(0, 100),
        html: el.outerHTML.substring(0, 300),
      })),
    };
  });
  console.error('State after scroll:', JSON.stringify(state3, null, 2));

  await page.close();
}

run().then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1); });
