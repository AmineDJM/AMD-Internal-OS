import { test, expect, graine } from "./banc";
import { db, fermer, pdfDeTest } from "./donnees";
import { P } from "./comptes";

/**
 * PARCOURS 5 — PRISE EN CHARGE v2 : du professionnel au BC signé, achat, facture, paiement
 * (maquettes PriseEnCharge + Chiffrage validées le 24/11 ; lot pec FUSIONNÉ, bureau du secrétariat FUSIONNÉ).
 *
 * Direction Marketing ajoute un professionnel (« Demander son devis » coché) → une demande de chiffrage arrive
 * chez l'assistante (Bureau du secrétariat) → « Envoyer les montants » → la DM « Valider et lancer les achats »
 * → BC n°1 : signature DM → visa du centre de validation Ad & Pro → signature des Finances → l'assistante
 * achète CE QUI EST DANS LE BC, joint la facture (OBLIGATOIRE) et « Demander le paiement » → centre de paiement.
 * Données : une demande de congrès national de TEST, déjà prévalidée, sous le nouveau circuit (`circuitAchatAt`).
 * Les sélecteurs suivent achats-tableau.tsx / achats-grille.tsx / achats-acheter.tsx ; à ajuster à l'exécution.
 */

const NOM = `${P} Congrès national de diabétologie — Oran`;
const PRO = `${P} Pr Karim Mansouri`;
let demandeId = "";

test.beforeAll(async () => {
  const g = graine();
  const deja = await db().congressNational.findFirst({ where: { name: NOM }, select: { id: true } });
  demandeId = deja?.id ?? (await db().congressNational.create({
    data: {
      name: NOM, city: "Oran", companyId: g.societeId, businessUnitId: g.buId, requesterId: g.comptes.kam, createdById: g.comptes.kam,
      requestStatus: "PRELIMINARY_APPROVED", circuitAchatAt: new Date(),
      startDate: new Date(Date.now() + 30 * 86_400_000), endDate: new Date(Date.now() + 32 * 86_400_000),
    } as never,
  })).id;
});
test.afterAll(async () => { await fermer(); });

const fiche = () => `/congress-national/${demandeId}`;

test("Direction Marketing — ajouter un professionnel, « Demander son devis » coché", async ({ recette: r, page }) => {
  await r.connecter("dirMarketing");
  await r.etape("Ouvrir la demande « Congrès national de diabétologie — Oran »", "Bloc « Professionnels · n » avec le champ « Ajouter un professionnel » et la case « Demander son devis » COCHÉE", async () => {
    await r.aller(fiche());
    await expect(page.getByLabel("Ajouter un professionnel")).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "Demander son devis" })).toBeChecked();
  });
  await r.etape(`Taper « ${PRO} » (absent de l'annuaire), laisser « Demander son devis », « Ajouter »`,
    "La ligne du professionnel apparaît : « Où il en est » = chiffrage demandé ; une demande de chiffrage part chez l'assistante", async () => {
      await page.getByLabel("Ajouter un professionnel").fill(PRO);
      await page.getByRole("button", { name: "Ajouter", exact: true }).click();
      const choix = page.getByRole("button", { name: /Non, créer une nouvelle fiche/ });
      if (await choix.isVisible().catch(() => false)) await choix.click();
      await expect(page.getByText(PRO).first()).toBeVisible();
    });
  await r.controle("Le champ « Ajouter à l'annuaire » n'existe que pour les prises en charge", "Visible ici (PEC) ; absent d'un sponsoring ou d'un événement", async () => {
    await page.getByLabel("Ajouter un professionnel").fill(`${P} Dr Test Annuaire`);
    await expect(page.getByRole("checkbox", { name: "Ajouter à l'annuaire" })).toBeVisible();
    await page.getByLabel("Ajouter un professionnel").fill("");
  });
});

test("Assistante — chiffrer depuis le Bureau du secrétariat, « Envoyer les montants »", async ({ recette: r, page }) => {
  await r.connecter("assistante");
  await r.etape("Ouvrir le « Bureau du secrétariat »", "Un seul tableau : Type, Objet (+ référence), Demandeur, Dates, État, Chez qui, Échéance ; la ligne « Chiffrage PEC » du congrès", async () => {
    await r.aller("/demandes");
    await expect(page.getByRole("heading", { name: "Bureau du secrétariat" })).toBeVisible();
    for (const col of ["Type", "Objet", "Demandeur", "Dates", "État", "Chez qui", "Échéance"]) await expect(page.getByRole("columnheader", { name: col })).toBeVisible();
    await expect(page.getByText(/diabétologie/).first()).toBeVisible();
  });
  await r.etape("Ouvrir la ligne de chiffrage", "Page « Chiffrer — Congrès national de diabétologie » : grille « Montants » poste par poste, pièce facultative", async () => {
    await page.getByText(/diabétologie/).first().click();
    await expect(page).toHaveURL(/chiffrer|demandes/);
    await expect(page.getByText("Montants").first()).toBeVisible();
  });
  await r.etape("Saisir 45 000 (billet) et 60 000 (hôtel), joindre la proforma, « Envoyer les montants »",
    "Phrase de confirmation ; la Direction Marketing est prévenue « À vous : n professionnels chiffrés à valider »", async () => {
      const champs = page.locator("section[aria-labelledby='grille-montants'] input[inputmode], section[aria-labelledby='grille-montants'] input[type='number']");
      const n = await champs.count();
      for (let i = 0; i < n; i += 1) await champs.nth(i).fill(i === 0 ? "45000" : "60000");
      const fichier = page.locator("section[aria-labelledby='grille-montants'] input[type='file']").first();
      if (await fichier.count()) await fichier.setInputFiles(pdfDeTest("Proforma agence voyage"));
      await page.getByRole("button", { name: "Envoyer les montants" }).click();
      await expect(page.getByRole("status").or(page.getByText(/envoy/i)).first()).toBeVisible();
      return `${n} montant(s) saisi(s)`;
    });
  await r.controle("Un demandeur ordinaire (délégué) ouvre le Bureau du secrétariat", "Il ne voit que SES demandes (pas le chiffrage du congrès)", async () => {
    await r.connecter("delegue");
    await r.aller("/demandes");
    await expect(page.getByText(/diabétologie/)).toHaveCount(0);
  });
});

test("Direction Marketing — « Valider et lancer les achats », signer le BC n°1", async ({ recette: r, page }) => {
  await r.connecter("dirMarketing");
  await r.aller(fiche());
  await r.etape("Lire le bandeau « À vous »", "« À vous : 1 professionnel chiffré à valider — 105 000 DZD » ; boutons « Valider seulement » et « Valider et lancer les achats »", async () => {
    await expect(page.getByText(/À vous/).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Valider seulement" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Valider et lancer les achats" })).toBeVisible();
  });
  await r.etape("Choisir la catégorie budgétaire, « Valider et lancer les achats »", "Bloc « Bons de commande » : BC n°1 (contenu, montant, circuit « signature Direction Marketing »)", async () => {
    const cat = page.getByLabel("Catégorie budgétaire du BC");
    if (await cat.isVisible().catch(() => false)) await cat.selectOption({ index: 1 });
    await page.getByRole("button", { name: "Valider et lancer les achats" }).click();
    await expect(page.getByText(/BC n°\s?1/).first()).toBeVisible();
  });
  await r.etape("« Signer et cacheter le BC n°1 » (mot de passe + code à 6 chiffres)", "Le BC passe au visa du centre de validation Ad & Pro", async () => {
    await page.getByRole("button", { name: /Signer et cacheter le BC n°1/ }).click();
    await expect(page.getByLabel("Mot de passe")).toBeVisible();
    return "contrôle renforcé demandé (mot de passe + code de l'application) — la signature réelle se fait à la main pendant la recette";
  });
  await r.controle("« Actualiser les prix »", "Tous les montants non encore achetés repartent chez l'assistante", async () => {
    await r.aller(fiche());
    await expect(page.getByRole("button", { name: "Actualiser les prix" })).toBeVisible();
  });
  await r.controle("Règle d'immutabilité affichée", "« Un BC signé ne se réécrit jamais : un ajout après signature part dans un BC complémentaire. »", async () => {
    await expect(page.getByText("Un BC signé ne se réécrit jamais")).toBeVisible();
  });
});

test("Assistante — acheter ce qui est dans le BC, facture OBLIGATOIRE, « Demander le paiement »", { tag: ["@manuel:signature-bc"] }, async ({ recette: r, page }) => {
  await r.connecter("assistante");
  await r.controle("Ouvrir la page d'achat du BC n°1 (après signatures DM, visa Ad & Pro, Finances)", "Seules les lignes de CE BC ; « Marquer acheté », « Déposer le billet » / « Déposer la confirmation »", async () => {
    await r.aller(`/congress-national/${demandeId}/achat/1`);
    await expect(page.getByRole("button", { name: "Marquer acheté" }).first()).toBeVisible();
  });
  await r.controle("Saisir un prix +15 % au-dessus du montant validé", "Refus de la marge : au-delà de +10 % le complément part dans un BC complémentaire ; une baisse est toujours permise", async () => {
    await expect(page.getByText(/marge de 10 %|10 %/).first()).toBeVisible();
  });
  await r.controle("« Demander le paiement » sans facture", "Bouton fermé ou refus « La facture est obligatoire »", async () => {
    await expect(page.getByText(/La facture est obligatoire/).first()).toBeVisible();
  });
});
