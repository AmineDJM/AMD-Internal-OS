import { test, expect } from "./banc";
import { fermer } from "./donnees";

/**
 * PARCOURS 21 — INFORMATION MÉDICALE (lot infomed FUSIONNÉ) : le pharmacien voit ses déclarations à faire, ses BAT à
 * contrôler et le registre ; une demande Ad & Pro qui exige une déclaration arrive au Centre de validations
 * (« Accepter : déclarer » / « Pas de déclaration nécessaire »).
 */

test.afterAll(async () => { await fermer(); });

test("Pharmacien information médicale — son module", async ({ recette: r, page }) => {
  await r.connecter("pharmacienIM");
  await r.etape("Ouvrir « Information médicale »", "Blocs « Déclarations à faire », « BAT à contrôler », registre ; état vide qui dit le remède s'il n'y a rien", async () => {
    await r.aller("/information-medicale");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });
  await r.controle("Ouvrir « Conformité »", "La page /information-medicale/conformite s'ouvre", async () => {
    await r.aller("/information-medicale/conformite");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });
  await r.controle("Téléphone", "Pas de débordement à 390 px", async () => {
    const tel = await r.telephone("pharmacienIM");
    await r.aller("/information-medicale", tel);
    return r.sansDebordement(tel);
  });
  await r.controle("Le KAM ouvre /information-medicale", "Refus d'accès", async () => {
    await r.connecter("kam");
    await r.aller("/information-medicale");
    await expect(page).not.toHaveURL(/\/information-medicale$/);
  });
});
