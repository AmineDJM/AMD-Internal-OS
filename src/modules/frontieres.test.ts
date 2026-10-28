import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cibleInterne, dependances } from "@/platform/imports";
import { demenagements } from "@/platform/demenagements";
import { CARTE, SOCLE_METIER } from "./carte";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES FRONTIÈRES DES MODULES (`src/modules/<module>/`) — rapport d'audit 08, structure cible.
 * Le guide pas à pas : `docs/architecture/MODULES.md`.
 *
 *   api.ts        la porte SERVEUR : commandes, requêtes, types publics ;
 *   api-*.ts      une porte serveur SPÉCIALISÉE quand une partie du module ne doit pas être
 *                 atteinte par tous (le coffre : `api.ts` n'écrit que, `api-lecture.ts` déchiffre) ;
 *   partage.ts    la porte PURE, importable partout (navigateur, autres `domaine/`) ;
 *   actions.ts    les actions serveur (`"use server"`), déclarées dans `src/lib/actions/parc.ts` —
 *                 `actions-<cas>.ts` quand le module en a plusieurs fichiers (chacun garde sa clé) ;
 *   domaine/      règles PURES : ni Prisma, ni Next, ni Node, ni React, ni `infra/`, ni `ecrans/` ;
 *   infra/        la base et les fichiers, réexportés par les portes ;
 *   ecrans/       composants React du module, importés par les pages de `src/app/` seulement.
 *
 * Les règles, toutes à ZÉRO (un module migré naît propre, il n'a pas de dette « à résorber ») :
 *   1. hors du module, on n'importe qu'une porte — ou un `ecrans/*` depuis `src/app/` ;
 *   2. `domaine/` est pur (un import de TYPE seul de `@prisma/client` est permis : il s'efface) ;
 *      et `partage.ts` ne réexporte que `domaine/` ;
 *   3. un module n'en lit un autre que s'il figure dans `carte.ts`, qui reste sans cycle ;
 *      un `domaine/` ne lit un autre module que par sa porte pure ;
 *   4. le socle (L0 de `platform/domains.ts`) n'importe aucun module ;
 *   5. personne n'importe un ancien chemin : l'adresse de réexpédition (`tsconfig.json`,
 *      `platform/demenagements.ts`) ne sert qu'au code qui arrive d'une autre branche.
 *
 * Et une dette HÉRITÉE, mesurée par module : les imports d'un module vers l'ancien `src/lib/`
 * hors socle. Elle ne peut que baisser — la liste est exacte, une entrée neuve fait échouer.
 *
 * ESLint (`no-restricted-imports`, `.eslintrc.json`) dit les règles 1, 2 et 5 dans l'éditeur ; ce
 * test les TIENT, imports relatifs compris (`platform/imports.ts`).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Les imports d'un module vers `src/lib/` hors socle, connus et nommés. Ne peut que rétrécir. */
const DETTE_HERITEE: Record<string, string[]> = {
  consommation: [
    // `normalizeHeader` (repli d'en-tête de tableur) vit dans l'import de l'annuaire médical.
    "src/modules/consommation/domaine/affinite.ts → src/lib/medical/directory-sheet",
    "src/modules/consommation/domaine/lecture.ts → src/lib/medical/directory-sheet",
    // Le référentiel produits : cible = `@/modules/produits/api`.
    "src/modules/consommation/domaine/resolution.ts → src/lib/products/identity",
  ],
  coffre: [
    // Qui a droit aux salaires : la règle de confidentialité RH, lue pour bâtir le lecteur.
    "src/modules/coffre/infra/lecteur.ts → src/lib/hr/confidentialite",
  ],
  referentiels: [
    // Les normalisations NIF / RC / e-mail vivent chez la qualité des données et la lecture des pièces.
    "src/modules/referentiels/domaine/coordonnees.ts → src/lib/quality/model",
    "src/modules/referentiels/domaine/normalisation.ts → src/lib/pieces-lues/fournisseur",
    "src/modules/referentiels/domaine/normalisation.ts → src/lib/quality/model",
    // Les FICHES 360° lisent la visibilité de chaque métier : ce sont des lectures transverses, à sortir
    // vers un modèle de lecture (proposition §5.5) quand les métiers auront leur `api.ts`.
    "src/modules/referentiels/infra/organisations/fiche.ts → src/lib/company",
    "src/modules/referentiels/infra/organisations/fiche.ts → src/lib/queries/visibilite-listes",
    "src/modules/referentiels/infra/personnes/fiche.ts → src/lib/ad-pro-items",
    "src/modules/referentiels/infra/personnes/fiche.ts → src/lib/company",
    "src/modules/referentiels/infra/personnes/fiche.ts → src/lib/entity-access",
    "src/modules/referentiels/infra/personnes/fiche.ts → src/lib/entity-href",
    "src/modules/referentiels/infra/personnes/fiche.ts → src/lib/queries/vue-360",
    // La reprise des pièces relance la file d'enrichissement (moteur E) : cible = `@/modules/pieces/api`.
    "src/modules/referentiels/infra/reprises/rattrapage-pieces.ts → src/lib/enrichissement/file",
    "src/modules/referentiels/infra/reprises/rattrapage-pieces.ts → src/lib/enrichissement/signalement",
  ],
};

/** Le socle : ce qu'un module a le droit de lire sans que ce soit une dette. */
const SOCLE = [
  "src/lib/prisma", "src/lib/session", "src/lib/rbac", "src/lib/utils", "src/lib/labels", "src/lib/audit",
  "src/lib/settings", "src/lib/journal", "src/lib/annuaires/", "src/lib/chemins/", "src/components/ui/", "src/components/shared/",
  "src/platform/imports",
];
/** Les actions serveur de `src/lib/actions/` : un écran de module peut les appeler (Next les remplace par un appel distant). */
const ACTIONS = "src/lib/actions/";
/** Ce qu'un `domaine/` ne peut pas importer en VALEUR. */
const INTERDITS_DOMAINE = /^(@prisma\/client|next(\/|$)|react(\/|$)|react-dom|node:|fs$|path$|crypto$|xlsx$)/;
/** Les fichiers permis à la racine d'un module (hors tests et README). */
const PORTE = /^(api|api-[a-z-]+|partage|actions|actions-[a-z-]+)$/;
const DOSSIERS = new Set(["domaine", "infra", "ecrans"]);

const RACINE = process.cwd();
function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules") walk(p, out); }
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(path.relative(RACINE, p).split(path.sep).join("/"));
  }
  return out;
}

const moduleDe = (f: string): string | null => f.match(/^src\/modules\/([^/]+)\//)?.[1] ?? null;
/** `domaine`, `infra`, `ecrans`, ou le nom d'une porte (`api`, `partage`…) pour un fichier à la racine. */
const partieDe = (f: string): string => f.split("/")[3]?.replace(/\.tsx?$/, "") ?? "";

interface Arete { from: string; spec: string; to: string | null; typeSeul: boolean }
const aretes: Arete[] = walk("src").concat(walk("scripts")).flatMap((from) =>
  dependances(fs.readFileSync(from, "utf8")).map(({ spec, typeSeul }) => ({ from, spec, to: cibleInterne(spec, from), typeSeul })));

const modules = fs.existsSync("src/modules")
  ? fs.readdirSync("src/modules", { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : [];

/** Les arêtes module → module mesurées, `a → b`. */
const aretesModules = [...new Set(aretes.flatMap(({ from, to }) => {
  const a = moduleDe(from);
  const b = to ? moduleDe(`${to}/`) : null;
  return a && b && a !== b ? [`${a} → ${b}`] : [];
}))].sort();

describe("modules — la structure de chaque module", () => {
  it("chaque module a sa porte `api.ts` et son `README.md`", () => {
    for (const m of modules) {
      expect(fs.existsSync(`src/modules/${m}/api.ts`), `src/modules/${m}/api.ts`).toBe(true);
      expect(fs.existsSync(`src/modules/${m}/README.md`), `src/modules/${m}/README.md`).toBe(true);
    }
  });

  it("à la racine d'un module, seulement des portes ; dessous, seulement domaine/, infra/, ecrans/", () => {
    const intrus: string[] = [];
    for (const m of modules) {
      for (const e of fs.readdirSync(`src/modules/${m}`, { withFileTypes: true })) {
        if (e.isDirectory()) { if (!DOSSIERS.has(e.name)) intrus.push(`src/modules/${m}/${e.name}/`); continue; }
        if (e.name === "README.md" || /\.test\.tsx?$/.test(e.name)) continue;
        if (!PORTE.test(e.name.replace(/\.tsx?$/, ""))) intrus.push(`src/modules/${m}/${e.name}`);
      }
    }
    expect(intrus, "une porte s'appelle api.ts, api-<facette>.ts, partage.ts, actions.ts ou actions-<cas>.ts ; le reste va dans domaine/, infra/ ou ecrans/").toEqual([]);
  });

  it("chaque module figure dans la carte (`carte.ts`), et la carte ne nomme que des modules qui existent", () => {
    expect([...modules].sort()).toEqual(Object.keys(CARTE).sort());
  });

  it("un module ne reste pas à moitié déménagé dans `src/lib/`", () => {
    for (const m of modules) expect(fs.existsSync(`src/lib/${m}`), `src/lib/${m} existe encore`).toBe(false);
  });
});

describe("modules — les frontières tiennent", () => {
  it("1 · hors du module, on n'entre que par une porte (ou un écran, depuis une page)", () => {
    const fautes = aretes.filter(({ from, to }) => {
      const m = to && moduleDe(`${to}/`);
      if (!m || moduleDe(from) === m) return false;
      const partie = partieDe(`${to}.ts`);
      if (PORTE.test(partie)) return false;
      if (partie === "ecrans" && from.startsWith("src/app/")) return false;
      return true;
    });
    expect(fautes.map((a) => `${a.from} ⇒ ${a.spec}`), "import profond dans un module : passer par sa porte (api.ts, partage.ts…)").toEqual([]);
  });

  it("2 · `domaine/` est pur", () => {
    const fautes = aretes.filter(({ from, spec, to, typeSeul }) => {
      if (!moduleDe(from) || partieDe(from) !== "domaine") return false;
      if (INTERDITS_DOMAINE.test(spec)) return !(typeSeul && spec === "@prisma/client");
      if (to === "src/lib/prisma") return true;
      return !!to && moduleDe(`${to}/`) === moduleDe(from) && partieDe(`${to}.ts`) !== "domaine";
    });
    expect(fautes.map((a) => `${a.from} ⇒ ${a.spec}`)).toEqual([]);
  });

  it("2 · `partage.ts` ne réexporte que `domaine/` (la porte pure le reste)", () => {
    const fautes = aretes.filter(({ from, to }) => moduleDe(from) && partieDe(from) === "partage"
      && !(to && moduleDe(`${to}/`) === moduleDe(from) && partieDe(`${to}.ts`) === "domaine"));
    expect(fautes.map((a) => `${a.from} ⇒ ${a.spec}`)).toEqual([]);
  });

  it("3 · un `domaine/` ne lit un autre module que par sa porte pure", () => {
    const fautes = aretes.filter(({ from, to }) => {
      const m = to && moduleDe(`${to}/`);
      return !!m && moduleDe(from) !== null && m !== moduleDe(from) && partieDe(from) === "domaine" && partieDe(`${to}.ts`) !== "partage";
    });
    expect(fautes.map((a) => `${a.from} ⇒ ${a.spec}`)).toEqual([]);
  });

  it("3 · chaque lien entre modules est déclaré dans `carte.ts`", () => {
    const declarees = new Set(Object.entries(CARTE).flatMap(([a, bs]) => bs.map((b) => `${a} → ${b}`)));
    expect(aretesModules.filter((a) => !declarees.has(a)), "un lien entre modules s'ajoute d'abord à src/modules/carte.ts (et se justifie en revue)").toEqual([]);
  });

  it("3 · aucune permission morte dans la carte (un lien déclaré est un lien utilisé)", () => {
    const mesurees = new Set(aretesModules);
    const mortes = Object.entries(CARTE).flatMap(([a, bs]) => bs.map((b) => `${a} → ${b}`)).filter((x) => !mesurees.has(x));
    expect(mortes, "retirer de carte.ts le lien que plus personne n'utilise").toEqual([]);
  });

  it("3 · la carte est sans cycle", () => {
    const etat = new Map<string, "encours" | "fini">();
    const cycles: string[] = [];
    const visiter = (m: string, chemin: string[]) => {
      if (etat.get(m) === "fini") return;
      if (etat.get(m) === "encours") { cycles.push([...chemin, m].join(" → ")); return; }
      etat.set(m, "encours");
      for (const d of (CARTE as Record<string, readonly string[]>)[m] ?? []) visiter(d, [...chemin, m]);
      etat.set(m, "fini");
    };
    for (const m of Object.keys(CARTE)) visiter(m, []);
    expect(cycles).toEqual([]);
  });

  it("3 · le socle métier ne lit que le socle métier", () => {
    const socle = new Set<string>(SOCLE_METIER);
    const fautes = SOCLE_METIER.flatMap((m) => ((CARTE as Record<string, readonly string[]>)[m] ?? []).filter((d) => !socle.has(d)).map((d) => `${m} → ${d}`));
    expect(fautes).toEqual([]);
  });

  it("4 · le socle n'importe aucun module", () => {
    const fautes = aretes.filter(({ from, to }) => !moduleDe(from) && SOCLE.some((s) => from === `${s}.ts` || from.startsWith(s))
      && !!to && !!moduleDe(`${to}/`));
    expect(fautes.map((a) => `${a.from} ⇒ ${a.spec}`)).toEqual([]);
  });

  it("5 · personne n'importe un ancien chemin (l'adresse de réexpédition est pour les autres branches)", () => {
    const parAncien = new Map(demenagements().map((d) => [d.ancienChemin, d]));
    const fautes = aretes.filter(({ to }) => !!to && parAncien.has(to))
      .map(({ from, spec, to }) => `${from} ⇒ ${spec} — écrire : ${porteDe(parAncien.get(to!)!.nouveauChemin)}`);
    expect(fautes, "ce fichier a déménagé dans un module : importer la porte du module").toEqual([]);
  });

  it("5 · chaque adresse de réexpédition mène à un fichier qui existe", () => {
    const perdues = demenagements().filter((d) => ![".ts", ".tsx", "/index.ts"].some((e) => fs.existsSync(`${d.nouveauChemin}${e}`)));
    expect(perdues.map((d) => `${d.ancien} → ${d.nouveauChemin}`)).toEqual([]);
  });

  it("la dette héritée vers `src/lib/` ne grossit pas (et la liste reste exacte)", () => {
    for (const m of modules) {
      const mesuree = aretes
        .filter(({ from, to }) => moduleDe(from) === m && !!to && to.startsWith("src/lib/")
          && !to.startsWith(ACTIONS) && !SOCLE.some((s) => to === s || to.startsWith(s)))
        .map(({ from, to }) => `${from} → ${to}`);
      const connue = DETTE_HERITEE[m] ?? [];
      expect([...new Set(mesuree)].sort(), `dette héritée du module ${m} — une entrée neuve est un couplage ajouté ; une entrée disparue se RETIRE de DETTE_HERITEE`).toEqual([...connue].sort());
    }
  });
});

/** La porte par laquelle on atteint désormais un fichier déménagé (pour le message d'erreur). */
function porteDe(nouveau: string): string {
  const m = moduleDe(`${nouveau}/`);
  if (!m) return `@/${nouveau.replace(/^src\//, "")}`;
  const partie = partieDe(`${nouveau}.ts`);
  if (partie === "domaine") return `@/modules/${m}/partage (ou /api côté serveur)`;
  if (PORTE.test(partie)) return `@/modules/${m}/${partie}`;
  return `@/modules/${m}/api (ou la porte api-*.ts qui l'exporte)`;
}
