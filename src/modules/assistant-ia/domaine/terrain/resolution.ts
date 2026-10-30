/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * RETROUVER CE QUI EST DIT DANS L'ANNUAIRE (lot J13, décision 0025) — règle PURE, zéro import.
 *
 * Le modèle rend « Benali » ; l'annuaire du délégué connaît « BEN ALI Karim » et « BENALLAL Sofiane ». On ne
 * devine pas : un médecin n'est RÉSOLU que s'il ressort seul, nettement devant le suivant ; sinon la carte
 * montre les candidats (AMBIGU) ou dit qu'il n'est pas dans l'annuaire (INCONNU) — jamais un nom choisi à la
 * place du délégué. Les candidats sont déjà ceux de SON périmètre (lu sous ses droits, côté serveur).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface CandidatMedecin {
  id: string;
  nom: string;
  etablissement?: string | null;
  specialite?: string | null;
}

export type ResolutionMedecin =
  | { statut: "RESOLU"; medecin: CandidatMedecin; score: number }
  | { statut: "AMBIGU"; candidats: CandidatMedecin[] }
  | { statut: "INCONNU" };

export const SEUIL_MEDECIN = 0.78;
/** Avance exigée sur le second : en dessous, deux médecins se valent et la personne choisit. */
export const ECART_MEDECIN = 0.12;

const TITRES = /\b(dr|docteur|doctoresse|pr|prof|professeur|mme|mr|m|madame|monsieur|el)\b\.?/g;

export const replier = (s: string): string =>
  s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").replace(TITRES, " ").replace(/\s+/g, " ").trim();

function distance(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

/** Ressemblance de deux mots, de 0 à 1 (1 − distance d'édition relative). */
export function ressemblance(a: string, b: string): number {
  if (!a || !b) return 0;
  return 1 - distance(a, b) / Math.max(a.length, b.length);
}

/**
 * Le score d'un nom dit contre un nom d'annuaire : chaque mot dit cherche son meilleur mot en face ; les mots
 * collés comptent aussi (« Benali » contre « Ben Ali »). La moyenne des mots DITS : dire « Benali » seul suffit
 * à trouver « BEN ALI Karim », dire « Karim » seul ne suffit pas s'il y a deux Karim.
 */
export function scoreNom(dit: string, annuaire: string): number {
  const d = replier(dit).split(" ").filter(Boolean);
  const a = replier(annuaire).split(" ").filter(Boolean);
  if (!d.length || !a.length) return 0;
  const colleA = a.join("");
  const colleD = d.join("");
  const formesA = [...a];
  for (let i = 0; i + 1 < a.length; i += 1) formesA.push(a[i] + a[i + 1]);
  const parMots = d.reduce((s, m) => s + Math.max(...formesA.map((x) => ressemblance(m, x))), 0) / d.length;
  // Tout le nom dit, collé, contenu dans le nom d'annuaire collé (« ouldali » dans « ouldaliyacine ») : un nom de famille composé.
  const colle = colleA.includes(colleD) && colleD.length >= 4 ? Math.max(0.9, colleD.length / colleA.length) : ressemblance(colleD, colleA);
  return Math.max(parMots, colle);
}

export function resoudreMedecin(dit: string | null, etablissementDit: string | null, candidats: CandidatMedecin[]): ResolutionMedecin {
  if (!dit || !replier(dit)) return { statut: "INCONNU" };
  const notes = candidats
    .map((c) => {
      let score = scoreNom(dit, c.nom);
      // L'établissement départage, il ne fait pas trouver : un bonus (de la taille de l'écart exigé), seulement si
      // le nom ressemble déjà. Non plafonné ici, pour que deux « 1 » se départagent ; le score rendu, lui, l'est.
      if (etablissementDit && c.etablissement && score >= SEUIL_MEDECIN - 0.1) {
        const e = scoreNom(etablissementDit, c.etablissement);
        if (e >= 0.75) score += ECART_MEDECIN;
      }
      return { c, score };
    })
    .filter((x) => x.score >= SEUIL_MEDECIN - 0.1)
    .sort((x, y) => y.score - x.score);
  if (!notes.length || notes[0].score < SEUIL_MEDECIN) {
    return notes.length ? { statut: "AMBIGU", candidats: notes.slice(0, 4).map((x) => x.c) } : { statut: "INCONNU" };
  }
  const second = notes[1]?.score ?? 0;
  if (notes[0].score - second < ECART_MEDECIN) {
    return { statut: "AMBIGU", candidats: notes.filter((x) => x.score >= notes[0].score - ECART_MEDECIN).slice(0, 4).map((x) => x.c) };
  }
  return { statut: "RESOLU", medecin: notes[0].c, score: Number(Math.min(1, notes[0].score).toFixed(2)) };
}

export interface ProduitConnu { id: string; nom: string }

/** Les produits dits, retrouvés au catalogue de la gamme — un produit non retrouvé reste nommé, sans identifiant. */
export function resoudreProduits(dits: string[], catalogue: ProduitConnu[]): { dit: string; produit: ProduitConnu | null }[] {
  return dits.map((dit) => {
    const best = catalogue
      .map((p) => ({ p, s: Math.max(scoreNom(dit, p.nom), ressemblance(replier(dit), replier(p.nom).split(" ")[0] ?? "")) }))
      .sort((a, b) => b.s - a.s)[0];
    return { dit, produit: best && best.s >= 0.8 ? best.p : null };
  });
}
