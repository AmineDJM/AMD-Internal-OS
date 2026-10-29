import { describe, expect, it } from "vitest";
import {
  bilanCloture, etatPostesSponsoring, peutCloturer, quiCloture, refusCloture,
  SPONSORING_DECIDE, SPONSORING_ARGENT_DECIDE, STATUTS_SOLDES_PAR_UN_REGLEMENT,
  type PostePourCloture,
} from "./cloture-sponsoring";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA VALIDATION FINALE ET LA CLÔTURE D'UN SPONSORING (§118.151) — la règle pure.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const poste = (label: string, status: string, amountGranted: number | null, budgetCategoryId: string | null = null): PostePourCloture =>
  ({ label, status, amountGranted, budgetCategoryId, kind: "OTHER", lignesStock: [] });

describe("l'état des postes d'un sponsoring — décidé, tardif, clos", () => {
  it("PRÉ-VALIDÉ : décidé (ses postes engagent) mais PAS tardif (ajouter des postes est l'étape)", () => {
    expect(etatPostesSponsoring("PRE_VALIDATED", null)).toEqual({ decide: true, tardif: false, clos: false, closParLaCloture: false });
  });

  it("ACCORDÉ à montant global (ancien circuit) : décidé ET tardif — un poste de plus dépasse l'enveloppe", () => {
    for (const s of ["APPROVED", "ACCEPTED", "PAID"]) {
      expect(etatPostesSponsoring(s, null), s).toMatchObject({ decide: true, tardif: true, clos: false });
    }
  });

  it("CLOSED a deux sens, et la date de clôture les distingue", () => {
    expect(etatPostesSponsoring("CLOSED", new Date()), "clôturé par sa validation finale").toMatchObject({ clos: true, closParLaCloture: true });
    expect(etatPostesSponsoring("CLOSED", null), "clos par un TRANSFERT vers un autre module").toMatchObject({ clos: true, closParLaCloture: false });
  });

  it("dans le circuit ou refusé : ni décidé, ni tardif, ni clos", () => {
    for (const s of ["AWAITING_PRELIMINARY", "PRELIMINARY_APPROVED", "AWAITING_FINAL", "REFUSED"]) {
      expect(etatPostesSponsoring(s, null), s).toEqual({ decide: false, tardif: false, clos: false, closParLaCloture: false });
    }
  });

  it("les listes restent cohérentes : tout ce qui a l'argent décidé est décidé ; seul un accord global se solde par un règlement", () => {
    for (const s of SPONSORING_ARGENT_DECIDE) expect(SPONSORING_DECIDE, s).toContain(s);
    expect(SPONSORING_ARGENT_DECIDE).not.toContain("PRE_VALIDATED");
    // Ce qui le ferait tomber : laisser un règlement de POSTE solder une demande pré-validée ou
    // clôturée — elle sauterait sa clôture, ou repasserait de « clôturée » à « payée ».
    expect(STATUTS_SOLDES_PAR_UN_REGLEMENT).not.toContain("PRE_VALIDATED");
    expect(STATUTS_SOLDES_PAR_UN_REGLEMENT).not.toContain("CLOSED");
    expect(STATUTS_SOLDES_PAR_UN_REGLEMENT).toContain("APPROVED");
  });
});

describe("le bilan de clôture — tout ce qui manque, en UNE fois", () => {
  it("clôturable : tout décidé, chaque accordé a son budget et son montant — le total est la somme des ACCORDÉS", () => {
    const b = bilanCloture("PRE_VALIDATED", [
      poste("Sponsoring direct", "APPROVED", 80_000, "cat-1"),
      poste("Stand", "APPROVED", 45_000.5, "cat-2"),
      poste("Dîner", "REJECTED", null),
    ]);
    expect(b.cloturable).toBe(true);
    expect(b.manques).toEqual([]);
    expect(b.total).toBe(125_000.5);
    expect(b).toMatchObject({ accordes: 2, refuses: 1, aDecider: 0 });
  });

  it("TOUT refusé : clôturable à 0 DZD — la tenue a eu lieu, rien n'a été financé, et ce n'est pas une impasse", () => {
    const b = bilanCloture("PRE_VALIDATED", [poste("Sponsoring indirect", "REJECTED", null)]);
    expect(b.cloturable).toBe(true);
    expect(b.total).toBe(0);
  });

  it("les manques sont TOUS dits, chacun avec ses postes nommés — pas un aller-retour par faute (§118.18)", () => {
    const b = bilanCloture("PRE_VALIDATED", [
      poste("Stand", "DRAFT", null),
      poste("Traiteur", "PENDING", null),
      poste("Salle", "REVISION", null),
      poste("Sponsoring direct", "APPROVED", 80_000, null),
      poste("Billetterie", "APPROVED", null, "cat-1"),
    ]);
    expect(b.cloturable).toBe(false);
    expect(b.manques).toHaveLength(3);
    const texte = b.manques.join(" | ");
    expect(texte).toMatch(/3 postes encore à décider/);
    for (const l of ["Stand", "Traiteur", "Salle"]) expect(texte).toContain(`« ${l} »`);
    expect(texte).toMatch(/sans budget[^|]*« Sponsoring direct »/);
    expect(texte).toMatch(/sans montant[^|]*« Billetterie »/);
  });

  it("aucun poste : pas de clôture à vide — et le refus nomme le geste qui en sort", () => {
    const b = bilanCloture("PRE_VALIDATED", []);
    expect(b.cloturable).toBe(false);
    expect(b.manques.join(" ")).toMatch(/ajoutez au moins le poste du sponsoring/);
  });

  it("une demande encore dans son circuit, ou déjà close, ne se clôture pas", () => {
    const tout = [poste("Sponsoring direct", "APPROVED", 1, "c")];
    expect(bilanCloture("AWAITING_FINAL", tout).manques.join(" ")).toMatch(/pré-validée/);
    expect(bilanCloture("CLOSED", tout).manques.join(" ")).toMatch(/déjà clôturée/);
  });

  it("une longue liste reste lisible : quatre noms, puis le compte de ce qui reste", () => {
    const b = bilanCloture("PRE_VALIDATED", ["A", "B", "C", "D", "E", "F"].map((l) => poste(l, "DRAFT", null)));
    expect(b.manques[0]).toContain("et 2 autres");
    expect(b.manques[0]).not.toContain("« E »");
  });
});

describe("qui clôture — celui qui a pré-validé la tenue, jamais le demandeur", () => {
  const faits = (o: Partial<Parameters<typeof peutCloturer>[0]> = {}) => ({
    estSuperAdmin: false, porteLeRoleQuiTranche: false, aLaVueGlobale: false, estLeDemandeur: false, ...o,
  });

  it("règle générale : la Direction Marketing clôture ; la Direction, non", () => {
    expect(peutCloturer(faits({ porteLeRoleQuiTranche: true }), "DIRECTION_MARKETING")).toBe(true);
    expect(peutCloturer(faits({ aLaVueGlobale: true }), "DIRECTION_MARKETING")).toBe(false);
  });

  it("demande de la Direction Marketing elle-même : c'est la Direction qui clôture — pas un collègue de la même direction", () => {
    expect(peutCloturer(faits({ aLaVueGlobale: true }), "DIRECTION")).toBe(true);
    expect(peutCloturer(faits({ porteLeRoleQuiTranche: true }), "DIRECTION")).toBe(false);
  });

  it("le demandeur ne se clôture JAMAIS — même quand il porte le rôle qui tranche", () => {
    expect(peutCloturer(faits({ porteLeRoleQuiTranche: true, estLeDemandeur: true }), "DIRECTION_MARKETING")).toBe(false);
    expect(peutCloturer(faits({ aLaVueGlobale: true, estLeDemandeur: true }), "DIRECTION")).toBe(false);
  });

  it("le Super Admin, toujours", () => {
    expect(peutCloturer(faits({ estSuperAdmin: true, estLeDemandeur: true }), "DIRECTION_MARKETING")).toBe(true);
  });

  it("le refus dit QUI clôture — la personne sait vers qui se tourner", () => {
    expect(refusCloture("DIRECTION_MARKETING")).toMatch(/Direction Marketing/);
    expect(refusCloture("DIRECTION")).toMatch(/la Direction \(la demande vient de la Direction Marketing/);
    expect(quiCloture("final")).toBe("DIRECTION");
  });
});

describe("le matériel du stock dans le bilan de clôture (§118.167)", () => {
  const stock = (label: string, status: string, lignes: { libelle: string; statut: string }[]): PostePourCloture =>
    ({ label, status, amountGranted: null, budgetCategoryId: null, kind: "STOCK_MATERIAL", lignesStock: lignes });

  it("un poste « Matériel du stock » accordé n'exige ni budget ni montant — et ne compte pas dans le total", () => {
    const b = bilanCloture("PRE_VALIDATED", [
      poste("Sponsoring direct", "APPROVED", 80_000, "cat-1"),
      stock("Matériel du stand", "APPROVED", [{ libelle: "Kakémono", statut: "CONFIRMEE" }]),
    ]);
    expect(b.cloturable, b.manques.join(" ; ")).toBe(true);
    expect(b.total).toBe(80_000);
  });

  it("une ligne encore RÉSERVÉE bloque la clôture, et la phrase la nomme", () => {
    const b = bilanCloture("PRE_VALIDATED", [
      poste("Sponsoring direct", "APPROVED", 80_000, "cat-1"),
      stock("Matériel du stand", "APPROVED", [{ libelle: "Kakémono Nivolex", statut: "RESERVEE" }]),
    ]);
    expect(b.cloturable).toBe(false);
    expect(b.manques.join(" ")).toMatch(/attendent leur confirmation.*« Kakémono Nivolex »/);
  });

  it("le même poste traité comme une dépense ordinaire serait bloqué faute de budget — c'est la nature qui l'exempte", () => {
    // Ce qui le ferait tomber : oublier la nature dans le filtre de l'argent. Le témoin le prouve.
    const b = bilanCloture("PRE_VALIDATED", [{ ...stock("Matériel du stand", "APPROVED", []), kind: "OTHER" }]);
    expect(b.cloturable).toBe(false);
    expect(b.manques.join(" ")).toMatch(/sans budget/);
  });

  it("un poste de stock encore à décider bloque comme n'importe quel poste", () => {
    const b = bilanCloture("PRE_VALIDATED", [stock("Matériel", "PENDING", [{ libelle: "Brochure", statut: "DEMANDEE" }])]);
    expect(b.manques.join(" ")).toMatch(/encore à décider/);
  });
});
