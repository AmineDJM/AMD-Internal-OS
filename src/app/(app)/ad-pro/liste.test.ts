import { describe, expect, it } from "vitest";
import {
  FILTRES_VIDES, attenteLongue, correspondRecherche, filtrer, filtresActifs, libelleDepuis, lireEcheance,
  nombreDeFiltresRanges, normaliser, pastillesEtat, pastillesNature, trier, triSuivant, type LigneAdPro,
} from "./liste";

const MAINTENANT = Date.parse("2026-11-24T10:00:00Z");
const JOUR = 86_400_000;

function ligne(p: Partial<LigneAdPro> & Pick<LigneAdPro, "id">): LigneAdPro {
  return {
    kind: "SPONSORING", reference: `REF-${p.id}`, title: `Objet ${p.id}`, beneficiary: null, amount: null,
    status: "SUBMITTED", state: "AWAITING", requester: null, createdAt: "2026-11-01T09:00:00.000Z", href: `/x/${p.id}`,
    chezQui: null, etape: null, aVous: false, depuis: null, echeance: null,
    ...p,
  };
}

const LIGNES: LigneAdPro[] = [
  ligne({ id: "a", title: "Congrès de cardiologie", kind: "CONGRESS_INTERNATIONAL", beneficiary: "Dr Benali", requester: "Yacine Habes", amount: 900_000, createdAt: "2026-11-20T08:00:00.000Z" }),
  ligne({ id: "b", title: "Soirée scientifique Oran", kind: "EVENT", requester: "Leila Merabet", amount: 250_000, state: "APPROVED", echeance: "2026-12-02T00:00:00.000Z" }),
  ligne({ id: "c", title: "Stand Société algérienne", kind: "SPONSORING", beneficiary: "SAC", requester: "Yacine Habes", amount: null, aVous: true, createdAt: "2026-10-05T08:00:00.000Z" }),
  ligne({ id: "d", title: "Brochures gamme", kind: "PROMO_MATERIAL", requester: "Leila Merabet", amount: 40_000, state: "RETURNED", createdAt: "2026-11-10T08:00:00.000Z" }),
  ligne({ id: "e", title: "Ancien sponsoring", kind: "SPONSORING", amount: 100_000, state: "DONE", createdAt: "2026-06-01T08:00:00.000Z" }),
];

describe("tableau Ad & Pro — la recherche", () => {
  it("ignore accents et casse, et chaque mot doit se trouver quelque part", () => {
    expect(normaliser("  Événement ")).toBe("evenement");
    const a = LIGNES[0]!;
    expect(correspondRecherche(a, "benali")).toBe(true);
    expect(correspondRecherche(a, "CONGRES habes")).toBe(true);
    expect(correspondRecherche(a, "benali oran")).toBe(false);
    expect(correspondRecherche(a, "REF-a")).toBe(true);
    // La nature se cherche aussi par son nom : « internationale » trouve la prise en charge internationale.
    expect(correspondRecherche(a, "internationale")).toBe(true);
    expect(correspondRecherche(a, "   ")).toBe(true);
  });

  it("les filtres de colonne d'avant sont tous là, et se combinent", () => {
    const f = { ...FILTRES_VIDES, requester: "habes", minAmount: "500 000" };
    expect(filtrer(LIGNES, f).map((r) => r.id)).toEqual(["a"]);
    expect(filtrer(LIGNES, { ...FILTRES_VIDES, beneficiary: "sac" }).map((r) => r.id)).toEqual(["c"]);
    expect(filtrer(LIGNES, { ...FILTRES_VIDES, reference: "ref-d" }).map((r) => r.id)).toEqual(["d"]);
    expect(filtrer(LIGNES, { ...FILTRES_VIDES, title: "brochure" }).map((r) => r.id)).toEqual(["d"]);
    expect(filtrer(LIGNES, { ...FILTRES_VIDES, dateFrom: "2026-11-10" }).map((r) => r.id)).toEqual(["a", "d"]);
    // Un montant minimum écarte ce qui n'a pas de montant : « ≥ 1 » ne garde pas un « — ».
    expect(filtrer(LIGNES, { ...FILTRES_VIDES, minAmount: "1" }).map((r) => r.id)).not.toContain("c");
    expect(filtrer(LIGNES, { ...FILTRES_VIDES, kind: "SPONSORING", etat: "DONE" }).map((r) => r.id)).toEqual(["e"]);
    expect(filtrer(LIGNES, { ...FILTRES_VIDES, etat: "A_VOUS" }).map((r) => r.id)).toEqual(["c"]);
  });

  it("le badge de « Filtres » compte les filtres rangés — pas la recherche ni les pastilles", () => {
    expect(nombreDeFiltresRanges({ ...FILTRES_VIDES, q: "x", kind: "EVENT", etat: "DONE" })).toBe(0);
    expect(nombreDeFiltresRanges({ ...FILTRES_VIDES, requester: "a", dateFrom: "2026-01-01" })).toBe(2);
    expect(filtresActifs(FILTRES_VIDES)).toBe(false);
    expect(filtresActifs({ ...FILTRES_VIDES, kind: "EVENT" })).toBe(true);
  });
});

describe("tableau Ad & Pro — les pastilles et leurs compteurs", () => {
  it("une pastille par nature PRÉSENTE, dans l'ordre du registre ; le compte suit la recherche mais pas la nature choisie", () => {
    const p = pastillesNature(LIGNES, { ...FILTRES_VIDES, kind: "EVENT", q: "habes" });
    expect(p.map((x) => x.cle)).toEqual(["SPONSORING", "CONGRESS_INTERNATIONAL", "EVENT", "PROMO_MATERIAL"]);
    expect(Object.fromEntries(p.map((x) => [x.cle, x.n]))).toEqual({ SPONSORING: 1, CONGRESS_INTERNATIONAL: 1, EVENT: 0, PROMO_MATERIAL: 0 });
  });

  it("« À vous » vient en tête quand quelque chose attend la personne, puis les états présents dans l'ordre de lecture", () => {
    const p = pastillesEtat(LIGNES, FILTRES_VIDES);
    expect(p.map((x) => `${x.label}:${x.n}`)).toEqual(["À vous:1", "En attente:2", "À corriger:1", "Validées:1", "Terminées:1"]);
    // Le compte suit la nature choisie : « Sponsoring » ne laisse qu'un en attente et un terminé.
    const s = pastillesEtat(LIGNES, { ...FILTRES_VIDES, kind: "SPONSORING", etat: "DONE" });
    expect(s.map((x) => `${x.cle}:${x.n}`)).toEqual(["A_VOUS:1", "AWAITING:1", "RETURNED:0", "APPROVED:0", "DONE:1"]);
    // Sans rien à elle : pas de pastille « À vous » du tout (une pastille à zéro qui ne bougera jamais).
    expect(pastillesEtat(LIGNES.map((r) => ({ ...r, aVous: false })), FILTRES_VIDES)[0]!.cle).toBe("AWAITING");
  });
});

describe("tableau Ad & Pro — le tri", () => {
  it("par défaut : ce qui attend la personne connectée en tête, puis l'ordre du serveur, intact", () => {
    expect(trier(LIGNES, null).map((r) => r.id)).toEqual(["c", "a", "b", "d", "e"]);
  });

  it("par colonne, les vides toujours en bas, quel que soit le sens", () => {
    expect(trier(LIGNES, { col: "montant", sens: "desc" }).map((r) => r.id)).toEqual(["a", "b", "e", "d", "c"]);
    expect(trier(LIGNES, { col: "montant", sens: "asc" }).map((r) => r.id)).toEqual(["d", "e", "b", "a", "c"]);
    expect(trier(LIGNES, { col: "echeance", sens: "asc" })[0]!.id).toBe("b");
    expect(trier(LIGNES, { col: "depot", sens: "desc" }).map((r) => r.id)).toEqual(["a", "d", "b", "c", "e"]);
    expect(trier(LIGNES, { col: "objet", sens: "asc" }).map((r) => r.id)).toEqual(["e", "d", "a", "b", "c"]);
    // L'état suit l'ordre de lecture ; à état égal, ce qui est à vous d'abord.
    expect(trier(LIGNES, { col: "etat", sens: "asc" }).map((r) => r.id)).toEqual(["c", "a", "d", "b", "e"]);
  });

  it("un clic par colonne : premier sens, l'autre, puis retour à l'ordre « ce qui attend d'abord »", () => {
    expect(triSuivant(null, "objet")).toEqual({ col: "objet", sens: "asc" });
    expect(triSuivant({ col: "objet", sens: "asc" }, "objet")).toEqual({ col: "objet", sens: "desc" });
    expect(triSuivant({ col: "objet", sens: "desc" }, "objet")).toBeNull();
    // Un montant se lit d'abord du plus grand.
    expect(triSuivant({ col: "objet", sens: "asc" }, "montant")).toEqual({ col: "montant", sens: "desc" });
    expect(triSuivant({ col: "montant", sens: "desc" }, "montant")).toEqual({ col: "montant", sens: "asc" });
  });
});

describe("tableau Ad & Pro — le temps", () => {
  it("« depuis » en un mot, et l'attente longue se signale au-delà de 7 jours", () => {
    const il = (j: number) => new Date(MAINTENANT - j * JOUR).toISOString();
    expect(libelleDepuis(null, MAINTENANT)).toBeNull();
    expect(libelleDepuis(il(0.2), MAINTENANT)).toBe("aujourd'hui");
    expect(libelleDepuis(il(3), MAINTENANT)).toBe("depuis 3 j");
    expect(libelleDepuis(il(21), MAINTENANT)).toBe("depuis 3 sem.");
    expect(libelleDepuis(il(95), MAINTENANT)).toBe("depuis 3 mois");
    expect(attenteLongue(il(3), MAINTENANT)).toBe(false);
    expect(attenteLongue(il(9), MAINTENANT)).toBe(true);
    expect(attenteLongue(null, MAINTENANT)).toBe(false);
  });

  it("l'échéance se compte en jours civils : demain, proche, dépassée", () => {
    expect(lireEcheance(null, MAINTENANT)).toBeNull();
    expect(lireEcheance("2026-11-24T00:00:00.000Z", MAINTENANT)).toEqual({ relatif: "aujourd'hui", proche: true, depassee: false });
    expect(lireEcheance("2026-11-25T07:00:00.000Z", MAINTENANT)).toEqual({ relatif: "demain", proche: true, depassee: false });
    expect(lireEcheance("2026-11-30T00:00:00.000Z", MAINTENANT)).toEqual({ relatif: "dans 6 j", proche: true, depassee: false });
    expect(lireEcheance("2026-12-20T00:00:00.000Z", MAINTENANT)!.proche).toBe(false);
    expect(lireEcheance("2026-11-21T00:00:00.000Z", MAINTENANT)).toEqual({ relatif: "dépassée de 3 j", proche: false, depassee: true });
  });
});
