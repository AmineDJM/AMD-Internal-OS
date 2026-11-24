import { test, expect } from "./banc";
import { fermer } from "./donnees";
import type { CleCompte } from "./comptes";

/**
 * PARCOURS 18 — POUVOIRS DES DIRECTEURS ET ACCÈS « SUPER ADMIN SEUL » (décisions du 24/11 ; lot directeurs EN ATTENTE,
 * budget Opérations à deux enveloppes FUSIONNÉ).
 *
 * « Directeur » = responsable de chaque département ; il ne voit que SA société (sauf DG et Super Admin). Il
 * RÉALLOUE librement entre les lignes de SON budget, le TOTAL est intouchable ; le Super Admin est informé (pas le DG).
 * Centre de paiement : Super Admin + DG uniquement, aucun siège. ROI Ad & Pro, graphe d'influence, Adventum Brain,
 * Adam : Super Admin uniquement. Formations : toutes par l'autorisation du Directeur des opérations.
 */

test.afterAll(async () => { await fermer(); });

test("Budget Opérations — deux enveloppes « Masse salariale » et « Missions »", async ({ recette: r, page }) => {
  await r.connecter("dirOps");
  await r.etape("Ouvrir « Budget Operations & Sales »", "Deux enveloppes : « Masse salariale » (hors mission, notes de frais KAM hors mission imputées automatiquement) et « Missions »", async () => {
    await r.aller("/budget-operations");
    await expect(page.getByText(/Masse salariale/).first()).toBeVisible();
    await expect(page.getByText(/Missions/).first()).toBeVisible();
  });
  await r.controle("Masse salariale : IRG et CNAS affichés séparément à l'intérieur", "Net + primes, IRG, CNAS (audit des dépenses, FONT FOI)", async () => {
    await r.aller("/budget-operations/masse-salariale");
    await expect(page.getByText(/IRG/).first()).toBeVisible();
    await expect(page.getByText(/CNAS/).first()).toBeVisible();
  });
});

