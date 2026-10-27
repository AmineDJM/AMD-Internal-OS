import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { etapeFixeLArgent, issueTerminaleSponsoring } from "./issue-sponsoring";
import { defaultDefinition, ETAPE_PRE_VALIDATION_SPONSORING, ETAPE_PREVALIDATION } from "./defaults";
import { WORKFLOW_CATEGORIES } from "./types";
import { SLUG_DIRECTION, SLUG_MARKETING } from "./parcours";
import { quiCloture } from "@/lib/ad-pro/cloture-sponsoring";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA TENUE, OU L'ARGENT — ce que décide l'étape qui conclut un sponsoring (§118.151).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
describe("l'issue d'un sponsoring se lit sur la CONFIGURATION de l'étape qui conclut", () => {
  it("une étape qui ne fixe aucun argent pré-valide la TENUE", () => {
    expect(issueTerminaleSponsoring({ requireAmount: false, powers: ["APPROVE", "REJECT", "COMMENT"] })).toBe("PRE_VALIDATED");
  });

  it("une étape qui EXIGE un montant accorde de l'argent — le circuit remodelé garde son comportement", () => {
    expect(issueTerminaleSponsoring({ requireAmount: true, powers: ["APPROVE", "REJECT"] })).toBe("APPROVED");
  });

  it("le seul POUVOIR de fixer un montant suffit — un Super Admin qui l'a laissé garde l'accord à montant", () => {
    // Ce qui le ferait tomber : ne lire que `requireAmount`. Une étape « Fixer un montant »
    // facultatif accorde quand même de l'argent quand on s'en sert.
    expect(etapeFixeLArgent({ requireAmount: false, powers: ["APPROVE", "SET_AMOUNT"] })).toBe(true);
    expect(issueTerminaleSponsoring({ requireAmount: false, powers: ["APPROVE", "SET_AMOUNT"] })).toBe("APPROVED");
  });
});

describe("la GRAINE : le sponsoring pré-valide la tenue, les trois autres natures PRÉVALIDENT aussi (27/10/2026)", () => {
  it("l'étape de la Direction Marketing du sponsoring est la pré-validation : sans montant, sans ordre global, avec la déclaration", () => {
    const etape = defaultDefinition("SPONSORING").steps.find((e) => e.slug === SLUG_MARKETING)!;
    expect(etape).toBe(ETAPE_PRE_VALIDATION_SPONSORING);
    expect(issueTerminaleSponsoring({ requireAmount: etape.requireAmount ?? false, powers: etape.powers })).toBe("PRE_VALIDATED");
    expect(etape.emitExpenseOrder, "un ordre global en plus des postes paierait la dépense deux fois").toBe(false);
    expect(etape.emitDeclaration, "l'événement se déclare AVANT d'avoir lieu — la clôture vient après").toBe(true);
    expect(etape.requireCategory).toBe(false);
  });

  it("les TROIS autres catégories PRÉVALIDENT elles aussi : sans montant, sans catégorie, sans ordre global, avec la déclaration", () => {
    // « Pareil pour les prises en charge, les événements et les autres » (Direction, 27/10/2026).
    // Ce qui le ferait tomber : garder la décision à montant sur les congrès et les événements —
    // un ordre de dépense global partirait AVANT les postes, et l'argent serait payé deux fois.
    for (const c of WORKFLOW_CATEGORIES.filter((x) => x !== "SPONSORING")) {
      const etape = defaultDefinition(c).steps.find((e) => e.slug === SLUG_MARKETING)!;
      expect(etape, c).toBe(ETAPE_PREVALIDATION);
      expect(etape.title, c).toBe("Prévalidation (Direction Marketing)");
      expect(issueTerminaleSponsoring({ requireAmount: etape.requireAmount ?? false, powers: etape.powers }), c).toBe("PRE_VALIDATED");
      expect(etape.requireAmount, c).toBe(false);
      expect(etape.requireCategory, c).toBe(false);
      expect(etape.emitExpenseOrder, c).toBe(false);
      expect(etape.emitDeclaration, c).toBe(true);
      expect(etape.confidential, c).toBe(false);
    }
  });

  it("le sponsoring GARDE sa propre graine — son titre dit « la tenue », pas « la demande »", () => {
    // Ses textes sont écrits en base par `20261129090000_sponsoring_pre_validation_postes_cloture` ;
    // les remplacer par ceux des trois autres ferait deux vérités pour la même étape.
    expect(ETAPE_PRE_VALIDATION_SPONSORING).not.toBe(ETAPE_PREVALIDATION);
    expect(ETAPE_PRE_VALIDATION_SPONSORING.powers).toEqual(ETAPE_PREVALIDATION.powers);
  });

  it("le slug ne change pas : parcours, bornes, caviardage et instances en vol le désignent par lui", () => {
    expect(ETAPE_PRE_VALIDATION_SPONSORING.slug).toBe(SLUG_MARKETING);
    expect(defaultDefinition("SPONSORING").steps.map((e) => e.slug)).toEqual(defaultDefinition("EVENTS").steps.map((e) => e.slug));
  });
});

describe("la MIGRATION écrit sur l'étape déjà en base EXACTEMENT ce que la graine sème ailleurs", () => {
  /*
   * Deux sources pour la même étape — la graine (bases neuves) et la migration (production) —
   * feraient deux circuits sous le même nom (§118.5). Ce banc lit le TEXTE de la migration et le
   * compare à la constante : un libellé retouché d'un seul côté le fait tomber.
   */
  const sql = fs.readFileSync(
    path.join(process.cwd(), "prisma/migrations/20261129090000_sponsoring_pre_validation_postes_cloture/migration.sql"),
    "utf8",
  );
  const lit = (champ: string): string => {
    const m = sql.match(new RegExp(`"${champ}"\\s*=\\s*'((?:[^']|'')*)'`));
    return m ? m[1].replace(/''/g, "'") : "";
  };

  it("le titre et la description sont identiques", () => {
    expect(lit("title")).toBe(ETAPE_PRE_VALIDATION_SPONSORING.title);
    expect(lit("description")).toBe(ETAPE_PRE_VALIDATION_SPONSORING.description);
  });

  it("les pouvoirs et les quatre drapeaux sont identiques", () => {
    const pouvoirs = sql.match(/"powers"\s*=\s*ARRAY\[([^\]]*)\]/)?.[1] ?? "";
    expect(pouvoirs.split(",").map((p) => p.trim().replace(/'/g, ""))).toEqual(ETAPE_PRE_VALIDATION_SPONSORING.powers);
    const drapeau = (c: string) => sql.match(new RegExp(`"${c}"\\s*=\\s*(TRUE|FALSE)`))?.[1];
    expect(drapeau("requireAmount")).toBe(String(ETAPE_PRE_VALIDATION_SPONSORING.requireAmount).toUpperCase());
    expect(drapeau("requireCategory")).toBe(String(ETAPE_PRE_VALIDATION_SPONSORING.requireCategory).toUpperCase());
    expect(drapeau("emitExpenseOrder")).toBe(String(ETAPE_PRE_VALIDATION_SPONSORING.emitExpenseOrder).toUpperCase());
    expect(drapeau("emitDeclaration")).toBe(String(ETAPE_PRE_VALIDATION_SPONSORING.emitDeclaration).toUpperCase());
  });

  it("la migration n'agit que sur l'étape `marketing` du SPONSORING encore à sa graine d'avant", () => {
    // Un Super Admin qui l'a remodelée a pris une décision ; ce n'est pas une migration qui la défait.
    expect(sql).toMatch(/d\."category"\s*=\s*'SPONSORING'/);
    expect(sql).toMatch(/s\."slug"\s*=\s*'marketing'/);
    expect(sql).toMatch(/s\."title"\s*=\s*'Décision et budget \(Direction Marketing\)'/);
  });
});

describe("la MIGRATION du 27/10/2026 écrit sur l'étape `marketing` des PEC et événements EXACTEMENT la graine de prévalidation", () => {
  /*
   * Même garde que ci-dessus, pour `20270131130000_adpro_circuit_prevalidation` : la graine ne
   * sème que là où rien n'existe, c'est la migration qui fait passer la production à la règle.
   * On lit l'instruction qui vise `marketing`, commentaires retirés (§118.79d).
   */
  const sql = fs.readFileSync(
    path.join(process.cwd(), "prisma/migrations/20270131130000_adpro_circuit_prevalidation/migration.sql"),
    "utf8",
  ).replace(/--[^\n]*/g, "");
  // On découpe sur le `;` qui FINIT une ligne : la description en contient un en son milieu.
  const instruction = sql.split(/;\s*$/m).map((i) => i.trim()).find((i) => i.includes(`s."slug" = 'marketing'`)) ?? "";
  const lit = (champ: string): string => {
    const m = instruction.match(new RegExp(`"${champ}"\\s*=\\s*'((?:[^']|'')*)'`));
    return m ? m[1].replace(/''/g, "'") : "";
  };

  it("le titre, la description, les pouvoirs et les drapeaux sont ceux de la graine", () => {
    expect(instruction, "une instruction vise l'étape `marketing`").not.toBe("");
    expect(lit("title")).toBe(ETAPE_PREVALIDATION.title);
    expect(lit("description")).toBe(ETAPE_PREVALIDATION.description);
    const pouvoirs = instruction.match(/"powers"\s*=\s*ARRAY\[([^\]]*)\]/)?.[1] ?? "";
    expect(pouvoirs.split(",").map((p) => p.trim().replace(/'/g, ""))).toEqual(ETAPE_PREVALIDATION.powers);
    const drapeau = (c: string) => instruction.match(new RegExp(`"${c}"\\s*=\\s*(TRUE|FALSE)`))?.[1];
    for (const c of ["requireAmount", "requireCategory", "emitExpenseOrder", "emitDeclaration", "confidential"] as const) {
      expect(drapeau(c), c).toBe(String(ETAPE_PREVALIDATION[c]).toUpperCase());
    }
  });

  it("elle épargne le sponsoring (sa graine à lui) et toute étape remodelée", () => {
    expect(instruction).toMatch(/d\."category" IN \('CONGRESS_NATIONAL','CONGRESS_INTERNATIONAL','EVENTS'\)/);
    expect(instruction).not.toMatch(/'SPONSORING'/);
    expect(instruction).toMatch(/s\."title" = 'Décision et budget \(Direction Marketing\)'/);
  });
});

describe("qui clôture : la borne `final` est celle de la Direction des opérations", () => {
  it("le littéral du module pur reste égal au slug du parcours", () => {
    // `cloture-sponsoring.ts` écrit « final » en dur pour rester pur ; renommer le slug sans lui
    // ferait clôturer par la Direction Marketing une demande qu'elle a elle-même déposée.
    expect(quiCloture(SLUG_DIRECTION)).toBe("DIRECTION");
    expect(quiCloture(null)).toBe("DIRECTION_MARKETING");
    expect(quiCloture(SLUG_MARKETING)).toBe("DIRECTION_MARKETING");
  });
});
