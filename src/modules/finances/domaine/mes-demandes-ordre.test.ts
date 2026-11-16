import { describe, expect, it } from "vitest";
import { dateDeLaDemande, deplacerDansMonOrdre, estTriMesDemandes, mettreEnTeteDeMonOrdre, trierMesDemandes, type CleDeTri } from "./mes-demandes-ordre";

/** L'ordre de « Mes demandes » (Direction, 10/11/2026) : la plus récente d'abord, et l'ordre choisi par la personne. */
const d = (id: string, creeLe: string, o: Partial<CleDeTri> = {}): CleDeTri => ({
  id, creeLe, montant: 0, statut: "SUBMITTED", rangEcheance: 0, rang: null, ...o,
});
const A = d("a", "2026-11-01T10:00:00Z", { montant: 500, statut: "APPROVED", rangEcheance: 2 });
const B = d("b", "2026-11-05T10:00:00Z", { montant: 9000, statut: "CHANGES_REQUESTED", rangEcheance: 0 });
const C = d("c", "2026-11-03T10:00:00Z", { montant: 1200, statut: "DRAFT", rangEcheance: 1 });
const ids = (l: CleDeTri[]) => l.map((x) => x.id);

describe("l'ordre de mes demandes de paiement", () => {
  it("par défaut, la plus récente en tête ; puis la plus ancienne", () => {
    expect(ids(trierMesDemandes([A, B, C], "RECENTES"))).toEqual(["b", "c", "a"]);
    expect(ids(trierMesDemandes([A, B, C], "ANCIENNES"))).toEqual(["a", "c", "b"]);
  });

  it("par échéance (l'ordre des Finances), par montant, par statut (ce qui m'attend d'abord)", () => {
    expect(ids(trierMesDemandes([A, B, C], "ECHEANCE"))).toEqual(["b", "c", "a"]);
    expect(ids(trierMesDemandes([A, B, C], "MONTANT"))).toEqual(["b", "c", "a"]);
    expect(ids(trierMesDemandes([A, B, C], "STATUT"))).toEqual(["b", "c", "a"]);
  });

  it("ma priorité : mon ordre ; une demande neuve (pas encore rangée) passe en tête", () => {
    const rangees = [{ ...A, rang: 0 }, { ...C, rang: 1 }, B];
    expect(ids(trierMesDemandes(rangees, "MA_PRIORITE"))).toEqual(["b", "a", "c"]);
  });

  it("monter / descendre rend l'ordre complet à enregistrer ; rien aux bords", () => {
    const rangees = [{ ...A, rang: 0 }, { ...B, rang: 1 }, { ...C, rang: 2 }];
    expect(deplacerDansMonOrdre(rangees, "c", -1)).toEqual(["a", "c", "b"]);
    expect(deplacerDansMonOrdre(rangees, "a", 1)).toEqual(["b", "a", "c"]);
    expect(deplacerDansMonOrdre(rangees, "a", -1)).toBeNull();
    expect(deplacerDansMonOrdre(rangees, "c", 1)).toBeNull();
    expect(deplacerDansMonOrdre(rangees, "z", 1)).toBeNull();
  });

  it("mettre en tête : la demande choisie passe première, les autres gardent leur ordre", () => {
    const rangees = [{ ...A, rang: 0 }, { ...B, rang: 1 }, { ...C, rang: 2 }];
    expect(mettreEnTeteDeMonOrdre(rangees, "c")).toEqual(["c", "a", "b"]);
    expect(mettreEnTeteDeMonOrdre(rangees, "a")).toBeNull();
    expect(mettreEnTeteDeMonOrdre(rangees, "z")).toBeNull();
  });

  it("la date de la demande s'écrit à l'heure d'Alger ; une date illisible ne casse rien", () => {
    expect(dateDeLaDemande("2026-11-05T23:30:00Z")).toMatch(/06 nov\.? 2026.*00:30/);
    expect(dateDeLaDemande("pas une date")).toBe("—");
  });

  it("l'entrée n'est pas modifiée ; un tri inconnu n'est pas un tri", () => {
    const l = [A, B, C];
    trierMesDemandes(l, "MONTANT");
    expect(ids(l)).toEqual(["a", "b", "c"]);
    expect(estTriMesDemandes("MA_PRIORITE")).toBe(true);
    expect(estTriMesDemandes("autre")).toBe(false);
  });
});
