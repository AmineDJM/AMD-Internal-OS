import { describe, it, expect } from "vitest";
import {
  parcoursOf, carteAction, libellePastille, nomCourt, chezPieces, joursDepuis, tonDelai, peutRelancerPiece,
  pharmacienPeutValider, type ParcoursInput, type Spectateur,
} from "./parcours";
import { slipsSummary } from "./slips";

const J = (n: number) => new Date(Date.UTC(2026, 9, n, 9));

function base(over: Partial<ParcoursInput> = {}): ParcoursInput {
  const slips = over.slips ?? [];
  return {
    circuit: "EVENT", status: "AWAITING_REVIEW", createdAt: J(1), updatedAt: J(2),
    declare: { validationId: null, validationStatus: null, intent: null, grantedAt: null },
    declareRequestedAt: null, authorityRef: null,
    lot: "A_DEMANDER", slips, summary: slipsSummary(slips.map((s, i) => ({ id: `s${i}`, label: "x", amount: 10, ...s }))),
    skipped: false, bvRequestedAt: null, requests: [],
    pharmacistValidatedAt: null, validatedAt: null, pharmacistName: "Amel Amarni",
    ...over,
  };
}

const accorde = (intent: "DECLARE" | "SKIP") => ({ validationId: "v1", validationStatus: "APPROVED", intent, grantedAt: null });
const piece = (status: string, jour: number, who = "u1", name = "Karim Benali") =>
  ({ status, createdAt: J(jour), fulfilledAt: status === "FULFILLED" ? J(jour + 1) : null, targetUserId: who, targetName: name });

const gestionnaire: Spectateur = { gestionnaire: true, direction: false, finances: false, aDeposer: 0, aRemettre: false };
const lecteur: Spectateur = { gestionnaire: false, direction: false, finances: false, aDeposer: 0, aRemettre: false };

describe("parcoursOf — la frise et la pastille", () => {
  it("circuit ÉVÉNEMENT : six étapes, la décision d'abord", () => {
    const p = parcoursOf(base());
    expect(p.etapes.map((e) => e.cle)).toEqual(["RECU", "DECLARER", "PIECES", "DEPOT", "PHARMACIEN", "DIRECTION"]);
    expect(p.courante).toBe("DECLARER");
    expect(p.etapes[0].etat).toBe("FAIT");
    expect(p.etapes[1].etat).toBe("ICI");
    expect(p.etapes[2].etat).toBe("SANS_OBJET"); // aucune pièce demandée
    expect(libellePastille(p)).toBe("À déclarer ? — chez Amel A.");
    expect(p.groupe).toBe("A_DECLARER");
    expect(p.depuis).toEqual(J(1));
  });

  it("circuit MATÉRIEL : les bons de versement remplacent la décision", () => {
    const p = parcoursOf(base({ circuit: "PROMO" }));
    expect(p.etapes.map((e) => e.cle)).toEqual(["RECU", "PIECES", "BONS", "DEPOT", "PHARMACIEN", "DIRECTION"]);
    expect(p.courante).toBe("BONS");
    expect(p.etapes.find((e) => e.cle === "BONS")?.detail).toBe("à séparer");
  });

  it("décision accordée + pièces attendues : l'étape courante est « Pièces », chez la personne sollicitée, depuis la plus ancienne", () => {
    const p = parcoursOf(base({ declare: accorde("DECLARE"), requests: [piece("PENDING", 3), piece("PENDING", 5), piece("FULFILLED", 2)] }));
    expect(p.courante).toBe("PIECES");
    expect(p.etapes.find((e) => e.cle === "DECLARER")).toMatchObject({ etat: "FAIT", detail: "oui" });
    expect(p.etapes.find((e) => e.cle === "PIECES")).toMatchObject({ etat: "ICI", detail: "1 sur 3" });
    expect(libellePastille(p)).toBe("Pièces attendues — chez Karim B.");
    expect(p.depuis).toEqual(J(3));
    expect(p.groupe).toBe("PIECES");
  });

  it("lecture « sans déclaration » accordée : le dépôt est sans objet, on passe au pharmacien", () => {
    const p = parcoursOf(base({ declare: accorde("SKIP") }));
    expect(p.etapes.find((e) => e.cle === "DEPOT")?.etat).toBe("SANS_OBJET");
    expect(p.courante).toBe("PHARMACIEN");
    expect(p.groupe).toBe("A_VALIDER_PHARMACIEN");
  });

  it("décision en validation : chez le Directeur des Opérations, depuis la demande", () => {
    const p = parcoursOf(base({
      declare: { validationId: "v1", validationStatus: "PENDING", intent: "DECLARE", grantedAt: null },
      declareRequestedAt: J(4),
    }));
    expect(libellePastille(p)).toBe("Décision en validation — chez le Directeur des Opérations");
    expect(p.depuis).toEqual(J(4));
  });

  it("transmis au Directeur des Opérations : à valider chez lui ; ce qui restait en amont est passé", () => {
    const p = parcoursOf(base({
      status: "AWAITING_DIRECTION", declare: accorde("DECLARE"), authorityRef: "MIP-12",
      pharmacistValidatedAt: J(6), requests: [piece("PENDING", 3)],
    }));
    expect(p.courante).toBe("DIRECTION");
    expect(libellePastille(p)).toBe("À valider — chez le Directeur des Opérations");
    expect(p.etapes.find((e) => e.cle === "PIECES")?.etat).toBe("SANS_OBJET");
    expect(p.groupe).toBe("A_VALIDER_DIRECTION");
    expect(p.depuis).toEqual(J(6));
  });

  it("validé : plus d'étape courante, plus de délai", () => {
    const p = parcoursOf(base({ status: "VALIDATED", declare: accorde("SKIP"), validatedAt: J(9) }));
    expect(p.courante).toBeNull();
    expect(p.etapes.every((e) => e.etat === "FAIT" || e.etat === "SANS_OBJET")).toBe(true);
    expect(libellePastille(p)).toBe("Validé");
    expect(p.depuis).toBeNull();
    expect(p.groupe).toBe("VALIDE");
  });

  it("bons au paiement : chez les Finances (groupe des bons) ; un bon à demander les ramène au pharmacien", () => {
    const enPaiement = { requestId: "r1", centralStatus: "AUTHORIZED", orderStatus: "APPROVED", deliveredAt: null, updatedAt: J(7) };
    const p = parcoursOf(base({ circuit: "PROMO", lot: "QUITTANCE_A_DEMANDER", slips: [enPaiement] }));
    expect(libellePastille(p)).toBe("Bon de versement — chez les Finances");
    expect(p.groupe).toBe("BONS_FINANCES");
    expect(p.depuis).toEqual(J(7));
    const q = parcoursOf(base({
      circuit: "PROMO", lot: "QUITTANCE_A_DEMANDER",
      slips: [enPaiement, { requestId: null, centralStatus: null, orderStatus: null, deliveredAt: null }],
    }));
    expect(libellePastille(q)).toBe("Bons de versement — chez Amel A.");
    expect(q.groupe).toBe("A_DECLARER");
  });

  it("toutes les quittances remises : dépôt au ministère, et le pharmacien peut déjà valider", () => {
    const remis = { requestId: "r1", centralStatus: "AUTHORIZED", orderStatus: "PAID", deliveredAt: J(8) };
    const i = base({ circuit: "PROMO", lot: "QUITTANCE_A_DEMANDER", slips: [remis] });
    const p = parcoursOf(i);
    expect(p.etapes.find((e) => e.cle === "BONS")).toMatchObject({ etat: "FAIT", detail: "1 remis" });
    expect(p.courante).toBe("DEPOT");
    expect(pharmacienPeutValider(i)).toBe(true);
  });
});

describe("carteAction — la seule chose à faire, pour celui qui regarde", () => {
  const regles = { pharmacienPeutValider: false, autoritesOuvertes: false };

  it("le pharmacien à l'étape de décision : le bloc de décision, rien d'autre", () => {
    const c = carteAction(parcoursOf(base()), gestionnaire, regles);
    expect(c).toEqual({ principal: ["DECLARER"], aussi: null, attente: null });
  });

  it("pièces attendues : les relances, et le dépôt à portée sans attendre", () => {
    const p = parcoursOf(base({ declare: accorde("DECLARE"), requests: [piece("PENDING", 3)] }));
    const c = carteAction(p, gestionnaire, { pharmacienPeutValider: false, autoritesOuvertes: true });
    expect(c.principal).toEqual(["PIECES_ATTENDUES"]);
    expect(c.aussi).toEqual({ bloc: "DEPOT", libelle: "Continuer sans attendre les pièces" });
  });

  it("la personne sollicitée dépose sa pièce ; les autres lisent « En attente — chez X »", () => {
    const p = parcoursOf(base({ declare: accorde("DECLARE"), requests: [piece("PENDING", 3)] }));
    expect(carteAction(p, { ...lecteur, aDeposer: 1 }, regles).principal).toEqual(["PIECES_A_DEPOSER"]);
    expect(carteAction(p, lecteur, regles)).toEqual({ principal: [], aussi: null, attente: "En attente — chez Karim B." });
  });

  it("chez le Directeur des Opérations : il valide, le pharmacien attend (et peut corriger le dépôt)", () => {
    const p = parcoursOf(base({ status: "AWAITING_DIRECTION", declare: accorde("DECLARE"), authorityRef: "MIP-1", pharmacistValidatedAt: J(5) }));
    expect(carteAction(p, { ...gestionnaire, direction: true }, regles).principal).toEqual(["VALIDER_DIRECTION"]);
    const pharma = carteAction(p, gestionnaire, { pharmacienPeutValider: true, autoritesOuvertes: true });
    expect(pharma.principal).toEqual([]);
    expect(pharma.attente).toBe("En attente — chez le Directeur des Opérations");
    expect(pharma.aussi?.bloc).toBe("DEPOT");
  });

  it("matériel, dépôt en cours : la validation reste à portée (le circuit matériel n'exige pas de référence)", () => {
    const p = parcoursOf(base({ circuit: "PROMO", skipped: true }));
    expect(p.courante).toBe("DEPOT");
    const c = carteAction(p, gestionnaire, { pharmacienPeutValider: true, autoritesOuvertes: true });
    expect(c.principal).toEqual(["DEPOT"]);
    expect(c.aussi?.bloc).toBe("VALIDER_PHARMACIEN");
  });

  it("les Finances : la remise d'une quittance réglée", () => {
    const p = parcoursOf(base({ circuit: "PROMO", lot: "QUITTANCE_A_DEMANDER", slips: [{ requestId: "r", centralStatus: "AUTHORIZED", orderStatus: "PAID", deliveredAt: null }] }));
    expect(carteAction(p, { ...lecteur, finances: true, aRemettre: true }, regles).principal).toEqual(["REMETTRE_QUITTANCE"]);
  });

  it("validé : rien à faire, pas d'attente", () => {
    const p = parcoursOf(base({ status: "VALIDATED", declare: accorde("SKIP") }));
    expect(carteAction(p, gestionnaire, regles)).toEqual({ principal: [], aussi: null, attente: null });
  });
});

describe("petits outils", () => {
  it("nomCourt, chezPieces", () => {
    expect(nomCourt("Amel Amarni")).toBe("Amel A.");
    expect(nomCourt("Amel")).toBe("Amel");
    expect(nomCourt("  ")).toBeNull();
    expect(chezPieces([piece("PENDING", 1, "a", "Ali B"), piece("PENDING", 1, "b", "Sara C")])).toBe("2 personnes");
    expect(chezPieces([piece("FULFILLED", 1)])).toBeNull();
  });

  it("joursDepuis et tonDelai : orange au-delà de 7 j, rouge au-delà de 14 j", () => {
    expect(joursDepuis(J(1), J(10))).toBe(9);
    expect(joursDepuis(null)).toBeNull();
    expect(tonDelai(7)).toBe("normal");
    expect(tonDelai(8)).toBe("attention");
    expect(tonDelai(15)).toBe("retard");
  });
});

describe("peutRelancerPiece — la règle des quatre heures", () => {
  const r = { status: "PENDING", createdAt: new Date("2026-10-07T08:00:00Z"), targetUserId: "cible", requestedById: "pharma" };
  const h = (iso: string) => new Date(iso).getTime();

  it("trop tôt après la demande, possible quatre heures plus tard", () => {
    expect(peutRelancerPiece(r, { userId: "pharma", gestionnaire: true, derniereRelance: null, now: h("2026-10-07T10:00:00Z") }).ok).toBe(false);
    expect(peutRelancerPiece(r, { userId: "pharma", gestionnaire: true, derniereRelance: null, now: h("2026-10-07T12:00:00Z") }).ok).toBe(true);
  });

  it("le délai court aussi depuis la dernière relance", () => {
    const v = peutRelancerPiece(r, { userId: "pharma", gestionnaire: true, derniereRelance: new Date("2026-10-07T13:00:00Z"), now: h("2026-10-07T15:00:00Z") });
    expect(v).toEqual({ ok: false, raison: "Trop tôt : vous pourrez relancer dans 2 h." });
  });

  it("ni la personne sollicitée, ni un tiers ; l'auteur de la demande, oui", () => {
    const now = h("2026-10-08T08:00:00Z");
    expect(peutRelancerPiece(r, { userId: "cible", gestionnaire: true, derniereRelance: null, now }).ok).toBe(false);
    expect(peutRelancerPiece(r, { userId: "tiers", gestionnaire: false, derniereRelance: null, now }).ok).toBe(false);
    expect(peutRelancerPiece(r, { userId: "pharma", gestionnaire: false, derniereRelance: null, now }).ok).toBe(true);
    expect(peutRelancerPiece({ ...r, status: "FULFILLED" }, { userId: "pharma", gestionnaire: true, derniereRelance: null, now }).ok).toBe(false);
  });
});
