/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * QUELLE RECETTE POUR CETTE DEMANDE ? (J10, décision 0028) — pur, sans modèle.
 *
 * Les mots de la demande contre les mots-clés de chaque recette (ceux du circuit, les libellés de ses étapes, ceux que
 * le responsable a ajoutés). Un mot qui ne désigne qu'UNE recette pèse double : « nationale » départage deux prises en
 * charge, « prise en charge » seul ne les départage pas — la réponse est alors une QUESTION, jamais un choix.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface CandidatRecette {
  id: string;
  titre: string;
  motsCles: string;
}

export type Correspondance =
  | { verdict: "UNE"; id: string; score: number }
  | { verdict: "AMBIGU"; ids: string[] }
  | { verdict: "AUCUNE" };

const VIDES = new Set([
  "le", "la", "les", "de", "du", "des", "un", "une", "pour", "avec", "sur", "dans", "chez", "nous", "mon", "ma", "mes", "et", "en", "au",
  "aux", "fais", "faire", "prepare", "preparer", "lance", "lancer", "demande", "demandes", "comment", "on", "qui", "que", "quoi", "est",
  "ce", "cette", "ces", "il", "elle", "je", "tu", "vous", "moi", "notre", "nos", "son", "sa", "ses", "par", "plus", "tout", "tous", "dzd",
  "da", "jours", "jour", "semaine", "semaines", "sous", "ici", "dossier", "dossiers", "aide", "aider", "besoin", "veux", "voudrais", "faut",
]);

const racine = (m: string): string => {
  let r = m.replace(/(s|x)$/, "");
  if (r.length > 4) r = r.replace(/e$/, "");
  return r;
};

/** Les mots porteurs d'un texte : minuscules, sans accents, sans mots vides, réduits à leur racine. */
export function mots(texte: string): Set<string> {
  const t = texte.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ");
  return new Set(t.split(" ").filter((m) => m.length >= 3 && !VIDES.has(m) && !/^\d+$/.test(m)).map(racine));
}

export const SCORE_MIN = 2;

export function correspondance(intention: string, candidats: readonly CandidatRecette[]): Correspondance {
  const demande = mots(intention);
  if (!demande.size || !candidats.length) return { verdict: "AUCUNE" };
  const motsDe = candidats.map((c) => ({ c, m: mots(`${c.titre} ${c.motsCles}`) }));
  const frequence = new Map<string, number>();
  for (const { m } of motsDe) for (const x of m) frequence.set(x, (frequence.get(x) ?? 0) + 1);
  const scores = motsDe
    .map(({ c, m }) => ({ id: c.id, score: [...demande].reduce((s, x) => s + (m.has(x) ? (frequence.get(x) === 1 ? 2 : 1) : 0), 0) }))
    .filter((s) => s.score >= SCORE_MIN)
    .sort((a, b) => b.score - a.score);
  if (!scores.length) return { verdict: "AUCUNE" };
  const [premier, second] = scores;
  if (second && premier.score - second.score < 1) return { verdict: "AMBIGU", ids: scores.filter((s) => premier.score - s.score < 1).map((s) => s.id) };
  return { verdict: "UNE", id: premier.id, score: premier.score };
}
