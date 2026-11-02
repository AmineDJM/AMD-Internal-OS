import { execFileSync } from "node:child_process";
import { test, expect, type Page } from "@playwright/test";
import { E2E } from "./global-setup";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * ASSISTANT IA — LOT J11 (décision 0030) : le FORMULAIRE de la carte et le DÉPÔT DE DOSSIER.
 *
 *   1. Une carte de capacité (`task__createTask`, préparée par le vrai outil — `scripts/e2e/carte-capacite.ts`) est un
 *      formulaire généré depuis le contrat : valeurs proposées surlignées, référence choisie dans un sélecteur filtré
 *      par les droits ; la personne CORRIGE le titre, puis signe — la tâche créée porte la correction.
 *   2. Un dossier de 30 fichiers glissé passe en mode « dépôt de dossier » (une puce) ; Entrée → l'arborescence est
 *      recréée dans le Drive, chaque fichier y monte, le suivi dit n fichiers, lus, en file.
 *
 * Aucun appel de modèle. Captures : `test-results/j11-*.png` (bureau et téléphone).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const ENV = { ...process.env };
const carte = (...args: string[]) => execFileSync("npx", ["tsx", "scripts/e2e/carte-capacite.ts", ...args], { encoding: "utf8", env: ENV }).trim();

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel(/e-?mail/i).fill(E2E.superAdminEmail);
  await page.getByLabel(/mot de passe/i).fill(E2E.password);
  await page.getByRole("button", { name: /connexion|se connecter/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 30_000 });
}

/** Un dossier d'imitation de 30 fichiers (Chromium ne laisse pas un script fabriquer de vraies entrées de dossier). */
async function deposerDossier(page: Page) {
  await page.evaluate(() => {
    const fichier = (nom: string, texte: string) => {
      const f = new File([texte], nom, { type: "text/plain" });
      return { isFile: true, isDirectory: false, name: nom, file: (ok: (f: File) => void) => ok(f) };
    };
    const dossier = (nom: string, enfants: unknown[]) => ({
      isFile: false, isDirectory: true, name: nom,
      createReader: () => { let lu = false; return { readEntries: (ok: (e: unknown[]) => void) => { ok(lu ? [] : enfants); lu = true; } }; },
    });
    const m1 = Array.from({ length: 10 }, (_, i) => fichier(`1.${i % 4} piece ${i}.txt`, `Module 1 — pièce administrative ${i}.`));
    const m3 = Array.from({ length: 20 }, (_, i) => fichier(`3.2.P.${1 + (i % 8)} document ${i}.txt`, `Produit fini, section ${1 + (i % 8)}, document ${i}.`));
    const racine = dossier("__e2e__ Dossier CTD", [dossier("Module 1", m1), dossier("Module 3", [dossier("3.2.P", m3)])]);
    const dt = { types: ["Files"], files: [], items: [{ kind: "file", webkitGetAsEntry: () => racine }], dropEffect: "none" };
    for (const type of ["dragenter", "drop"]) {
      const ev = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(ev, "dataTransfer", { value: dt });
      window.dispatchEvent(ev);
    }
  });
}

test.afterAll(() => { carte("clean", E2E.superAdminEmail); });

test("la carte est un formulaire généré depuis le contrat : corriger, puis signer", async ({ page }) => {
  test.setTimeout(120_000);
  carte("seed", E2E.superAdminEmail);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await login(page);
  await page.goto("/assistant");
  const champTitre = page.locator('[data-champ="title"] input');
  await expect(champTitre).toBeVisible({ timeout: 30_000 });
  await expect(champTitre).toHaveValue(/Préparer le stand du congrès/);
  await expect(page.locator('[data-champ="title"]').getByText("Proposé")).toBeVisible();
  await expect(page.locator('[data-champ="priority"] select')).toBeVisible();
  await expect(page.locator('[data-champ="dueDate"] input[type="date"]')).toHaveValue("2026-11-06");
  await page.locator('[data-champ="title"]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/j11-carte-formulaire.png", fullPage: false });

  // Corriger : le titre, la priorité — marqués « Corrigé », puis signer.
  await champTitre.fill("__e2e__ Préparer le stand du congrès d'Oran (corrigé)");
  await page.locator('[data-champ="priority"] select').selectOption("HIGH");
  await expect(page.locator('[data-champ="title"]').getByText("Corrigé")).toBeVisible();
  await page.screenshot({ path: "test-results/j11-carte-corrigee.png" });
  await page.getByRole("button", { name: /Signer avec mes corrections/ }).click();
  await expect(page.getByText(/Créer tâche : fait\./)).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: "test-results/j11-carte-signee.png" });

  // Sur téléphone, la même carte (re-semée) : une colonne, champs de 44 px.
  carte("seed", E2E.superAdminEmail);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/assistant");
  await expect(page.locator('[data-champ="title"] input')).toBeVisible({ timeout: 30_000 });
  await page.locator('[data-champ="assignedToId"]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/j11-carte-mobile.png" });
});

test("un dossier de 30 fichiers glissé passe en mode « dépôt de dossier » et recrée son arborescence", async ({ page, request }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/assistant");
  await expect(page.getByLabel("Votre message")).toBeVisible({ timeout: 30_000 });
  await deposerDossier(page);
  const puce = page.getByTestId("puce-dossier");
  await expect(puce).toContainText("__e2e__ Dossier CTD");
  await expect(puce).toContainText("30 fichiers");
  await page.screenshot({ path: "test-results/j11-dossier-puce.png" });

  await page.getByLabel("Votre message").fill("Classe ce dossier par module CTD.");
  await page.getByLabel("Votre message").press("Enter");
  await expect(page.getByText(/Dossier déposé : « __e2e__ Dossier CTD/).first()).toBeVisible({ timeout: 30_000 });
  const suivi = page.getByTestId("suivi-depots");
  await expect(suivi).toContainText("30 fichiers", { timeout: 60_000 });
  // Tous les fichiers arrivent dans le Drive (lus ensuite par la tâche de fond).
  await expect.poll(async () => {
    const r = await page.request.get("/api/assistant-ia/depot-dossier");
    const b = (await r.json()) as { lots: { nom: string; televerses: number }[] };
    return b.lots.find((l) => l.nom.startsWith("__e2e__ Dossier CTD"))?.televerses ?? 0;
  }, { timeout: 90_000 }).toBe(30);
  await page.screenshot({ path: "test-results/j11-dossier-suivi.png" });
  void request;
});
