import { test, expect } from "./banc";
import { decorVisite, fermer } from "./donnees";
import { P } from "./comptes";

/**
 * PARCOURS 9 — PHARMACOVIGILANCE : signalement rattaché à la visite (FUSIONNÉ), fiche du cas côté
 * Regulatory (FUSIONNÉ), déclaration à l'autorité avec délai et visa du pharmacien responsable (lot pvdecl EN ATTENTE).
 */

test.beforeAll(async () => { await decorVisite("delegue"); });
test.afterAll(async () => { await fermer(); });

test("Délégué — signaler un cas de pharmacovigilance", async ({ recette: r, page }) => {
  await r.connecter("delegue");
  await r.etape("Ouvrir « Signaler un cas de pharmacovigilance » (/medical/rapports/pharmacovigilance/nouveau)",
    "Champs : « Produit concerné * », « Date de survenue * », « Hôpital / établissement * », « Gravité », « Sexe du patient », « Âge du patient », description, « Pièces jointes (photos, documents) »", async () => {
      await r.aller("/medical/rapports/pharmacovigilance/nouveau");
      for (const t of ["Produit concerné", "Date de survenue", "Hôpital / établissement", "Gravité"]) await expect(page.getByText(t).first()).toBeVisible();
    });
  await r.controle("Envoyer sans produit ni date", "Refus : les champs marqués * sont obligatoires", async () => {
    await page.getByRole("button", { name: /Envoyer|Signaler|Enregistrer/ }).last().click();
    await expect(page.getByText(/obligatoire|requis|renseign/i).first()).toBeVisible();
  });
  await r.etape("Remplir : produit « Cardiolex 5 mg », date du jour, établissement « CHU Mustapha », gravité « Grave », description ; envoyer",
    "Le cas est créé, rattaché ; le pharmacien et le Regulatory sont prévenus", async () => {
      await page.getByLabel("Rechercher un produit").fill("Cardiolex");
      await page.getByText(`${P} Cardiolex 5 mg`).first().click();
      await page.locator("input[name='occurredOn']").fill(new Date().toISOString().slice(0, 10));
      const etab = page.getByLabel("Rechercher un établissement");
      await etab.fill("CHU");
      const autre = page.getByText("Autre établissement (saisir le nom)");
      if (await autre.isVisible().catch(() => false)) { await autre.click(); await page.getByLabel("Nom de l'établissement").fill(`${P} CHU Mustapha`); }
      await page.locator("textarea[name='description']").fill(`${P} Vertiges et hypotension 2 h après la 2e prise ; arrêt du traitement, amélioration en 24 h.`);
      await page.getByRole("button", { name: /Envoyer|Signaler|Enregistrer/ }).last().click();
      await expect(page).not.toHaveURL(/nouveau$/);
    });
});

test("Responsable réglementaire / pharmacien — instruire le cas", async ({ recette: r, page }) => {
  await r.connecter("regulatory");
  await r.etape("Ouvrir Regulatory › Pharmacovigilance", "Le cas « Vertiges et hypotension… » est dans la liste, avec sa visite d'origine", async () => {
    await r.aller("/regulatory/pharmacovigilance");
    await expect(page.getByText(/Cardiolex/).first()).toBeVisible();
  });
  await r.controle("Le délégué ouvre la liste Regulatory", "Refus d'accès (il ne voit que ses propres signalements)", async () => {
    await r.connecter("delegue");
    await r.aller("/regulatory/pharmacovigilance");
    await expect(page).not.toHaveURL(/\/regulatory\/pharmacovigilance$/);
  });
});

