import { test, expect, attendFusion } from "./banc";
import { fermer, pdfDeTest } from "./donnees";

/**
 * PARCOURS 13 — IMPÔTS & COTISATIONS (G50) et TVA (maquette ImpotsCotisations ; lots impots + tva EN ATTENTE).
 *
 * « TVA : elle doit être enregistrée sur les factures et la TVA de la G50 doit en être CALCULÉE (collectée −
 * déductible). Très, très important. » Vocabulaire (audit des dépenses, FONT FOI) : VENTE / ACHAT, jamais « PCH »
 * ni « exonération » ; IMPÔTS & TAXES = TVA + IBS (IRG et CNAS sont dans la MASSE SALARIALE) ; pas de TAP, CASNOS, TFP.
 */

test.afterAll(async () => { await fermer(); });

const IMPOTS = "/finances/impots-cotisations";

test("TVA — HT / TVA / TTC sur une facture ; la TVA du mois calculée", attendFusion("tva"), async ({ recette: r, page }) => {
  await r.connecter("finances");
  await r.etape("Legal › factures : enregistrer une facture d'ACHAT 1 000 000 HT, TVA 19 %, timbre", "Colonnes HT / TVA / TTC ; TTC = 1 190 000 + timbre ; un total incohérent est refusé (HT + TVA + timbre ≠ TTC)", async () => {
    await r.aller("/legal");
    await expect(page.getByText(/HT/).first()).toBeVisible();
    await expect(page.getByText(/TVA/).first()).toBeVisible();
  });
  await r.controle("Filtre « TVA à compléter »", "Les factures sans TVA renseignée y sont (rien n'est inventé pour les anciennes)", async () => {
    await expect(page.getByText(/TVA à compléter/).first()).toBeVisible();
  });
});

test("G50 — la TVA nette proposée = collectée − déductible ; envoi au centre avec la G50 jointe", attendFusion("impots", "tva"), async ({ recette: r, page }) => {
  await r.connecter("finances");
  await r.etape("Ouvrir « Impôts & cotisations »", "Pastilles des sociétés ; liste des échéances par état ; menu ⋯ (calendrier des échéances, paiement ponctuel)", async () => {
    await r.aller(IMPOTS);
    await expect(page.getByRole("heading", { name: "Impôts & cotisations" })).toBeVisible();
  });
  await r.etape("« Préparer » la G50 du mois", "« Décomposition du montant — ligne par ligne » ; « TVA à payer (collectée X − déductible Y) » CALCULÉE depuis les factures ; « Comment la plateforme remplit ces montants »", async () => {
    await page.getByText(/G50/).first().click();
    await expect(page.getByText(/collectée/i).first()).toBeVisible();
    await expect(page.getByText(/déductible/i).first()).toBeVisible();
  });
  await r.controle("Modifier un montant proposé puis « Revenir au montant proposé »", "L'écart est tracé (« Qui a fait quoi ») ; le retour au proposé est possible", async () => {
    await expect(page.getByText(/Revenir au montant proposé/).first()).toBeVisible();
  });
  await r.controle("« Envoyer au centre de paiement » SANS la G50 jointe", "Refus : le justificatif est obligatoire", async () => {
    await page.getByRole("button", { name: "Envoyer au centre de paiement" }).click();
    await expect(page.getByText(/justificatif|joindre/i).first()).toBeVisible();
  });
  await r.etape("Joindre la G50 (PDF), « Envoyer au centre de paiement »", "La ligne passe « au centre de paiement » ; « Retirer la demande » possible tant que non décidée", async () => {
    await page.locator("input[type='file']").first().setInputFiles(pdfDeTest("G50 novembre"));
    await page.getByRole("button", { name: "Envoyer au centre de paiement" }).click();
    await expect(page.getByText(/centre de paiement/).first()).toBeVisible();
  });
  await r.controle("Après autorisation et paiement : « Joindre la quittance »", "La quittance se dépose sur la ligne payée", async () => {
    await expect(page.getByText(/quittance/i).first()).toBeVisible();
  });
  await r.controle("Vocabulaire", "Aucune occurrence de « PCH », « exonération », « TAP », « CASNOS », « TFP » à l'écran", async () => {
    const texte = await page.locator("main").innerText();
    for (const mot of ["PCH", "exonération", "TAP", "CASNOS", "TFP"]) expect(texte.includes(mot), `« ${mot} » ne doit pas apparaître`).toBe(false);
  });
});

test("Budget — enveloppe « Impôts & taxes » par société : TVA nette et IBS", attendFusion("impots", "campagne"), async ({ recette: r, page }) => {
  await r.connecter("finances");
  await r.controle("Budgets › enveloppe « Impôts & taxes » de la société de test", "Lignes TVA nette et IBS ; le paiement de la G50 autorisé et payé s'y impute ; IRG et CNAS sont dans la masse salariale, pas ici", async () => {
    await r.aller("/budgets");
    await expect(page.getByText(/Impôts & taxes/).first()).toBeVisible();
  });
});
