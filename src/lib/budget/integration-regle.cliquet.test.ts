import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CLIQUET DE LA RÈGLE D'INTÉGRATION — aucun lecteur de budget ne l'ignore (Ad & Pro 2026, Direction 10/2026).
 *
 * Après une intégration, une enveloppe ne compte que (a) ses postes historiques, (b) ce qui naît après, (c) jamais deux
 * fois la même dépense (`budget/integration-regle.ts`). Un lecteur qui additionnerait les écritures ou les lignes d'une
 * enveloppe SANS passer par `queries/budget-integration.ts` compterait deux fois le webinaire SAI (53 350 payés + 53 550
 * du fichier) — et l'écran, l'Excel ou le pré-remplissage diraient trois totaux différents.
 *
 * Le test lit la SOURCE : tout fichier qui agrège la consommation d'une catégorie (écritures, lignes budgétaires, postes
 * rangés, engagements bruts) est soit un LECTEUR qui importe la règle, soit EXEMPTÉ avec sa raison. Un lecteur nouveau
 * fait échouer le test en le nommant.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const RACINE = process.cwd();
const SRC = join(RACINE, "src");
const REGLE = 'from "@/lib/queries/budget-integration"';

/** Les lecteurs de budget — chacun importe la règle (et l'applique : chaque cas a son test de flux). */
const LECTEURS: Record<string, string> = {
  "src/lib/queries/budget.ts": "vue d'ensemble (getBudgetOverview) et total des enveloppes (getEnvelopesGrandTotal) — lus par tous les écrans, l'Excel, le cockpit, l'assistant",
  "src/lib/queries/budget-sources.ts": "l'engagé (engagementsDesCategories) — y compris l'atterrissage automatique des ordres sans catégorie (pickAutoCategory)",
  "src/lib/queries/budget-marketing-depenses.ts": "Budget Marketing › Dépenses (les postes rangés ; un poste historique s'y lit payé)",
  "src/lib/queries/budget-marketing.ts": "Budget Marketing › Demandes Ad & Pro",
  "src/lib/queries/budget-marketing-rapport.ts": "les faits de la vue d'ensemble Budget Marketing, de l'Excel, du PDF, du CSV et des diapositives",
  "src/lib/budget-campagne/prefill.ts": "le réalisé qui pré-remplit les campagnes budgétaires",
  "src/lib/adventum/risks.ts": "les risques budgétaires d'Adventum Brain",
};

/** Ce qui lit des catégories sans être un total d'enveloppe Ad & Pro — et pourquoi. */
const HORS_REGLE: Record<string, string> = {
  "src/lib/queries/budget-integration.ts": "la règle elle-même",
  "src/lib/budget-marketing/integration-serveur.ts": "l'assistant d'intégration (aperçu par la règle, sur un lot simulé)",
  "src/lib/queries/budget-regulatory.ts": "les BV des enveloppes REGULATORY — un lot ne se pose que sur une enveloppe MARKETING (`ecrireLot`)",
  "src/lib/missions-equipe/imputation-serveur.ts": "les frais de mission de l'équipe Adventum — Operations & Sales seulement, jamais Ad & Pro",
  "src/lib/queries/budget-general-means.ts": "les achats des moyens généraux — dépenses des départements, jamais une dépense Ad & Pro",
  "src/lib/assistant/ops/impl-finance-budget.ts": "une RECHERCHE par libellé (l'assistant retrouve une ligne), pas un total",
};

/** Les appelants de `pickAutoCategory` — l'attribution automatique d'un ordre à la première catégorie de l'enveloppe. */
const AUTO_CATEGORIE: Record<string, string> = {
  "src/lib/budget/auto-category.ts": "la règle pure",
  "src/lib/queries/budget-sources.ts": "LECTEUR : l'engagé des ordres sans catégorie — jugé par la règle juste après (engagementsDesCategories)",
  "src/lib/finance/settle-budget.ts": "ÉCRIVAIN au règlement : l'écriture née porte sa catégorie ; la règle la juge à la lecture, datée par son ordre",
  "src/lib/actions/expense-actions.ts": "ÉCRIVAIN au règlement (même chemin que settle-budget)",
  "src/app/(app)/finances/paiements-a-faire/page.tsx": "AFFICHAGE de la catégorie prévue d'un ordre — pas un total",
};

function fichiers(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...fichiers(p));
    else if (/\.(ts|tsx)$/.test(e) && !/\.test\.tsx?$/.test(e)) out.push(p);
  }
  return out;
}

const LIT_UNE_CONSOMMATION = [
  /budgetExpenseLine\.(groupBy|findMany|aggregate)\(/,
  /financeTransaction\.(groupBy|aggregate|findMany)\(\{[^]*?budgetCategoryId: \{ in/,
  /adProItem\.findMany\(\{[^)]*budgetCategoryId: \{ in/,
  /engagementsBruts\(/,
];

describe("la règle d'intégration — aucun lecteur de budget ne l'ignore", () => {
  const tous = fichiers(SRC).map((f) => ({ chemin: relative(RACINE, f).split("\\").join("/"), source: readFileSync(f, "utf8") }));

  it("chaque lecteur nommé importe la règle", () => {
    for (const [chemin, role] of Object.entries(LECTEURS)) {
      const f = tous.find((x) => x.chemin === chemin);
      expect(f, `${chemin} (${role}) a disparu : retirez-le de la liste, ou corrigez le chemin`).toBeDefined();
      expect(f!.source.includes(REGLE), `${chemin} — ${role} — lit le budget SANS la règle d'intégration (\`queries/budget-integration.ts\`)`).toBe(true);
    }
  });

  it("aucun nouveau lecteur n'échappe à la règle", () => {
    const fautifs = tous
      .filter((f) => LIT_UNE_CONSOMMATION.some((re) => re.test(f.source)))
      .map((f) => f.chemin)
      .filter((c) => !(c in LECTEURS) && !(c in HORS_REGLE));
    expect(fautifs, `Ces fichiers agrègent la consommation d'une catégorie sans être classés : faites-les passer par \`queries/budget-integration.ts\` (et ajoutez-les à LECTEURS), ou exemptez-les avec leur raison.`).toEqual([]);
  });

  it("l'engagé applique la règle après les engagements bruts", () => {
    const src = tous.find((f) => f.chemin === "src/lib/queries/budget-sources.ts")!.source;
    const corps = src.slice(src.indexOf("export async function engagementsDesCategories"));
    expect(corps).toMatch(/engagementsBruts\(/);
    expect(corps).toMatch(/jugerEngagements\(/);
  });

  it("l'attribution automatique (pickAutoCategory) n'a que des appelants classés", () => {
    const appelants = tous.filter((f) => /\bpickAutoCategory\b/.test(f.source)).map((f) => f.chemin).sort();
    expect(appelants).toEqual(Object.keys(AUTO_CATEGORIE).sort());
  });

  it("les exports lisent la vue d'ensemble, jamais la base", () => {
    const exp = tous.find((f) => f.chemin === "src/lib/budget-export.ts")!.source;
    expect(exp).not.toMatch(/@\/lib\/prisma/);
    for (const route of ["src/app/api/budgets/export/route.ts", "src/app/api/budgets/marketing/export/route.ts"]) {
      const r = tous.find((f) => f.chemin === route)!.source;
      expect(r, route).toMatch(/getBudgetOverview/);
      expect(r, route).not.toMatch(/financeTransaction\.|budgetExpenseLine\./);
    }
  });
});
