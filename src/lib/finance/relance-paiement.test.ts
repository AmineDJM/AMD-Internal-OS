import { describe, expect, it } from "vitest";
import { etatDuPaiement, refusDeRelance, messageDeRelance, commentaireDeRelance, relancable } from "@/lib/finance/relance-paiement";
import { canNudge } from "@/lib/finance/dossier-auto";
import { phraseDeBlocage, phraseDoublonPossible } from "@/lib/factures/blocage-vue";
import { signerJetonRelance, verifierJetonRelance, DUREE_JETON_MS } from "@/lib/factures/jeton-relance";

describe("La relance unifiée d'un paiement (Direction, 14/10/2026)", () => {
  it("l'état se lit sur l'ORDRE d'abord : centre, Finances, demandeur, payé, clos", () => {
    expect(etatDuPaiement({ ordre: { status: "PENDING", centralStatus: "AWAITING" } })).toBe("CENTRE");
    expect(etatDuPaiement({ ordre: { status: "PENDING", centralStatus: "APPROVED" } })).toBe("FINANCES");
    expect(etatDuPaiement({ ordre: { status: "PENDING", centralStatus: "INFO_REQUESTED" } })).toBe("DEMANDEUR");
    expect(etatDuPaiement({ ordre: { status: "PAID", centralStatus: "APPROVED" } })).toBe("PAYE");
    expect(etatDuPaiement({ ordre: { status: "PENDING", centralStatus: "REFUSED" } })).toBe("CLOS");
    expect(etatDuPaiement({ ordre: { status: "CANCELLED", centralStatus: "AWAITING" } })).toBe("CLOS");
    // Sans ordre (demandes anciennes) : la demande.
    expect(etatDuPaiement({ demande: { status: "UNDER_REVIEW" } })).toBe("FINANCES");
    expect(etatDuPaiement({ demande: { status: "DRAFT" } })).toBe("HORS_PAIEMENT");
    expect(etatDuPaiement({})).toBe("HORS_PAIEMENT");
  });

  it("rien à relancer quand rien n'attend ; le demandeur ne se relance pas lui-même ; une relance par heure", () => {
    expect(refusDeRelance({ etat: "PAYE", parLeDemandeur: true })).toMatch(/déjà réglé/);
    expect(refusDeRelance({ etat: "CLOS", parLeDemandeur: true })).toMatch(/annulé ou refusé/);
    expect(refusDeRelance({ etat: "HORS_PAIEMENT", parLeDemandeur: true })).toMatch(/Aucun paiement/);
    expect(refusDeRelance({ etat: "DEMANDEUR", parLeDemandeur: true })).toMatch(/c'est à vous d'agir/);
    expect(refusDeRelance({ etat: "DEMANDEUR", parLeDemandeur: false })).toBeNull();
    const now = new Date("2026-10-14T10:00:00Z");
    expect(refusDeRelance({ etat: "CENTRE", parLeDemandeur: true, derniereRelance: new Date("2026-10-14T09:30:00Z"), now })).toMatch(/30 min/);
    expect(refusDeRelance({ etat: "FINANCES", parLeDemandeur: true, derniereRelance: new Date("2026-10-14T08:30:00Z"), now })).toBeNull();
    expect(relancable("CENTRE") && relancable("FINANCES") && !relancable("PAYE")).toBe(true);
  });

  it("la relance du dossier garde SA règle — le même délai de courtoisie, extrait et partagé", () => {
    const now = new Date("2026-10-14T10:00:00Z");
    expect(canNudge({ status: "SUBMITTED", kind: "REMINDER", comment: null, lastNudgeAt: new Date("2026-10-14T09:30:00Z"), now }).reason).toMatch(/moins d'une heure — réessayez dans 30 min/);
    expect(canNudge({ status: "SUBMITTED", kind: "REMINDER", comment: null, lastNudgeAt: new Date("2026-10-14T08:00:00Z"), now }).ok).toBe(true);
  });

  it("le message dit QUI relance et POURQUOI ; le commentaire est facultatif et borné", () => {
    expect(messageDeRelance({ reference: "PAY-2026-012", auteur: "Amine", parLeDemandeur: false, factureDejaConnue: true, commentaire: null }))
      .toBe("PAY-2026-012 — relancé par Amine, qui a voulu déposer la même facture ailleurs et a été arrêté(e) : elle est déjà en cours de traitement ici.");
    expect(messageDeRelance({ reference: "OD-1", auteur: "Sara", parLeDemandeur: true, factureDejaConnue: false, commentaire: "urgent" })).toBe("OD-1 — relance du demandeur (Sara) : « urgent »");
    expect(commentaireDeRelance("   ")).toBeNull();
    expect(commentaireDeRelance("x".repeat(900))?.length).toBe(500);
  });
});

describe("Le blocage d'une facture déjà connue — ce que la personne lit", () => {
  const piece = { numero: "FA-12", fournisseur: "SARL X", ttc: 119_000 };
  it("sans accès : ni titre ni montant du dossier, seulement « dans un dossier <module> » ; le seul geste est la relance", () => {
    const p = phraseDeBlocage(piece, { module: "Ad & Pro", acces: false, titre: null, montant: null, lien: null, etat: "CENTRE", chefDeDepartement: "Mme Y (Marketing)" });
    expect(p).toMatch(/^Cette facture existe déjà \(n° FA-12, SARL X, 119/);
    expect(p).toMatch(/en cours de traitement — au centre de paiement/);
    expect(p).toMatch(/Elle est dans un dossier Ad & Pro\./);
    expect(p).not.toMatch(/Mme Y/);
    expect(p).toMatch(/vous pouvez seulement la relancer/);
  });
  it("avec l'accès : le dossier est nommé, avec son montant et le chef du département ; une facture payée ne se relance pas", () => {
    const p = phraseDeBlocage(piece, { module: "Demandes de paiement", acces: true, titre: "PAY-2026-3 — Hôtel", montant: 250_000, lien: "/x", etat: "PAYE", chefDeDepartement: "Mme Y (Marketing)" });
    expect(p).toMatch(/elle est déjà payée/);
    expect(p).toMatch(/« PAY-2026-3 — Hôtel » \(Demandes de paiement, 250/);
    expect(p).toMatch(/Chef du département du dossier : Mme Y/);
    expect(p).not.toMatch(/relancer/);
  });
  it("le doublon possible avertit sans bloquer", () => {
    expect(phraseDoublonPossible("Même fournisseur, même montant TTC et même date.", { module: "Ad & Pro", acces: false, titre: "secret" }))
      .toMatch(/^Doublon possible avec une pièce d'un dossier Ad & Pro — .* marque « doublon possible »/);
  });
});

describe("Le jeton de relance — la personne arrêtée, et elle seule, relance CE paiement", () => {
  it("lié à la personne, à la cible, et daté", () => {
    const now = Date.now();
    const j = signerJetonRelance("u1", "EXPENSE_ORDER", "o1", now);
    expect(verifierJetonRelance(j, "u1", "EXPENSE_ORDER", "o1", now)).toBe(true);
    expect(verifierJetonRelance(j, "u2", "EXPENSE_ORDER", "o1", now)).toBe(false);
    expect(verifierJetonRelance(j, "u1", "EXPENSE_ORDER", "o2", now)).toBe(false);
    expect(verifierJetonRelance(j, "u1", "PAYMENT_REQUEST", "o1", now)).toBe(false);
    expect(verifierJetonRelance(j, "u1", "EXPENSE_ORDER", "o1", now + DUREE_JETON_MS + 1)).toBe(false);
    expect(verifierJetonRelance(`${j}x`, "u1", "EXPENSE_ORDER", "o1", now)).toBe(false);
    expect(verifierJetonRelance(null, "u1", "EXPENSE_ORDER", "o1", now)).toBe(false);
  });
});
