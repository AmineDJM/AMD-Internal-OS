import { test, expect, attendFusion } from "./banc";
import { dossierRegulatory, fermer, pdfDeTest } from "./donnees";

/**
 * PARCOURS 16 — ENREGISTREMENT D'UN PRODUIT, VALIDITÉ 5 ANS (lot regenreg EN ATTENTE).
 *
 * Dans Regulatory, on dépose la DÉCISION D'ENREGISTREMENT et l'ATTESTATION DE PRIX ; l'IA lit la date de début et de
 * fin de validité (fin = début + 5 ans si elle manque) ; alerte de renouvellement.
 */

let produit = "";
test.beforeAll(async () => { produit = await dossierRegulatory("Tensiolex 10 mg"); });
test.afterAll(async () => { await fermer(); });

test("Responsable réglementaire — décision d'enregistrement et attestation de prix", attendFusion("regenreg"), async ({ recette: r, page }) => {
  await r.connecter("regulatory");
  await r.etape("Ouvrir le dossier « Tensiolex 10 mg » : carte Enregistrement", "Boutons « Joindre la décision » et « Joindre l'attestation de prix »", async () => {
    await r.aller(`/regulatory/${produit}`);
    await expect(page.getByRole("button", { name: "Joindre la décision" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Joindre l'attestation de prix" })).toBeVisible();
  });
  await r.etape("« Joindre la décision » (PDF)", "Dates de début et de fin de validité lues (IA réelle) ou à saisir ; fin = début + 5 ans proposée si absente ; « Confirmer »", async () => {
    await page.getByRole("button", { name: "Joindre la décision" }).click();
    await page.locator("input[type='file']").last().setInputFiles(pdfDeTest("Decision enregistrement Tensiolex"));
    await expect(page.getByText(/5 ans|validit/i).first()).toBeVisible();
  });
  await r.controle("Saisir début = 01/01/2022 sans fin, « Confirmer »", "Fin de validité affichée 01/01/2027 ; alerte de renouvellement planifiée", async () => {
    await expect(page.getByText(/2027/).first()).toBeVisible();
  });
  await r.controle("« Joindre l'attestation de prix », « Confirmer le prix »", "Prix confirmé, pièce rangée au dossier", async () => {
    await expect(page.getByRole("button", { name: /Confirmer le prix|Joindre l'attestation de prix/ }).first()).toBeVisible();
  });
});
