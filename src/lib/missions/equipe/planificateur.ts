import type { CerveauChantier } from "@/lib/missions/chantiers/cerveau";
import { lirePlanProgramme, type LecturePlan } from "@/lib/missions/equipe/programme";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * MiMo, PLANIFICATEUR APPELÉ À LA DEMANDE (lot O2, décision 0059 § 3) — jamais une boucle de surveillance.
 *
 *   1. MiMo décompose la demande en un DAG de tâches, en JSON STRICT ;
 *   2. le VALIDATEUR DÉTERMINISTE (`lirePlanProgramme`) le relit — cycles, périmètres, critères, budget, aucun déploiement ;
 *   3. refusé : MiMo une seconde fois, avec la liste des fautes ;
 *   4. encore refusé (ou MiMo absent) : Sol en recours, une fois ;
 *   5. sinon : la demande est rendue avec les fautes (Terra peut alors écrire le plan lui-même — il passe le même validateur).
 * MiMo n'est jamais seule autorité : son plan ne fait rien tant que le validateur ne l'a pas admis, et les gestes
 * critiques (fusion sur main, production) restent sous carte de la Direction.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const CONSIGNE = `Tu es le superviseur technique d'une équipe de développeurs (sessions Claude Code). Décompose la demande en tâches
INDÉPENDANTES autant que possible, chacune faisable par UNE session sur SA branche. Réponds par UN SEUL objet JSON, sans texte
autour, de la forme :
{"titre": "...", "objectif": "...", "depot": {"proprietaire": "...", "nom": "..."}, "cible": "main",
 "concurrence": 3, "budget": {"usd": 0, "lancements": 0},
 "taches": [{"cle": "a-court", "titre": "...", "objectif": "comportement attendu précis", "perimetre": ["src/chemin/**"],
   "ressources": ["SCHEMA"|"CONTRAT"|"API"|"DEPENDANCES"|"GENERES"|"MODULE:<nom>"], "criteres": ["ce qui se constate"],
   "commandesVerif": ["npm test -- chemin"], "dependances": ["cle-d-une-autre-tache"], "migrations": false, "taille": "S"|"M"|"L"}]}
Règles : périmètres les plus ÉTROITS possible (deux tâches au même endroit sont sérialisées) ; une migration ou un changement du
contrat des actions ou du package.json se DÉCLARE en ressource ; critères vérifiables (une sortie, un statut, un test), jamais
« ça marche » ; au plus 12 tâches ; aucun déploiement (interdit dans un programme).`;

export interface IssuePlanification {
  lecture: LecturePlan;
  par: "MIMO" | "SOL";
  essais: number;
  coutUsd: number;
}

/** Le premier objet JSON d'un texte (le modèle peut l'entourer de ```json). Illisible : `null`. */
export function extraireJson(texte: string): unknown {
  const debut = texte.indexOf("{");
  const fin = texte.lastIndexOf("}");
  if (debut < 0 || fin <= debut) return null;
  try { return JSON.parse(texte.slice(debut, fin + 1)); } catch { return null; }
}

export async function planifier(
  demande: { texte: string; depot: { proprietaire: string; nom: string }; cible: string; contexte?: string },
  ctx: { cerveau: CerveauChantier; missionId: string; userId: string; plafondUsd?: number; lancementsMax?: number },
): Promise<IssuePlanification> {
  const dispo = ctx.cerveau.disponibles();
  const base = `Dépôt : ${demande.depot.proprietaire}/${demande.depot.nom} ; branche cible : ${demande.cible}.\n${demande.contexte ? `${demande.contexte}\n` : ""}\nDemande de la Direction :\n${demande.texte}`;
  let coutUsd = 0;
  let essais = 0;
  let derniere: LecturePlan = { ok: false, fautes: ["aucun planificateur disponible (MiMo et Sol absents)"] };
  const essai = async (niveau: "MIMO" | "SOL", fautes: string[] | null): Promise<LecturePlan> => {
    essais += 1;
    const texte = fautes ? `${base}\n\nTon plan précédent a été REFUSÉ par le validateur :\n- ${fautes.slice(0, 15).join("\n- ")}\nCorrige-le.` : base;
    const r = await ctx.cerveau.executer(niveau, { consigne: CONSIGNE, texte, missionId: ctx.missionId, userId: ctx.userId, maxSortie: 6_000 });
    if (!r.ok) return { ok: false, fautes: [`${niveau} : ${r.erreur}`] };
    coutUsd += r.coutUsd ?? 0;
    const brut = extraireJson(r.texte);
    if (!brut) return { ok: false, fautes: ["la réponse n'est pas un objet JSON"] };
    // Le dépôt et la cible sont ceux de la DEMANDE : le modèle ne les choisit pas.
    return lirePlanProgramme({ ...(brut as object), depot: demande.depot, cible: demande.cible }, { plafondUsd: ctx.plafondUsd, lancementsMax: ctx.lancementsMax });
  };
  if (dispo.mimo) {
    derniere = await essai("MIMO", null);
    if (derniere.ok) return { lecture: derniere, par: "MIMO", essais, coutUsd };
    derniere = await essai("MIMO", derniere.fautes);
    if (derniere.ok) return { lecture: derniere, par: "MIMO", essais, coutUsd };
  }
  if (dispo.sol) {
    derniere = await essai("SOL", derniere.ok ? null : derniere.fautes);
    return { lecture: derniere, par: "SOL", essais, coutUsd };
  }
  return { lecture: derniere, par: "MIMO", essais, coutUsd };
}
