import { describe, expect, it } from "vitest";
import {
  ajouterMois, finDeduite, palierAPrevenir, palierAtteint, sourceRetenue, statutValidite, validiteRetenue, ymd,
  PALIER_EXPIREE, PALIERS_ALERTE_MOIS, VALIDITE_ENREGISTREMENT_ANS,
} from "./validite-enregistrement";
import { lireAttestationModele, lireDecisionModele, proposerDates } from "./decision-lue";

const j = (s: string) => new Date(`${s}T00:00:00.000Z`);
const midi = (s: string) => new Date(`${s}T12:00:00.000Z`);

describe("validité d'une décision d'enregistrement — la règle des 5 ans", () => {
  it("la fin déduite est le début + 5 ans, jour pour jour", () => {
    expect(VALIDITE_ENREGISTREMENT_ANS).toBe(5);
    expect(ymd(finDeduite(j("2026-03-15")))).toBe("2031-03-15");
  });

  it("un 29 février se déduit au 28 février (l'année d'arrivée n'est pas bissextile)", () => {
    expect(ymd(finDeduite(j("2028-02-29")))).toBe("2033-02-28");
  });

  it("ajouter des mois reste dans le mois visé", () => {
    expect(ymd(ajouterMois(j("2031-03-31"), -1))).toBe("2031-02-28");
    expect(ymd(ajouterMois(j("2031-03-15"), -12))).toBe("2030-03-15");
  });
});

describe("statut et paliers d'alerte (12, 6, 1 mois, puis expirée)", () => {
  const fin = "2031-03-15";

  it("les paliers par défaut sont 12, 6 et 1 mois", () => {
    expect([...PALIERS_ALERTE_MOIS]).toEqual([12, 6, 1]);
  });

  it("valide avant le premier palier, à renouveler à 12 mois, expirée le lendemain de la fin", () => {
    expect(statutValidite(fin, midi("2030-03-14"))).toBe("VALIDE");
    expect(statutValidite(fin, midi("2030-03-15"))).toBe("A_RENOUVELER");
    expect(statutValidite(fin, midi("2031-03-15"))).toBe("A_RENOUVELER"); // le jour de fin est encore valide
    expect(statutValidite(fin, midi("2031-03-16"))).toBe("EXPIREE");
    expect(statutValidite(null, midi("2031-03-16"))).toBeNull();
  });

  it("le palier atteint est le plus proche de la fin", () => {
    expect(palierAtteint(fin, midi("2030-03-14"))).toBeNull();
    expect(palierAtteint(fin, midi("2030-03-15"))).toBe(12);
    expect(palierAtteint(fin, midi("2030-09-15"))).toBe(6);
    expect(palierAtteint(fin, midi("2031-02-15"))).toBe(1);
    expect(palierAtteint(fin, midi("2031-04-01"))).toBe(PALIER_EXPIREE);
  });

  it("une alerte par palier : 12 une fois, puis 6, puis 1, puis expirée", () => {
    const base = { fin: j(fin), finPrevenue: j(fin) };
    expect(palierAPrevenir({ ...base, maintenant: midi("2030-03-15"), dernierPalier: null, finPrevenue: null })).toBe(12);
    expect(palierAPrevenir({ ...base, maintenant: midi("2030-04-15"), dernierPalier: 12 })).toBeNull();
    expect(palierAPrevenir({ ...base, maintenant: midi("2030-09-15"), dernierPalier: 12 })).toBe(6);
    expect(palierAPrevenir({ ...base, maintenant: midi("2031-02-20"), dernierPalier: 6 })).toBe(1);
    expect(palierAPrevenir({ ...base, maintenant: midi("2031-03-10"), dernierPalier: 1 })).toBeNull();
    expect(palierAPrevenir({ ...base, maintenant: midi("2031-03-16"), dernierPalier: 1 })).toBe(PALIER_EXPIREE);
    expect(palierAPrevenir({ ...base, maintenant: midi("2031-06-16"), dernierPalier: PALIER_EXPIREE })).toBeNull();
  });

  it("découvert à trois mois de la fin : le palier 6 sonne une fois, pas 12 puis 6", () => {
    expect(palierAPrevenir({ fin, maintenant: midi("2030-12-15"), dernierPalier: null, finPrevenue: null })).toBe(6);
  });

  it("une nouvelle décision (fin repoussée) rouvre les paliers", () => {
    expect(palierAPrevenir({ fin: "2036-03-15", maintenant: midi("2035-03-20"), dernierPalier: PALIER_EXPIREE, finPrevenue: fin })).toBe(12);
  });
});

describe("la confirmation : ce qui est retenu, et la source de chaque date", () => {
  it("garder la proposition garde sa source ; la changer en fait une saisie", () => {
    expect(sourceRetenue("2026-03-15", { valeur: "2026-03-15", source: "LUE_IA" })).toBe("LUE_IA");
    expect(sourceRetenue("2026-03-16", { valeur: "2026-03-15", source: "LUE_IA" })).toBe("SAISIE");
    expect(sourceRetenue(null, { valeur: "2026-03-15", source: "LUE_IA" })).toBeNull();
  });

  it("fin manquante : déduite à début + 5 ans", () => {
    const v = validiteRetenue({ numero: "DE-123", dateDecision: "2026-03-15", debut: null, fin: null });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(ymd(v.debut!)).toBe("2026-03-15");
    expect(ymd(v.fin!)).toBe("2031-03-15");
    expect(v.sourceFin).toBe("DEDUITE");
    expect(v.sourceDecision).toBe("SAISIE");
  });

  it("une fin tapée égale à début + 5 ans reste une déduction ; une autre est une saisie", () => {
    const a = validiteRetenue({ numero: null, dateDecision: null, debut: "2026-03-15", fin: "2031-03-15" });
    const b = validiteRetenue({ numero: null, dateDecision: null, debut: "2026-03-15", fin: "2030-12-31" });
    expect(a.ok && a.sourceFin).toBe("DEDUITE");
    expect(b.ok && b.sourceFin).toBe("SAISIE");
  });

  it("une fin avant le début est refusée, avec le remède", () => {
    const v = validiteRetenue({ numero: null, dateDecision: null, debut: "2026-03-15", fin: "2025-01-01" });
    expect(v.ok).toBe(false);
    expect(!v.ok && v.error).toMatch(/fin de validité doit suivre le début/);
  });

  it("rien à enregistrer : refusé", () => {
    expect(validiteRetenue({ numero: null, dateDecision: null, debut: null, fin: null }).ok).toBe(false);
  });
});

describe("ce que l'IA a lu — relu par notre code", () => {
  it("une décision sans fin imprimée : la fin est DÉDUITE, sans phrase", () => {
    const lu = lireDecisionModele({
      numero: { valeur: "245/DG/ANPP/2026", extrait: "Décision n° 245/DG/ANPP/2026" },
      dateDecision: { valeur: "15/03/2026", extrait: "Alger, le 15/03/2026" },
      debutValidite: { valeur: "", extrait: "" },
      finValidite: { valeur: "", extrait: "" },
    });
    const p = proposerDates(lu);
    expect(p.numero?.valeur).toBe("245/DG/ANPP/2026");
    expect(p.dateDecision).toEqual({ valeur: "2026-03-15", extrait: "Alger, le 15/03/2026", source: "LUE_IA" });
    expect(p.debut?.valeur).toBe("2026-03-15");
    expect(p.fin).toEqual({ valeur: "2031-03-15", extrait: null, source: "DEDUITE" });
  });

  it("une valeur sans la phrase qui la dit n'est pas reprise", () => {
    const lu = lireDecisionModele({ numero: { valeur: "12", extrait: "" }, dateDecision: { valeur: "15/03/2026", extrait: "" }, debutValidite: {}, finValidite: {} });
    expect(lu?.numero).toBeNull();
    expect(lu?.dateDecision).toBeNull();
    expect(proposerDates(lu).fin).toBeNull();
  });

  it("une attestation : prix en DZD lus en texte, un par type ; une devise étrangère est écartée", () => {
    const a = lireAttestationModele({
      date: { valeur: "02/04/2026", extrait: "Fait à Alger le 02/04/2026" },
      prix: [
        { type: "PPA", montant: "1 234,50 DA", extrait: "PPA : 1 234,50 DA" },
        { type: "PPA", montant: "999", extrait: "doublon" },
        { type: "SHP", montant: "12 EUR", extrait: "FOB 12 EUR" },
        { type: "INCONNU", montant: "10", extrait: "x" },
      ],
    });
    expect(a?.date?.valeur).toBe("2026-04-02");
    expect(a?.prix).toEqual([{ type: "PPA", valeur: 1234.5, extrait: "PPA : 1 234,50 DA", source: "LUE_IA" }]);
  });
});
