import { test, expect, attendFusion } from "./banc";
import { fermer } from "./donnees";

/**
 * PARCOURS 20 — AUDIT DES DÉPENSES (décisions du 24/11, FONT FOI ; lots chargesfixes + natures EN ATTENTE).
 *
 * « Informations de la société » avec « Locaux & charges fixes » → budget de l'ADMINISTRATION (une enveloppe par
 * société, tenue par les FINANCES) ; les Finances demandent chaque mois le paiement des charges fixes. Nature
 * OBLIGATOIRE sur la demande de paiement ; retenues à la source (honoraires médecins, prestataires étrangers) au
 * paiement ; « Dons et mécénat » séparé du sponsoring ; réserve pour imprévus libérable par le DG ou le Super Admin
 * seulement ; alerte d'une facture « selon facture » au-delà de +10 %.
 */

test.afterAll(async () => { await fermer(); });

test("Informations de la société — Locaux & charges fixes", attendFusion("chargesfixes"), async ({ recette: r, page }) => {
  await r.connecter("finances");
  await r.etape("Ouvrir « Informations de la société » (ex-« Coordonnées des entités »)", "Section « Locaux & charges fixes » : loyer, charges, périodicité", async () => {
    await r.aller("/admin/entites");
    await expect(page.getByText("Informations de la société").first()).toBeVisible();
    await expect(page.getByText("Locaux & charges fixes").first()).toBeVisible();
  });
  await r.controle("Budget de l'Administration de la société de test", "Une enveloppe par société, tenue par les Finances ; les charges fixes et les Moyens généraux y passent", async () => {
    await r.aller("/budgets");
    await expect(page.getByText(/Administration/).first()).toBeVisible();
  });
  await r.controle("Paiement mensuel des charges fixes", "Les Finances le demandent chaque mois (ligne dans « À faire ») ; il part au centre avec le justificatif (quittance de loyer)", async () => {
    await r.aller("/mon-espace");
    await expect(page.getByText(/loyer|charges fixes/i).first()).toBeVisible();
  });
});

test("Demande de paiement — nature obligatoire, retenues, dons, réserve", attendFusion("natures"), async ({ recette: r, page }) => {
  await r.connecter("assistante");
  await r.controle("Créer une demande de paiement sans « Nature »", "Refus : la nature est obligatoire", async () => {
    await r.aller("/validations?panneau=mes-demandes");
    await expect(page.getByText(/Nature/).first()).toBeVisible();
  });
  await r.controle("Liste des natures", "« Dons et mécénat » distinct de « Sponsoring » ; « Emprunts » disponible (vide)", async () => {
    await expect(page.getByText(/Dons et mécénat/).first()).toBeVisible();
  });
  await r.connecter("finances");
  await r.controle("Payer les honoraires d'un médecin", "La retenue à la source est calculée au paiement (taux réglable) et affichée", async () => {
    await r.aller("/finances/paiements-a-faire");
    await expect(page.getByText(/retenue/i).first()).toBeVisible();
  });
  await r.connecter("dirOps");
  await r.controle("Libérer la réserve pour imprévus", "Refus : seuls le DG ou le Super Admin la libèrent", async () => {
    await r.aller("/budgets");
    await expect(page.getByRole("button", { name: /Libérer/ })).toHaveCount(0);
  });
});
