import { correspond, globsSeRecouvrent } from "@/lib/missions/chantiers/perimetre";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES RESSOURCES PARTAGÉES NOMMÉES (lot O2, décision 0059 § 5) — module PUR.
 *
 * Deux tâches peuvent ne partager AUCUN fichier déclaré et se casser quand même : l'une ajoute une migration, l'autre
 * aussi ; l'une ajoute une action serveur (le contrat généré change), l'autre aussi ; deux `npm install` dans le même
 * lockfile. Les globs ne suffisent pas : on nomme ces ressources, on les RÉSERVE (exclusives), et on les VÉRIFIE AU
 * DIFF — un travailleur qui en touche une qu'il n'a pas réservée rend sa tâche rouge.
 *
 *   SCHEMA        prisma/schema.prisma, prisma/migrations/**
 *   CONTRAT       le contrat des actions et le classement des capacités (fichiers générés du code)
 *   API           src/app/api/** (contrat public HTTP)
 *   DEPENDANCES   package.json, package-lock.json
 *   GENERES       tout fichier généré (`*.genere.*`, graphify-out/**)
 *   MODULE:<m>    src/modules/<m>/** (un module se modifie par une tâche à la fois)
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const RESSOURCES_FIXES = ["SCHEMA", "CONTRAT", "API", "DEPENDANCES", "GENERES"] as const;
export type RessourceFixe = (typeof RESSOURCES_FIXES)[number];

const MOTIFS: Record<RessourceFixe, readonly string[]> = {
  SCHEMA: ["prisma/schema.prisma", "prisma/migrations/**"],
  CONTRAT: ["src/lib/actions/contrat.genere.json", "src/lib/actions/contrat.genere.ts", "src/lib/actions/contrat.genere.d.json.ts", "src/lib/actions/aiguillage.genere.ts", "src/platform/ia/capacites/classement.genere.json"],
  API: ["src/app/api/**"],
  DEPENDANCES: ["package.json", "package-lock.json"],
  GENERES: ["**/*.genere.*", "graphify-out/**"],
};

const MODULE = /^src\/modules\/([a-z0-9][a-z0-9-]*)(\/|$)/;
const NOM_RESSOURCE = /^(SCHEMA|CONTRAT|API|DEPENDANCES|GENERES|MODULE:[a-z0-9][a-z0-9-]{0,60})$/;

export const ressourceValide = (nom: string): boolean => NOM_RESSOURCE.test(nom);

/** Les globs d'une ressource nommée — ajoutés au périmètre d'une tâche qui la réserve (elle a le droit d'y écrire). */
export function globsDeRessource(nom: string): readonly string[] {
  if (nom.startsWith("MODULE:")) return [`src/modules/${nom.slice(7)}/**`];
  return (RESSOURCES_FIXES as readonly string[]).includes(nom) ? MOTIFS[nom as RessourceFixe] : [];
}

/** Les ressources qu'un FICHIER touche (diff réel). */
export function ressourcesDuFichier(fichier: string): string[] {
  const fixes = RESSOURCES_FIXES.filter((r) => MOTIFS[r].some((g) => correspond(g, fichier)));
  // Un fichier généré qui appartient à une ressource PLUS précise (le contrat) relève de celle-ci seulement.
  const out = fixes.length > 1 ? fixes.filter((r) => r !== "GENERES") : fixes;
  const m = fichier.match(MODULE);
  return m ? [...out, `MODULE:${m[1]}`] : [...out];
}

/** Les ressources qu'un GLOB de périmètre peut toucher (déclaration) : un glob large les couvre toutes. */
export function ressourcesDuGlob(glob: string): string[] {
  const out: string[] = RESSOURCES_FIXES.filter((r) => MOTIFS[r].some((g) => globsSeRecouvrent(g, glob)));
  const m = glob.match(MODULE);
  if (m) out.push(`MODULE:${m[1]}`);
  return out;
}

/**
 * Les ressources d'une tâche : celles qu'elle DÉCLARE, plus celles que ses globs impliquent (on ne réserve pas un
 * périmètre `prisma/**` sans réserver le schéma). `GENERES` n'est impliqué que par une déclaration explicite ou un glob
 * qui le vise précisément : un glob large comme `src/**` ne fait pas d'une tâche la propriétaire des fichiers générés.
 */
export function ressourcesDeTache(t: { perimetre: readonly string[]; ressources?: readonly string[] }): string[] {
  const deduites = t.perimetre.flatMap((g) => ressourcesDuGlob(g).filter((r) => r !== "GENERES" || /genere|graphify/.test(g)));
  return [...new Set([...(t.ressources ?? []), ...deduites])].sort();
}

/**
 * LA VÉRIFICATION AU DIFF — les ressources touchées par les fichiers modifiés et NON réservées. Un module dont le
 * dossier est dans le périmètre est réservé de fait (le périmètre l'a impliqué) ; un fichier généré touché par une
 * tâche qui ne l'a pas déclaré est une faute (il se régénère à l'intégration, il ne se pousse pas en douce).
 */
export function ressourcesHorsReservation(fichiers: readonly string[], reservees: readonly string[]): string[] {
  const tenues = new Set(reservees);
  return [...new Set(fichiers.flatMap(ressourcesDuFichier))].filter((r) => !tenues.has(r)).sort();
}

/** Deux ensembles de ressources se recouvrent-ils ? (exclusives : un nom commun suffit). */
export function ressourcesCommunes(a: readonly string[], b: readonly string[]): string[] {
  const s = new Set(a);
  return b.filter((x) => s.has(x));
}

/**
 * LES FICHIERS « TRIVIAUX » D'UN CONFLIT — ceux qu'une régénération résout sans jugement : fichiers générés et lockfile.
 * Un conflit qui ne porte QUE sur eux se résout par une recette déterministe (régénérer, puis CI) ; tout autre conflit
 * retourne au travailleur avec le détail.
 */
export function recetteDeRegeneration(fichiers: readonly string[]): string[] | null {
  if (!fichiers.length) return null;
  const recettes: string[] = [];
  for (const f of fichiers) {
    if (f === "package-lock.json") recettes.push("npm install --package-lock-only");
    else if (/^src\/lib\/actions\/(contrat|aiguillage)\.genere\./.test(f)) recettes.push("npm run actions:contrat");
    else if (f === "src/platform/ia/capacites/classement.genere.json") recettes.push("npm run capacites:classement");
    else if (f.startsWith("graphify-out/")) recettes.push("npm run graphify:refresh");
    else return null;
  }
  return [...new Set(recettes)];
}
