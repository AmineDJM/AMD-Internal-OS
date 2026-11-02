const { chromium } = require('playwright');
const fs = require('fs');
const OUT = process.argv[2];
const BASE = 'http://localhost:3000';
const pages = [
  ['ad-pro', '/ad-pro'], ['centre-de-paiement', '/centre-de-paiement'], ['drive', '/drive'],
  ['rh', '/rh'], ['assistant', '/assistant'], ['mon-espace', '/mon-espace'], ['sponsoring', '/sponsoring'],
];
(async () => {
  const browser = await chromium.launch();
  const report = [];
  for (const vp of [{ name: 'desktop', width: 1366, height: 860 }, { name: 'mobile', width: 375, height: 812 }]) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, locale: 'fr-FR', isMobile: vp.name === 'mobile', hasTouch: vp.name === 'mobile' });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 200)); });
    await page.goto(BASE + '/login');
    await page.fill('input[name=email]', 'admin@adventum.dz');
    await page.fill('input[name=password]', 'Audit2026!x');
    await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30000 }), page.click('button[type=submit]')]);
    for (const [slug, path] of pages) {
      errors.length = 0;
      const t0 = Date.now();
      const resp = await page.goto(BASE + path, { waitUntil: 'networkidle', timeout: 60000 }).catch((e) => null);
      const ms = Date.now() - t0;
      await page.waitForTimeout(500);
      const m = await page.evaluate(() => {
        const main = document.querySelector('main');
        const over = [];
        const vw = document.documentElement.clientWidth;
        for (const el of document.querySelectorAll('main *')) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.right > vw + 1) { let p = el.parentElement, clip = false; while (p && p !== main) { const s = getComputedStyle(p); if (/(auto|scroll|hidden)/.test(s.overflowX)) { clip = true; break; } p = p.parentElement; } if (!clip) over.push(el.tagName + '.' + String(el.className).slice(0, 60) + ' right=' + Math.round(r.right)); }
        }
        const inputs = [...document.querySelectorAll('input:not([type=hidden]),select,textarea')].filter((i) => { if (i.getAttribute('aria-label') || i.getAttribute('aria-labelledby') || i.closest('label')) return false; if (i.id && document.querySelector(`label[for="${CSS.escape(i.id)}"]`)) return false; return true; }).map((i) => i.outerHTML.slice(0, 120));
        const btns = [...document.querySelectorAll('button,a[href]')].filter((b) => !(b.innerText || '').trim() && !b.getAttribute('aria-label') && !b.getAttribute('title') && !b.querySelector('[aria-label],img[alt]')).map((b) => b.outerHTML.slice(0, 140));
        const small = [...document.querySelectorAll('button,a[href]')].filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0 && (r.height < 32 || r.width < 32) && getComputedStyle(b).display !== 'inline'; }).length;
        return { h1: document.querySelector('h1')?.innerText, scrollW: main ? main.scrollWidth : 0, clientW: main ? main.clientWidth : 0, docOverflow: document.documentElement.scrollWidth > vw, over: over.slice(0, 8), unlabeled: inputs.slice(0, 8), nUnlabeled: inputs.length, unnamedBtns: btns.slice(0, 8), nUnnamed: btns.length, smallTargets: small };
      });
      await page.screenshot({ path: `${OUT}/${slug}-${vp.name}.png`, fullPage: false });
      report.push({ vp: vp.name, slug, status: resp && resp.status(), ms, ...m, errors: [...errors].slice(0, 6) });
    }
    await ctx.close();
  }
  fs.writeFileSync(`${OUT}/../pw-report.json`, JSON.stringify(report, null, 2));
  await browser.close();
  console.log('ok');
})();
