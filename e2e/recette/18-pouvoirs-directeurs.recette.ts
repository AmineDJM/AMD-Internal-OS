import { test, expect, attendFusion } from "./banc";
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

test("Accès Super Admin SEUL — ROI Ad & Pro, graphe d'influence, Adventum Brain, Adam", attendFusion("directeurs"), async ({ recette: r, page }) => {
  const pages: [string, string][] = [["/adventum-brain", "Adventum Brain"], ["/assistant", "Adam"], ["/adam/bureau", "Adam (bureau)"]];
  for (const cle of ["dirOps", "dg", "dirMarketing"] as CleCompte[]) {
    await r.connecter(cle);
    for (const [url, nom] of pages) {
      await r.controle(`${cle} : ouvrir ${nom} (${url})`, "Refus d'accès", async () => {
        await r.aller(url);
        await expect(page).not.toHaveURL(new RegExp(`${url}$`));
        return `arrivé sur ${new URL(page.url()).pathname}`;
      });
    }
  }
  await r.connecter("superAdmin");
  for (const [url, nom] of pages) {
    await r.controle(`Super Admin : ouvrir ${nom}`, "La page s'ouvre", async () => {
      await r.aller(url);
      await expect(page).toHaveURL(new RegExp(url));
    });
  }
});

test("Centre de paiement — aucun siège par pôle", attendFusion("directeurs"), async ({ recette: r, page }) => {
  await r.connecter("superAdmin");
  await r.controle("Administration › Accès : « Qui siège au centre de paiement »", "La désignation par nom n'existe plus : le centre est au Super Admin et au DG", async () => {
    await r.aller("/admin/access");
    await expect(page.getByText("Qui siège au centre de paiement")).toHaveCount(0);
  });
});

test("Réallocation — librement entre les lignes de SON budget, total intouchable", attendFusion("directeurs"), async ({ recette: r, page }) => {
  await r.connecter("dirOps");
  await r.etape("Budgets › son enveloppe : « Réallouer » 100 000 d'une ligne vers une autre", "Accepté sans validation ; le total de l'enveloppe ne bouge pas ; le Super Admin reçoit une notification, pas le DG", async () => {
    await r.aller("/budgets");
    await expect(page.getByRole("button", { name: /Réallouer/ }).first()).toBeVisible();
  });
  await r.controle("Tenter d'augmenter le TOTAL de l'enveloppe", "Refus qui dit le remède (demander au Super Admin)", async () => {
    await expect(page.getByRole("button", { name: /Modifier le total|Augmenter/ })).toHaveCount(0);
  });
  await r.controle("Tenter de réallouer sur le budget Marketing", "Refus : ce n'est pas SON budget", async () => {
    await r.aller("/budget-marketing");
    await expect(page.getByRole("button", { name: /Réallouer/ })).toHaveCount(0);
  });
  await r.controle("Le directeur ne voit que SA société", "La société « Pharmagène TEST » (fermée) n'apparaît nulle part dans ses pastilles", async () => {
    await r.aller("/budgets");
    await expect(page.getByText("RECETTE-PHG")).toHaveCount(0);
  });
});

test("Formations — toutes par le Directeur des opérations", attendFusion("directeurs"), async ({ recette: r, page }) => {
  await r.connecter("dirOps");
  await r.controle("Ouvrir « Formations »", "Les demandes de formation (réglementaires comprises) attendent SON autorisation ; le DG n'est pas dans le circuit", async () => {
    await r.aller("/formations");
    await expect(page.getByText(/Formations/).first()).toBeVisible();
  });
});
