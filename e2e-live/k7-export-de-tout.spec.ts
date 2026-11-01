import { mkdirSync, statSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * K7 SUITE — « L'EXPORT DE TOUT », DANS L'APP, AU VRAI MODÈLE (décision 0037 § 7, Direction 01/11/2026).
 *
 *   1. « Exporte-moi les demandes de paiement en attente en Excel. » → le classeur, téléchargé par son lien.
 *   2. « Donne-moi la liste des médecins de Blida. » puis « Exporte-la en PDF. » → la liste relue, le PDF téléchargé.
 * Captures à chaque étape (`bench-out/k7-tout/`), AUCUNE erreur de console. Trois médecins de Blida sont semés pour le
 * temps du parcours. Base LOCALE du banc seulement.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
const DB = process.env.DATABASE_URL ?? "";
if (!/@(localhost|127\.0\.0\.1)(:\d+)?\/amd_bench/.test(DB)) throw new Error("Ce parcours ne tourne que sur amd_bench (base locale).");
const prisma = new PrismaClient({ datasources: { db: { url: DB } } });
const SORTIE = "bench-out/k7-tout";
mkdirSync(SORTIE, { recursive: true });
const TAG = `__k7e2e_${Date.now().toString(36)}`;

test.beforeAll(async () => {
  await prisma.medicalDoctor.createMany({
    data: [
      { name: `Dr Amrani Karim ${TAG}`, specialty: "Cardiologie", wilaya: "Blida", institution: "CHU Blida Frantz Fanon" },
      { name: `Dr Belkacem Nadia ${TAG}`, specialty: "Oncologie", wilaya: "Blida", institution: "CHU Blida Frantz Fanon" },
      { name: `Dr Cherif Yasmine ${TAG}`, specialty: "Pédiatrie", wilaya: "Blida", institution: "EPH Blida Boufarik" },
    ],
  });
});
test.afterAll(async () => {
  await prisma.medicalDoctor.deleteMany({ where: { name: { endsWith: TAG } } });
  await prisma.$disconnect();
});

async function ouvrir(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email professionnel").fill("super@adventum-bench.dz");
  await page.getByLabel("Mot de passe").fill("Bench12345!");
  await page.getByRole("button", { name: /connexion|se connecter/i }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 60_000 });
  await page.goto("/ia");
  // Une conversation NEUVE : l'historique d'un passage précédent ne doit rien souffler.
  await page.getByRole("button", { name: /Nouvelle conversation/ }).first().click().catch(() => {});
  return page.getByPlaceholder(/Écrivez, glissez des fichiers/);
}

/** Poser une demande ; attendre soit un lien de téléchargement de PLUS (un export), soit un texte attendu (une lecture). */
async function demander(page: Page, texte: string, attendre: { liensAvant: number } | { texte: RegExp }) {
  await page.getByPlaceholder(/Écrivez, glissez des fichiers/).fill(texte);
  await page.getByRole("button", { name: "Envoyer", exact: true }).first().click();
  await expect(page.getByText(texte).last()).toBeVisible();
  if ("texte" in attendre) await expect(page.getByText(attendre.texte).last()).toBeVisible({ timeout: 300_000 });
  else await expect.poll(async () => page.locator('a[href*="/raw?dl=1"]').count(), { timeout: 300_000 }).toBeGreaterThan(attendre.liensAvant);
}

async function telecharger(page: Page, nom: string, extension: RegExp) {
  const lien = page.locator('a[href*="/raw?dl=1"]').last();
  const [d] = await Promise.all([page.waitForEvent("download", { timeout: 60_000 }), lien.click()]);
  const chemin = `${SORTIE}/${nom}-${d.suggestedFilename()}`;
  await d.saveAs(chemin);
  expect(d.suggestedFilename()).toMatch(extension);
  expect(statSync(chemin).size).toBeGreaterThan(1_000);
}

test("l'export de tout : demandes de paiement en Excel, puis la liste des médecins de Blida en PDF", async ({ page }, info) => {
  const appareil = info.project.name;
  const erreurs: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") erreurs.push(m.text()); });
  page.on("pageerror", (e) => erreurs.push(String(e)));
  const capture = (etape: string) => page.screenshot({ path: `${SORTIE}/${appareil}-${etape}.png` });

  await (await ouvrir(page)).waitFor({ timeout: 60_000 });
  await demander(page, "Exporte-moi les demandes de paiement en attente en Excel.", { liensAvant: await page.locator('a[href*="/raw?dl=1"]').count() });
  await capture("1-demandes-paiement");
  await telecharger(page, `${appareil}-1`, /\.xlsx$/);

  await demander(page, "Donne-moi la liste des médecins de Blida.", { texte: /Amrani/ });
  await demander(page, "Exporte-la en PDF.", { liensAvant: await page.locator('a[href*="/raw?dl=1"]').count() });
  await capture("2-medecins-pdf");
  await telecharger(page, `${appareil}-2`, /\.pdf$/);

  expect(erreurs, erreurs.join("\n")).toEqual([]);
});
