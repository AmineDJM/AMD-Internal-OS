import { describe, expect, it } from "vitest";
import {
  compteDuFlux, compteParDefaut, disponible, jourAlger, soldesTresorerie,
  type CompteTresorerie, type FluxTresorerie,
} from "./tresorerie";

/**
 * LA TRÉSORERIE ANCRÉE — la règle pure (§118.176). Chaque cas dit le défaut qu'il attrape : une
 * assertion dont on ne sait pas nommer le cas qui la ferait tomber n'en est pas une (§118.17).
 */

const ADVENTUM = "soc-adventum";
const PHARMAGENE = "soc-pharmagene";

const compte = (p: Partial<CompteTresorerie> & { id: string }): CompteTresorerie => ({
  nom: p.id, societeId: null, principal: false, ancrage: 0, jourAncrage: "2026-09-28", ...p,
});
let n = 0;
const flux = (p: Partial<FluxTresorerie>): FluxTresorerie => ({
  id: `f${++n}`, sens: "OUT", montant: 0, statut: "SETTLED", jour: "2026-09-29", compteId: null, compte: "Banque", societeId: null, ...p,
});

describe("jourAlger — la journée de la banque, pas celle du serveur", () => {
  it("23 h 30 UTC le 28 septembre, c'est le 29 à Alger (UTC+1) — et 22 h 59 UTC, encore le 28", () => {
    expect(jourAlger(new Date("2026-09-28T23:30:00Z"))).toBe("2026-09-29");
    expect(jourAlger(new Date("2026-09-28T22:59:00Z"))).toBe("2026-09-28");
  });
});

describe("soldesTresorerie — l'ancrage et ce qui vient APRÈS", () => {
  const sga = compte({ id: "sga", nom: "SGA Birkhadem — Adventum", societeId: ADVENTUM, principal: true, ancrage: 2_966_153, jourAncrage: "2026-09-28" });

  it("le relevé du 28 contient déjà le 28 : seules les écritures RÉGLÉES postérieures s'ajoutent", () => {
    const r = soldesTresorerie([sga], [
      flux({ jour: "2026-09-27", montant: 100 }), // avant : déjà dans le relevé
      flux({ jour: "2026-09-28", montant: 200 }), // le jour même : déjà dans le relevé
      flux({ jour: "2026-09-29", montant: 300 }),
      flux({ jour: "2026-09-30", montant: 50, sens: "IN" }),
      flux({ jour: "2026-09-30", montant: 999, statut: "PENDING" }), // pas réglée : rien ne sort encore
    ]);
    // L'ancien calcul — ouverture + TOUS les flux réglés — aurait rendu 2 965 603 : 300 de trop retirés.
    expect(r.comptes[0]).toMatchObject({ solde: 2_965_903, mouvements: -250, nombreMouvements: 2 });
    expect(r.total).toBe(2_965_903);
    expect(r.nonRattaches).toEqual({ nombre: 0, montant: 0 });
  });

  it("deux comptes ancrés à des jours différents : chaque écriture se juge contre l'ancrage de SON compte", () => {
    const bna = compte({ id: "bna", nom: "BNA — Pharmagène", societeId: PHARMAGENE, principal: true, ancrage: 1_000_000, jourAncrage: "2026-09-30" });
    const r = soldesTresorerie([sga, bna], [
      flux({ jour: "2026-09-29", montant: 10, societeId: ADVENTUM }), // après le 28 : compte SGA
      flux({ jour: "2026-09-29", montant: 20, societeId: PHARMAGENE }), // avant le 30 : déjà dans le relevé BNA
      flux({ jour: "2026-10-01", montant: 40, societeId: PHARMAGENE }),
    ]);
    expect(r.comptes.map((c) => c.solde)).toEqual([2_966_143, 999_960]);
    expect(r.total).toBe(2_966_143 + 999_960);
  });
});

describe("compteDuFlux — la règle en cinq marches", () => {
  const a = compte({ id: "a", nom: "Banque", societeId: ADVENTUM });
  const b = compte({ id: "b", nom: "SGA", societeId: ADVENTUM, principal: true });
  const c = compte({ id: "c", nom: "CPA", societeId: null, principal: true });

  it("1. le compte NOMMÉ l'emporte sur tout le reste", () => {
    expect(compteDuFlux({ compteId: "c", compte: "Banque", societeId: ADVENTUM }, [a, b, c])).toBe("c");
  });
  it("2. sinon le compte dont le nom est son libellé (« Banque » de l'historique)", () => {
    expect(compteDuFlux({ compteId: null, compte: " banque ", societeId: ADVENTUM }, [a, b, c])).toBe("a");
  });
  it("3. sinon le principal de SON entité, 4. le principal sans entité, 5. le compte unique", () => {
    expect(compteDuFlux({ compteId: null, compte: "Caisse", societeId: ADVENTUM }, [a, b, c])).toBe("b");
    expect(compteDuFlux({ compteId: null, compte: "Caisse", societeId: PHARMAGENE }, [a, b, c])).toBe("c");
    expect(compteDuFlux({ compteId: null, compte: "Caisse", societeId: null }, [a])).toBe("a");
  });
  it("rien ne répond : rattachée à rien — jamais « le premier trouvé »", () => {
    expect(compteDuFlux({ compteId: null, compte: "Caisse", societeId: null }, [a, b])).toBeNull();
  });
});

describe("compteParDefaut — ce que fige une écriture neuve", () => {
  it("deux principaux pour la même entité n'en désignent AUCUN (§118.34)", () => {
    const x = compte({ id: "x", societeId: ADVENTUM, principal: true });
    const y = compte({ id: "y", societeId: ADVENTUM, principal: true });
    expect(compteParDefaut([x, y], ADVENTUM)).toBeNull();
  });
  it("sans principal, un compte UNIQUE est le compte — deux comptes sans principal, aucun", () => {
    expect(compteParDefaut([compte({ id: "u" })], ADVENTUM)).toBe("u");
    expect(compteParDefaut([compte({ id: "u" }), compte({ id: "v" })], ADVENTUM)).toBeNull();
  });
  it("une entité sans principal retombe sur le principal SANS entité, jamais sur celui d'une autre entité", () => {
    const autre = compte({ id: "autre", societeId: PHARMAGENE, principal: true });
    const commun = compte({ id: "commun", societeId: null, principal: true });
    expect(compteParDefaut([autre, commun], ADVENTUM)).toBe("commun");
    expect(compteParDefaut([autre], ADVENTUM)).toBe("autre"); // compte unique — la 5e marche, pas la 3e
    expect(compteParDefaut([autre, compte({ id: "z", societeId: PHARMAGENE })], ADVENTUM)).toBeNull();
  });
});

describe("ce qu'aucun compte ne reçoit est COMPTÉ, et ce qui n'est pas à nous n'est pas compté", () => {
  const x = compte({ id: "x", jourAncrage: "2026-09-28" });
  const y = compte({ id: "y", jourAncrage: "2026-09-30" });

  it("rattachée à rien et postérieure au plus ancien ancrage : comptée dans les non rattachées", () => {
    const r = soldesTresorerie([x, y], [
      flux({ jour: "2026-09-29", montant: 70 }),
      flux({ jour: "2026-09-20", montant: 5 }), // avant tout ancrage : ne touche aucun compte
    ]);
    expect(r.nonRattaches).toEqual({ nombre: 1, montant: -70 });
    expect(r.total).toBe(0);
  });

  it("une écriture qui NOMME un compte hors de la liste appartient à un compte qu'on ne voit pas : ni comptée, ni signalée", () => {
    const r = soldesTresorerie([x], [flux({ jour: "2026-10-01", montant: 500, compteId: "compte-d-une-autre-entite" })]);
    expect(r.total).toBe(0);
    expect(r.nonRattaches.nombre).toBe(0);
  });

  it("sans aucun compte ancré, rien n'est compté — l'écran le DIT au lieu d'additionner des flux sans point de départ", () => {
    const r = soldesTresorerie([], [flux({ montant: 100 })]);
    expect(r).toEqual({ comptes: [], total: 0, nonRattaches: { nombre: 0, montant: 0 } });
  });
});

describe("disponible — la somme des comptes moins ce qui est déjà autorisé", () => {
  it("2 965 903 en banque, 400 000 autorisés par le centre et pas encore réglés : 2 565 903 disponibles", () => {
    expect(disponible(2_965_903, 400_000)).toBe(2_565_903);
  });
});
