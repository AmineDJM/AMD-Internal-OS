import { describe, expect, it } from "vitest";
import { argentEffectif, porteUnPouvoirDArgent, type ConfigArgent } from "./pouvoirs-argent";
import { defaultDefinition } from "./defaults";
import { etapesNonAtteintes, parcoursAdPro } from "./parcours";
import { WORKFLOW_CATEGORIES, type StepInput } from "./types";

/**
 * Les pouvoirs d'argent de l'étape qui CONCLUT une route coupée — la règle seule, sans base.
 * Le comportement de bout en bout (création, écran, moteur, pièce financière) est éprouvé par
 * `argent-route-coupee-flow.test.ts`.
 */

const etape = (powers: string[], requireAmount = false, requireCategory = false): ConfigArgent => ({ powers, requireAmount, requireCategory });
const DECISION = etape(["APPROVE", "REJECT", "SET_AMOUNT", "SET_CATEGORY", "COMMENT"], true, true);
const VALIDATION = etape(["APPROVE", "REJECT", "COMMENT"]);
const TENUE = etape(["APPROVE", "REJECT", "COMMENT"]);

describe("argentEffectif — ce que l'étape qui conclut décide de l'argent", () => {
  it("l'étape qui CONCLUT une route coupée hérite le montant, la catégorie ET leurs exigences", () => {
    const e = argentEffectif(VALIDATION, true, [DECISION]);
    expect(e.powers).toEqual(expect.arrayContaining(["SET_AMOUNT", "SET_CATEGORY"]));
    expect([e.requireAmount, e.requireCategory]).toEqual([true, true]);
    expect(e.powers, "ses propres pouvoirs restent").toEqual(expect.arrayContaining(["APPROVE", "REJECT", "COMMENT"]));
  });

  it("une étape qui NE conclut PAS n'hérite rien — elle propose, elle ne décide pas l'argent", () => {
    expect(argentEffectif(VALIDATION, false, [DECISION])).toBe(VALIDATION);
  });

  it("une étape configurée À LA MAIN garde sa configuration — rien n'y est fusionné", () => {
    // Le Super Admin lui a donné « fixer un montant » sans l'exiger : l'exigence de l'étape coupée ne
    // s'y ajoute pas. Une seule de ses quatre clés suffit à dire « configurée ».
    for (const propre of [etape(["APPROVE", "SET_AMOUNT"]), etape(["APPROVE", "SET_CATEGORY"]), etape(["APPROVE"], true), etape(["APPROVE"], false, true)]) {
      expect(argentEffectif(propre, true, [DECISION]), JSON.stringify(propre)).toBe(propre);
    }
  });

  it("RIEN À HÉRITER quand l'étape coupée ne fixe aucun argent — le sponsoring par défaut (§118.151)", () => {
    expect(argentEffectif(VALIDATION, true, [TENUE])).toBe(VALIDATION);
    expect(argentEffectif(VALIDATION, true, [])).toBe(VALIDATION);
  });

  it("l'exigence suit sa source : un pouvoir hérité sans exigence reste facultatif", () => {
    const e = argentEffectif(VALIDATION, true, [etape(["APPROVE", "SET_AMOUNT"])]);
    expect(e.powers).toContain("SET_AMOUNT");
    expect(e.powers).not.toContain("SET_CATEGORY");
    expect([e.requireAmount, e.requireCategory]).toEqual([false, false]);
  });

  it("porteUnPouvoirDArgent lit les quatre faits, et eux seuls", () => {
    expect(porteUnPouvoirDArgent(VALIDATION)).toBe(false);
    expect(porteUnPouvoirDArgent(etape(["ASSIGN", "COMMENT"]))).toBe(false);
    expect(porteUnPouvoirDArgent(etape(["SET_CATEGORY"]))).toBe(true);
    expect(porteUnPouvoirDArgent(etape([], true))).toBe(true);
  });
});

describe("Sur le circuit PAR DÉFAUT, aucune route n'hérite — la Direction Marketing prévalide, toujours (27/10/2026)", () => {
  const config = (s: StepInput): ConfigArgent => ({ powers: s.powers, requireAmount: s.requireAmount ?? false, requireCategory: s.requireCategory ?? false });

  it("chaque catégorie × chaque demandeur : la route conclut sur la prévalidation, et rien n'y est hérité", () => {
    // Le garde-fou STRUCTUREL de la règle du 27/10/2026 : plus aucune étape de la graine ne fixe
    // d'argent (les postes portent la dépense). Ce qui le ferait tomber : une route coupée qui
    // ferait hériter un montant à l'étape qui conclut — l'argent se déciderait de nouveau sur la
    // demande entière, avant les postes et sans la porte du DG sur le total.
    const demandeurs = [
      { nom: "délégué (KAM)", rang: 0, kam: true, directionMarketing: false },
      { nom: "ordinaire", rang: 0, kam: false, directionMarketing: false },
      { nom: "National Sales", rang: 1, kam: false, directionMarketing: false },
      { nom: "Manager Promotion médicale", rang: 2, kam: false, directionMarketing: false },
      { nom: "Direction Marketing", rang: 2, kam: false, directionMarketing: true },
      { nom: "Direction", rang: 3, kam: false, directionMarketing: false },
    ];
    for (const categorie of WORKFLOW_CATEGORIES) {
      const steps = defaultDefinition(categorie).steps;
      const slugs = steps.map((s) => s.slug);
      for (const etape of steps) expect(porteUnPouvoirDArgent(config(etape)), `${categorie} · ${etape.slug}`).toBe(false);
      for (const d of demandeurs) {
        const p = parcoursAdPro({ rang: d.rang, kam: d.kam, directionMarketing: d.directionMarketing, categorie });
        const hors = etapesNonAtteintes(slugs, p.decision, p.ignorees);
        const route = slugs.filter((s) => !hors.includes(s));
        const conclut = steps.find((s) => s.slug === route[route.length - 1])!;
        expect(conclut.slug, `${categorie} · ${d.nom}`).toBe("marketing");
        const avant = config(conclut);
        const apres = argentEffectif(avant, true, hors.map((slug) => config(steps.find((s) => s.slug === slug)!)));
        expect(apres, `${categorie} · ${d.nom} : rien n'est hérité`).toBe(avant);
      }
    }
  });
});
