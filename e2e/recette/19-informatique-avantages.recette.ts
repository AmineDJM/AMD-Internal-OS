import { test, expect, attendFusion } from "./banc";
import { fermer } from "./donnees";
import type { CleCompte } from "./comptes";

/**
 * PARCOURS 19 — DÉPARTEMENT INFORMATIQUE (lot informatique EN ATTENTE) et REGISTRE DES AVANTAGES PAR MÉDECIN
 * (lot avantages EN ATTENTE ; Super Admin UNIQUEMENT, clair et détaillé).
 */

test.afterAll(async () => { await fermer(); });

test("Informatique — budget propre, coût de l'IA imputé chaque mois, abonnements et parc", attendFusion("informatique"), async ({ recette: r, page }) => {
  await r.connecter("superAdmin");
  await r.etape("Ouvrir le département Informatique", "Son budget ; la ligne « Intelligence artificielle » consommée chaque mois par le coût mesuré", async () => {
    await r.aller("/informatique");
    await expect(page.getByText(/Intelligence artificielle/).first()).toBeVisible();
  });
  await r.controle("« Abonnements » et « Parc »", "Les deux pages s'ouvrent (/informatique/abonnements, /informatique/parc)", async () => {
    await r.aller("/informatique/abonnements");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await r.aller("/informatique/parc");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });
  await r.controle("Une facture du fournisseur IA réglée sur la ligne le mois venu", "Elle SOLDE le mesuré (pas de double consommation) ; l'écran rapproche mesuré et facturé", async () => {
    await r.aller("/informatique");
    await expect(page.getByText(/mesur|factur/i).first()).toBeVisible();
  });
});

test("Registre des avantages par médecin — Super Admin seul", attendFusion("avantages"), async ({ recette: r, page }) => {
  await r.connecter("superAdmin");
  await r.etape("Administration › Registre des avantages", "Par médecin : chaque avantage (prise en charge, sponsoring, échantillon…), date, montant, demande d'origine ; total par année", async () => {
    await r.aller("/admin/avantages");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });
  for (const cle of ["dg", "dirMarketing", "kam"] as CleCompte[]) {
    await r.controle(`${cle} : ouvrir /admin/avantages`, "Refus d'accès", async () => {
      await r.connecter(cle);
      await r.aller("/admin/avantages");
      await expect(page).not.toHaveURL(/\/admin\/avantages$/);
    });
  }
});
