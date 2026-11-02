import { plier } from "@/lib/utils";
/**
 * LE NIVEAU D'INTELLIGENCE DE RÉUNION (mandat 4 §32) — pur, sans import.
 *
 * Trois niveaux, et c'est la PERSONNE qui l'enseigne (Teach Adam) : « pour mes réunions, je veux
 * un briefing de chef de cabinet ». Sans règle, un défaut selon le rôle. Le niveau ne change pas ce
 * qui est VRAI — il change ce qu'on lit et ce qu'on montre.
 *
 *   LIGHT           contexte, ordre du jour, tâches ouvertes entre les participants
 *   STANDARD        + notes de la dernière réunion, décisions, actions, responsables, échéances, suivi
 *   CHIEF_OF_STAFF  + historique, personnes, dossiers, décisions à obtenir, risques, contradictions,
 *                   engagements, questions ouvertes, suivi jusqu'à la réunion suivante
 */

export type NiveauReunion = "LIGHT" | "STANDARD" | "CHIEF_OF_STAFF";
export const NIVEAUX: readonly NiveauReunion[] = ["LIGHT", "STANDARD", "CHIEF_OF_STAFF"];
export const LIBELLE_NIVEAU: Record<NiveauReunion, string> = { LIGHT: "léger", STANDARD: "standard", CHIEF_OF_STAFF: "chef de cabinet" };
export const RANG_NIVEAU: Record<NiveauReunion, number> = { LIGHT: 0, STANDARD: 1, CHIEF_OF_STAFF: 2 };

/** Ce que chaque niveau LIT et MONTRE — la même liste sert au modèle et à la documentation. */
export const CONTENU_PAR_NIVEAU: Record<NiveauReunion, readonly string[]> = {
  LIGHT: ["contexte de la réunion", "ordre du jour", "tâches ouvertes entre vous et chaque participant"],
  STANDARD: ["contexte de la réunion", "ordre du jour", "tâches ouvertes entre vous et chaque participant", "notes de la dernière réunion", "décisions récentes liées", "actions issues de la dernière réunion et leur sort", "responsables et échéances", "engagements suivis"],
  CHIEF_OF_STAFF: ["contexte de la réunion", "ordre du jour", "tâches ouvertes entre vous et chaque participant", "notes de la dernière réunion", "décisions récentes liées", "actions issues de la dernière réunion et leur sort", "responsables et échéances", "engagements suivis", "historique des réunions", "personnes (fonction, département)", "dossiers concernés", "décisions à obtenir", "risques calculés", "contradictions à trancher", "questions ouvertes", "suivi jusqu'à la réunion suivante"],
};

/** Le niveau lu dans une phrase — `null` quand la phrase n'en nomme aucun clairement. */
export function niveauDepuisTexte(texte: string): NiveauReunion | null {
  const t = plier(texte);
  if (/\b(chief[_ ]of[_ ]staff|chef de cabinet|complet|complete|integral|maximal|exhaustif)\b/.test(t)) return "CHIEF_OF_STAFF";
  if (/\b(standard|normal|classique|habituel|intermediaire)\b/.test(t)) return "STANDARD";
  if (/\b(light|leger|legere|minimal|minimale|court|bref|rapide|simple|essentiel)\b/.test(t)) return "LIGHT";
  return null;
}

const PARLE_DE_REUNION = /(brief|briefing|prepar\w*|preparation)[^.]{0,80}?reunions?|reunions?[^.]{0,80}?(brief|briefing|prepar\w*)/;

/** Une phrase enseignée PARLE-t-elle du brief de réunion ? (pliée ou non). */
export function parleDuBriefDeReunion(texte: string): boolean {
  return PARLE_DE_REUNION.test(plier(texte));
}

export interface RegleNiveau { params: Record<string, unknown> | null; statement: string; id?: string }

/** Le niveau APPRIS : la première règle en vigueur qui le dit — par sa clé, ou par sa phrase. */
export function niveauDepuisRegles(regles: readonly RegleNiveau[]): { niveau: NiveauReunion; statement: string; id?: string } | null {
  for (const r of regles) {
    const cle = r.params && typeof r.params.cle === "string" ? r.params.cle : null;
    if (cle === "niveauReunion") {
      const v = r.params?.valeur;
      const niv = typeof v === "string" ? ((NIVEAUX as readonly string[]).includes(v.toUpperCase()) ? (v.toUpperCase() as NiveauReunion) : niveauDepuisTexte(v)) : null;
      if (niv) return { niveau: niv, statement: r.statement, id: r.id };
    }
  }
  for (const r of regles) {
    if (!parleDuBriefDeReunion(r.statement)) continue;
    const niv = niveauDepuisTexte(r.statement);
    if (niv) return { niveau: niv, statement: r.statement, id: r.id };
  }
  return null;
}

const ROLES_DIRECTION: ReadonlySet<string> = new Set(["SUPER_ADMIN", "DIRECTION", "DIRECTION_ASSISTANT", "GENERAL_MANAGER", "OPERATIONS_DIRECTOR"]);

/** Sans règle : la direction et son cabinet lisent STANDARD, les autres LIGHT. */
export function niveauParDefaut(role: string): NiveauReunion {
  return ROLES_DIRECTION.has(role) ? "STANDARD" : "LIGHT";
}

export const auMoins = (niveau: NiveauReunion, plancher: NiveauReunion): boolean => RANG_NIVEAU[niveau] >= RANG_NIVEAU[plancher];
