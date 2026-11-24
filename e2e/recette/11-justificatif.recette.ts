import { test, expect, attendFusion, graine } from "./banc";
import { db, fermer, ordre, pdfDeTest } from "./donnees";
import { ligneDuCentre } from "../centre";

/**
 * PARCOURS 11 — JUSTIFICATIF OBLIGATOIRE (consigne du 24/11 ; lot justif EN ATTENTE).
 *
 * Tout paiement porte une pièce (facture, proforma, G50, bordereau, état de paie, bon de remise…). Sans elle,
 * l'ordre naît « en attente de justificatif » (AWAITING_PROOF) : il n'atteint NI le centre de paiement NI les
 * Finances ; son émetteur reçoit une ligne « Joindre le justificatif » ; la pièce déposée le fait entrer SEUL au centre.
 * Les données de ce parcours simulent l'état que poserait `createExpenseOrder` sans pièce.
 */

let sansPiece = { id: "", reference: "", libelle: "" };
test.beforeAll(async () => {
  sansPiece = await ordre({ libelle: "Location véhicule séminaire (sans pièce)", montant: 75_000, demandeur: "assistante", beneficiaire: "__recette__ Loc Auto", statutCentre: "AWAITING_PROOF" });
});
test.afterAll(async () => { await fermer(); });

test("Sans justificatif, l'ordre n'atteint ni le centre ni les Finances", attendFusion("justif"), async ({ recette: r, page }) => {
  await r.connecter("superAdmin");
  await r.controle("Centre de paiement", "L'ordre sans pièce n'est PAS dans « À décider »", async () => {
    await r.aller(`/centre-de-paiement?entite=${graine().societeId}`);
    await expect(ligneDuCentre(page, sansPiece.libelle)).toHaveCount(0);
  });
  await r.connecter("finances");
  await r.controle("Banque & paiements", "L'ordre sans pièce n'y est pas", async () => {
    await r.aller(`/finances/paiements-a-faire?entite=${graine().societeId}`);
    await expect(page.getByText("Loc Auto")).toHaveCount(0);
  });
});

test("L'émetteur joint la pièce : l'ordre entre seul au centre", attendFusion("justif"), async ({ recette: r, page }) => {
  await r.connecter("assistante");
  await r.etape("Ouvrir « Mon espace »", "Ligne « Joindre le justificatif » pour « Location véhicule séminaire »", async () => {
    await r.aller("/mon-espace");
    await expect(page.getByText(/Joindre le justificatif/).first()).toBeVisible();
  });
  await r.etape("Cliquer la ligne, déposer la facture (PDF)", "L'ordre passe « en attente du centre de paiement » (AWAITING)", async () => {
    await page.getByText(/Joindre le justificatif/).first().click();
    await page.locator("input[type='file']").first().setInputFiles(pdfDeTest("Facture Loc Auto"));
    const envoyer = page.getByRole("button", { name: /Joindre|Envoyer|Déposer/ }).last();
    if (await envoyer.isEnabled().catch(() => false)) await envoyer.click();
    await expect.poll(async () => (await db().expenseOrder.findUniqueOrThrow({ where: { id: sansPiece.id } })).centralStatus, { timeout: 20_000 }).toBe("AWAITING");
  });
  await r.connecter("superAdmin");
  await r.controle("Centre de paiement", "L'ordre est maintenant dans la file ; « Pièces » montre la facture ✓, ouvrable", async () => {
    await r.aller(`/centre-de-paiement?entite=${graine().societeId}`);
    await expect(ligneDuCentre(page, sansPiece.libelle)).toBeVisible();
  });
});

test("Chaque circuit exige sa pièce : paie, caisse, information médicale, PEC", attendFusion("justif"), async ({ recette: r, page }) => {
  await r.connecter("rh");
  await r.controle("RH › Paie : « Envoyer la paie au centre » sans état de paie", "Refus qui dit le remède : joindre l'état de paie", async () => {
    await r.aller("/rh/paie");
    await expect(page.getByText(/état de paie/i).first()).toBeVisible();
  });
  await r.connecter("superAdmin");
  await r.controle("Moyens généraux : « Remettre une somme en caisse »", "Le formulaire demande le bon de remise (pièce jointe)", async () => {
    await r.aller("/moyens-generaux");
    await expect(page.getByText(/bon de remise/i).first()).toBeVisible();
  });
});
