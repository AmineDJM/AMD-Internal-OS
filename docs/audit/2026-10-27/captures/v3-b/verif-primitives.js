const { chromium } = require('playwright');
// Banc V3-B : node verif-primitives.js (ADMIN_PASSWORD du Super Admin local, serveur sur :3000). Captures à côté.
const OUT = __dirname;
const BASE = 'http://localhost:3000';
const log = (...a) => console.log(...a);
async function etatDialogue(p) {
  return p.evaluate(() => {
    const d = document.querySelector('[role=alertdialog]');
    if (!d) return null;
    const a = document.activeElement;
    return { modal: d.getAttribute('aria-modal'), titre: document.getElementById(d.getAttribute('aria-labelledby'))?.innerText,
      focusDedans: d.contains(a), focus: (a?.innerText || a?.tagName || '').trim(), boutons: [...d.querySelectorAll('button')].map((b) => b.innerText.trim()) };
  });
}
(async () => {
  const b = await chromium.launch();
  const res = {};
  for (const vp of [{ n: 'bureau', w: 1366, h: 860 }, { n: '375', w: 375, h: 812 }]) {
    const ctx = await b.newContext({ viewport: { width: vp.w, height: vp.h }, locale: 'fr-FR', isMobile: vp.n === '375', hasTouch: vp.n === '375' });
    const p = await ctx.newPage();
    const erreurs = []; p.on('pageerror', (e) => erreurs.push(String(e).slice(0, 200)));
    p.on('console', (m) => { if (m.type() === 'error') erreurs.push('console: ' + m.text().slice(0, 160)); });
    await p.goto(BASE + '/login');
    await p.fill('input[name=email]', 'admin@adventum.dz'); await p.fill('input[name=password]', process.env.ADMIN_PASSWORD);
    await Promise.all([p.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30000 }), p.click('button[type=submit]')]);
    const r = res[vp.n] = {};

    // ── 1. Entités : désactiver → dialogue de confirmation accessible ──
    await p.goto(BASE + '/admin/entites', { waitUntil: 'networkidle' });
    const bouton = p.locator('button[aria-label^="Désactiver"]').first();
    const nomBouton = (await bouton.getAttribute('aria-label')) || (await bouton.innerText());
    await bouton.click();
    await p.waitForSelector('[role=alertdialog]');
    r.entites_ouvert = await etatDialogue(p);
    for (let i = 0; i < 6; i++) await p.keyboard.press('Tab');
    r.entites_apres6Tab = (await etatDialogue(p)).focusDedans;
    await p.screenshot({ path: `${OUT}/entites-dialogue-${vp.n}.png` });
    await p.keyboard.press('Escape');
    await p.waitForTimeout(200);
    r.entites_echapFerme = (await etatDialogue(p)) === null;
    r.entites_focusRendu = await p.evaluate(() => (document.activeElement?.getAttribute('aria-label') || document.activeElement?.innerText || '').trim());
    r.entites_boutonOuvreur = nomBouton;

    // ── 2. Réglages : coupure réseau sur « Enregistrer les limites » → bandeau, pas de page d'erreur ──
    await p.goto(BASE + '/admin/settings', { waitUntil: 'networkidle' });
    await p.route('**/admin/settings', (route) => (route.request().method() === 'POST' ? route.abort('internetdisconnected') : route.continue()));
    await p.click('button:has-text("Enregistrer les limites")');
    await p.waitForTimeout(2500);
    r.settings = await p.evaluate(() => ({
      pageErreur: document.body.innerText.includes("n'a pas pu s'afficher"),
      alertes: [...document.querySelectorAll('[role=alert]')].map((a) => a.innerText.trim()).filter(Boolean),
      boutonActif: !document.querySelector('button:disabled') || ![...document.querySelectorAll('button')].find((b) => b.innerText.includes('Enregistrer les limites'))?.disabled,
    }));
    await p.screenshot({ path: `${OUT}/reglages-coupure-${vp.n}.png` });
    await p.unroute('**/admin/settings');

    // ── 3. Drive : créer un dossier, le mettre à la corbeille via le dialogue ──
    await p.goto(BASE + '/drive', { waitUntil: 'networkidle' });
    const nom = `Vérif V3-B ${vp.n} ${Date.now() % 100000}`;
    await p.click('button:has-text("Nouveau dossier")');
    await p.waitForTimeout(400);
    const champ = p.locator('[role=dialog] input:not([type=hidden]), [aria-modal=true] input:not([type=hidden])').first();
    await champ.fill(nom);
    await champ.press('Enter');
    await p.waitForSelector(`text=${nom}`, { timeout: 15000 });
    r.drive_cree = true;
    const ligne = p.locator(`tr:has-text("${nom}"), [role=row]:has-text("${nom}")`).first();
    const caseACocher = ligne.locator('input[type=checkbox]').first();
    if (await caseACocher.count()) {
      await caseACocher.check({ force: true });
      await p.click('button:has-text("Supprimer")');
    } else {
      await ligne.locator(`button[aria-label^="Actions"]`).first().click();
      await p.click('[role=menu] >> text=/corbeille/i');
    }
    const dlg = await p.waitForSelector('[role=alertdialog]', { timeout: 5000 }).catch(() => null);
    r.drive_dialogue = dlg ? await etatDialogue(p) : 'pas de dialogue (geste sans confirmation)';
    await p.screenshot({ path: `${OUT}/drive-dialogue-${vp.n}.png` });
    if (dlg) await p.click('[role=alertdialog] button[type=submit]');
    await p.waitForTimeout(2500);
    r.drive_disparu = !(await p.locator(`text=${nom}`).count());
    r.horsCadre375 = await p.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    r.erreursConsole = erreurs.slice(0, 5);
    await ctx.close();
  }
  console.log(JSON.stringify(res, null, 1));
  await b.close();
})().catch((e) => { console.error('ECHEC', e.message); process.exit(1); });
