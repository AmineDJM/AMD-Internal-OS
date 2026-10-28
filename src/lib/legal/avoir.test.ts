import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { entierementCreditee, netDeLaFacture, refusPlafondAvoir, resteACrediter } from "@/lib/lecteurs/avoir";
import { invoiceTally } from "@/lib/legal/invoices";
import { initialLegalListState, visibleLegalRows, type LegalListRow } from "@/lib/legal/list-view";
import { canSendToSettlement, REFUS_FACTURE_EMISE_AU_REGLEMENT } from "@/modules/finances/partage";
import {
  AVAL_QUI_FIGE, pieceDefinitive, pieceEmise, refusChampsDuFichier, remedePieceEmise,
} from "@/lib/legal/piece-emise";
import {
  estPieceFiscale, LIBELLE_TYPE, NATURE_LEGALE, PREFIXE_DEFAUT, TYPES_DOCUMENT, verifierSpecCommerciale,
  type SpecDocumentCommercial,
} from "@/lib/artifact/factory/commercial";
import { natureLegale } from "@/lib/labels";

/**
 * ═════════════════════════════════════════════════════════════════
 * L'AVOIR — les règles PURES (§118.195 — audit 360°, R15).
 *
 * Le banc de flux (`actions/avoir-flow.test.ts`) prouve l'émission par les vraies actions ; celui-ci tient les
 * trois lectures que la fabrique, la fiche et le règlement partagent : ce qui reste à créditer, le net de la
 * facture, et le refus d'un avoir qui dépasserait — au CENTIME, parce qu'une somme de flottants dérive.
 * ═════════════════════════════════════════════════════════════════
 */

describe("ce qui reste à créditer, et le net de la facture — au centime", () => {
  it("retire les avoirs actifs du TTC, sans dérive flottante", () => {
    // 0,1 + 0,2 vaut 0,30000000000000004 en flottant : compté en centimes, le net tombe juste.
    expect(netDeLaFacture(100.3, [0.1, 0.2])).toBe(100);
    expect(netDeLaFacture(51_170, [11_900, 5_950])).toBe(33_320);
    expect(netDeLaFacture(45_220, [])).toBe(45_220);
  });

  it("n'est jamais négatif — des avoirs plus lourds que la facture ne font pas devoir de l'argent à la facture", () => {
    expect(netDeLaFacture(100, [60, 60])).toBe(0);
  });

  it("le reste à créditer EST le net : une seule lecture, lue des deux côtés", () => {
    // Deux fonctions qui s'accordent aujourd'hui divergeraient au premier ajustement (§118.140) : c'est la même.
    expect(resteACrediter).toBe(netDeLaFacture);
  });
});

describe("le refus d'un avoir qui dépasse — les deux nombres dans la phrase", () => {
  it("laisse passer un avoir EXACTEMENT égal à ce qui reste, même écrit en flottants", () => {
    expect(refusPlafondAvoir("FA-2026-0001", 3_570, 3_570)).toBeNull();
    expect(refusPlafondAvoir("FA-2026-0001", 0.1 + 0.2, 0.3)).toBeNull();
  });

  it("refuse un centime de trop, en disant le montant de l'avoir ET ce qui reste", () => {
    // Les milliers se séparent par l'espace fine de `toLocaleString` (U+202F) : on compare des espaces, pas l'octet.
    const refus = (refusPlafondAvoir("FA-2026-0001", 3_570.01, 3_570) ?? "").replace(/\s/gu, " ");
    expect(refus).toContain("FA-2026-0001");
    expect(refus).toContain("3 570,01 DZD");
    expect(refus).toContain("3 570,00 DZD");
    expect(refus).toContain("avoirs déjà émis compris");
  });

  it("une facture entièrement créditée le dit — « il reste 0 » ne ferait chercher personne", () => {
    expect(refusPlafondAvoir("FA-2026-0001", 1, 0)).toBe("La facture FA-2026-0001 est déjà entièrement créditée par ses avoirs : il n'y reste rien à créditer.");
  });
});

describe("une pièce émise de type AVOIR — lue, nommée, et jamais révisée", () => {
  it("se lit comme une pièce émise, et elle est DÉFINITIVE comme la facture", () => {
    expect(pieceEmise({ fabrique: { type: "AVOIR", numero: "AV-2026-0001", version: 1 } })).toEqual({ type: "AVOIR", numero: "AV-2026-0001", version: 1 });
    expect(pieceDefinitive("AVOIR")).toBe(true);
    expect(pieceDefinitive("FACTURE")).toBe(true);
    expect(pieceDefinitive("DEVIS")).toBe(false);
    expect(pieceDefinitive("BON_DE_COMMANDE")).toBe(false);
  });

  it("le remède d'une facture émise est l'AVOIR, celui d'un avoir est de l'annuler puis d'en émettre un autre", () => {
    expect(remedePieceEmise({ type: "FACTURE", numero: "FA-1", version: 1 })).toContain("« Émettre un avoir », sur sa fiche");
    expect(remedePieceEmise({ type: "AVOIR", numero: "AV-1", version: 1 })).toContain("annulez-le (motif à l'appui)");
    expect(remedePieceEmise({ type: "DEVIS", numero: "DEV-1", version: 1 })).toContain("« Réviser la pièce »");
  });

  it("le refus du formulaire générique s'accorde à l'avoir", () => {
    const refus = refusChampsDuFichier({ type: "AVOIR", numero: "AV-2026-0001", version: 1 }, ["amount"]);
    expect(refus.startsWith("Cet avoir a été émis par la plateforme (AV-2026-0001)")).toBe(true);
  });

  it("rien en aval ne fige une facture ni un avoir — ils ne se révisent pas du tout", () => {
    expect(AVAL_QUI_FIGE.FACTURE).toEqual([]);
    expect(AVAL_QUI_FIGE.AVOIR).toEqual([]);
  });
});

const emetteur = { nom: "Adventum Pharma", formeJuridique: "SARL", adresse: "12 rue des Frères Bouadou, Alger", rc: "16/00-1234567B21", nif: "001916012345678", ai: "16012345678", nis: "001916012345690" };
const avoir = (extra: Partial<SpecDocumentCommercial> = {}): SpecDocumentCommercial => ({
  type: "AVOIR", numero: "AV-2026-0001", date: "2026-10-03", emetteur,
  tiers: { nom: "Pharmacie Centrale d'Alger", adresse: "Alger", nif: "000016098765432" },
  lignes: [{ designation: "Amoxicilline 1 g — boîte de 12 (retour)", quantite: 20, prixUnitaire: 250 }],
  referenceAmont: "FA-2026-0007", referenceAmontDate: "2026-09-20",
  objet: "Retour de 20 boîtes endommagées à la livraison.",
  ...extra,
});

describe("la pièce AVOIR dans la fabrique — une pièce fiscale qui dit ce qu'elle corrige", () => {
  it("est déclarée partout : type, libellé, préfixe, nature du registre, pièce fiscale", () => {
    expect(TYPES_DOCUMENT).toContain("AVOIR");
    expect(LIBELLE_TYPE.AVOIR).toBe("Avoir");
    expect(PREFIXE_DEFAUT.AVOIR).toBe("AV");
    expect(NATURE_LEGALE.AVOIR).toBe("CREDIT_NOTE");
    expect(estPieceFiscale("AVOIR")).toBe(true);
    expect(estPieceFiscale("FACTURE")).toBe(true);
    expect(estPieceFiscale("BON_DE_COMMANDE")).toBe(false);
    expect(natureLegale("CREDIT_NOTE")).toBe("Avoir");
  });

  it("un avoir complet passe — sans réclamer de mode de paiement, qu'il n'a pas", () => {
    const v = verifierSpecCommerciale(avoir());
    expect(v.bloquants).toEqual([]);
    expect(v.avertissements.join(" ")).not.toContain("mode de paiement");
  });

  it("refuse un avoir sans facture d'origine, et un avoir sans motif — c'est ce qu'il imprime", () => {
    expect(verifierSpecCommerciale(avoir({ referenceAmont: "  " })).bloquants).toContain("Avoir sans facture d'origine : il doit porter le numéro de la facture qu'il corrige.");
    expect(verifierSpecCommerciale(avoir({ objet: null })).bloquants).toContain("Avoir sans motif : dites pourquoi la facture est créditée — c'est ce que l'avoir imprime.");
  });

  it("exige les mentions légales de l'émetteur comme une facture — un avoir est une pièce fiscale", () => {
    const v = verifierSpecCommerciale(avoir({ emetteur: { ...emetteur, nif: null } }));
    expect(v.bloquants.some((b) => b.startsWith("Identité de l'émetteur incomplète"))).toBe(true);
  });

  it("l'avertissement du client sans NIF ni RC s'accorde à l'avoir", () => {
    const v = verifierSpecCommerciale(avoir({ tiers: { nom: "Client sans identifiant" } }));
    expect(v.avertissements).toContain("Le client n'a ni NIF ni RC sur l'avoir : une pièce fiscale entre professionnels les porte.");
  });
});

// ─────────────────── Qui lisait l'ancienne forme ? — le montant DÛ d'une facture est son NET (§118.61) ───────────────────

const ligneListe = (extra: Partial<LegalListRow>): LegalListRow => ({
  id: "x", reference: null, title: "Facture", kind: "INVOICE", counterparty: null, startDate: null, endDate: null,
  status: "ACTIVE", expiry: "NONE", daysLeft: null, amount: null, driveNodeId: null, driveName: null,
  renewedFromTitle: null, restricted: false, paidDate: null, expenseOrderId: null, ...extra,
});

describe("les lecteurs de ce qu'une facture doit encore — le NET, partout où on le compte", () => {
  it("une facture entièrement créditée n'est plus à régler — et un montant inconnu n'est jamais « crédité »", () => {
    expect(entierementCreditee(10_000, 10_000)).toBe(true);
    expect(entierementCreditee(10_000, 9_999.99)).toBe(false);
    expect(entierementCreditee(null, 0)).toBe(false);
    expect(entierementCreditee(0, 0)).toBe(false);
  });

  it("le compte « à régler » et son total lisent le net : 45 220 crédités de 5 950 laissent 39 270", () => {
    const t = invoiceTally([
      { kind: "INVOICE", amount: 45_220, endDate: null, paidDate: null, expenseOrderId: null, status: "ACTIVE", avoirs: 5_950 },
      // Entièrement créditée : rien à régler — elle sort du compte, comme du filtre de la liste.
      { kind: "INVOICE", amount: 10_000, endDate: "2026-01-01T00:00:00.000Z", paidDate: null, expenseOrderId: null, status: "ACTIVE", avoirs: 10_000 },
      // Montant inconnu, aucun avoir : elle reste à régler, comme avant la règle.
      { kind: "INVOICE", amount: null, endDate: null, paidDate: null, expenseOrderId: null, status: "ACTIVE" },
    ], new Date("2026-10-03T00:00:00Z"));
    expect(t).toEqual({ count: 3, unpaid: 2, unpaidTotal: 39_270, overdue: 0 });
  });

  it("le filtre « à régler » de la liste écarte la facture entièrement créditée — comme le compte d'en-tête", () => {
    const etat = { ...initialLegalListState("tous", false), unpaidOnly: true };
    const lignes = [
      ligneListe({ id: "partielle", amount: 45_220, avoirs: 5_950 }),
      ligneListe({ id: "creditee", amount: 10_000, avoirs: 10_000 }),
      ligneListe({ id: "sans-montant" }),
    ];
    expect(visibleLegalRows(lignes, etat).map((r) => r.id)).toEqual(["partielle", "sans-montant"]);
  });

  it("une facture ÉMISE par la société ne part pas au centre de paiement — c'est son client qui la règle", () => {
    const base = { kind: "INVOICE", amount: 45_220, paidDate: null, expenseOrderId: null };
    expect(canSendToSettlement({ ...base, direction: "IN" })).toEqual({ ok: false, error: REFUS_FACTURE_EMISE_AU_REGLEMENT });
    // Le témoin : une facture REÇUE part, comme avant — sans lui, une garde qui refuserait tout passerait pour juste.
    expect(canSendToSettlement({ ...base, direction: "OUT" })).toEqual({ ok: true });
    expect(canSendToSettlement(base)).toEqual({ ok: true });
  });

  it("le règlement et la règle qualité comparent au NET — leur point d'appel, pas seulement la règle (§118.49)", () => {
    const sansCommentaires = (f: string) => readFileSync(join(process.cwd(), f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(sansCommentaires("src/modules/finances/infra/settle-invoice.ts")).toMatch(/const amount = netDeLaFacture\(.*, await montantsDesAvoirsActifs\(doc\.id\)\);/);
    const regle = sansCommentaires("src/lib/quality/rules.ts");
    const bloc = regle.slice(regle.indexOf("async montant_contradictoire"), regle.indexOf("async valeur_aberrante"));
    expect(bloc).toContain("const du = netDeLaFacture(montant, [avoirs]);");
    expect(bloc).toContain("ecartPct(regle, du)");
    expect(bloc).not.toContain("ecartPct(regle, montant)");
  });
});
