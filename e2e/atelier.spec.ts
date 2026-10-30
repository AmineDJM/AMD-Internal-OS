import { execFileSync } from "node:child_process";
import { test, expect, type Page } from "@playwright/test";
import { E2E } from "./global-setup";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'ATELIER (J3, décision 0017) — deux documents en onglets à côté de la conversation ; une modification de
 * l'assistant arrive EN DIRECT et SURLIGNÉE ; la personne la refuse (elle disparaît), la rétablit, l'accepte ;
 * « Enregistrer » crée une NOUVELLE version ; une diapositive ajoutée apparaît. Captures bureau et téléphone.
 *
 * Aucun appel de modèle : le geste de l'assistant est joué par `scripts/e2e/atelier.ts geste` — le même code que
 * l'outil `modifier_document` — et l'écran ne l'apprend que par sa relecture, exactement comme en vrai.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const ENV = {
  ...process.env,
  DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/amd_internal_os?schema=public",
  NEXTAUTH_SECRET: E2E.authSecret,
};
const atelier = (...args: string[]) => execFileSync("npx", ["tsx", "scripts/e2e/atelier.ts", ...args], { encoding: "utf8", env: ENV });

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel(/e-?mail/i).fill(E2E.superAdminEmail);
  await page.getByLabel(/mot de passe/i).fill(E2E.password);
  await page.getByRole("button", { name: /connexion|se connecter/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 30_000 });
}

test("Atelier : Word et PowerPoint en onglets, modification diffusée surlignée, refuser puis accepter, enregistrer → nouvelle version", async ({ page }) => {
  test.setTimeout(180_000);
  const decor = JSON.parse(atelier("seed", E2E.superAdminEmail)) as { docx: { sessionId: string }; pptx: { sessionId: string } };
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/assistant");

  // 1. Les deux documents ouverts par l'assistant apparaissent en ONGLETS, l'Atelier s'ouvre seul.
  const panneau = page.getByTestId("atelier");
  await expect(panneau).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("atelier-onglet")).toHaveCount(2);
  await page.getByTestId("atelier-onglet").filter({ hasText: "Contrat Benali" }).click();
  const scene = page.getByTestId("atelier-onglet-contenu").first();
  await expect(scene).toHaveAttribute("data-format", "DOCX");
  await expect(scene.locator(".artifact-bloc").nth(2)).toContainText("3 mois");
  await page.screenshot({ path: "e2e-screenshots/atelier-1-onglets.png" });

  // 2. L'assistant modifie le contrat : la modification arrive, surlignée, et attend la revue.
  atelier("geste", E2E.superAdminEmail, decor.docx.sessionId, JSON.stringify([{ action: "remplacer_texte", chercher: "3 mois", remplacer: "6 mois" }]));
  const surligne = scene.locator(".artifact-bloc-actif");
  await expect(surligne).toContainText("6 mois", { timeout: 20_000 });
  const ligne = page.getByTestId("atelier-modif").first();
  await expect(ligne).toHaveAttribute("data-etat", "attente");
  await page.screenshot({ path: "e2e-screenshots/atelier-2-modification-surlignee.png" });

  // 3. Refuser : la modification disparaît du document (rejeu exact) ; la ligne reste, barrée.
  await ligne.getByRole("button", { name: /^Refuser/ }).click();
  await expect(ligne).toHaveAttribute("data-etat", "refusee");
  await expect(scene.locator(".artifact-bloc").nth(2)).toContainText("3 mois");
  await page.screenshot({ path: "e2e-screenshots/atelier-3-refusee.png" });

  // 4. Remettre à revoir, puis accepter.
  await ligne.getByRole("button", { name: /^Remettre à revoir/ }).click();
  await expect(ligne).toHaveAttribute("data-etat", "attente");
  await expect(scene.locator(".artifact-bloc").nth(2)).toContainText("6 mois");
  await ligne.getByRole("button", { name: /^Accepter/ }).click();
  await expect(ligne).toHaveAttribute("data-etat", "acceptee");

  // 5. Enregistrer : une NOUVELLE version (la 2), la 1 reste.
  await scene.getByTestId("atelier-enregistrer").click();
  await expect(page.getByTestId("atelier-message")).toContainText("Nouvelle version 2", { timeout: 20_000 });
  await page.screenshot({ path: "e2e-screenshots/atelier-4-enregistre-v2.png" });

  // 6. Le PowerPoint : l'assistant ajoute une diapositive de synthèse — elle apparaît, l'écran y va.
  await page.getByTestId("atelier-onglet").filter({ hasText: "Revue trimestrielle" }).click();
  atelier("geste", E2E.superAdminEmail, decor.pptx.sessionId, JSON.stringify([
    { action: "modifier_titre", diapo: 1, titre: "Revue du 3e trimestre" },
    { action: "ajouter_diapo", titre: "Synthèse", texte: "Ventes en hausse de 12 %\nDeux lancements réussis\nObjectif T4 confirmé" },
  ]));
  const pptx = page.getByTestId("atelier-onglet-contenu").first();
  await expect(pptx.locator(".artifact-miniature")).toHaveCount(4, { timeout: 20_000 });
  await expect(pptx.locator(".artifact-diapo")).toContainText("Synthèse");
  await page.screenshot({ path: "e2e-screenshots/atelier-5-diapositive-ajoutee.png" });

  // 7. Côte à côte, puis comparer avant / après.
  await pptx.getByRole("button", { name: "Côte à côte" }).click();
  await expect(page.getByTestId("atelier-onglet-contenu")).toHaveCount(2);
  await page.screenshot({ path: "e2e-screenshots/atelier-6-cote-a-cote.png" });
  await pptx.getByTestId("atelier-comparer").click();
  await expect(page.getByTestId("atelier-comparaison")).toBeVisible();
  await page.screenshot({ path: "e2e-screenshots/atelier-7-comparer.png" });
  await page.getByRole("button", { name: "Fermer la comparaison" }).click();

  // 8. Téléphone : l'Atelier est un panneau plein écran.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(panneau).toBeVisible();
  await page.screenshot({ path: "e2e-screenshots/atelier-8-telephone.png" });
});
