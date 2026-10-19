import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE PÉRIMÈTRE D'UNE LISTE A DEUX LECTEURS — L'ÉCRAN ET LA RECHERCHE — ET UN SEUL AUTEUR.
 *
 * La recherche globale composait ses propres filtres à côté de ceux des écrans ; quinze familles
 * sur vingt-trois laissaient passer les lignes des autres sociétés (§118.177). Ce banc tient la
 * réparation par ses POINTS D'APPEL (§118.49) — vérifier le corps d'une clause ne dirait rien
 * d'un écran qui ne l'appellerait plus :
 *
 *   1. chaque clause est appelée par l'écran (ou le chargeur) de sa liste ET par la recherche ;
 *   2. la recherche ne construit plus AUCUNE portée elle-même — ni entité, ni portée de module ;
 *   3. le cookie d'entité n'est jamais lu comme une autorisation : hors de `company.ts` (qui le
 *      VALIDE) et de la résolution CTD (qui le valide aussi), il ne sert qu'à NOMMER l'entité
 *      affichée.
 *
 * La source est lue SANS ses commentaires : quatre fois dans ce dépôt, un cliquet s'est accroché à
 * la prose qui le décrivait (§118.79d, §118.88, §118.112b, §118.138).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const RACINE = process.cwd();
const lire = (chemin: string) => readFileSync(join(RACINE, chemin), "utf8");
/** Le code sans ses commentaires — blocs et lignes. Les chaînes ne contiennent pas « // » ici. */
const code = (chemin: string) => lire(chemin).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

const RECHERCHE = "src/lib/queries/search.ts";

/**
 * Chaque clause et les fichiers qui DOIVENT l'appeler. La table est ici, côté test : le FAIT
 * vérifié est la source des écrans. Une clause sans écran déclaré ne passerait pas la ligne 2 du
 * premier test (« toute clause appelée par la recherche est déclarée »).
 */
const CLAUSES: { fonction: string; ecrans: string[] }[] = [
  { fonction: "clauseSponsoringsVisibles", ecrans: ["src/app/(app)/sponsoring/page.tsx"] },
  { fonction: "clauseEcrituresVisibles", ecrans: ["src/lib/queries/finance.ts", "src/lib/queries/compta.ts"] },
  { fonction: "clauseSalariesVisibles", ecrans: ["src/lib/queries/hr.ts"] },
  { fonction: "clauseVentesVisibles", ecrans: ["src/app/(app)/sales/historique/page.tsx"] },
  { fonction: "clauseCommandesLogistiqueVisibles", ecrans: ["src/app/(app)/logistics/page.tsx"] },
  { fonction: "clauseDemandesSecretariatVisibles", ecrans: ["src/lib/queries/admin-requests.ts"] },
  { fonction: "clauseCongresInternationauxVisibles", ecrans: ["src/lib/queries/congress.ts"] },
  { fonction: "clauseCongresNationauxVisibles", ecrans: ["src/lib/queries/congress.ts"] },
  { fonction: "clauseEvenementsVisibles", ecrans: ["src/lib/queries/events.ts"] },
  { fonction: "clauseMarchesPchVisibles", ecrans: ["src/lib/queries/pch.ts"] },
  // Les bons de commande PCH n'ont pas d'écran : ils héritent de la clause des marchés, qui l'appelle.
  { fonction: "clauseBonsDeCommandePchVisibles", ecrans: [] },
  { fonction: "clauseCourriersVisibles", ecrans: ["src/app/(app)/courriers/page.tsx"] },
  { fonction: "perimetreLegal", ecrans: ["src/app/(app)/legal/page.tsx"] },
  // La messagerie charge ses listes par les adhésions (`getConversationSummaries`) : la règle
  // (membre ACTIF) y est écrite en clair ; la clause la rend pour qui cherche par le contenu.
  { fonction: "clauseConversationsVisibles", ecrans: [] },
  { fonction: "clauseMessagesVisibles", ecrans: [] },
  { fonction: "regulatoryVisibleWhere", ecrans: ["src/lib/queries/regulatory-rows.ts"] },
  { fonction: "accessibleDocumentWhere", ecrans: ["src/app/(app)/documents/page.tsx"] },
  { fonction: "clausePraticiensVisibles", ecrans: ["src/app/api/medical/annuaire/export/route.ts"] },
  { fonction: "clauseDirectivesVisibles", ecrans: ["src/lib/queries/directives.ts"] },
  { fonction: "clauseTachesVisibles", ecrans: [] },
  { fonction: "resolveRegCompanyIdFor", ecrans: ["src/app/(app)/regulatory/enregistrement/analyse/page.tsx"] },
  { fonction: "scopeBusinessDevelopment", ecrans: ["src/app/(app)/business-development/opportunites/page.tsx"] },
];

describe("Recherche globale — chaque famille lit la clause de SON écran (§118.177)", () => {
  it("chaque clause est appelée par son écran ET par la recherche", () => {
    const recherche = code(RECHERCHE);
    const manquants: string[] = [];
    for (const { fonction, ecrans } of CLAUSES) {
      if (!new RegExp(`\\b${fonction}\\(`).test(recherche)) manquants.push(`${RECHERCHE} n'appelle pas ${fonction}`);
      for (const e of ecrans) {
        if (!new RegExp(`\\b${fonction}\\(`).test(code(e))) manquants.push(`${e} n'appelle pas ${fonction}`);
      }
    }
    expect(manquants, manquants.join("\n")).toEqual([]);
  });

  it("toute clause que la recherche appelle est déclarée ici — une famille ajoutée demain l'est aussi", () => {
    const appelees = [...code(RECHERCHE).matchAll(/\b(clause[A-Z]\w*|perimetre[A-Z]\w*)\(/g)].map((m) => m[1]);
    const declarees = new Set(CLAUSES.map((c) => c.fonction));
    const inconnues = [...new Set(appelees)].filter((f) => !declarees.has(f));
    expect(inconnues, `clauses appelées par la recherche sans écran déclaré : ${inconnues.join(", ")}`).toEqual([]);
    // Le plancher : sans lui, un parcours cassé (aucune clause trouvée) passerait au vert.
    expect(new Set(appelees).size).toBeGreaterThanOrEqual(18);
  });

  it("la recherche ne construit AUCUNE portée elle-même", () => {
    const recherche = code(RECHERCHE);
    // L'entité : jamais `platformScope` ni `companyScopedWhere` en direct.
    expect(recherche).not.toMatch(/\bplatformScope\(/);
    expect(recherche).not.toMatch(/\bcompanyScopedWhere\(/);
    // La portée par ligne des modules : chacune passe par la clause de son écran. La seule
    // exception est Business Development, dont l'écran appelle `scopeBusinessDevelopment` tel quel.
    const portees = [...recherche.matchAll(/\b(scope[A-Z]\w*)\(/g)].map((m) => m[1]).filter((f) => f !== "scopeBusinessDevelopment");
    expect(portees, `portées recomposées dans la recherche : ${portees.join(", ")}`).toEqual([]);
    // Le verrou de lecture des tâches lit le rôle PRINCIPAL, comme la fiche (`canSee`).
    expect(recherche).toMatch(/clauseTachesVisibles\(\s*user\.id\s*,\s*hasGlobalView\(\s*user\.role\s*\)\s*\)/);
  });

  it("les clauses composent en `AND` — aucune n'étale une portée de module (§118.133)", () => {
    const src = code("src/lib/queries/visibilite-listes.ts") + code("src/lib/queries/regulatory-rows.ts");
    expect(src).not.toMatch(/\.\.\.\s*scope[A-Z]\w*\(/);
  });
});

describe("La gamme Regulatory ne se recompose pas à côté de la clause de l'écran (§118.178)", () => {
  /**
   * La phase 0 a réparé `regulatoryVisibleWhere` : étaler `scopeRegulatory` puis ajouter
   * `AND: [gamme]` écrasait la portée par ligne et le verrou du pipeline. La phase 1 a trouvé
   * TROIS autres lecteurs qui recomposaient la même clause avec le même défaut, à côté d'elle —
   * le rapprochement des catalogues, la relance des dossiers, l'export Excel. Réparer les trois ne
   * protège pas le quatrième (§118.58) : la forme fautive est interdite partout.
   */
  it("aucun fichier ne compose la gamme avec un étalement de la portée Regulatory", () => {
    const fautifs = fichiersDeProduction().filter((f) => {
      if (f === "src/lib/queries/regulatory-rows.ts") return false;
      const c = code(f);
      return /productRangeScope\(/.test(c) && /\.\.\.\s*scopeRegulatory\(/.test(c);
    });
    expect(fautifs, "recompose la gamme et la portée par étalement : lire `regulatoryVisibleWhere(user)`").toEqual([]);
  });

  it("le rapprochement des catalogues, la relance et l'export lisent la clause de l'écran", () => {
    for (const f of ["src/lib/queries/product-catalog.ts", "src/lib/queries/regulatory-reminders.ts", "src/app/api/regulatory/export/route.ts"]) {
      expect(code(f), f).toMatch(/regulatoryVisibleWhere\(user\)/);
      expect(code(f), f).not.toMatch(/\.\.\.\s*scopeRegulatory\(/);
    }
  });
});

/** Tous les fichiers `.ts` / `.tsx` de production sous `src/`. */
function fichiersDeProduction(dir = "src"): string[] {
  const out: string[] = [];
  for (const nom of readdirSync(join(RACINE, dir))) {
    const chemin = join(dir, nom);
    if (statSync(join(RACINE, chemin)).isDirectory()) out.push(...fichiersDeProduction(chemin));
    else if (/\.(ts|tsx)$/.test(nom) && !/\.(test|spec)\.tsx?$/.test(nom)) out.push(chemin.replace(/\\/g, "/"));
  }
  return out;
}

/**
 * Les SEULS fichiers qui lisent le cookie d'entité, et pourquoi. Tout autre lecteur est une
 * autorisation tirée d'une donnée du navigateur — le défaut des trente-trois appels du CTD et de
 * l'écran des départements (§118.177).
 */
const LECTEURS_DU_COOKIE: Record<string, string> = {
  "src/lib/company.ts": "la porte : `myCompanyScope`, `myCompanyWhere` et `platformScope` le VALIDENT",
  "src/lib/regulatory/intelligence/access.ts": "la résolution CTD le valide par `resolveScope`",
  "src/app/(app)/courriers/page.tsx": "le NOM de l'entité affichée, cherché parmi les entités de la personne",
  "src/app/(app)/organigramme/page.tsx": "le NOM de l'entité affichée, cherché parmi les entités de la personne",
  "src/app/(app)/information-medicale/page.tsx": "le NOM de l'entité affichée, cherché parmi les entités de la personne",
};

describe("Le cookie d'entité est une DEMANDE, jamais une autorisation (§118.177)", () => {
  it("seuls les lecteurs déclarés appellent `getCompanyScope`", () => {
    const lecteurs = fichiersDeProduction().filter((f) => /\bgetCompanyScope\(\)/.test(code(f)));
    const inconnus = lecteurs.filter((f) => !(f in LECTEURS_DU_COOKIE));
    expect(inconnus, `lecteurs du cookie non déclarés : ${inconnus.join(", ")}`).toEqual([]);
    // Et la liste ne garde pas d'entrée morte : un lecteur retiré sort de la table.
    const morts = Object.keys(LECTEURS_DU_COOKIE).filter((f) => !lecteurs.includes(f));
    expect(morts, `entrées sans lecteur : ${morts.join(", ")}`).toEqual([]);
  });

  it("les lecteurs d'affichage ne s'en servent que pour NOMMER une entité parmi les leurs", () => {
    for (const f of ["src/app/(app)/courriers/page.tsx", "src/app/(app)/organigramme/page.tsx", "src/app/(app)/information-medicale/page.tsx"]) {
      const src = code(f);
      const variable = src.match(/const (\w+) = getCompanyScope\(\);/)?.[1];
      expect(variable, `${f} : lecture du cookie introuvable`).toBeTruthy();
      // Chaque usage de la variable est une recherche dans une liste d'entités de la personne.
      const usages = [...src.matchAll(new RegExp(`\\b${variable}\\b`, "g"))].length;
      const recherches = [...src.matchAll(new RegExp(`\\.find\\(\\(c\\) => c\\.id === ${variable}\\)`, "g"))].length;
      // Une déclaration, une condition (`x ? … : null`), une recherche dans la liste.
      expect(recherches, `${f} : le cookie sert à autre chose qu'à nommer l'entité`).toBeGreaterThanOrEqual(1);
      expect(usages).toBeLessThanOrEqual(1 + 2 * recherches);
    }
  });

  it("le module CTD n'expose plus de résolution qui prenne une portée brute", () => {
    const access = code("src/lib/regulatory/intelligence/access.ts");
    expect(access).not.toMatch(/export async function resolveRegCompanyId\(/);
    expect(access).toMatch(/export async function resolveRegCompanyIdFor\(userId: string\)/);
  });

  it("l'écran des départements lit la portée VALIDÉE et le filtre de la liste RH", () => {
    const src = code("src/app/(app)/rh/departements/page.tsx");
    expect(src).toMatch(/myCompanyScope\(user\.id\)/);
    expect(src).toMatch(/platformScope\(user\.id\)/);
  });
});
