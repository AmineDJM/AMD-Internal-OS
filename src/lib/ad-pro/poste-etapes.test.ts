import { describe, it, expect } from "vitest";
import { faitsDuPoste, etapesDuPoste, prochainPas, facturePourPayer, LIBELLE_JUSTIFICATIF_DIRECT, type FaitsPoste, type RegardPoste } from "@/lib/ad-pro/poste-etapes";

/**
 * LE GESTE SUIVANT D'UN POSTE (§118.175, §118.204) — un seul, ou ce qu'on attend et de qui.
 *
 * Chaque cas nomme la situation qui ferait tomber la règle (§118.17). Le banc de bout en bout
 * (`ad-pro-postes-flow.test.ts`, `postes-chaine-flow.test.ts`) rejoue chaque geste rendu par la VRAIE
 * action : ici, on tient la CARTE ; là-bas, qu'elle ne propose rien que l'action refuserait.
 *
 * Depuis §118.204 : la validation d'un poste d'argent se fait en DEUX TEMPS (Direction des opérations,
 * puis Direction Marketing qui fixe montant ET budget), le bon de commande passe par l'assistante de
 * direction puis la signature des Finances, et le paiement part de la FACTURE du demandeur.
 */

const poste = (p: Partial<FaitsPoste> = {}): FaitsPoste => ({
  kind: "STAND", status: "DRAFT", amountEstimated: null, amountGranted: null,
  budgetCategoryId: null, orderStage: "NONE", expenseOrderId: null, expenseOrderStatus: null, lignesStock: 0, ...p,
});
const regard = (r: Partial<RegardPoste> = {}): RegardPoste => ({
  canEdit: false, canAllocate: false, canViserBC: false, canEmettre: false, fige: false, operationDecidee: true, ...r,
});
const DEMANDEUR = regard({ canEdit: true });
const OPERATIONS = regard({ canAllocate: true, validation: { operations: true, marketing: false } });
const MARKETING = regard({ canAllocate: true, validation: { operations: false, marketing: true } });
const pret = (p: Partial<FaitsPoste> = {}) => poste({ status: "APPROVED", amountGranted: 120_000, budgetCategoryId: "cat", opsDecidedAt: "2026-10-01", ...p });

describe("le geste suivant d'un poste", () => {
  it("un poste « Matériel du stock » : pas de frise d'argent, mais le même ACCORD — soumettre puis décider", () => {
    const vide = poste({ kind: "STOCK_MATERIAL" });
    expect(etapesDuPoste(vide)).toEqual([]);
    expect(prochainPas(vide, DEMANDEUR)).toEqual({ geste: null, attente: "Ajoutez au moins un article du magasin pour soumettre ce poste." });
    expect(prochainPas(poste({ kind: "STOCK_MATERIAL", lignesStock: 2 }), DEMANDEUR).geste?.cle).toBe("SOUMETTRE");
    // Le stock garde sa décision UNIQUE : `canAllocate` décide, pas les deux temps.
    expect(prochainPas(poste({ kind: "STOCK_MATERIAL", status: "PENDING", lignesStock: 2 }), regard({ canAllocate: true })).geste?.cle).toBe("DECIDER");
    expect(prochainPas(poste({ kind: "STOCK_MATERIAL", status: "APPROVED", lignesStock: 2 }), MARKETING)).toEqual({ geste: null, attente: null });
  });

  it("un sponsoring indirect non réparti : le SEUL geste est de le répartir — même chiffré", () => {
    const p = poste({ kind: "INDIRECT_SUPPORT", amountEstimated: 400_000 });
    expect(prochainPas(p, DEMANDEUR).geste?.cle).toBe("REPARTIR");
    expect(prochainPas(p, DEMANDEUR).geste?.cle).not.toBe("SOUMETTRE");
    expect(prochainPas(p, regard()).attente).toMatch(/répartir/);
    expect(prochainPas(p, regard({ canEdit: true, fige: true })).geste).toBeNull();
  });

  it("un brouillon : chiffrer d'abord, puis soumettre — et qui ne peut pas le voit attendre le demandeur", () => {
    expect(prochainPas(poste(), DEMANDEUR).geste?.cle).toBe("CHIFFRER");
    expect(prochainPas(poste({ amountEstimated: 120_000 }), DEMANDEUR).geste).toEqual({ cle: "SOUMETTRE", libelle: "Soumettre pour validation" });
    expect(prochainPas(poste({ status: "REVISION", amountEstimated: 120_000 }), DEMANDEUR).geste?.libelle).toBe("Resoumettre pour validation");
    expect(prochainPas(poste({ amountEstimated: 120_000 }), regard()).attente).toMatch(/demandeur/);
  });

  it("DEUX TEMPS : la Direction des opérations d'abord — la Direction Marketing ne voit rien à faire avant elle", () => {
    const p = poste({ status: "PENDING", amountEstimated: 120_000 });
    expect(prochainPas(p, OPERATIONS).geste?.cle).toBe("VALIDER_OPS");
    // Ce qui ferait tomber la règle : proposer DECIDER à la Direction Marketing avant le premier temps.
    expect(prochainPas(p, MARKETING)).toEqual({ geste: null, attente: "En attente — chez la Direction des opérations." });
    expect(prochainPas(p, DEMANDEUR).geste).toBeNull();
    // `canAllocate` seul ne suffit plus : sans droit sur le temps, rien n'est proposé.
    expect(prochainPas(p, regard({ canAllocate: true })).geste).toBeNull();
    expect(prochainPas(p, regard({ ...OPERATIONS, fige: true })).geste).toBeNull();
  });

  it("DEUX TEMPS : validé par les opérations, la Direction Marketing tranche montant ET budget", () => {
    const p = poste({ status: "PENDING", amountEstimated: 120_000, opsDecidedAt: "2026-10-01" });
    expect(prochainPas(p, MARKETING).geste).toEqual({ cle: "DECIDER", libelle: "Valider et choisir le budget" });
    expect(prochainPas(p, OPERATIONS).attente).toBe("En attente — chez la Direction Marketing (montant et budget).");
    // Demande de la Direction Marketing : c'est la Direction des opérations qui tient le second temps.
    const parOps = regard({ secondTempsParOperations: true, validation: { operations: true, marketing: true } });
    expect(prochainPas(p, parOps).geste?.cle).toBe("DECIDER");
    expect(prochainPas(p, regard({ secondTempsParOperations: true })).attente).toMatch(/chez la Direction des opérations \(montant et budget\)/);
    expect(prochainPas(p, regard({ ...MARKETING, fige: true })).geste).toBeNull();
  });

  it("accordé d'AVANT la règle : montant, puis budget, puis bon de commande — dans cet ordre", () => {
    const sansMontant = poste({ status: "APPROVED", amountEstimated: 120_000 });
    expect(prochainPas(sansMontant, MARKETING).geste?.cle).toBe("MONTANT");
    const sansBudget = poste({ status: "APPROVED", amountGranted: 120_000 });
    expect(prochainPas(sansBudget, MARKETING).geste?.cle).toBe("BUDGET");
    expect(prochainPas(sansBudget, DEMANDEUR).attente).toMatch(/budget/);
    expect(prochainPas(pret(), DEMANDEUR).geste?.cle).toBe("DEMANDER_BC");
    expect(prochainPas(pret(), regard()).attente).toMatch(/demandeur/);
  });

  it("la demande du BC est un geste d'EXÉCUTION : elle reste offerte sur une demande clôturée (§118.151)", () => {
    expect(prochainPas(pret(), regard({ canEdit: true, fige: true })).geste?.cle).toBe("DEMANDER_BC");
  });

  it("un BC refusé par le centre se redemande — le libellé le dit", () => {
    expect(prochainPas(pret({ orderStage: "REFUSED" }), DEMANDEUR).geste?.libelle).toBe("Redemander l'émission du BC");
  });

  it("le BC : centre (au-dessus du seuil), assistante, vérification par le demandeur, signature des Finances", () => {
    const auCentre = pret({ orderStage: "REQUESTED", demandeBC: "CHEZ_ASSISTANTE" });
    expect(prochainPas(auCentre, regard({ canViserBC: true })).geste?.cle).toBe("VISER_BC");
    expect(prochainPas(auCentre, DEMANDEUR).attente).toMatch(/centre Ad & Pro/);
    const chezElle = pret({ orderStage: "DIRECTION_OK", demandeBC: "CHEZ_ASSISTANTE" });
    expect(prochainPas(chezElle, DEMANDEUR).attente).toMatch(/chez l'assistante de direction/);
    const depose = { ...chezElle, demandeBC: "DEPOSE" as const };
    expect(prochainPas(depose, regard({ canEdit: true, verifieLeBC: true })).geste?.cle).toBe("VERIFIER_BC");
    // Le demandeur d'un autre — pas celui qui a demandé le BC — ne vérifie pas.
    expect(prochainPas(depose, DEMANDEUR).geste).toBeNull();
    const aSigner = pret({ orderStage: "DIRECTION_OK", bc: "A_SIGNER" });
    expect(prochainPas(aSigner, DEMANDEUR)).toEqual({ geste: null, attente: "En attente de signature — chez les Finances." });
    // Signé : le demandeur dépose la facture. C'est le SEUL chemin qui ouvre le paiement d'un poste à BC.
    const signe = pret({ orderStage: "DIRECTION_OK", bc: "SIGNE" });
    expect(prochainPas(signe, DEMANDEUR).geste?.cle).toBe("DEMANDER_PAIEMENT");
    expect(prochainPas(signe, regard()).attente).toMatch(/facture/);
  });

  /**
   * DÉFAUT NOMMÉ (§118.204, rapporté et NON corrigé ici — `prochainPas`) : un poste d'AVANT la règle, visé
   * (`DIRECTION_OK`) sans demande de pièce ouverte, attend « l'assistante » pour toujours. L'action accepte
   * de lui envoyer la demande (`requestAdProItemOrder`, branche « demande d'avant la règle » —
   * `postes-chaine-flow.test.ts` le joue), mais la carte ne propose pas ce geste : un geste accepté que
   * l'écran n'offre jamais (§118.83, à l'envers). Réparé : la carte le propose.
   */
  it("un BC visé d'avant la règle, sans demande à l'assistante : la carte propose de la lui envoyer", () => {
    const avant = pret({ orderStage: "DIRECTION_OK", demandeBC: "AUCUNE" });
    expect(prochainPas(avant, DEMANDEUR).geste?.cle).toBe("DEMANDER_BC");
  });

  /**
   * SPONSORING DIRECT : LA PIÈCE EXIGÉE EST LA PROFORMA / LETTRE (Direction, 05/10). La frise nomme ce qui
   * est exigé et le dit FAIT dès que la pièce est là ; le geste le dit aussi ; la facture n'est nulle part
   * obligatoire — et le sponsoring INDIRECT garde son « Facture » : sans ce témoin, un libellé qui dirait
   * « Pro forma » partout passerait.
   */
  it("un sponsoring DIRECT nomme la proforma / lettre — la facture n'y est plus exigée ; l'INDIRECT garde la facture", () => {
    const p = pret({ kind: "ASSOCIATION_SUPPORT", amountGranted: 300_000 });
    expect(etapesDuPoste(p).find((e) => e.cle === "FACTURE")?.libelle).toBe("Pro forma / lettre");
    expect(prochainPas(p, DEMANDEUR).geste?.libelle).toMatch(/proforma \/ lettre de demande/);
    expect(prochainPas(p, DEMANDEUR).geste?.libelle).not.toMatch(/facture/i);
    expect(prochainPas(p, regard({ canAllocate: true })).attente).toMatch(/proforma ou la lettre de demande/);
    // La pièce posée (un devis non annulé au poste) : l'étape est FAITE sans qu'aucune facture existe.
    expect(etapesDuPoste({ ...p, devis: 1, factures: 0 }).find((e) => e.cle === "FACTURE")?.etat).toBe("FAIT");
    expect(etapesDuPoste({ ...p, devis: 0, factures: 0 }).find((e) => e.cle === "FACTURE")?.etat).not.toBe("FAIT");
    // Le TÉMOIN : un sponsoring indirect (poste d'un autre genre) garde le mot « Facture ».
    const autre = pret({ kind: "OTHER", orderStage: "DIRECTION_OK", bc: "SIGNE" });
    expect(etapesDuPoste(autre).find((e) => e.cle === "FACTURE")?.libelle).toBe("Facture");
    expect(prochainPas(autre, DEMANDEUR).geste?.libelle).toMatch(/Déposer la facture/);
  });

  it("CLIQUET — la carte d'un poste direct demande la proforma / lettre (fichier exigé), et la facture n'y est qu'un second champ facultatif", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/components/ad-pro/items-panel.tsx", "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(src, "le libellé vient de la source unique").toMatch(/libelleFichier=\{direct \? LIBELLE_JUSTIFICATIF_DIRECT : undefined\}/);
    expect(src, "le fichier de la proforma est exigé sauf s'il est déjà sur le poste").toMatch(/fichierObligatoire=\{!\(direct && /);
    expect(src, "la facture est un champ facultatif propre au sponsoring direct").toMatch(/factureFacultative=\{direct\}/);
    expect(src, "un second champ fichier porte la facture facultative").toContain('name="facture"');
    expect(src, "le texte de la carte dit que la facture est facultative").toMatch(/la facture est facultative/);
    expect(src, "et que le sponsoring indirect la garde obligatoire").toMatch(/La facture est obligatoire\./);
  });

  it("`facturePourPayer` : exigée partout SAUF pour un versement direct à l'association", () => {
    expect(facturePourPayer("ASSOCIATION_SUPPORT")).toBe(false);
    for (const k of ["OTHER", "TRAVEL", "CATERING", "PRINTING"] as const) expect(facturePourPayer(k), k).toBe(true);
    expect(LIBELLE_JUSTIFICATIF_DIRECT).toBe("Proforma / lettre de demande de sponsoring");
  });

  it("DES LIGNES DE DEVIS VALIDÉES : le geste est « Générer le BC » (« les BC (N) » pour plusieurs devis), jamais « demander » — et il cède à une demande déjà chez l'assistante (§118.206)", () => {
    const avec = (n: number, extra = {}) => faitsDuPoste({
      kind: "PRINTING", status: "APPROVED", amountEstimated: 10, amountGranted: 9, budgetCategoryId: "b", orderStage: "NONE",
      expenseOrderId: null, expenseOrder: null, lignesStock: [], orderSansCentre: false, opsDecidedAt: "2026-10-01", demandeBC: null,
      devisLignes: Array.from({ length: n }, () => ({ etat: "A_GENERER" })), ...extra,
    });
    expect(prochainPas(avec(1), DEMANDEUR).geste).toEqual({ cle: "GENERER_BC", libelle: "Générer le BC" });
    expect(prochainPas(avec(3), DEMANDEUR).geste).toEqual({ cle: "GENERER_BC", libelle: "Générer les BC (3)" });
    // Aucun devis à générer (aucune ligne validée, ou tous à jour) : le geste d'avant, demander le BC.
    expect(prochainPas(avec(0), DEMANDEUR).geste?.cle).toBe("DEMANDER_BC");
    expect(prochainPas(avec(0, { devisLignes: [{ etat: "A_JOUR" }, { etat: "AUCUNE_LIGNE" }] }), DEMANDEUR).geste?.cle).toBe("DEMANDER_BC");
    // Seul le demandeur génère (la même porte que « demander le BC »).
    expect(prochainPas(avec(2), regard({ canEdit: false })).geste?.cle).not.toBe("GENERER_BC");
    // Une demande déjà chez l'assistante : on n'offre pas un second chemin pour le même BC.
    // (une demande ouverte a toujours pris la marche : le poste est « demandé », jamais « à demander »).
    expect(prochainPas(avec(2, { orderStage: "REQUESTED", demandeBC: { etat: "CHEZ_ASSISTANTE" as const } }), DEMANDEUR).geste?.cle).not.toBe("GENERER_BC");
    expect(prochainPas(avec(2, { orderStage: "DIRECTION_OK", demandeBC: { etat: "DEPOSE" as const } }), DEMANDEUR).geste?.cle).not.toBe("GENERER_BC");
    // Un poste dont la marche est prise par une génération (« demandé », sans demande chez l'assistante) : la suite se génère encore.
    expect(prochainPas(avec(1, { orderStage: "DIRECTION_OK" }), DEMANDEUR).geste?.cle).toBe("GENERER_BC");
  });

  it("un sponsoring DIRECT se paie sur facture, sans BC — et jamais avant que l'opération soit accordée", () => {
    const p = pret({ kind: "ASSOCIATION_SUPPORT", amountGranted: 300_000 });
    expect(etapesDuPoste(p).map((e) => e.cle)).toEqual(["CHIFFRE", "OPERATIONS", "MARKETING", "FACTURE", "PAIEMENT"]);
    expect(prochainPas(p, DEMANDEUR).geste?.cle).toBe("DEMANDER_PAIEMENT");
    expect(prochainPas(p, regard({ canEdit: true, operationDecidee: false })).geste).toBeNull();
    // Jamais « demander un BC » sur un versement direct.
    expect(prochainPas(p, DEMANDEUR).geste?.cle).not.toBe("DEMANDER_BC");
    expect(prochainPas(poste({ kind: "ASSOCIATION_SUPPORT" }), DEMANDEUR).geste?.cle).toBe("CHIFFRER");
  });

  it("le paiement demandé : le poste attend le centre de paiement, puis il est arrivé au bout", () => {
    const emis = pret({ orderStage: "ISSUED", expenseOrderId: "o", expenseOrderStatus: "PENDING", bc: "SIGNE", factures: 1 });
    expect(prochainPas(emis, MARKETING)).toEqual({ geste: null, attente: "Paiement en cours — chez le centre de paiement." });
    expect(prochainPas({ ...emis, expenseOrderStatus: "PAID" }, MARKETING)).toEqual({ geste: null, attente: null });
    expect(etapesDuPoste({ ...emis, expenseOrderStatus: "PAID" }).every((e) => e.etat === "FAIT")).toBe(true);
    // Sans facture, l'étape « Facture » n'est pas faite : on ne dit pas « fait » ce qui n'a pas eu lieu.
    expect(etapesDuPoste({ ...emis, factures: 0 }).find((e) => e.cle === "FACTURE")?.etat).not.toBe("FAIT");
  });

  it("la frise dit un refus là où il a eu lieu — au premier ou au second temps", () => {
    expect(etapesDuPoste(poste({ status: "REJECTED", amountEstimated: 5 })).find((e) => e.cle === "OPERATIONS")?.etat).toBe("REFUSE");
    const refuseMkt = etapesDuPoste(poste({ status: "REJECTED", amountEstimated: 5, opsDecidedAt: "2026-10-01" }));
    expect(refuseMkt.find((e) => e.cle === "OPERATIONS")?.etat).toBe("FAIT");
    expect(refuseMkt.find((e) => e.cle === "MARKETING")?.etat).toBe("REFUSE");
    expect(etapesDuPoste(pret({ orderStage: "REFUSED" })).find((e) => e.cle === "BC")?.etat).toBe("REFUSE");
  });
});

describe("la traduction des faits d'un poste — une seule, lue par l'écran et par le banc (§118.175)", () => {
  it("garde ce qui DÉCIDE de l'étape : le BC sous le seuil, l'ordre, les articles, le premier temps, la demande de BC, les pièces", () => {
    // Ce qui le ferait tomber : perdre `orderSansCentre` (l'écran dirait « validé » d'un BC qu'aucun
    // centre n'a vu, §118.149), le statut de l'ordre, `opsDecidedAt` (la Direction Marketing verrait
    // DECIDER avant les opérations), l'état de la demande de BC ou l'étape du BC au registre.
    const brut = {
      kind: "STAND" as const, status: "APPROVED" as const, amountEstimated: 10, amountGranted: 9, budgetCategoryId: "b",
      orderStage: "DIRECTION_OK" as const, expenseOrderId: "e", expenseOrder: { status: "PAID" }, lignesStock: [{}, {}], orderSansCentre: true,
      opsDecidedAt: "2026-10-01", demandeBC: { etat: "DEPOSE" as const }, pieces: { bc: { etape: "SIGNE" as const }, factures: [{}] },
    };
    const f = faitsDuPoste(brut);
    expect(f).toEqual({
      kind: "STAND", status: "APPROVED", amountEstimated: 10, amountGranted: 9, budgetCategoryId: "b",
      orderStage: "DIRECTION_OK", expenseOrderId: "e", expenseOrderStatus: "PAID", expenseOrderCentral: null, lignesStock: 2, orderSansCentre: true,
      opsDecidedAt: "2026-10-01", demandeBC: "DEPOSE", bc: "SIGNE", factures: 1, devis: 0, devisAGenerer: 0,
    });
    // La décision du centre de paiement voyage aussi (audit Ad & Pro, 14/10) : un ordre refusé n'est pas « en cours ».
    expect(faitsDuPoste({ ...brut, expenseOrder: { status: "PENDING", centralStatus: "REFUSED" } }).expenseOrderCentral).toBe("REFUSED");
    const vide = faitsDuPoste({ ...brut, expenseOrder: null, lignesStock: [], demandeBC: null, pieces: undefined, opsDecidedAt: null });
    expect(vide).toMatchObject({ expenseOrderStatus: null, demandeBC: "AUCUNE", bc: null, factures: 0, opsDecidedAt: null });
    // Un BC au registre dont l'étape ne se lit pas (hors circuit) reste un BC : « pas de BC » serait faux.
    expect(faitsDuPoste({ ...brut, pieces: { bc: { etape: null }, factures: [] } }).bc).toBe("HORS_CIRCUIT");
    // La proforma / lettre d'un sponsoring direct est un DEVIS du poste : seuls les devis NON annulés comptent.
    expect(faitsDuPoste({ ...brut, pieces: { bc: null, factures: [], devis: [{ annulee: false }, { annulee: true }, {}] } }).devis).toBe(2);
    // LES FICHES PAR PERSONNE (Direction, 06/10) : comptées quand le chargeur les rend, jamais devinées sinon.
    expect(faitsDuPoste(brut).fichesPersonnes).toBeUndefined();
    expect(faitsDuPoste({ ...brut, voyageurs: [{}, {}], hebergements: [] }).fichesPersonnes).toBe(2);
    expect(faitsDuPoste({ ...brut, voyageurs: [], hebergements: [{}], priseEnChargeIndirecte: true })).toMatchObject({ fichesPersonnes: 1, priseEnChargeIndirecte: true });
  });
});

describe("une fiche par personne avant de soumettre (Direction, 06/10)", () => {
  const chiffre = { amountEstimated: 50_000 };
  it("billetterie sans voyageur, hôtellerie sans fiche : « Soumettre » n'est pas offert — l'attente dit quoi faire", () => {
    const billet = prochainPas(poste({ kind: "TICKETING", ...chiffre, fichesPersonnes: 0 }), DEMANDEUR);
    expect(billet.geste).toBeNull();
    expect(billet.attente).toMatch(/au moins un voyageur/);
    const hotel = prochainPas(poste({ kind: "ACCOMMODATION", ...chiffre, fichesPersonnes: 0 }), DEMANDEUR);
    expect(hotel.geste).toBeNull();
    expect(hotel.attente).toMatch(/au moins une fiche hôtellerie/);
  });
  it("une fiche suffit ; en sponsoring indirect, aucune n'est exigée", () => {
    expect(prochainPas(poste({ kind: "TICKETING", ...chiffre, fichesPersonnes: 1 }), DEMANDEUR).geste?.cle).toBe("SOUMETTRE");
    expect(prochainPas(poste({ kind: "ACCOMMODATION", ...chiffre, fichesPersonnes: 0, priseEnChargeIndirecte: true }), DEMANDEUR).geste?.cle).toBe("SOUMETTRE");
    // Témoin : une autre nature sans fiche se soumet.
    expect(prochainPas(poste({ kind: "STAND", ...chiffre, fichesPersonnes: 0 }), DEMANDEUR).geste?.cle).toBe("SOUMETTRE");
  });
  it("le chiffre d'abord : un poste non chiffré propose de le chiffrer", () => {
    expect(prochainPas(poste({ kind: "ACCOMMODATION", fichesPersonnes: 0 }), DEMANDEUR).geste?.cle).toBe("CHIFFRER");
  });
});
