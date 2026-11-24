import { test, expect, graine } from "./banc";
import { compteBancaire, db, fermer } from "./donnees";
import { ficheDuCentre, ouvrirAuCentre } from "../centre";
import { cliquerDecisif } from "../decisif";
import { nomDe } from "./comptes";

/**
 * PARCOURS 4 — CAISSE D'AVANCE / REMISE (lot caisse FUSIONNÉ).
 *
 * Une remise part au centre de paiement ; autorisée, elle passe aux Finances ; « payée » par les Finances
 * (sans budget : une remise n'est pas une dépense), elle n'entre dans la caisse qu'à la CONFIRMATION DU
 * CAISSIER (« Quand les Finances marquent payé, ET que le caissier confirme la réception »). Une seule
 * caisse, celle des Moyens généraux.
 */

let reference = "";
test.beforeAll(async () => { await compteBancaire("CPA Caisse", 5_000_000); });
test.afterAll(async () => { await fermer(); });

const remise = () => db().pettyCashAllotment.findFirst({
  where: { departmentId: graine().departements.MOYENS_GENERAUX }, orderBy: { createdAt: "desc" }, include: { expenseOrder: true },
});

test("Super Admin — remettre une somme en caisse : elle part au centre de paiement", async ({ recette: r, page }) => {
  await r.connecter("superAdmin");
  await r.etape("Ouvrir « Moyens généraux »", "Carte de la caisse d'avance ; formulaire « Remettre une somme en caisse » (ou bouton « Remettre une somme »)", async () => {
    await r.aller("/moyens-generaux");
    const bouton = page.getByRole("button", { name: "Remettre une somme" });
    if (await bouton.isVisible().catch(() => false)) await bouton.click();
    await expect(page.getByText("Remettre une somme en caisse")).toBeVisible();
  });
  await r.etape("Saisir 24 000, choisir le caissier, « Envoyer au centre de paiement »",
    "« Remise de 24 000 DZD envoyée au centre de paiement (OD-…) : autorisée, elle passera aux Finances ; payée, elle comptera dans la caisse dès que le caissier en confirme la réception. »", async () => {
      const form = page.locator("form").filter({ hasText: "Remettre une somme en caisse" });
      await form.locator("input[name='amount']").fill("24000");
      await form.locator("select[name='holderId']").selectOption({ label: nomDe("caissier") });
      await form.getByRole("button", { name: "Envoyer au centre de paiement" }).click();
      await expect(page.getByText(/Remise de 24[\s  ]000 DZD envoyée au centre de paiement \(/)).toBeVisible({ timeout: 20_000 });
      const rm = await remise();
      expect(rm?.expenseOrder?.centralStatus).toBe("AWAITING");
      expect(rm?.transactionId ?? null, "rien n'est décaissé avant l'autorisation").toBeNull();
      reference = rm?.expenseOrder?.reference ?? "";
      return `ordre ${reference} en attente du centre`;
    });
  await r.controle("Le caissier ouvre « Moyens généraux »", "« en attente du centre de paiement » ; PAS de « Confirmer la réception » avant le paiement", async () => {
    const tel = await r.telephone("caissier");
    await r.aller("/moyens-generaux", tel);
    await expect(tel.getByText(/en attente du centre de paiement/i).first()).toBeVisible();
    await expect(tel.getByRole("button", { name: /Confirmer la réception/ })).toHaveCount(0);
    return r.sansDebordement(tel);
  });
});

test("Centre puis Finances — autoriser, puis payer SANS budget", async ({ recette: r, page }) => {
  await r.connecter("superAdmin");
  await r.etape("Centre de paiement : ouvrir la remise et « Autoriser le paiement »", "Autorisé ; la remise passe aux Finances", async () => {
    await r.aller(`/centre-de-paiement?entite=${graine().societeId}`);
    await ouvrirAuCentre(page, /Caisse d'avance/);
    await cliquerDecisif(ficheDuCentre(page).getByRole("button", { name: "Autoriser le paiement" }));
    await expect.poll(async () => (await remise())?.expenseOrder?.centralStatus, { timeout: 15_000 }).toBe("APPROVED");
  }, { cible: ficheDuCentre(page) });

  await r.connecter("finances");
  await r.etape("Banque & paiements : « Payer » la remise", "Le panneau n'exige AUCUN budget (pas de champ « Budget * ») ; « Marquer payé » → payée", async () => {
    await r.aller(`/finances/paiements-a-faire?entite=${graine().societeId}`);
    const ligne = page.locator("tr, li").filter({ hasText: /Caisse d'avance/ }).first();
    await ligne.getByRole("button", { name: "Payer", exact: true }).click();
    const panneau = page.getByRole("dialog").last();
    await expect(panneau.getByText(/^Budget/)).toHaveCount(0);
    await panneau.getByRole("button", { name: "Marquer payé" }).click();
    await expect.poll(async () => String((await remise())?.expenseOrder?.status), { timeout: 15_000 }).toBe("PAID");
  });
});

test("Caissier — confirmer la réception : la somme entre dans la caisse", async ({ recette: r, page }) => {
  await r.connecter("caissier");
  await r.etape("Ouvrir « Moyens généraux »", "La remise payée attend sa confirmation : bouton « Confirmer la réception »", async () => {
    await r.aller("/moyens-generaux");
    await expect(page.getByRole("button", { name: /Confirmer la réception/ }).first()).toBeVisible();
  });
  await r.etape("Cliquer « Confirmer la réception »", "« En caisse » compte désormais 24 000 DZD ; la remise est confirmée", async () => {
    await page.getByRole("button", { name: /Confirmer la réception/ }).first().click();
    await expect.poll(async () => (await remise())?.status, { timeout: 15_000 }).not.toBe("ALLOTTED");
    await r.aller("/moyens-generaux");
    await expect(page.getByText(/24[\s  ]000/).first()).toBeVisible();
  });
  await r.controle("Un autre compte (assistante) ouvre la caisse", "Elle ne peut pas confirmer une remise qui ne lui est pas faite", async () => {
    await r.connecter("assistante");
    await r.aller("/moyens-generaux");
    await expect(page.getByRole("button", { name: /Confirmer la réception/ })).toHaveCount(0);
  });
});
