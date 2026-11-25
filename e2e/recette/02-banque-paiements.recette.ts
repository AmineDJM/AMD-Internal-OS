import { test, expect, graine } from "./banc";
import { cliquerDecisif } from "../decisif";
import { compteBancaire, db, enveloppe, etatOrdre, fermer, imputer, ordre } from "./donnees";

/**
 * PARCOURS 2 — BANQUE & PAIEMENTS (consignes du 24/11 ; maquette BanquePaiements ; lot banqueui FUSIONNÉ).
 *
 * Trois onglets (À payer, Reportés, Payés) ; le SOLDE BANCAIRE en haut ; cliquer le bénéficiaire ouvre le
 * justificatif + RIB + échanges avec le demandeur ; « Payer » (compte, date, mode, référence) → « Marquer
 * payé » ; un ordre REFUSÉ ou non autorisé n'apparaît jamais ; un ordre ANNULÉ affiche « Annulé ».
 */

const O = { aPayer: { id: "", reference: "", libelle: "" }, reporter: { id: "", reference: "", libelle: "" }, refuse: { id: "", reference: "", libelle: "" }, annule: { id: "", reference: "", libelle: "" } };
const banque = (vue?: string) => `/finances/paiements-a-faire?entite=${graine().societeId}${vue ? `&vue=${vue}` : ""}`;

test.beforeAll(async () => {
  const env = await enveloppe("Banque — enveloppe", "Fournitures");
  await compteBancaire("BNA Hydra", 25_000_000);
  O.aPayer = await ordre({ libelle: "Maintenance climatisation siège", montant: 64_000, demandeur: "assistante", beneficiaire: "__recette__ Froid Service", statutCentre: "APPROVED" });
  O.reporter = await ordre({ libelle: "Acompte bureau d'études AMM", montant: 410_000, demandeur: "regulatory", beneficiaire: "__recette__ ReguPharm", statutCentre: "APPROVED" });
  O.refuse = await ordre({ libelle: "Dépense refusée au centre", montant: 12_000, demandeur: "assistante", beneficiaire: "__recette__ Fournisseur refusé", statutCentre: "REFUSED" });
  O.annule = await ordre({ libelle: "Commande annulée", montant: 9_000, demandeur: "assistante", beneficiaire: "__recette__ Fournisseur annulé", statutCentre: "APPROVED" });
  await db().expenseOrder.update({ where: { id: O.annule.id }, data: { status: "CANCELLED" } });
  await imputer(O.aPayer.id, env.ligneId);
  await imputer(O.reporter.id, env.ligneId);
});
test.afterAll(async () => { await fermer(); });

test("Finances — solde bancaire, trois onglets, ce qui n'a pas à être là n'y est pas", async ({ recette: r, page }) => {
  await r.etape("Se connecter comme Finances et ouvrir « Banque & paiements »",
    "En haut « Solde bancaire » (un chiffre, date des relevés) ; onglets « À payer · n », « Reportés · n », « Payés · n »", async () => {
      await r.connecter("finances");
      await r.aller(banque());
      await expect(page.getByRole("region", { name: "Solde bancaire" }).or(page.locator("section[aria-label='Solde bancaire']")).first()).toBeVisible();
      const vues = page.getByLabel("Vues");
      for (const o of [/À payer · \d+/, /Reportés · \d+/, /Payés · \d+/]) await expect(vues.getByText(o)).toBeVisible();
    });
  await r.controle("Lire l'onglet « À payer »", "Les deux ordres AUTORISÉS y sont ; l'ordre REFUSÉ n'y est pas", async () => {
    await expect(page.getByText("Froid Service").first()).toBeVisible();
    await expect(page.getByText("ReguPharm").first()).toBeVisible();
    await expect(page.getByText("Fournisseur refusé")).toHaveCount(0);
  });
  await r.controle("Ouvrir « ⋯ » (Autres : comptes de trésorerie, actualiser les soldes, vider l'historique)",
    "« Actualiser les soldes » est proposé aux Finances", async () => {
      await page.getByLabel(/Autres : comptes de trésorerie/).click();
      await expect(page.getByText("Actualiser les soldes").first()).toBeVisible();
      await page.keyboard.press("Escape");
    });
});

test("Finances — le justificatif et les échanges avec le demandeur", async ({ recette: r, page }) => {
  await r.connecter("finances");
  await r.aller(banque());
  await r.etape("Cliquer le nom du bénéficiaire « Froid Service »",
    "Le panneau s'ouvre : justificatif (ici « Aucun justificatif joint à ce paiement. Demandez-le au demandeur ci-contre. »), RIB, « Échanges avec le demandeur »", async () => {
      await page.getByRole("button", { name: /Froid Service/ }).first().click();
      const panneau = page.getByRole("dialog").last();
      await expect(panneau).toContainText("Échanges avec le demandeur");
      await expect(panneau.getByLabel("Justificatif")).toBeVisible();
    });
  await r.etape("Écrire au demandeur : « Merci de transmettre le RIB du fournisseur. » puis « Envoyer »",
    "Le message s'affiche dans le fil ; le demandeur est notifié", async () => {
      const panneau = page.getByRole("dialog").last();
      await panneau.getByPlaceholder("Une question au demandeur : RIB, mode de règlement souhaité, acompte…").fill("__recette__ Merci de transmettre le RIB du fournisseur.");
      await panneau.getByRole("button", { name: "Envoyer", exact: true }).click();
      await expect(panneau).toContainText("Merci de transmettre le RIB du fournisseur.");
    }, { cible: page.getByRole("dialog").last() });
  await r.controle("Le demandeur (assistante) ouvre ses notifications", "Une notification porte la question des Finances et mène au dossier de paiement", async () => {
    const tel = await r.telephone("assistante");
    await r.aller("/notifications", tel);
    await expect(tel.getByText(/Finances|RIB|question/i).first()).toBeVisible();
  });
});

test("Finances — « Reporter » puis « Lever le report »", async ({ recette: r, page }) => {
  await r.connecter("finances");
  await r.aller(banque());
  await r.etape("Sur la ligne « ReguPharm » : ⋯ › « Reporter »", "Panneau « Reporter le paiement » : « Reporter au », « Motif (visible par le demandeur) »", async () => {
    // Le « ⋯ » de la ligne s'appelle « Autres actions sur <bénéficiaire> » ; son menu, « Actions sur la ligne ».
    await page.getByRole("button", { name: /Autres actions sur .*ReguPharm/ }).first().click();
    await page.getByRole("menu", { name: "Actions sur la ligne" }).getByRole("menuitem", { name: "Reporter" }).click();
    await expect(page.getByText("Reporter au")).toBeVisible();
  });
  await r.etape("Choisir une date à J+10, motif « attente du visa », valider", "La ligne passe dans « Reportés » ; en base : deferredUntil posé", async () => {
    const d = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
    await page.locator("input[name='until']").fill(d);
    await page.getByPlaceholder("Pourquoi ce paiement attend-il ?").fill("__recette__ attente du visa");
    await page.getByRole("dialog").last().getByRole("button", { name: /^Reporter/ }).last().click();
    await expect.poll(async () => Boolean((await db().expenseOrder.findUniqueOrThrow({ where: { id: O.reporter.id } })).deferredUntil)).toBe(true);
    await r.aller(banque("reportes"));
    await expect(page.getByText("ReguPharm").first()).toBeVisible();
  });
  await r.controle("Cliquer « Lever le report »", "« Report levé : … revient dans « À payer ». »", async () => {
    await page.getByRole("button", { name: "Lever le report" }).first().click();
    await expect(page.getByText(/Report levé/)).toBeVisible();
  });
});

test("Finances — « Payer » puis « Marquer payé » ; l'annulé dit « Annulé »", async ({ recette: r, page }) => {
  await r.connecter("finances");
  await r.aller(banque());
  await r.etape("Cliquer « Payer » sur la ligne « Froid Service »",
    "Panneau « Payer Froid Service » : « Payé depuis » (compte + solde), « Date du paiement », « Mode », « Référence du virement ou du chèque (facultatif) »", async () => {
      const ligne = page.locator("tr, li").filter({ hasText: "Froid Service" }).first();
      await ligne.getByRole("button", { name: "Payer", exact: true }).click();
      await expect(page.getByText("Payé depuis")).toBeVisible();
      await expect(page.getByText("Date du paiement")).toBeVisible();
    });
  await r.etape("Choisir le compte « BNA Hydra », mode virement, puis « Marquer payé »",
    "La ligne quitte « À payer » et apparaît dans « Payés » avec « Payé le … » ; en base : PAID", async () => {
      const panneau = page.getByRole("dialog").last();
      // Plusieurs comptes : on choisit « BNA Hydra » ; un seul : il est affiché, sans choix à faire.
      const bna = panneau.getByRole("button", { name: /BNA Hydra/ });
      if (await bna.count()) await bna.first().click();
      await expect(panneau.getByText(/BNA Hydra/).first()).toBeVisible();
      // « Marquer payé » est un bouton DÉCISIF : deux clics.
      await cliquerDecisif(panneau.getByRole("button", { name: "Marquer payé" }));
      await expect.poll(async () => (await etatOrdre(O.aPayer.id)).status, { timeout: 15_000 }).toBe("PAID");
      await r.aller(banque("payes"));
      await expect(page.locator("tr, li").filter({ hasText: "Froid Service" }).first()).toContainText(/Payé le/);
    });
  await r.controle("Lire l'ordre annulé dans « Payés »", "Il affiche « Annulé » — jamais « Non payé »", async () => {
    const ligne = page.locator("tr, li").filter({ hasText: "Fournisseur annulé" }).first();
    await expect(ligne).toContainText("Annulé");
    await expect(ligne).not.toContainText("Non payé");
  });
});

test("Séparation des tâches — la Comptabilité et le délégué n'entrent pas à la Banque", async ({ recette: r, page }) => {
  for (const cle of ["comptable", "delegue"] as const) {
    await r.controle(`${cle === "comptable" ? "Comptabilité" : "Délégué médical"} : ouvrir /finances/paiements-a-faire`,
      "Refus d'accès (redirection hors de la page, aucun « Marquer payé »)", async () => {
        await r.connecter(cle);
        await r.aller("/finances/paiements-a-faire");
        await expect(page).not.toHaveURL(/\/finances\/paiements-a-faire/);
        await expect(page.getByRole("button", { name: "Marquer payé" })).toHaveCount(0);
        return `arrivé sur ${new URL(page.url()).pathname}`;
      });
  }
});

test("Téléphone — Banque & paiements au téléphone", async ({ recette: r }) => {
  const tel = await r.telephone("finances");
  await r.controle("Ouvrir la Banque sur un téléphone (390 px)", "Solde lisible, onglets accessibles, aucun défilement de côté", async () => {
    await r.aller(banque(), tel);
    await expect(tel.getByLabel("Vues")).toBeVisible();
    return r.sansDebordement(tel);
  }, { page: tel });
});
