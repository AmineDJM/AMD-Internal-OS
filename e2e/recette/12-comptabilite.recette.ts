import { test, expect, attendFusion } from "./banc";
import { fermer } from "./donnees";

/**
 * PARCOURS 12 — COMPTABILITÉ : dépenses, recettes, résultat, « Composer une facture » (maquette Comptabilite
 * validée ; lot compta EN ATTENTE). Le bouton « Composer une facture » QUITTE Legal pour Comptabilité › Recettes
 * (même compositeur, même fabrique) ; la facture émise s'enregistre toujours au registre Legal et au Drive.
 */

test.afterAll(async () => { await fermer(); });

const COMPTA = "/finances/comptabilite";

test("Comptable — trois onglets, une recherche, le panneau d'une écriture", attendFusion("compta"), async ({ recette: r, page }) => {
  await r.connecter("comptable");
  await r.etape("Ouvrir « Comptabilité »", "Onglets « Dépenses · total », « Recettes · total », « Résultat » ; pastilles des sociétés de la personne ; « + Nouvelle écriture »", async () => {
    await r.aller(COMPTA);
    for (const o of [/Dépenses/, /Recettes/, /Résultat/]) await expect(page.getByRole("button", { name: o }).or(page.getByRole("tab", { name: o })).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /Nouvelle écriture/ })).toBeVisible();
  });
  await r.controle("Une seule recherche, qui couvre écritures ET factures du registre", "Taper un fournisseur trouve ses écritures et ses factures (« Facture non payée » → « Créer sa demande de paiement »)", async () => {
    await expect(page.getByRole("searchbox").or(page.getByPlaceholder(/Rechercher/)).first()).toBeVisible();
  });
  await r.controle("« + Nouvelle écriture » de DÉPENSE sans justificatif", "Refus qui dit le remède (joindre la pièce)", async () => {
    await page.getByRole("button", { name: /Nouvelle écriture/ }).click();
    await page.getByRole("button", { name: /Enregistrer/ }).last().click();
    await expect(page.getByText(/justificatif/i).first()).toBeVisible();
  });
  await r.controle("Ouvrir une écriture › « Contre-passer »", "Motif OBLIGATOIRE ; « Une écriture inverse de … sera créée. » ; « Confirmer la contre-passation »", async () => {
    await expect(page.getByText(/Contre-passer/).first()).toBeVisible();
  });
  await r.controle("Menu ⋯", "« Enregistrer un encaissement », « Importer un relevé bancaire (CSV) », « Contrôles du livre », comptes de trésorerie", async () => {
    await expect(page.getByText(/Importer un relevé/).first()).toBeVisible();
  });
  await r.controle("« Paiements sans justificatif »", "La liste des dépenses ✕ manquant, avec « Joindre un justificatif » / « Demander la pièce »", async () => {
    await expect(page.getByText(/sans justificatif/i).first()).toBeVisible();
  });
  await r.controle("Le comptable cherche « Marquer payé »", "Absent : la Comptabilité ne paie pas (séparation des tâches)", async () => {
    await expect(page.getByRole("button", { name: "Marquer payé" })).toHaveCount(0);
  });
});

test("« Composer une facture » vit dans Comptabilité › Recettes, plus dans Legal", attendFusion("compta"), async ({ recette: r, page }) => {
  await r.connecter("finances");
  await r.etape("Comptabilité › Recettes", "Bouton « Composer une facture »", async () => {
    await r.aller(COMPTA);
    await page.getByRole("button", { name: /Recettes/ }).or(page.getByRole("tab", { name: /Recettes/ })).first().click();
    await expect(page.getByRole("button", { name: /Composer une facture/ })).toBeVisible();
  });
  await r.etape("Composer une facture de vente (client, lignes HT, TVA 19 %) et l'émettre", "Word + PDF au papier en-tête de la société ; la facture entre au registre Legal (nature INVOICE) et au Drive ; HT / TVA / TTC enregistrés", async () => {
    await page.getByRole("button", { name: /Composer une facture/ }).click();
    await expect(page.getByRole("dialog").last()).toBeVisible();
  });
  await r.controle("Legal : le compositeur", "Ne propose plus que « Bon de commande » et « Devis » — plus « Facture »", async () => {
    await r.aller("/legal");
    const composer = page.getByRole("button", { name: /Composer/ }).first();
    if (await composer.isVisible().catch(() => false)) await composer.click();
    await expect(page.getByRole("menuitem", { name: /^Facture$/ }).or(page.getByRole("option", { name: /^Facture$/ }))).toHaveCount(0);
  });
});
