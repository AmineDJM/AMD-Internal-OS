import { contexteDonnees, evaluateurDonnees } from "./contexte";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA GARDE DES DONNÉES (lot D3, décision 0057) — UN seul point de passage, dans le relais `prisma`.
 *
 * Masquer des menus ne suffit pas : une donnée sort aussi par un export, une recherche, l'assistant, une API ou la
 * JOINTURE d'un autre écran. Toute l'application lisant par `prisma`, la question « cette base est-elle ouverte à
 * cette personne ? » se pose une fois, pour les ~6 400 lectures du code. L'extension Prisma qui appelle `jugerRequete`
 * vit dans `src/lib/prisma.ts` (le seul à connaître Prisma) ; ici, rien que la règle de passage, sans dépendance ERP.
 *
 * EN MODE OBSERVATION (D3) : la garde ne refuse RIEN. L'évaluateur COMPTE ce qu'il aurait refusé, la console le montre.
 *
 * LES RELATIONS COMPTENT : une demande Ad & Pro qui `include` le salarié touche la base Personnel. Le modèle lié vient
 * du modèle de données de Prisma (fourni par `prisma.ts`), pas d'une liste recopiée à la main.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const LECTURES = new Set(["findMany", "findFirst", "findUnique", "findUniqueOrThrow", "findFirstOrThrow", "count", "aggregate", "groupBy"]);

/** Modèle → (champ de relation → modèle lié). */
export type Relations = (modele: string) => ReadonlyMap<string, string>;

/** Les modèles touchés par une requête : celui demandé, plus ceux que `include` / `select` tirent avec lui. */
export function modelesTouches(modele: string, args: unknown, relations: Relations, profondeur = 0): string[] {
  const out = [modele];
  if (profondeur > 3 || !args || typeof args !== "object") return out;
  const champs = relations(modele);
  if (!champs.size) return out;
  for (const cle of ["include", "select"] as const) {
    const bloc = (args as Record<string, unknown>)[cle];
    if (!bloc || typeof bloc !== "object") continue;
    for (const [nom, valeur] of Object.entries(bloc as Record<string, unknown>)) {
      const lie = champs.get(nom);
      if (!lie || valeur === false || valeur == null) continue;
      out.push(...modelesTouches(lie, valeur === true ? null : valeur, relations, profondeur + 1));
    }
  }
  return out;
}

/**
 * Juge UNE requête : chaque modèle touché passe devant l'évaluateur du module `acces-bases` (branché au démarrage).
 * Sans évaluateur : rien, coût nul. D3 : rend le premier refus qu'il AURAIT prononcé (l'évaluateur l'a déjà compté) —
 * l'appelant ne l'applique pas.
 */
export function jugerRequete(modele: string | undefined, operation: string, args: unknown, relations: Relations): string | null {
  const juge = evaluateurDonnees();
  if (!juge || !modele) return null;
  const geste = LECTURES.has(operation) ? "lecture" : "ecriture";
  const contexte = contexteDonnees();
  for (const m of geste === "lecture" ? modelesTouches(modele, args, relations) : [modele]) {
    const verdict = juge({ modele: m, geste, operation, contexte });
    if (verdict?.refus) return verdict.refus;
  }
  return null;
}
