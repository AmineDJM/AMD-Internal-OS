/**
 * LOT M1 (décision 0045) — le panneau « Ce qu'il retient » CÔTÉ ERP (`/assistant`), sur serveur de production SANS
 * `APP_MODE` (l'ERP), base de banc, après `scripts/bench/m1-audit.ts` (la mémoire du compte est déjà remplie).
 *   rm -rf .next && npm run build:render
 *   DATABASE_URL=…/amd_bench … npx next start -p 3101
 *   M1_BASE=http://localhost:3101 DATABASE_URL=…/amd_bench npx tsx scripts/bench/m1-audit-erp.ts
 * Captures : `docs/assistant/preuves/m1/erp-{bureau,iphone}-panneau.jpg`.
 */
import { chromium, devices } from "@playwright/test";

const BASE = process.env.M1_BASE ?? "http://localhost:3101";

(async () => {
  const b = await chromium.launch({ executablePath: process.env.PW_CHROMIUM ?? "/opt/pw-browsers/chromium" });
  for (const [nom, opts] of [["bureau", { viewport: { width: 1440, height: 900 } }], ["iphone", { ...devices["iPhone 13"] }]] as const) {
    const p = await (await b.newContext(opts as never)).newPage();
    p.setDefaultTimeout(120_000);
    await p.goto(`${BASE}/login`);
    await p.getByLabel(/e-?mail/i).fill(process.env.M1_EMAIL ?? "yacine.benali@adventum-bench.dz");
    await p.getByLabel(/mot de passe/i).fill("Bench12345!");
    await p.getByRole("button", { name: /connexion|se connecter/i }).click();
    await p.waitForURL((u) => !u.pathname.startsWith("/login"));
    await p.goto(`${BASE}/assistant`);
    await p.getByLabel("Votre message").first().waitFor();
    // Sur téléphone, « Ma mémoire » est dans « Plus d'outils ».
    if (nom === "iphone") await p.getByRole("button", { name: "Plus d'outils" }).click();
    await p.getByRole(nom === "iphone" ? "menuitem" : "button", { name: /Ma mémoire/ }).first().click();
    const panneau = p.getByRole("dialog", { name: "Ce qu'il retient" });
    await panneau.getByTestId("souvenir").first().waitFor();
    await p.waitForTimeout(800);
    await p.screenshot({ path: `docs/assistant/preuves/m1/erp-${nom}-panneau.jpg`, type: "jpeg", quality: 62 });
    console.log(nom, "souvenirs affichés :", await panneau.getByTestId("souvenir").count(), "— compteur :", await panneau.getByTestId("compteur-memoire").innerText());
  }
  await b.close();
})().catch((e) => { console.error(e); process.exit(1); });
