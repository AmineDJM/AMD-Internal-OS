import { Prisma } from "@prisma/client";
import { contexteDonnees, evaluateurDonnees, type VerdictDonnees } from "./contexte";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA GARDE DES DONNÉES (lot D3, décision 0057) — UN seul point de passage, dans le relais `prisma`.
 *
 * Masquer des menus ne suffit pas : une donnée sort aussi par un export, une recherche, l'assistant, une API ou la
 * JOINTURE d'un autre écran. Toute l'application lisant par `prisma`, la question « cette base est-elle ouverte à
 * cette personne ? » se pose ici, une fois, pour les ~6 400 lectures du code.
 *
 * EN MODE OBSERVATION (D3, ce lot) : la garde ne refuse RIEN. Elle COMPTE ce qu'elle aurait refusé, et la console le
 * montre. L'application stricte est le lot D4, et la Direction en fixera la date après deux semaines de mesure.
 *
 * LES RELATIONS COMPTENT : une demande Ad & Pro qui `include` le salarié touche la base Personnel. Le modèle lié se
 * lit dans le modèle de données de Prisma (`Prisma.dmmf`), pas dans une liste recopiée à la main.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const LECTURES = new Set(["findMany", "findFirst", "findUnique", "findUniqueOrThrow", "findFirstOrThrow", "count", "aggregate", "groupBy"]);

/** Modèle → (nom du champ de relation → modèle lié), lu une fois dans le modèle de données de Prisma. */
let relations: Map<string, Map<string, string>> | null = null;
function relationsDe(modele: string): Map<string, string> {
  if (!relations) {
    relations = new Map();
    try {
      for (const m of Prisma.dmmf.datamodel.models) {
        const champs = new Map<string, string>();
        for (const f of m.fields) if (f.kind === "object" && typeof f.type === "string") champs.set(f.name, f.type);
        relations.set(m.name, champs);
      }
    } catch {
      // Pas de modèle de données (client non généré) : la garde juge le modèle demandé, sans ses relations.
    }
  }
  return relations.get(modele) ?? new Map();
}

/** Les modèles touchés par une requête : celui demandé, plus ceux que `include` / `select` tirent avec lui. */
export function modelesTouches(modele: string, args: unknown, profondeur = 0): string[] {
  const out = [modele];
  if (profondeur > 3 || !args || typeof args !== "object") return out;
  const champs = relationsDe(modele);
  if (!champs.size) return out;
  for (const cle of ["include", "select"] as const) {
    const bloc = (args as Record<string, unknown>)[cle];
    if (!bloc || typeof bloc !== "object") continue;
    for (const [nom, valeur] of Object.entries(bloc as Record<string, unknown>)) {
      const lie = champs.get(nom);
      if (!lie || valeur === false || valeur == null) continue;
      out.push(...modelesTouches(lie, valeur === true ? null : valeur, profondeur + 1));
    }
  }
  return out;
}

/**
 * L'extension de requête posée sur le client de base. Elle demande son verdict à l'évaluateur du module
 * `acces-bases` (branché au démarrage) ; sans évaluateur, elle ne fait qu'appeler la requête — coût nul.
 */
export function extensionGarde() {
  return Prisma.defineExtension({
    name: "garde-acces-par-base",
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          const juge = evaluateurDonnees();
          if (juge && model) {
            const geste = LECTURES.has(operation) ? "lecture" : "ecriture";
            const contexte = contexteDonnees();
            const vus = geste === "lecture" ? modelesTouches(model, args) : [model];
            for (const m of vus) {
              const verdict: VerdictDonnees | null = juge({ modele: m, geste, operation, contexte });
              // D3 : on MESURE (l'évaluateur a déjà compté). Rien n'est refusé avant le lot D4.
              if (verdict?.refus) break;
            }
          }
          return query(args);
        },
      },
    },
  });
}
