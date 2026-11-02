/**
 * LOT M1 — les écrans des décisions du 01/11/2026, sur serveur de production SANS `APP_MODE` (l'ERP) : « Sans plafond »
 * dans Administration › Contrôle de l'IA › Consommation IA et dans Administration › IA (le tableau de consommation), et
 * « X jetons sur Y » dans le panneau « Ce qu'il retient ». Après `scripts/bench/m1-jetons.ts` (la mémoire consolidée).
 *   M1_BASE=http://localhost:3101 DATABASE_URL=…/amd_bench npx tsx scripts/bench/m1-ecrans-jetons.ts
 */
import { chromium, devices, type Page } from "@playwright/test";

const BASE = process.env.M1_BASE ?? "http://localhost:3101";
const SORTIE = "docs/assistant/preuves/m1";

async function connecter(p: Page, email: string) {
  await p.goto(`${BASE}/login`);
  await p.getByLabel(/e-?mail/i).fill(email);
  await p.getByLabel(/mot de passe/i).fill("Bench12345!");
  await p.getByRole("button", { name: /connexion|se connecter/i }).click();
  await p.waitForURL((u) => !u.pathname.startsWith("/login"));
}

(async () => {
  const b = await chromium.launch({ executablePath: process.env.PW_CHROMIUM ?? "/opt/pw-browsers/chromium" });
  const admin = await (await b.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
  admin.setDefaultTimeout(120_000);
  await connecter(admin, "super@adventum-bench.dz");
  await admin.goto(`${BASE}/admin/ai/consommation`);
  await admin.getByText("Plafond par personne et par jour").waitFor();
  console.log("console :", await admin.getByText("Sans plafond", { exact: true }).first().isVisible());
  await admin.screenshot({ path: `${SORTIE}/erp-admin-consommation-sans-plafond.jpg`, type: "jpeg", quality: 62 });
  await admin.goto(`${BASE}/admin/ai`);
  const plafonds = admin.getByLabel("Plafonds en cours").first();
  await plafonds.waitFor();
  await plafonds.scrollIntoViewIfNeeded();
  console.log("tableau :", (await plafonds.innerText()).replace(/\s+/g, " ").slice(0, 160));
  await admin.screenshot({ path: `${SORTIE}/erp-admin-ia-plafonds.jpg`, type: "jpeg", quality: 62 });

  const p = await (await b.newContext({ ...devices["iPhone 13"] })).newPage();
  p.setDefaultTimeout(120_000);
  await connecter(p, process.env.M1_EMAIL ?? "yacine.benali@adventum-bench.dz");
  await p.goto(`${BASE}/assistant`);
  await p.getByLabel("Votre message").first().waitFor();
  await p.getByRole("button", { name: "Plus d'outils" }).click();
  await p.getByRole("menuitem", { name: /Ma mémoire/ }).first().click();
  const occ = p.getByTestId("occupation-memoire");
  await occ.waitFor();
  console.log("panneau :", (await occ.innerText()).replace(/\s+/g, " ").slice(0, 120));
  await p.screenshot({ path: `${SORTIE}/erp-iphone-memoire-jetons.jpg`, type: "jpeg", quality: 62 });
  await b.close();
})().catch((e) => { console.error(e); process.exit(1); });
