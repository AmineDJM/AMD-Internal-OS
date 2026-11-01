import { estSorteMemoire, MEMOIRE_MAX_CARACTERES, type SorteMemoire } from "../memoire-ui";
import { garderCandidat } from "./capture";
import { jetonsLigne } from "./rappel";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA CONSOLIDATION DE LA MÉMOIRE (M1, Direction 01/11/2026) — règle PURE.
 *
 * « Ce n'est pas une histoire de nombre de souvenirs, plutôt un nombre de jetons. » La mémoire de chaque personne a un
 * BUDGET DE STOCKAGE en jetons (`AssistantIaReglage.memoireJetonsBudget`, défaut 8 000 ≈ 300 faits courts). Quand elle en
 * occupe 85 %, le modèle RAPIDE la consolide EN UN LOT : fusion des faits proches ou redondants, réécriture concise
 * (« Fille : Lina, 9 ans, école X » plutôt que trois lignes), regroupement par sujet, faits anciens et jamais rappelés
 * résumés — jusqu'à ~60 % du budget. Rare (au plus une fois par jour et par personne), journalisée (K8, usage
 * « memoire »), réversible : chaque fait repris reste 12 mois, inactif, lié à son remplaçant (`consolideDans`).
 *
 * La règle garde le dernier mot : un groupe n'est appliqué que s'il remplace au moins deux faits (ou en raccourcit un),
 * s'il ÉCONOMISE des jetons, et si chaque chiffre ou nom propre de la phrase neuve vient des faits qu'elle remplace.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const SEUIL_CONSOLIDATION = 0.85;
export const CIBLE_CONSOLIDATION = 0.6;
/** Au plus une consolidation par personne sur cette durée. */
export const ECART_CONSOLIDATION_MS = 20 * 3600_000;
/** L'historique (faits remplacés ou repris) est gardé 12 mois, puis purgé ; un fait ACTIF ne l'est jamais par l'âge. */
export const DUREE_HISTORIQUE_MS = 365 * 24 * 3600_000;

export interface FaitStocke {
  id: string;
  sorte: string;
  contenu: string;
  /** Jours depuis la création, et depuis le dernier rappel (null : jamais rappelé). */
  ageJours: number;
  rappelJours: number | null;
}

export const jetonsStockes = (faits: readonly Pick<FaitStocke, "contenu">[]): number => faits.reduce((s, f) => s + jetonsLigne(f.contenu), 0);

export const doitConsolider = (jetons: number, budget: number): boolean => budget > 0 && jetons >= budget * SEUIL_CONSOLIDATION;

export const CONSIGNE_CONSOLIDATION = [
  "Tu ranges la mémoire d'un assistant sur UNE personne. Elle dépasse son budget : réduis-la SANS perdre d'information utile.",
  "Tu reçois des faits numérotés (m1, m2…), leur sorte, leur âge et leur dernier rappel. Rends des GROUPES :",
  "- Fusionne les faits proches ou redondants en UNE phrase concise (« Fille : Lina, 9 ans, école Les Oliviers »).",
  "- Regroupe par sujet (famille, voyage, goûts…) ; réécris court ce qui est verbeux.",
  "- Un fait ancien et jamais rappelé peut être résumé plus brièvement ; un voyage passé se résume (« A visité Lyon en novembre 2026 »).",
  "- Ne crée AUCUNE information : chaque chiffre, date, nom de la phrase neuve vient des faits qu'elle remplace.",
  "- Sans pronom ni genre supposé. Rien de confidentiel (salaire, IBAN, pièce d'identité).",
  "- Un fait que tu ne cites dans aucun groupe reste tel quel : ne cite que ce que tu changes.",
  "SORTES : PERSONNEL_IDENTITE, FAMILLE, ETUDES_PARCOURS, SANTE_DECLAREE, VOYAGES, GOUTS_LOISIRS, PROJETS,",
  "ORGANIZATIONAL_CONTEXT, WORKING_STYLE, CONTRAINTES, PERSONNES_CITEES, USER_PREFERENCE, ENTITY_ALIAS, TERMINOLOGY.",
  "RÉPONDS UNIQUEMENT en JSON : {\"groupes\":[{\"remplace\":[\"m1\",\"m4\"],\"sorte\":\"FAMILLE\",\"contenu\":\"…\"}]}",
].join("\n");

/** L'entrée : les faits, du plus ancien au plus récent, avec ce qui aide à choisir quoi résumer. */
export function entreeConsolidation(faits: readonly FaitStocke[], budget: number): { texte: string; cles: Map<string, string> } {
  const cles = new Map<string, string>();
  const lignes = faits.map((f, i) => {
    const cle = `m${i + 1}`;
    cles.set(cle, f.id);
    const rappel = f.rappelJours == null ? "jamais rappelé" : `rappelé il y a ${f.rappelJours} j`;
    return `${cle} [${f.sorte}] (${f.ageJours} j, ${rappel}) ${f.contenu}`;
  });
  const cible = Math.round(budget * CIBLE_CONSOLIDATION);
  return { texte: [`Budget : ${budget} jetons ; occupé : ${jetonsStockes(faits)} ; vise ${cible} au plus.`, "", ...lignes].join("\n"), cles };
}

export interface GroupeConsolide {
  remplace: string[];
  sorte: SorteMemoire;
  contenu: string;
}

/** Lit la sortie (JSON strict, tolérant aux balises) ; les clés inconnues et les faits cités deux fois sont écartés. */
export function lireConsolidation(brut: string, cles: ReadonlyMap<string, string>): GroupeConsolide[] {
  const t = brut.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const d = t.indexOf("{");
  const f = t.lastIndexOf("}");
  if (d < 0 || f <= d) return [];
  let lu: unknown;
  try { lu = JSON.parse(t.slice(d, f + 1)); } catch { return []; }
  const groupes = (lu as { groupes?: unknown })?.groupes;
  if (!Array.isArray(groupes)) return [];
  const pris = new Set<string>();
  const out: GroupeConsolide[] = [];
  for (const g of groupes) {
    const o = g as Record<string, unknown>;
    const contenu = typeof o?.contenu === "string" ? o.contenu.replace(/\s+/g, " ").trim() : "";
    const ids = (Array.isArray(o?.remplace) ? o.remplace : []).map((k) => (typeof k === "string" ? cles.get(k) : undefined)).filter((x): x is string => !!x);
    const uniques = [...new Set(ids)].filter((id) => !pris.has(id));
    if (!contenu || contenu.length > MEMOIRE_MAX_CARACTERES || !uniques.length || !estSorteMemoire(o.sorte)) continue;
    uniques.forEach((id) => pris.add(id));
    out.push({ remplace: uniques, sorte: o.sorte, contenu });
  }
  return out;
}

export type VerdictGroupe = { ok: true; economie: number } | { ok: false; raison: string };

/** Le dernier mot de la règle sur un groupe : il économise, il n'invente rien. */
export function validerGroupe(g: Pick<GroupeConsolide, "contenu">, remplaces: readonly { contenu: string }[]): VerdictGroupe {
  const avant = jetonsStockes(remplaces);
  const apres = jetonsLigne(g.contenu);
  if (apres >= avant) return { ok: false, raison: "aucune économie" };
  const v = garderCandidat(g, remplaces.map((r) => r.contenu).join(" . "));
  if (!v.ok) return { ok: false, raison: v.raison };
  return { ok: true, economie: avant - apres };
}
