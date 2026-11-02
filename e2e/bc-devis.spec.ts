import { execFileSync } from "node:child_process";
import { test, expect, type Page } from "@playwright/test";
import { E2E } from "./global-setup";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « CRÉE UN BC EN PDF » DEPUIS LE DEVIS INSIGNE (lot B1, décision 0049) — serveur RÉEL, mode app (`/ia`),
 * au bureau et sur iPhone 13.
 *
 * Le décor (`scripts/e2e/carte-bc-devis.ts`) dépose le vrai PDF du devis au Drive et prépare la carte par l'outil réel,
 * SANS validateur ni société — exactement l'appel de l'assistant à « Crée un bc en pdf ». Ici : la carte résume
 * (fournisseur INSIGNE, société Adventum, 27 lignes, 794 500 DZD HT), le détail des 27 lignes s'ouvre dans le panneau,
 * aucune question de validateur, ni « seuil », ni Regulatory ; « Créer le BC (PDF) » → « Ouvrir le PDF » sert un PDF.
 * Aucun appel de modèle. Captures : `test-results/b1-*.png`. 0 défilement horizontal.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const ENV = { ...process.env };
const decor = (...args: string[]) => execFileSync("npx", ["tsx", "scripts/e2e/carte-bc-devis.ts", ...args], { encoding: "utf8", env: ENV }).trim();

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel(/e-?mail/i).fill(E2E.superAdminEmail);
  await page.getByLabel(/mot de passe/i).fill(E2E.password);
  await page.getByRole("button", { name: /connexion|se connecter/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 30_000 });
}

const ECRANS = [{ nom: "bureau", largeur: 1440, hauteur: 900 }, { nom: "iphone13", largeur: 390, hauteur: 844 }] as const;

test.afterAll(() => { decor("clean", E2E.superAdminEmail); });

for (const ecran of ECRANS) {
  test(`B1 (${ecran.nom}) — la carte du BC depuis le devis INSIGNE, le détail au panneau, « Créer le BC (PDF) » rend le PDF`, async ({ page }) => {
    test.setTimeout(150_000);
    decor("seed", E2E.superAdminEmail);
    await page.setViewportSize({ width: ecran.largeur, height: ecran.hauteur });
    await login(page);
    await page.goto("/ia");

    const carte = page.locator('[data-glass="true"]').filter({ hasText: "Bon de commande — INSIGNE" }).last();
    await expect(carte).toBeVisible({ timeout: 30_000 });
    await expect(carte).toContainText("INSIGNE · NIF 001216098700412");
    await expect(carte).toContainText(/Adventum Pharma \(client du devis\)/i);
    await expect(carte).toContainText("27 lignes");
    await expect(carte).toContainText(/794\s500 DZD/);
    await expect(carte).toContainText("à désigner à l'envoi en validation");
    await expect(carte).not.toContainText(/seuil/i);
    await expect(carte).not.toContainText(/Regulatory/i);
    await expect(carte.getByText(/lus sur le tableau du PDF/)).toHaveCount(1);
    await carte.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `test-results/b1-${ecran.nom}-1-carte.png`, fullPage: false });

    // Le détail des 27 lignes : au panneau, pas dans la conversation.
    await carte.getByTestId("carte-ouvrir-detail").click();
    const detail = page.getByTestId("panneau-detail-carte");
    await expect(detail.locator("li")).toHaveCount(27);
    await expect(detail).toContainText("2. Conception ADV — 1 × 145");
    await page.screenshot({ path: `test-results/b1-${ecran.nom}-2-detail.png` });
    await page.keyboard.press("Escape");
    await expect(detail).toHaveCount(0);

    // Le geste principal.
    await carte.getByRole("button", { name: "Créer le BC (PDF)" }).click();
    const lien = carte.getByRole("link", { name: /Ouvrir le PDF/ });
    await expect(lien).toBeVisible({ timeout: 60_000 });
    await expect(carte).toContainText(/créé en brouillon/);
    await page.screenshot({ path: `test-results/b1-${ecran.nom}-3-cree.png` });
    const href = await lien.getAttribute("href");
    const r = await page.request.get(href!);
    expect(r.status()).toBe(200);
    expect(r.headers()["content-type"]).toContain("application/pdf");

    const deborde = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    expect(deborde).toBe(false);
  });
}
