import { describe, expect, it } from "vitest";
import {
  consommationHistorique, estAbsenteDuFichier, plusAncienne, regleDuLot, trierSources, verdictSource, type SourceBudget,
} from "./integration-regle";

/** LA RÈGLE DU BUDGET APRÈS UNE INTÉGRATION — pure : (a) postes historiques, (b) ce qui naît après, (c) jamais deux fois. */

const INTEGRE = new Date("2026-10-14T10:00:00Z");
const avant = new Date("2026-09-21T09:00:00Z");
const apres = new Date("2026-10-20T09:00:00Z");
const regle = regleDuLot({
  lotId: "lot", enveloppeId: "env", integreLe: INTEGRE,
  demandes: [{ type: "SPONSORING", id: "spo3" }],
  postesHistoriques: ["p-hist"],
  decisions: [{ cleSource: "LIGNE:l2", decision: "SORTIR" }, { cleSource: "LIGNE:l3", decision: "GARDER" }, { cleSource: "LIGNE:l4", decision: "AUTRE" }],
});
const s = (o: Partial<SourceBudget>): SourceBudget => ({ cle: "TX:x", neeLe: avant, demande: null, posteId: null, ...o });

describe("verdictSource", () => {
  it("(c) une source d'une demande intégrée, née avant, est remplacée par le fichier (le 53 350 du webinaire ne s'ajoute pas)", () => {
    expect(verdictSource(regle, s({ demande: "SPONSORING:spo3" }))).toEqual({ compte: false, raison: "REMPLACEE_PAR_LE_FICHIER" });
  });
  it("(b) ce qui naît après l'intégration compte, même sur une demande intégrée", () => {
    expect(verdictSource(regle, s({ demande: "SPONSORING:spo3", neeLe: apres }))).toEqual({ compte: true, raison: "APRES_INTEGRATION" });
  });
  it("un poste historique n'engage ni ne consomme jamais rien d'autre que sa ligne — même après", () => {
    expect(verdictSource(regle, s({ posteId: "p-hist", neeLe: apres })).raison).toBe("POSTE_HISTORIQUE");
  });
  it("ce qui comptait avant et n'est dans aucune ligne : à décider (compté), gardé, ou sorti", () => {
    expect(verdictSource(regle, s({ cle: "LIGNE:l1" }))).toEqual({ compte: true, raison: "ABSENTE_A_DECIDER" });
    expect(verdictSource(regle, s({ cle: "LIGNE:l2" }))).toEqual({ compte: false, raison: "ABSENTE_SORTIE" });
    expect(verdictSource(regle, s({ cle: "LIGNE:l3" }))).toEqual({ compte: true, raison: "ABSENTE_GARDEE" });
    // Un choix illisible ne vaut rien : à décider.
    expect(verdictSource(regle, s({ cle: "LIGNE:l4" })).raison).toBe("ABSENTE_A_DECIDER");
  });
  it("trierSources : sans règle, tout compte ; avec, chaque source a son verdict", () => {
    const sources = [s({ cle: "TX:a", demande: "SPONSORING:spo3" }), s({ cle: "LIGNE:l2" }), s({ cle: "TX:b", neeLe: apres }), s({ cle: "TX:c" })];
    expect(trierSources(null, sources).comptees).toHaveLength(4);
    const t = trierSources(regle, sources);
    expect(t.comptees.map((x) => x.cle)).toEqual(["TX:b", "TX:c"]);
    expect(t.ecartees.map((x) => x.cle)).toEqual(["TX:a", "LIGNE:l2"]);
    expect(t.absentes.map((x) => x.cle)).toEqual(["LIGNE:l2", "TX:c"]);
    expect(t.absentes.every((x) => estAbsenteDuFichier(x.verdict))).toBe(true);
  });
});

describe("consommationHistorique — (a) les postes payés, à leur date, dans leur catégorie", () => {
  const postes = [
    { id: "1", categoryId: "sym", montant: 195_475, payeLe: new Date("2026-10-31T12:00:00Z"), kind: "SYMPOSIUM", libelle: "Honoraires", demande: "SPONSORING:s", ligne: 22 },
    { id: "2", categoryId: "sym", montant: 8_000, payeLe: new Date("2026-10-31T12:00:00Z"), kind: "TICKETING", libelle: "Billet", demande: "SPONSORING:s", ligne: 22 },
    { id: "3", categoryId: "spo", montant: 300_000, payeLe: new Date("2026-02-28T12:00:00Z"), kind: "ASSOCIATION_SUPPORT", libelle: "Sapsox", demande: null, ligne: 14 },
    { id: "4", categoryId: "autre-enveloppe", montant: 1, payeLe: new Date("2026-02-28T12:00:00Z"), kind: "OTHER", libelle: "x", demande: null, ligne: null },
  ];
  it("additionne par catégorie, et seulement celles demandées", () => {
    const r = consommationHistorique(postes, new Set(["sym", "spo"]));
    expect(Object.fromEntries(r.parCategorie)).toEqual({ sym: 203_475, spo: 300_000 });
  });
  it("respecte la période (une vue bornée de mars à décembre ne voit pas Sapsox de février)", () => {
    const r = consommationHistorique(postes, new Set(["sym", "spo"]), new Date("2026-03-01"), new Date("2026-12-31"));
    expect(Object.fromEntries(r.parCategorie)).toEqual({ sym: 203_475 });
  });
  it("plusAncienne : la première trace d'une source date sa naissance", () => {
    expect(plusAncienne(apres, avant, null).toISOString()).toBe(avant.toISOString());
    expect(plusAncienne(null, undefined).getTime()).toBe(0);
  });
});
