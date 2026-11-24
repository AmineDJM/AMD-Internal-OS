import type { Page } from "@playwright/test";
import { test, expect } from "./banc";
import { budgetRegulatory, db, dossierRegulatory, fermer, pdfDeTest } from "./donnees";
import { cliquerDecisif } from "../decisif";

/**
 * PARCOURS 3 — BV 25 % / 75 % PAR LE CENTRE DE VALIDATIONS (lots bv + ctrvalid FUSIONNÉS).
 *
 * Le responsable réglementaire demande l'autorisation du BV depuis l'étape « Demande du BV 25 % » de son
 * dossier (montant + proforma) ; la demande part au Centre de validations ; acceptée, son montant est
 * ENGAGÉ au budget Regulatory et l'étape « Paiement » se déverrouille ; refusée, le motif revient et il
 * peut redemander. Pas d'ordre de dépense, pas de centre de paiement (exception assumée). Une seule
 * entrée de menu « Centre de validations ».
 */

let accepte = "";
let refuse = "";

test.beforeAll(async () => {
  await budgetRegulatory();
  accepte = await dossierRegulatory("Cardiolex 5 mg");
  refuse = await dossierRegulatory("Glucovia 850 mg");
});
test.afterAll(async () => { await fermer(); });

const fileValidations = (page: Page) => page.locator("section[aria-labelledby='file-validations']");
const ficheValidation = (page: Page) => page.locator("section[aria-labelledby='fiche-validation']");

async function demanderBv(r: { aller: (u: string) => Promise<void> }, page: Page, produitId: string, montant: string) {
  await r.aller(`/regulatory/${produitId}`);
  await page.getByText("Demande du BV 25 %").first().click();
  await page.getByRole("button", { name: /Demander l'autorisation du BV 25 %/ }).click();
  const feuille = page.getByRole("dialog").last();
  await feuille.getByLabel("Montant (DZD)").fill(montant);
  await feuille.getByLabel(/Commentaire/).fill("__recette__ Échéance ANPP dans 10 jours");
  await feuille.locator("input[type='file']").first().setInputFiles(pdfDeTest("Proforma BV 25 pourcent"));
  await feuille.getByRole("button", { name: "Demander l'autorisation" }).click();
}

test("Responsable réglementaire — demander l'autorisation du BV 25 % depuis l'étape", async ({ recette: r, page }) => {
  await r.connecter("regulatory");
  await r.etape("Ouvrir le dossier « Cardiolex 5 mg », cliquer l'étape « Demande du BV 25 % »",
    "Bouton « Demander l'autorisation du BV 25 % » ; la feuille s'ouvre : « Montant (DZD) », « Commentaire (facultatif) », « Pièces jointes (proforma BV, courrier ANPP…) »", async () => {
      await r.aller(`/regulatory/${accepte}`);
      await page.getByText("Demande du BV 25 %").first().click();
      await page.getByRole("button", { name: /Demander l'autorisation du BV 25 %/ }).click();
      const feuille = page.getByRole("dialog").last();
      await expect(feuille.getByLabel("Montant (DZD)")).toBeVisible();
      await expect(feuille).toContainText("Pièces jointes (proforma BV, courrier ANPP…)");
      await page.keyboard.press("Escape");
    });
  await r.etape("Saisir 120 000, joindre la proforma, « Demander l'autorisation »",
    "L'étape dit que la demande attend le Centre de validations ; en base : une demande REGULATORY_BV_25 PENDING de 120 000", async () => {
      await demanderBv(r, page, accepte, "120000");
      await expect.poll(async () => (await db().validationRequest.findFirst({ where: { entityId: accepte, objectType: "REGULATORY_BV_25" } }))?.status ?? null, { timeout: 15_000 }).toBe("PENDING");
      await r.aller(`/regulatory/${accepte}`);
      await expect(page.getByText(/Centre de validations/).first()).toBeVisible();
    });
  await r.controle("Demander une seconde fois (double clic, ou retour arrière)", "Refus « déjà demandé » : une seule demande au centre", async () => {
    await r.aller(`/regulatory/${accepte}`);
    await expect(page.getByRole("button", { name: /Demander l'autorisation du BV 25 %/ })).toHaveCount(0);
    expect(await db().validationRequest.count({ where: { entityId: accepte, objectType: "REGULATORY_BV_25", status: "PENDING" } })).toBe(1);
  });
  await r.etape("Demander aussi le BV 25 % du dossier « Glucovia 850 mg » (sera refusé)", "Seconde demande au centre", async () => {
    await demanderBv(r, page, refuse, "95000");
    await expect.poll(async () => (await db().validationRequest.findFirst({ where: { entityId: refuse } }))?.status ?? null, { timeout: 15_000 }).toBe("PENDING");
  });
});

test("DG — accepter le BV au Centre de validations ; le budget Regulatory est engagé", async ({ recette: r, page }) => {
  await r.connecter("dg");
  await r.controle("Lire le menu", "UNE seule entrée « Centre de validations »", async () => {
    await expect(page.locator("[data-app-sidebar]").getByRole("link", { name: /Centre de validations/ })).toHaveCount(1);
  });
  await r.etape("Ouvrir le Centre de validations", "« À décider · n » ; la demande « BV 25 % — Cardiolex » est dans la file", async () => {
    await r.aller("/centre-de-validations");
    await expect(page).toHaveURL(/\/validations/);
    await expect(fileValidations(page)).toContainText(/À décider · \d+/);
    await expect(fileValidations(page).locator("li").filter({ hasText: /Cardiolex/ }).first()).toBeVisible();
  });
  await r.etape("Cliquer la ligne, lire la fiche", "Fiche : montant 120 000 DZD, « Déjà validé », « Pièces » (proforma ouvrable), gestes « Demander une précision », « Refuser », « Accepter le BV »", async () => {
    await fileValidations(page).locator("li").filter({ hasText: /Cardiolex/ }).first().getByRole("button").first().click();
    const fiche = ficheValidation(page);
    await expect(fiche).toContainText("120");
    await expect(fiche).toContainText("Pièces");
    await expect(fiche.getByRole("button", { name: "Accepter le BV" })).toBeVisible();
  }, { cible: ficheValidation(page) });
  await r.etape("« Accepter le BV » (deux clics)", "La demande sort de la file ; en base : APPROVED ; la ligne « BV 25 % » du budget Regulatory a 120 000 engagés", async () => {
    await cliquerDecisif(ficheValidation(page).getByRole("button", { name: "Accepter le BV" }));
    await expect.poll(async () => (await db().validationRequest.findFirst({ where: { entityId: accepte } }))?.status ?? null, { timeout: 15_000 }).toBe("APPROVED");
  });
  await r.etape("Ouvrir « Glucovia », « Refuser », motif en un clic, « Confirmer le refus »", "Demande REFUSÉE avec le motif", async () => {
    await r.aller("/centre-de-validations");
    await fileValidations(page).locator("li").filter({ hasText: /Glucovia/ }).first().getByRole("button").first().click();
    const fiche = ficheValidation(page);
    await fiche.getByRole("button", { name: "Refuser", exact: true }).click();
    await fiche.locator("button[aria-pressed]").first().click();
    await cliquerDecisif(fiche.getByRole("button", { name: "Confirmer le refus" }));
    await expect.poll(async () => (await db().validationRequest.findFirst({ where: { entityId: refuse } }))?.status ?? null, { timeout: 15_000 }).toBe("REJECTED");
  });
});

test("Responsable réglementaire — budget engagé, étape « Paiement » ouverte, refus motivé et redemande", async ({ recette: r, page }) => {
  await r.connecter("regulatory");
  await r.controle("Rouvrir « Cardiolex »", "Bloc Budget : « Engagé » 120 000 DZD ; l'étape « Paiement » du BV 25 % est déverrouillée", async () => {
    await r.aller(`/regulatory/${accepte}`);
    await expect(page.getByText("Engagé").first()).toBeVisible();
    await expect(page.getByText(/120[\s  ]000/).first()).toBeVisible();
  });
  await r.controle("Rouvrir « Glucovia »", "« Motif : … » affiché ; bouton « Redemander l'autorisation du BV 25 % »", async () => {
    await r.aller(`/regulatory/${refuse}`);
    await page.getByText("Demande du BV 25 %").first().click();
    await expect(page.getByText("Motif :").first()).toBeVisible();
    await expect(page.getByRole("button", { name: /Redemander l'autorisation du BV 25 %/ })).toBeVisible();
  });
});

test("Contrôles négatifs — qui ne décide pas un BV", async ({ recette: r, page }) => {
  await r.controle("Délégué médical : ouvrir /centre-de-validations", "Refus d'accès (aucune file « À décider »)", async () => {
    await r.connecter("delegue");
    await r.aller("/centre-de-validations");
    await expect(fileValidations(page)).toHaveCount(0);
    return `arrivé sur ${new URL(page.url()).pathname}`;
  });
  await r.controle("Le budget, en base", "Ligne « BV 25 % » : engagé ≥ 120 000 (acceptation) ; aucun ordre de dépense créé pour ce BV", async () => {
    const ordres = await db().expenseOrder.count({ where: { sourceId: accepte } });
    expect(ordres).toBe(0);
    return `ordres de dépense pour le BV : ${ordres}`;
  });
});
