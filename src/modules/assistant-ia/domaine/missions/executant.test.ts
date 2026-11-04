import { describe, expect, it } from "vitest";
import { diagnostiquerMission, phraseDernierBalayage, silenceDesExecutants } from "./pilotage";

/** P1 ter (décision 0066) — la vérité sur l'exécutant, la candidature au balayage, le dernier balayage. */
const T0 = Date.parse("2026-11-03T10:00:00Z");
const il = (min: number) => new Date(T0 - min * 60_000).toISOString();

describe("P1 ter — la VÉRITÉ SUR L'EXÉCUTANT (Direction, 03/11)", () => {
  const mission = { etat: "EN_COURS", motifPause: null, attente: null, etapes: [], majLe: il(1) };
  it("« prête » (fait daté, jamais une prévision — I1, 0063) SEULEMENT si un passage effectif a eu lieu dans les 3 dernières minutes", () => {
    expect(diagnostiquerMission(mission, { dernierPassage: il(1), workerVu: null }, T0).phrase).toMatch(/^prête, .* dernière activité il y a/);
    expect(diagnostiquerMission(mission, { dernierPassage: il(4), workerVu: null }, T0).phrase).not.toMatch(/^prête/);
  });
  it("un balayage DÉBRAYÉ (TRAVAUX_SWEEP=off) dit la vraie raison — pas « aucun battement »", () => {
    const s = silenceDesExecutants({ dernierPassage: null, workerVu: null, balayageVu: il(1), raisonIgnore: "TRAVAUX_SWEEP=off" }, T0);
    expect(s).toContain("TRAVAUX_SWEEP=off");
    expect(s).not.toContain("aucun battement enregistré");
  });
  it("le web s'abstient pour le worker, mais le worker ne bat pas : dit tel quel, avec depuis quand", () => {
    expect(silenceDesExecutants({ dernierPassage: null, workerVu: null, balayageVu: il(1), raisonIgnore: "le worker conduit les travaux (TACHES_DE_FOND=les-deux)" }, T0)).toContain("le worker n'a jamais battu");
    expect(silenceDesExecutants({ dernierPassage: il(9), workerVu: il(9), balayageVu: il(1), raisonIgnore: "le worker conduit les travaux" }, T0)).toContain("ne bat plus depuis 9 min");
  });
  it("aucun exécutant jamais vu : le dit ; un passage récent : rien à dire", () => {
    expect(silenceDesExecutants({ dernierPassage: null, workerVu: null }, T0)).toContain("aucun battement enregistré");
    expect(silenceDesExecutants({ dernierPassage: il(2), workerVu: null }, T0)).toBeNull();
  });
  it("une mission que le balayage NE PRENDRA PAS n'est jamais « prête », même exécutant vivant : la raison est dite", () => {
    const d = diagnostiquerMission({ ...mission, candidate: false, raisonNonCandidate: "aucune étape n'est prête à partir (dépendances non satisfaites)" }, { dernierPassage: il(1), workerVu: il(1) }, T0);
    expect(d.phrase).not.toMatch(/^prête/);
    expect(d.phrase).toContain("pas prise par le balayage");
    expect(diagnostiquerMission({ ...mission, candidate: true }, { dernierPassage: il(1), workerVu: il(1) }, T0).phrase).toMatch(/^prête/);
  });
  it("le dernier balayage se dit : qui, quand, bilan", () => {
    expect(phraseDernierBalayage({ dernierPassage: il(2), workerVu: il(2), dernierBalayage: { qui: "worker", quand: il(2), statut: "OK", bilan: "examinés 3, conduits 3" } }, T0)).toBe("par le worker il y a 2 min — examinés 3, conduits 3");
    expect(phraseDernierBalayage({ dernierPassage: null, workerVu: null, dernierBalayage: null }, T0)).toContain("aucun balayage");
  });
  it("04/11 — l'interrupteur global posé : une mission vivante se dit SUSPENDUE (avec le remède), jamais « prête »", () => {
    const ex = { dernierPassage: il(1), workerVu: il(1), suspension: "Les missions d'Adam sont suspendues par la direction : … (/adam/reglages)" };
    const d = diagnostiquerMission({ ...mission, candidate: true }, ex, T0);
    expect(d.code).toBe("SUSPENDUE");
    expect(d.phrase).toContain("/adam/reglages");
    // Une mission finie reste finie, suspension ou pas.
    expect(diagnostiquerMission({ ...mission, etat: "TERMINE" }, ex, T0).code).toBe("FINIE");
  });
});
