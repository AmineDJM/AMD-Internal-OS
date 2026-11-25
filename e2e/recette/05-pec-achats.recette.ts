import type { Page } from "@playwright/test";
import { test, expect, graine } from "./banc";
import { db, fermer, pdfDeTest } from "./donnees";
import { P } from "./comptes";
import { cliquerDecisif } from "../decisif";

/**
 * PARCOURS 5 — PRISE EN CHARGE v2 : du professionnel au BC signé, achat, facture, paiement
 * (maquettes PriseEnCharge + Chiffrage validées le 24/11 ; lot pec FUSIONNÉ, bureau du secrétariat FUSIONNÉ).
 *
 * Direction Marketing ajoute un professionnel (« Demander son devis » coché) → une demande de chiffrage arrive
 * chez l'assistante (Bureau du secrétariat) → « Envoyer les montants » → la DM « Valider et lancer les achats »
 * → BC n°1 : signature DM → visa du centre de validation Ad & Pro → signature des Finances → l'assistante
 * achète CE QUI EST DANS LE BC, joint la facture (OBLIGATOIRE) et « Demander le paiement » → centre de paiement.
 * Données : une demande de congrès national de TEST, déjà prévalidée (circuit terminé), sous le nouveau circuit (`circuitAchatAt`).
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
      // PRÉVALIDÉE (N+1 → Directeur des opérations → Direction Marketing) : c'est la porte de tout devis, BC ou ordre
      // (`demandePrevalidee`). « PRELIMINARY_APPROVED » n'est qu'une étape de l'ancien circuit, pas la prévalidation.
      requestStatus: "APPROVED", circuitAchatAt: new Date(),
      date: new Date(Date.now() + 30 * 86_400_000), endDate: new Date(Date.now() + 32 * 86_400_000),
    },
  })).id;
});
test.afterAll(async () => { await fermer(); });

const fiche = () => `/congress-national/${demandeId}`;

/** « Ouvrir » d'une section vide de la fiche voyageur (Billetterie, Hôtellerie) : le bloc qui porte la phrase ET le bouton. */
async function ouvrirSection(page: Page, phrase: string): Promise<void> {
  await page.locator("div").filter({ has: page.getByText(phrase, { exact: true }) }).filter({ has: page.getByRole("button", { name: "Ouvrir" }) })
    .last().getByRole("button", { name: "Ouvrir" }).click();
}

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
  // CIRCUIT D'ACHAT (24/11/2026) : la fiche d'un professionnel naît SANS poste — billet, hôtel… s'ajoutent à la main
  // (« seules les NOUVELLES demandes changent »). Sans poste, l'assistante n'aurait rien à chiffrer.
  await r.etape(`Ouvrir la fiche de « ${PRO} », ouvrir un billet et un hôtel`,
    "La fiche montre « Billetterie » et « Hôtellerie » ouvertes ; retour à la liste des professionnels", async () => {
      await page.locator("section[aria-labelledby='pec-pros'] li, section[aria-labelledby='pec-pros'] tr").filter({ hasText: PRO }).first()
        .getByRole("button", { name: "Ouvrir", exact: true }).click();
      await expect(page.getByText("Pas de billet ouvert.")).toBeVisible();
      await ouvrirSection(page, "Pas de billet ouvert.");
      await expect(page.getByText("Pas de billet ouvert.")).toHaveCount(0);
      await ouvrirSection(page, "Pas d'hôtel ouvert.");
      await expect(page.getByText("Pas d'hôtel ouvert.")).toHaveCount(0);
      await page.getByRole("button", { name: "Professionnels de la demande" }).click();
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
      // « Envoyer les montants » est un bouton DÉCISIF : deux clics.
      await cliquerDecisif(page.getByRole("button", { name: "Envoyer les montants" }));
      await expect(page.getByText("Montants envoyés — la Direction Marketing est prévenue.").first()).toBeVisible();
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
    // « Valider et lancer les achats » est un bouton DÉCISIF : deux clics. Le BC n°1 naît et attend la signature de la DM.
    await cliquerDecisif(page.getByRole("button", { name: "Valider et lancer les achats" }));
    await expect(page.getByText(/BC n°1 \(.*\) lancé/).first()).toBeVisible({ timeout: 30_000 });
    expect(await db().carePecBc.count({ where: { congressNationalId: demandeId, numero: 1, legalDocumentId: { not: null } } })).toBe(1);
  });
  await r.etape("« Signer et cacheter le BC n°1 » (mot de passe + code à 6 chiffres)", "Bloc « À vous : signer et cacheter le BC n°1 » : « J'ai relu », mot de passe, code de l'application ; le bouton reste fermé tant qu'ils manquent", async () => {
    await expect(page.getByText(/À vous : signer et cacheter le BC n°1/)).toBeVisible();
    await expect(page.getByLabel("Mot de passe")).toBeVisible();
    await expect(page.getByLabel("Code de l'application")).toBeVisible();
    await expect(page.getByRole("button", { name: /Signer et cacheter le BC n°1/ })).toBeDisabled();
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

/**
 * L'AMONT DE L'ACHAT : les trois signatures du BC n°1 (Direction Marketing par mot de passe + code de l'application, visa du
 * centre Ad & Pro, Finances) se font À LA MAIN pendant la recette (`@manuel:signature-bc`) — un script n'a pas le code de
 * l'application. Le banc les POSE donc en base, comme tout amont qu'un parcours ne recette pas (`donnees.ts`), pour éprouver
 * ce qui suit : n'acheter que le BC, la marge de 10 %, la facture obligatoire.
 */
async function signerLeBcEnAmont(): Promise<string | null> {
  const bc = await db().carePecBc.findFirst({ where: { congressNationalId: demandeId, numero: 1 }, select: { legalDocumentId: true } });
  if (!bc?.legalDocumentId) return null;
  const g = graine();
  const id = bc.legalDocumentId;
  await db().signatureBC.upsert({
    where: { legalDocumentId_qualite: { legalDocumentId: id, qualite: "DIRECTION_MARKETING" } },
    create: { legalDocumentId: id, qualite: "DIRECTION_MARKETING", userId: g.comptes.dirMarketing, signataireNom: `${P} Direction Marketing`, methode: "RECETTE", jeton: `${P}${id}` },
    update: {},
  });
  await db().legalDocument.update({ where: { id }, data: { signedAt: new Date(), signedById: g.comptes.finances } });
  return id;
}

test("Assistante — acheter ce qui est dans le BC, facture OBLIGATOIRE, « Demander le paiement »", { tag: ["@manuel:signature-bc"] }, async ({ recette: r, page }) => {
  await r.connecter("assistante");
  await r.etape("Ouvrir la page d'achat du BC n°1 (signatures DM, visa Ad & Pro, Finances posées en amont)", "Seules les lignes de CE BC ; « Déposer le billet » / « Déposer la confirmation » (« Marquer acheté » pour un autre poste)", async () => {
    expect(await signerLeBcEnAmont(), "le BC n°1 est lancé par la Direction Marketing (parcours précédent)").not.toBeNull();
    await r.aller(`/congress-national/${demandeId}/achat/1`);
    await expect(page.getByRole("heading", { name: "Ce que porte le BC n°1" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Déposer le billet" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Déposer la confirmation" })).toBeVisible();
  });
  await r.controle("Déposer le billet à un prix +15 % au-dessus du montant validé (45 000 → 51 750)",
    "Accepté sans toucher au BC signé : « Au-delà de la marge de 10 % … le complément … part dans un BC complémentaire »", async () => {
      const ligne = page.locator("section[aria-labelledby='lignes-bc'] li").filter({ has: page.getByRole("button", { name: "Déposer le billet" }) }).first();
      await ligne.locator("input[type='file']").setInputFiles(pdfDeTest("E-billet Oran"));
      await ligne.getByLabel("Référence de réservation").fill("PNR7K2");
      await ligne.getByLabel("Montant d'achat, s'il a changé").fill("51750");
      await cliquerDecisif(ligne.getByRole("button", { name: "Déposer le billet" }));
      await expect(page.getByText(/Au-delà de la marge de 10 %/).first()).toBeVisible();
      await expect(page.getByText(/BC complémentaire/).first()).toBeVisible();
    });
  await r.controle("« Demander le paiement » sans facture", "Bouton fermé ; la page dit « La facture est obligatoire »", async () => {
    await expect(page.getByText(/La facture est obligatoire/).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Demander le paiement" })).toBeDisabled();
  });
});
