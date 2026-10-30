import { describe, expect, it } from "vitest";
import { attenteDuMoteur, compilerTravail, decouperEnLots, lirePlan, type CatalogueTravail } from "@/lib/missions/travaux/plan";
import { etatTravail, motifPlafond, phraseAttente } from "@/lib/missions/travaux/regles";
import { lireAnalyse } from "@/lib/missions/travaux/consignes";
import { correspond, lireAttente } from "@/lib/missions/events/match";

const CAT: CatalogueTravail = {
  lectures: [{ nom: "lister_demandes", libelle: "Demandes" }],
  gestes: [{ nom: "relancer", libelle: "Relance", famille: "AD_PRO", libelleFamille: "Ad & Pro" }],
};

const PLAN = {
  titre: "Demandes de l'année", objectif: "Analyser, relancer, rendre compte.",
  etapes: [
    { cle: "lire", titre: "Lire", type: "LECTURE", outil: "lister_demandes" },
    { cle: "lots", titre: "Lots", type: "LOTS", lots: { etape: "lire", chemin: "items", taille: 3 } },
    { cle: "analyse", titre: "Analyse", type: "ANALYSE", consigne: "x", pourChaque: { etape: "lots" } },
    { cle: "attente", titre: "Attendre la signature", type: "ATTENTE", attente: { evenement: "BC_STATUT", entite: "BC:1", champs: { statut: "SIGNE" }, jours: 21 }, apres: ["analyse"] },
    { cle: "relance", titre: "Relancer", type: "GESTE", outil: "relancer", si: { etape: "attente", issue: "timeout" } },
    { cle: "rapport", titre: "Rapport", type: "LIVRABLE", consigne: "y", apres: ["relance"] },
  ],
};

describe("le plan d'un travail (J2) — pur", () => {
  it("lit un plan juste, en déduit les gestes à autoriser (libellé et famille de la console)", () => {
    const r = lirePlan(PLAN, CAT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.gestes).toEqual([{ nom: "relancer", libelle: "Relance", famille: "AD_PRO", libelleFamille: "Ad & Pro" }]);
    expect(r.plan.etapes.find((e) => e.cle === "relance")?.si).toEqual({ etape: "attente", issue: "TIMEOUT" });
  });

  it("refuse un geste hors du catalogue de la personne, une clé en double, un type inconnu, une attente vide", () => {
    const r = lirePlan({
      titre: "t", objectif: "o",
      etapes: [
        { cle: "a", titre: "A", type: "GESTE", outil: "virer_argent" },
        { cle: "a", titre: "A bis", type: "LECTURE", outil: "lister_demandes" },
        { cle: "b", titre: "B", type: "MAGIE" },
        { cle: "c", titre: "C", type: "ATTENTE", attente: {} },
        { cle: "d", titre: "D", type: "LIVRABLE", consigne: "x" },
      ],
    }, CAT);
    expect(r.ok).toBe(false);
    const f = r.ok ? "" : r.fautes.join("\n");
    expect(f).toMatch(/virer_argent/);
    expect(f).toMatch(/clé en double/);
    expect(f).toMatch(/MAGIE/);
    expect(f).toMatch(/evenement/);
  });

  it("compile en étapes du moteur : capacités préfixées, éventail sur les lots, condition, clé d'idempotence sur le geste seul", () => {
    const r = lirePlan(PLAN, CAT);
    if (!r.ok) throw new Error("plan");
    const t0 = new Date("2026-11-01T08:00:00Z");
    const c = compilerTravail(r.plan, t0);
    const par = new Map(c.steps.map((s) => [s.key, s]));
    expect(par.get("lire")).toMatchObject({ nodeType: "CAPABILITY", capability: "lecture:lister_demandes", needsIdempotencyKey: false });
    expect(par.get("lots")).toMatchObject({ capability: "travail:lots", input: { liste: "{{lire.items}}", taille: 5 }, dependsOn: ["lire"] });
    expect(par.get("analyse")).toMatchObject({ nodeType: "WORKER", forEach: { from: "lots", path: "lots", as: "lot" }, input: { consigne: "x", lot: "{{lot}}" } });
    expect(par.get("relance")).toMatchObject({ capability: "geste:relancer", needsIdempotencyKey: true, spec: { when: { step: "attente", outcome: "TIMEOUT" } }, dependsOn: ["attente"] });
    expect(par.get("rapport")).toMatchObject({ nodeType: "ARTIFACT" });
    // L'échéance part de l'APPROBATION (t0), et la charge utile devient un prédicat.
    expect(par.get("attente")?.waitFor).toEqual({
      anyOf: [{ event: "BC_STATUT", entity: "BC:1", payload: { statut: "SIGNE" } }, { until: "2026-11-22T08:00:00.000Z" }],
    });
    expect(c.acceptance.length).toBeGreaterThan(0);
  });

  it("une minuterie seule devient une échéance", () => {
    expect(attenteDuMoteur({ minutes: 90 }, new Date("2026-11-01T08:00:00Z"))).toEqual({ until: "2026-11-01T09:30:00.000Z" });
  });

  it("découpe en lots bornés : la taille s'élargit pour ne jamais dépasser 50 lots", () => {
    const petit = decouperEnLots(Array.from({ length: 12 }, (_, i) => i), 5);
    expect(petit.ok && petit.lots.map((l) => l.elements.length)).toEqual([5, 5, 2]);
    expect(petit.ok && petit.lots[0]!.id).toBe("lot-01");
    const gros = decouperEnLots(Array.from({ length: 4000 }, (_, i) => i), 10);
    expect(gros.ok && gros.lots.length).toBe(50);
    expect(decouperEnLots("pas une liste", 10).ok).toBe(false);
    expect(decouperEnLots(Array.from({ length: 6000 }), 10).ok).toBe(false);
  });

  it("l'état affiché : le plafond est une pause à part, l'attente se dit avec sa durée", () => {
    expect(etatTravail("PAUSED", "BUDGET_HOLD — plafond")).toBe("BUDGET_HOLD");
    expect(etatTravail("PAUSED", "à la demande")).toBe("EN_PAUSE");
    expect(etatTravail("AWAITING_APPROVAL", null)).toBe("A_APPROUVER");
    expect(etatTravail("WAITING_EVENT", null)).toBe("EN_ATTENTE");
    const depuis = new Date("2026-11-01T08:00:00Z");
    expect(phraseAttente("Attendre la signature du BC", depuis, new Date("2026-11-03T08:00:00Z"))).toBe("attend « la signature du BC » depuis 2 jours");
  });

  it("le motif de plafond : le travail d'abord, puis le mois, puis les jetons du jour", () => {
    const base = { coutTravailUsd: 1, plafondTravailUsd: 20, depenseMoisUsd: 1, plafondMensuelUsd: 50, jourAtteint: false };
    expect(motifPlafond(base)).toBeNull();
    expect(motifPlafond({ ...base, coutTravailUsd: 20 })).toMatch(/plafond du travail/);
    expect(motifPlafond({ ...base, depenseMoisUsd: 50 })).toMatch(/mensuel/);
    expect(motifPlafond({ ...base, jourAtteint: true })).toMatch(/du jour/);
  });

  it("lit la réponse d'une analyse : le JSON demandé, ou le texte entier", () => {
    expect(lireAnalyse('```json\n{"resultat":"r","trouvailles":["t"],"notes":[]}\n```')).toEqual({ resultat: "r", trouvailles: ["t"], notes: [] });
    expect(lireAnalyse("du texte libre")).toEqual({ resultat: "du texte libre", trouvailles: [], notes: [] });
  });
});

describe("le prédicat sur la charge utile d'une attente (J2, `events/match.ts`)", () => {
  const attente = lireAttente({ event: "BC_STATUT", entity: "BC:1", payload: { statut: "SIGNE", "bc.montant": 100, bad: { x: 1 } } })!;
  it("est relu sans confiance : seuls les scalaires restent", () => {
    expect(attente.payload).toEqual({ statut: "SIGNE", "bc.montant": 100 });
  });
  it("chaque champ doit valoir exactement la valeur ; un champ absent ne règle rien", () => {
    const fait = (payload: unknown) => ({ type: "BC_STATUT", relatedRefs: ["BC:1"], payload });
    expect(correspond(attente, fait({ statut: " signe ", bc: { montant: 100 } }))).toBe(true);
    expect(correspond(attente, fait({ statut: "TRANSMIS", bc: { montant: 100 } }))).toBe(false);
    expect(correspond(attente, fait({ statut: "SIGNE" }))).toBe(false);
  });
  it("une attente sans prédicat garde son comportement d'avant", () => {
    expect(lireAttente({ event: "X" })).not.toHaveProperty("payload");
  });
});
