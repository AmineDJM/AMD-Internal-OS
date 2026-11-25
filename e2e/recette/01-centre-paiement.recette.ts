import { test, expect, graine } from "./banc";
import { ordre, etatOrdre, fermer } from "./donnees";
import { ficheDuCentre, ligneDuCentre, ouvrirAuCentre } from "../centre";
import { cliquerDecisif } from "../decisif";

/**
 * PARCOURS 1 — LE CENTRE DE PAIEMENT (maquette CentrePaiement validée le 24/11 ; lot centreui FUSIONNÉ).
 *
 * Réservé à la Direction générale (Super Admin + Directeur général) ; un ordre refusé ou pas encore
 * autorisé n'atteint JAMAIS les Finances ; le demandeur suit son ordre sans pouvoir le décider ;
 * le demandeur ne décide pas son propre paiement (séparation des tâches).
 */

let A = { id: "", reference: "", libelle: "" };
let B = { id: "", reference: "", libelle: "" };
let C = { id: "", reference: "", libelle: "" };
let D = { id: "", reference: "", libelle: "" };
const centre = () => `/centre-de-paiement?entite=${graine().societeId}`;

test.beforeAll(async () => {
  // A honore un BC signé de 185 000 : la frise « Les montants » (BC → À payer) et l'alerte « Sans facture » (exigée au règlement).
  A = await ordre({ libelle: "Impression des dépliants Cardio", montant: 185_000, demandeur: "assistante", beneficiaire: "__recette__ Imprimerie El Djazair", bcSigne: 185_000 });
  B = await ordre({ libelle: "Location salle comité de direction", montant: 96_000, demandeur: "dg", beneficiaire: "__recette__ Hôtel Aurassi" });
  C = await ordre({ libelle: "Abonnement revue doublon", montant: 42_000, demandeur: "assistante", beneficiaire: "__recette__ Éditions Santé" });
  D = await ordre({ libelle: "Fournitures de bureau novembre", montant: 23_500, demandeur: "assistante", beneficiaire: "__recette__ Papeterie Centrale" });
});

test.afterAll(async () => { await fermer(); });

test("Super Admin — la file « À décider », la fiche de décision, « Autoriser le paiement »", async ({ recette: r, page }) => {
  await r.etape("Se connecter comme Super Admin et ouvrir le centre sur la société de test",
    "Titre « Centre de paiement » ; à gauche « À décider · N » avec les 4 ordres de test", async () => {
      await r.connecter("superAdmin");
      await r.aller(centre());
      await expect(page.getByRole("heading", { level: 1, name: "Centre de paiement" })).toBeVisible();
      await expect(page.locator("#file-centre")).toContainText(/À décider · \d+/);
      for (const o of [A, B, C, D]) await expect(ligneDuCentre(page, o.libelle)).toBeVisible();
      return (await page.locator("#file-centre").innerText()).trim();
    });

  await r.etape(`Cliquer la ligne « ${A.libelle} »`,
    "La fiche s'ouvre à droite : montant + bénéficiaire, « Déjà validé », « Pièces », « Les montants, du début à la fin »", async () => {
      const fiche = await ouvrirAuCentre(page, A.libelle);
      await expect(fiche).toContainText("185");
      await expect(fiche).toContainText("Imprimerie El Djazair");
      for (const bloc of ["Déjà validé", "Pièces", "Les montants, du début à la fin"]) await expect(fiche).toContainText(bloc);
    }, { cible: ficheDuCentre(page) });

  await r.controle("Lire les alertes de la fiche",
    "Alerte en rouge « Sans facture » (le BC est signé, la facture n'est pas encore jointe) ; « Déjà validé » cite le BC signé", async () => {
      await expect(ficheDuCentre(page).locator("[data-alertes]")).toContainText("Sans facture");
      await expect(ficheDuCentre(page)).toContainText(/BC n°[\s\S]*signé le/);
    }, { cible: ficheDuCentre(page) });

  await r.etape("Cliquer « Autoriser le paiement » (bouton décisif : deux clics)",
    "Bandeau « Autorisé — le paiement part chez les Finances (Banque & paiements). », la ligne passe « Autorisé » et la fiche suivante s'ouvre ; en base : APPROVED", async () => {
      await cliquerDecisif(ficheDuCentre(page).getByRole("button", { name: "Autoriser le paiement" }));
      // Le bandeau ne reste que 0,9 s : la fiche SUIVANTE s'ouvre d'elle-même et l'ordre décidé sort de la file. Ce qui
      // demeure, c'est la phrase de retour du geste : « Paiement autorisé : … passe aux Finances, qui le régleront. »
      await expect(page.getByText(/Paiement autorisé : .* passe aux Finances/).first()).toBeVisible();
      await expect.poll(async () => (await etatOrdre(A.id)).centralStatus, { timeout: 15_000 }).toBe("APPROVED");
      return "centralStatus = APPROVED";
    }, { cible: ficheDuCentre(page) });

  await r.controle("Recharger la page", "L'ordre décidé est sorti de la file « À décider »", async () => {
    await r.aller(centre());
    await expect(ligneDuCentre(page, A.libelle)).toHaveCount(0);
  });

  await r.controle("Ouvrir « ⋯ » (Autres : déjà décidés, exporter) › « Déjà décidés · n »", "L'ordre autorisé figure dans « Déjà décidés », marqué autorisé", async () => {
    await page.getByLabel("Autres : déjà décidés, exporter").click();
    await page.getByRole("menuitem", { name: /Déjà décidés · \d+/ }).click();
    const liste = page.getByRole("dialog", { name: "Déjà décidés" });
    await expect(liste.locator("li").filter({ hasText: A.libelle })).toBeVisible();
  });
});

test("Super Admin — « Refuser » avec un motif en un clic", async ({ recette: r, page }) => {
  await r.connecter("superAdmin");
  await r.aller(centre());
  await r.etape(`Ouvrir « ${C.libelle} » puis cliquer « Refuser »`,
    "« Motif du refus — c'est ce que lira le demandeur », des motifs en un clic, un champ « Ou écrivez le vôtre… »", async () => {
      const fiche = await ouvrirAuCentre(page, C.libelle);
      await fiche.getByRole("button", { name: "Refuser", exact: true }).click();
      await expect(fiche).toContainText("Motif du refus — c'est ce que lira le demandeur");
      await expect(fiche.getByLabel("Motif du refus")).toBeVisible();
    }, { cible: ficheDuCentre(page) });

  await r.etape("Choisir le premier motif proposé puis « Confirmer le refus » (deux clics)",
    "Bandeau « Refusé — le demandeur est prévenu, avec votre motif. » ; en base : REFUSED", async () => {
      const fiche = ficheDuCentre(page);
      await fiche.locator("button[aria-pressed]").first().click();
      await expect(fiche.getByLabel("Motif du refus")).not.toHaveValue("");
      await cliquerDecisif(fiche.getByRole("button", { name: "Confirmer le refus" }));
      // Même course que l'autorisation : le bandeau cède la place à la fiche suivante ; la phrase de retour demeure.
      await expect(page.getByText(/Paiement refusé : .*Le demandeur est prévenu/).first()).toBeVisible();
      await expect.poll(async () => (await etatOrdre(C.id)).centralStatus, { timeout: 15_000 }).toBe("REFUSED");
      return "centralStatus = REFUSED";
    }, { cible: ficheDuCentre(page) });
});

test("Directeur général — il siège, mais ne décide pas un paiement qu'il a demandé", async ({ recette: r, page }) => {
  await r.etape("Se connecter comme DG et ouvrir le centre", "La file « À décider » s'affiche (le DG siège au centre)", async () => {
    await r.connecter("dg");
    await r.aller(centre());
    await expect(page.locator("#file-centre")).toContainText("À décider");
  });
  await r.controle(`Ouvrir « ${B.libelle} » (demandé par le DG lui-même)`,
    "« Autoriser le paiement » est fermé et une phrase dit pourquoi (demandeur = décideur)", async () => {
      const fiche = await ouvrirAuCentre(page, B.libelle);
      await expect(fiche.getByRole("button", { name: "Autoriser le paiement" })).toBeDisabled();
      await expect(fiche).toContainText(/Demandeur = décideur|demand/i);
    }, { cible: ficheDuCentre(page) });
});

test("Directeur des opérations — aucun siège au centre de paiement", async ({ recette: r, page }) => {
  await r.etape("Se connecter comme Directeur des opérations et ouvrir /centre-de-paiement",
    "« réservé à la Direction générale » — aucun bouton de décision", async () => {
      await r.connecter("dirOps");
      await r.aller("/centre-de-paiement");
      await expect(page.getByText("Le centre de paiement est réservé à la Direction générale", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Autoriser le paiement" })).toHaveCount(0);
    });
});

test("Demandeur (assistante) — suit son ordre au centre, sans pouvoir le décider", async ({ recette: r, page }) => {
  await r.etape("Se connecter comme assistante et ouvrir le centre", "« Mes paiements au centre » avec son ordre en attente ; aucun « Autoriser »", async () => {
    await r.connecter("assistante");
    await r.aller("/centre-de-paiement");
    await expect(page.locator("#file-centre")).toContainText("Mes paiements au centre");
    await expect(ligneDuCentre(page, D.libelle)).toBeVisible();
    await expect(page.getByRole("button", { name: "Autoriser le paiement" })).toHaveCount(0);
  });
  await r.controle("Ouvrir ses notifications", "Le refus de « Abonnement revue doublon » lui est notifié avec le motif", async () => {
    await r.aller("/notifications");
    await expect(page.getByText(/refus/i).first()).toBeVisible();
  });
});

test("Finances — un ordre refusé ou pas encore autorisé n'apparaît jamais à la Banque", async ({ recette: r, page }) => {
  await r.etape("Se connecter comme Finances et ouvrir Banque & paiements", "L'ordre AUTORISÉ est dans « À payer »", async () => {
    await r.connecter("finances");
    await r.aller(`/finances/paiements-a-faire?entite=${graine().societeId}`);
    await expect(page.getByText(A.libelle).or(page.getByText("Imprimerie El Djazair")).first()).toBeVisible();
  });
  await r.controle("Chercher l'ordre REFUSÉ et l'ordre EN ATTENTE", "Ni « Abonnement revue doublon » (refusé) ni « Fournitures de bureau novembre » (en attente)", async () => {
    await expect(page.getByText(C.libelle)).toHaveCount(0);
    await expect(page.getByText(D.libelle)).toHaveCount(0);
    await expect(page.getByText("Éditions Santé")).toHaveCount(0);
  });
});

test("Téléphone — le Super Admin décide depuis la file", async ({ recette: r }) => {
  const tel = await r.telephone("superAdmin");
  await r.controle("Ouvrir le centre sur un téléphone (390 px)", "La file tient dans l'écran, sans défilement de côté", async () => {
    await r.aller(centre(), tel);
    await expect(ligneDuCentre(tel, D.libelle)).toBeVisible();
    return r.sansDebordement(tel);
  }, { page: tel });
  await r.controle(`Toucher « ${D.libelle} »`, "La fiche s'ouvre en plein écran avec « Retour à la file » ; pas de débordement", async () => {
    await ligneDuCentre(tel, D.libelle).getByRole("button").first().click();
    await expect(tel.getByRole("button", { name: "Retour à la file" })).toBeVisible();
    await expect(ficheDuCentre(tel).getByRole("button", { name: "Autoriser le paiement" })).toBeVisible();
    return r.sansDebordement(tel);
  }, { page: tel });
});
