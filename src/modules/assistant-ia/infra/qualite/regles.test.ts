import { describe, expect, it } from "vitest";
import { calendrierLisible, dernierCreneau, normaliserReglageBanc, passageDu, prochainCreneau, REGLAGE_BANC_DEFAUT } from "../../domaine/qualite/calendrier";
import { estVert, regressions, type MesuresPassage } from "../../domaine/qualite/regression";
import { choisirBaseEssai, empreinteBase, REFUS_SANS_BASE_ESSAI } from "../../domaine/qualite/base-essai";
import { autorisationChangement, lireCandidat } from "../../domaine/qualite/ab-modele";
import { agreger, lireResultatBanc } from "../../domaine/qualite/resultat";
import { estLaBaseEssaiDeclaree, refusDeBase } from "@/lib/prisma";

/** LES RÈGLES PURES DE LA QUALITÉ CONTINUE (J5 + J14, décision 0022). */

describe("le calendrier du banc (heure d'Alger)", () => {
  const hebdo = { ...REGLAGE_BANC_DEFAUT, frequence: "HEBDOMADAIRE" as const, jour: 5, heure: 3 };

  it("par défaut : chaque semaine, 1 $ par passage, actif", () => {
    expect(REGLAGE_BANC_DEFAUT).toMatchObject({ actif: true, frequence: "HEBDOMADAIRE", plafondUsd: 1 });
    expect(calendrierLisible(hebdo)).toBe("chaque vendredi à 3 h, heure d'Alger");
  });

  it("le dernier créneau échu : vendredi 3 h d'Alger = 2 h UTC", () => {
    // Le vendredi 30/10/2026 à 15 h UTC : le créneau du jour (2 h UTC) est échu.
    expect(dernierCreneau(hebdo, new Date("2026-10-30T15:00:00Z")).toISOString()).toBe("2026-10-30T02:00:00.000Z");
    // Le vendredi à 1 h UTC (2 h d'Alger) : pas encore — celui de la semaine d'avant.
    expect(dernierCreneau(hebdo, new Date("2026-10-30T01:00:00Z")).toISOString()).toBe("2026-10-23T02:00:00.000Z");
    expect(prochainCreneau(hebdo, new Date("2026-10-30T15:00:00Z")).toISOString()).toBe("2026-11-06T02:00:00.000Z");
  });

  it("dû une fois par créneau ; désactivé, jamais", () => {
    const now = new Date("2026-10-30T15:00:00Z");
    expect(passageDu(hebdo, null, now)).toBe(true);
    expect(passageDu(hebdo, new Date("2026-10-29T10:00:00Z"), now)).toBe(true);
    expect(passageDu(hebdo, new Date("2026-10-30T02:05:00Z"), now)).toBe(false);
    expect(passageDu({ ...hebdo, actif: false }, null, now)).toBe(false);
  });

  it("quotidien et mensuel", () => {
    expect(dernierCreneau({ frequence: "QUOTIDIEN", jour: 0, heure: 23 }, new Date("2026-10-30T15:00:00Z")).toISOString()).toBe("2026-10-29T22:00:00.000Z");
    expect(dernierCreneau({ frequence: "MENSUEL", jour: 15, heure: 3 }, new Date("2026-10-30T15:00:00Z")).toISOString()).toBe("2026-10-15T02:00:00.000Z");
    expect(dernierCreneau({ frequence: "MENSUEL", jour: 28, heure: 3 }, new Date("2026-10-10T15:00:00Z")).toISOString()).toBe("2026-09-28T02:00:00.000Z");
  });

  it("une saisie hors bornes est ramenée dans les bornes", () => {
    expect(normaliserReglageBanc({ frequence: "N'IMPORTE", jour: 12, heure: 40, plafondUsd: 900, actif: "on" })).toEqual({ actif: true, frequence: "HEBDOMADAIRE", jour: 6, heure: 23, plafondUsd: 20 });
    expect(normaliserReglageBanc({ frequence: "MENSUEL", jour: 0, plafondUsd: -3, actif: false })).toMatchObject({ jour: 1, plafondUsd: 1, actif: false });
  });
});

const mesures = (o: Partial<MesuresPassage> = {}): MesuresPassage => ({
  reussis: 22, total: 26, erreurs: 0, ecrituresSansCarte: 0, premierMotP50Ms: 3400, premierMotP95Ms: 8000, latenceP50Ms: 4000, latenceP95Ms: 9000,
  coutUsd: 0.47, budgetAtteint: false, scenarios: Array.from({ length: 26 }, (_, i) => ({ scenario: `s${i}`, verdict: i < 22 ? "OK" : "ÉCHEC" })), ...o,
});

describe("la régression d'un passage", () => {
  it("rien n'a reculé : vert", () => {
    expect(regressions(mesures(), mesures())).toEqual([]);
    expect(estVert(mesures(), mesures())).toBe(true);
  });

  it("réussite en baisse : le scénario perdu est nommé", () => {
    const sc = mesures().scenarios.map((s) => (s.scenario === "s3" ? { ...s, verdict: "ÉCHEC" } : s));
    const r = regressions(mesures({ reussis: 21, scenarios: sc }), mesures());
    expect(r[0]).toMatchObject({ mesure: "réussite", avant: "22", apres: "21", detail: "n'est plus OK : s3" });
  });

  it("latence ou coût +30 % : régression ; +20 % : non", () => {
    expect(regressions(mesures({ premierMotP50Ms: 4500 }), mesures()).map((r) => r.mesure)).toEqual(["latence P50"]);
    expect(regressions(mesures({ premierMotP95Ms: 9500 }), mesures())).toEqual([]);
    expect(regressions(mesures({ coutUsd: 0.62 }), mesures()).map((r) => r.mesure)).toEqual(["coût"]);
  });

  it("un passage arrêté par son plafond n'est pas une baisse de réussite, mais n'est jamais vert", () => {
    const sc = mesures().scenarios.map((s, i) => (i >= 20 ? { ...s, verdict: "NON JOUÉ" } : s));
    const p = mesures({ reussis: 20, budgetAtteint: true, scenarios: sc, coutUsd: 0.36 });
    expect(regressions(p, mesures()).map((r) => r.mesure)).toEqual([]);
    expect(estVert(p, mesures())).toBe(false);
  });

  it("une écriture sans carte, une erreur : régression même sans référence", () => {
    expect(regressions(mesures({ ecrituresSansCarte: 1, erreurs: 1 }), null).map((r) => r.mesure)).toEqual(["écriture sans carte", "erreur"]);
    expect(estVert(mesures(), null)).toBe(true);
  });
});

describe("la base d'essai", () => {
  const PROD = "postgresql://u:secret@dpg-xyz.oregon-postgres.render.com:5432/amd_internal_os";
  it("en production, sans base d'essai déclarée : refus dit", () => {
    expect(choisirBaseEssai({ production: true, baseProduction: PROD, baseEssai: "", baseBancLocale: "postgresql://amd:amd@localhost:5432/amd_bench" })).toEqual({ ok: false, raison: REFUS_SANS_BASE_ESSAI });
  });
  it("la base d'essai qui EST la production (même hôte, port, nom — autre mot de passe) : refus", () => {
    const r = choisirBaseEssai({ production: true, baseProduction: PROD, baseEssai: "postgresql://autre:pw@DPG-XYZ.oregon-postgres.render.com/amd_internal_os" });
    expect(r.ok).toBe(false);
  });
  it("une base séparée : acceptée ; hors production, la base de banc locale en tient lieu", () => {
    expect(choisirBaseEssai({ production: true, baseProduction: PROD, baseEssai: "postgresql://u:p@dpg-xyz.oregon-postgres.render.com:5432/amd_essai" }).ok).toBe(true);
    expect(choisirBaseEssai({ production: false, baseProduction: "postgresql://amd:amd@localhost:5432/amd_internal_os", baseBancLocale: "postgresql://amd:amd@localhost:5432/amd_bench" })).toEqual({ ok: true, url: "postgresql://amd:amd@localhost:5432/amd_bench" });
  });
  it("la garde du processus de banc (`prisma.ts`) : seulement la base déclarée, et d'empreinte différente de la production", () => {
    const essai = "postgresql://u:p@dpg-xyz.oregon-postgres.render.com:5432/amd_essai";
    const env = { BANC_ESSAI_DATABASE_URL: essai, BANC_EMPREINTE_PRODUCTION: empreinteBase(PROD)! } as unknown as NodeJS.ProcessEnv;
    expect(estLaBaseEssaiDeclaree(essai, env)).toBe(true);
    expect(estLaBaseEssaiDeclaree(PROD, { ...env, BANC_ESSAI_DATABASE_URL: PROD })).toBe(false);
    expect(estLaBaseEssaiDeclaree(essai, { ...env, BANC_EMPREINTE_PRODUCTION: "" })).toBe(false);
    expect(estLaBaseEssaiDeclaree(essai, { ...env, BANC_EMPREINTE_PRODUCTION: empreinteBase(essai)! })).toBe(false);
    const argv = ["node", "scripts/bench/banc-programme.ts"];
    expect(refusDeBase({ ...env, DATABASE_URL: essai } as NodeJS.ProcessEnv, argv)).toBeNull();
    expect(refusDeBase({ ...env, DATABASE_URL: PROD } as NodeJS.ProcessEnv, argv)).toMatch(/REFUS/);
  });
});

describe("le protocole A/B d'un modèle", () => {
  const c = { role: "standard" as const, modelId: "gpt-6.2-terra", effort: "low" };
  const now = new Date("2026-10-30T12:00:00Z");
  const p = (o: Record<string, unknown>) => ({ id: "p1", statut: "TERMINE", vert: true, candidat: c, finLe: new Date("2026-10-29T12:00:00Z"), ...o });
  it("permis sur un banc vert récent pour ce candidat exact", () => {
    expect(autorisationChangement(c, [p({})], now)).toEqual({ ok: true, passageId: "p1" });
  });
  it("refusé sans banc, sur un banc rouge, en cours, trop vieux, ou pour un autre effort", () => {
    expect(autorisationChangement(c, [], now).ok).toBe(false);
    expect(autorisationChangement(c, [p({ vert: false })], now)).toMatchObject({ ok: false, raison: expect.stringMatching(/pas vert/) });
    expect(autorisationChangement(c, [p({ statut: "EN_COURS", vert: null })], now)).toMatchObject({ raison: expect.stringMatching(/pas terminé/) });
    expect(autorisationChangement(c, [p({ finLe: new Date("2026-10-01T00:00:00Z") })], now)).toMatchObject({ raison: expect.stringMatching(/plus de 14 jours/) });
    expect(autorisationChangement({ ...c, effort: "high" }, [p({})], now).ok).toBe(false);
  });
  it("un candidat illisible n'en est pas un", () => {
    expect(lireCandidat({ role: "standard", modelId: "rm -rf /; echo", effort: "low" })).toBeNull();
    expect(lireCandidat({ role: "chef", modelId: "gpt-x", effort: "low" })).toBeNull();
  });
});

describe("le résultat d'un passage", () => {
  it("relu sans confiance, agrégé : réussite, centiles, écritures sans carte", () => {
    const r = lireResultatBanc({
      depenseUsd: 0.4, budgetAtteint: false,
      scenarios: [
        { scenario: "00-bonjour", verdict: "OK", ms: 2000, premierMotMs: 1800, entree: 6000, appels: 1, coutUsd: 0.01 },
        { scenario: "01", verdict: "ÉCHEC", ms: 5000, premierMotMs: 4000, motifs: ["ÉCRITURE SANS CONFIRMATION : taches 0→1"] },
        { scenario: "atelier-word", famille: "atelier", verdict: "OK", ms: 90_000 },
        { scenario: "", verdict: "OK" }, { scenario: "x", verdict: "PEUT-ÊTRE" },
      ],
    });
    expect(r.scenarios.map((s) => s.verdict)).toEqual(["OK", "ÉCHEC", "OK", "ERREUR"]);
    const m = agreger(r);
    expect(m).toMatchObject({ reussis: 2, total: 4, erreurs: 1, ecrituresSansCarte: 1, premierMotP50Ms: 4000, latenceP95Ms: 5000, jetonsEntree: 6000 });
  });
});
