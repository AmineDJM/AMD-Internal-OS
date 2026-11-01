import { mkdirSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
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
 *
 * `K7_FAUX=1` (vrai modèle injoignable — crédit épuisé) : chaque demande est jouée au FAUX modèle par
 * `scripts/e2e/k7-export-de-tout.ts` (le code de production du fil et des outils, lecture et export réels) ; l'écran,
 * le lien et le téléchargement restent ceux de l'app. Le passage au vrai modèle est alors à refaire.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
const DB = process.env.DATABASE_URL ?? "";
if (!/@(localhost|127\.0\.0\.1)(:\d+)?\/amd_bench/.test(DB)) throw new Error("Ce parcours ne tourne que sur amd_bench (base locale).");
const prisma = new PrismaClient({ datasources: { db: { url: DB } } });
const SORTIE = "bench-out/k7-tout";
mkdirSync(SORTIE, { recursive: true });
const TAG = `__k7e2e_${Date.now().toString(36)}`;
const FAUX = process.env.K7_FAUX === "1";

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
  // (Au faux modèle, le script dépose dans la conversation COURANTE : on y reste.)
  if (!FAUX) await page.getByRole("button", { name: /Nouvelle conversation/ }).first().click({ timeout: 3_000 }).catch(() => {});
  return page.getByPlaceholder(/Écrivez, glissez des fichiers/);
}

/** Poser une demande ; attendre soit un lien de téléchargement de PLUS (un export), soit un texte attendu (une lecture). */
async function demander(page: Page, texte: string, attendre: { liensAvant: number } | { texte: RegExp }, cas?: "paiements" | "medecins") {
  if (FAUX) {
    if (!cas) return; // au faux modèle, la lecture seule n'a rien à montrer : la demande d'export relit la liste elle-même
    const sortie = execFileSync("npx", ["tsx", "scripts/e2e/k7-export-de-tout.ts", cas, "super@adventum-bench.dz", texte], { env: process.env, stdio: ["ignore", "pipe", "pipe"] }).toString();
    const { conversation } = JSON.parse(sortie.slice(sortie.indexOf("{"))) as { conversation: string };
    await page.goto(`/ia?c=${conversation}`);
  } else {
    await page.getByPlaceholder(/Écrivez, glissez des fichiers/).fill(texte);
    await page.getByRole("button", { name: "Envoyer", exact: true }).first().click();
  }
  await expect(page.getByText(texte).last()).toBeVisible();
  if ("texte" in attendre) await expect(page.getByText(attendre.texte).last()).toBeVisible({ timeout: 300_000 });
  else await expect.poll(async () => page.locator('a[href*="/raw?dl=1"]').count(), { timeout: 300_000 }).toBeGreaterThan(attendre.liensAvant);
}

/**
 * TÉLÉCHARGER par le lien de la réponse et vérifier le CONTENU (signature du format). Le nom suggéré n'est pas jugé :
 * le Chromium sans interface de ce conteneur nomme « download » tout fichier dont le nom accentué arrive en UTF-8
 * (RFC 5987, `filename*`) — mesuré hors de l'ERP, avec ou sans attribut `download` ; l'en-tête du serveur, lui, est juste.
 */
async function telecharger(page: Page, nom: string, format: "xlsx" | "pdf") {
  const lien = page.locator('a[href*="/raw?dl=1"]').last();
  const [d] = await Promise.all([page.waitForEvent("download", { timeout: 60_000 }), lien.click()]);
  const chemin = `${SORTIE}/${nom}.${format}`;
  await d.saveAs(chemin);
  expect(statSync(chemin).size).toBeGreaterThan(1_000);
  const debut = readFileSync(chemin).subarray(0, 5).toString("latin1");
  expect(debut.startsWith(format === "pdf" ? "%PDF" : "PK")).toBe(true);
}

test("l'export de tout : demandes de paiement en Excel, puis la liste des médecins de Blida en PDF", async ({ page }, info) => {
  const appareil = info.project.name;
  const erreurs: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") erreurs.push(m.text()); });
  page.on("pageerror", (e) => erreurs.push(String(e)));
  const capture = (etape: string) => page.screenshot({ path: `${SORTIE}/${appareil}-${etape}.png` });

  await (await ouvrir(page)).waitFor({ timeout: 60_000 });
  await demander(page, "Exporte-moi les demandes de paiement en attente en Excel.", { liensAvant: await page.locator('a[href*="/raw?dl=1"]').count() }, "paiements");
  await capture("1-demandes-paiement");
  await telecharger(page, `${appareil}-1-demandes-paiement`, "xlsx");

  await demander(page, "Donne-moi la liste des médecins de Blida.", { texte: /Amrani/ });
  await demander(page, FAUX ? "Exporte la liste des médecins de Blida en PDF." : "Exporte-la en PDF.", { liensAvant: await page.locator('a[href*="/raw?dl=1"]').count() }, "medecins");
  await capture("2-medecins-pdf");
  await telecharger(page, `${appareil}-2-medecins-blida`, "pdf");

  expect(erreurs, erreurs.join("\n")).toEqual([]);
});
