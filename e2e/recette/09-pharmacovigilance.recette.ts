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
  await r.controle("Envoyer sans produit ni établissement", "Refus du formulaire : rien ne part ; le navigateur désigne le premier champ * manquant (« Produit concerné »)", async () => {
    await page.getByRole("button", { name: "Signaler à Regulatory" }).click();
    await expect(page).toHaveURL(/nouveau/);
    const produit = page.locator("select[name='promoProductId']");
    expect(await produit.evaluate((s: HTMLSelectElement) => s.validity.valueMissing)).toBe(true);
    expect(await page.locator("select[name='institutionId']").evaluate((s: HTMLSelectElement) => s.validity.valueMissing)).toBe(true);
    expect(await produit.evaluate((s) => s === document.activeElement), "le curseur est posé sur le premier champ manquant").toBe(true);
  });
  await r.etape("Remplir : produit « Cardiolex 5 mg », date du jour, établissement « CHU Mustapha », gravité « Grave », description ; envoyer",
    "Le cas est créé, rattaché ; le pharmacien et le Regulatory sont prévenus", async () => {
      await page.getByLabel("Rechercher un produit").fill("Cardiolex");
      const produit = page.locator("select[name='promoProductId']");
      const option = (await produit.locator("option").allTextContents()).find((t) => t.includes("Cardiolex 5 mg"));
      expect(option, "le produit de la gamme est proposé").toBeTruthy();
      await produit.selectOption({ label: option! });
      await page.locator("input[name='occurredOn']").fill(new Date().toISOString().slice(0, 10));
      await page.locator("select[name='institutionId']").selectOption({ label: "Autre établissement (saisir le nom)" });
      await page.getByLabel("Nom de l'établissement").fill(`${P} CHU Mustapha`);
      const gravite = page.locator("select[name='severity']");
      const grave = (await gravite.locator("option").allTextContents()).find((t) => /^Grave/i.test(t.trim()));
      if (grave) await gravite.selectOption({ label: grave });
      await page.locator("textarea[name='description']").fill(`${P} Vertiges et hypotension 2 h après la 2e prise ; arrêt du traitement, amélioration en 24 h.`);
      await page.getByRole("button", { name: "Signaler à Regulatory" }).click();
      await expect(page).not.toHaveURL(/nouveau$/);
      return new URL(page.url()).pathname;
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

