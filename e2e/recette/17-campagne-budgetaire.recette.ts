import { test, expect, attendFusion } from "./banc";
import { fermer } from "./donnees";

/**
 * PARCOURS 17 — CAMPAGNE BUDGÉTAIRE : RECETTES ET DÉPENSES (lot campagne EN ATTENTE).
 *
 * Les recettes sont saisies par le Super Admin et la Direction générale ; les dépenses par les directions. La TVA nette
 * (collectée − déductible) se calcule depuis recettes et dépenses ; IBS = résultat × taux réglable.
 */

test.afterAll(async () => { await fermer(); });

test("DG — saisir une recette ; la synthèse calcule TVA à reverser et IBS", attendFusion("campagne"), async ({ recette: r, page }) => {
  await r.connecter("dg");
  await r.etape("Ouvrir « Campagne budgétaire »", "Recettes et dépenses ; « Saisir une recette » ; « Taux et calendrier »", async () => {
    await r.aller("/budget-campagne");
    await expect(page.getByRole("button", { name: "Saisir une recette" })).toBeVisible();
  });
  await r.etape("« Saisir une recette » : produit · client, montant HT 12 000 000, société de test ; « Ajouter »", "La recette apparaît ; la synthèse « Trésorerie — TVA à reverser » se met à jour", async () => {
    await page.getByRole("button", { name: "Saisir une recette" }).click();
    await page.getByLabel(/Montant HT/).fill("12000000");
    await page.getByRole("button", { name: "Ajouter" }).last().click();
    await expect(page.getByText(/TVA à reverser/).first()).toBeVisible();
  });
  await r.controle("« Taux et calendrier »", "« IBS par défaut (%) », « IRG moyen (%) », « CNAS (%) » — « Taux préréglés — à confirmer par le cabinet » ; « Enregistrer les taux »", async () => {
    await page.getByText("Taux et calendrier").first().click();
    await expect(page.getByText("IBS par défaut (%)").first()).toBeVisible();
  });
});

test("Directeur des opérations — saisit ses DÉPENSES, pas les recettes", attendFusion("campagne"), async ({ recette: r, page }) => {
  await r.connecter("dirOps");
  await r.controle("Ouvrir la campagne", "Il saisit les dépenses de son pôle ; « Saisir une recette » absent", async () => {
    await r.aller("/budget-campagne");
    await expect(page.getByRole("button", { name: "Saisir une recette" })).toHaveCount(0);
  });
});
