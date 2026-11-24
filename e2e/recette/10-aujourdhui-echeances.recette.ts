import { test, expect } from "./banc";
import { fermer } from "./donnees";
import { P } from "./comptes";

/**
 * PARCOURS 10 — « MON ESPACE › AUJOURD'HUI » (FUSIONNÉ) et ÉCHÉANCES INTÉGRÉES (lot echeances EN ATTENTE).
 *
 * « Bonjour <prénom> » ; « À faire · N » en trois groupes (« En retard » rouge, « Aujourd'hui », « Plus tard » replié),
 * un bouton par ligne ; « Mes rappels » (« Fait ») ; « Demander » ; « Mon équipe » pour un N+1. Les échéances de
 * conformité (G50, fin de contrat, renouvellement d'enregistrement…) arrivent DANS « À faire » et dans leur module —
 * jamais une page ni un onglet « Échéancier ».
 */

test.afterAll(async () => { await fermer(); });

test("Chaque métier — Aujourd'hui s'ouvre, simple, sur ordinateur et téléphone", async ({ recette: r, page }) => {
  for (const cle of ["dg", "assistante", "kam", "finances"] as const) {
    await r.controle(`${cle} : ouvrir « Mon espace »`, "« Bonjour <prénom> », « À faire », « Mes rappels », « Demander »", async () => {
      await r.connecter(cle);
      await r.aller("/mon-espace");
      await expect(page.getByRole("heading", { level: 1 })).toContainText("Bonjour");
      await expect(page.getByText(/À faire/).first()).toBeVisible();
      await expect(page.getByText("Mes rappels").first()).toBeVisible();
    });
  }
  await r.controle("Le N+1 (DG) voit « Mon équipe »", "Encart « Mon équipe » présent pour un supérieur hiérarchique", async () => {
    await r.connecter("dg");
    await r.aller("/mon-espace");
    await expect(page.getByText("Mon équipe").first()).toBeVisible();
  });
  const tel = await r.telephone("kam");
  await r.controle("KAM sur téléphone", "Aucun défilement de côté ; un bouton par ligne", async () => {
    await r.aller("/mon-espace", tel);
    return r.sansDebordement(tel);
  }, { page: tel });
});

test("Rappels — ajouter, voir, marquer « Fait »", async ({ recette: r, page }) => {
  await r.connecter("assistante");
  await r.aller("/mon-espace");
  await r.etape("Dans « Mes rappels » : « Ajouter » un rappel « Relancer l'imprimeur » pour aujourd'hui", "Le rappel apparaît dans « Mes rappels »", async () => {
    await page.getByRole("button", { name: "Ajouter" }).first().click();
    const champ = page.getByRole("textbox").last();
    await champ.fill(`${P} Relancer l'imprimeur`);
    await champ.press("Enter");
    await expect(page.getByText("Relancer l'imprimeur").first()).toBeVisible();
  });
  await r.etape("Cliquer « Fait »", "Le rappel quitte la liste", async () => {
    const ligne = page.locator("li").filter({ hasText: "Relancer l'imprimeur" }).first();
    await ligne.getByRole("button", { name: "Fait" }).click();
    await expect(page.getByText("Relancer l'imprimeur")).toHaveCount(0, { timeout: 15_000 });
  });
});

