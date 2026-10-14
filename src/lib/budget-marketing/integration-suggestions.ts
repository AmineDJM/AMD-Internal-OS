/**
 * L'INTÉGRATION AD & PRO 2026 — TROUVER LA DEMANDE QUI EXISTE DÉJÀ (module PUR, sans import lourd).
 *
 * Pour chaque ligne du fichier, l'assistant cherche d'abord une demande 2026 de la même nature qui lui ressemble : le
 * NOM (mots communs), le MOIS, le MONTANT ; un indice de la maquette (« SPO-2026-003 », « poste billetterie à 124 750 »)
 * la met en tête. Il PROPOSE, la personne choisit « compléter celle-ci » ou « créer la demande historique » : rien
 * n'est rapproché d'office.
 */
import { normaliserTexte, type DemandePrevue, type TypeDemandeIntegree } from "./integration-2026";

export interface Candidate {
  type: TypeDemandeIntegree;
  id: string;
  reference: string | null;
  libelle: string;
  /** La date qui situe la demande (événement, demande), ISO. */
  date: string | null;
  /** Centimes : l'accordé, à défaut l'estimé. */
  montant: number | null;
  /** Les postes de la demande (libellé, accordé en centimes, fournisseur). */
  postes: { id: string; libelle: string; montant: number | null; fournisseur: string | null; historique: boolean }[];
}

export interface Suggestion {
  candidate: Candidate;
  score: number;
  raisons: string[];
  /** Le poste existant qui porte la dépense (un indice « poste » de la maquette), s'il est repéré. */
  posteRepere: string | null;
}

const MOTS_VIDES = new Set(["les", "des", "du", "de", "la", "le", "et", "aux", "pour", "programme", "service", "staff", "pr", "dr", "sponsoring", "congres", "prise", "charge"]);
const mots = (s: string): Set<string> => new Set(normaliserTexte(s).split(" ").filter((m) => m.length >= 3 && !MOTS_VIDES.has(m)));

/** Le score d'une candidate pour une demande prévue (0–100+). */
export function scorer(d: Pick<DemandePrevue, "type" | "libelle" | "mois" | "postes" | "existant">, c: Candidate, annee = 2026): Suggestion | null {
  const raisons: string[] = [];
  let score = 0;
  let posteRepere: string | null = null;
  const ex = d.existant;
  // Une autre nature ne se propose que par l'indice d'un POSTE (le poste billetterie des pharmaciens peut vivre sur un
  // sponsoring indirect) : son nom ou son montant ne suffisent pas.
  if (c.type !== d.type) {
    const p = ex?.poste ? c.postes.find((x) => !x.historique && x.montant === ex.poste!.montant && normaliserTexte(x.libelle).includes(normaliserTexte(ex.poste!.libelleContient))) : undefined;
    return p ? { candidate: c, score: 100, raisons: [`poste « ${p.libelle} » au même montant (${c.type})`], posteRepere: p.id } : null;
  }
  if (ex?.reference && c.reference && normaliserTexte(ex.reference) === normaliserTexte(c.reference)) {
    score += 100; raisons.push(`référence ${c.reference}`);
  }
  if (ex?.poste) {
    const p = c.postes.find((x) => !x.historique && x.montant === ex.poste!.montant && normaliserTexte(x.libelle).includes(normaliserTexte(ex.poste!.libelleContient)));
    if (p) { score += 100; posteRepere = p.id; raisons.push(`poste « ${p.libelle} » au même montant`); }
  }
  const a = mots(d.libelle), b = mots(c.libelle);
  const communs = [...a].filter((m) => b.has(m));
  if (communs.length) {
    const part = communs.length / Math.max(1, Math.min(a.size, b.size));
    score += Math.round(60 * Math.min(1, part));
    raisons.push(`nom (${communs.join(", ")})`);
  }
  if (c.date) {
    const dt = new Date(c.date);
    if (dt.getUTCFullYear() === annee && dt.getUTCMonth() + 1 === d.mois) { score += 20; raisons.push("même mois"); }
  }
  const total = d.postes.reduce((s, p) => s + p.montant, 0);
  if (c.montant != null && c.montant > 0) {
    if (c.montant === total) { score += 25; raisons.push("même montant"); }
    else if (Math.abs(c.montant - total) / total <= 0.05) { score += 10; raisons.push("montant proche"); }
  }
  return { candidate: c, score, raisons, posteRepere };
}

/** Le seuil sous lequel une candidate n'est pas proposée — et celui à partir duquel elle est cochée d'avance. */
export const SEUIL_SUGGESTION = 40;
export const SEUIL_PRESELECTION = 100;

/** Les trois meilleures candidates d'une demande prévue, la plus probable d'abord. */
export function suggestions(d: Pick<DemandePrevue, "type" | "libelle" | "mois" | "postes" | "existant">, candidates: readonly Candidate[], max = 3): Suggestion[] {
  return candidates
    .map((c) => scorer(d, c))
    .filter((s): s is Suggestion => s !== null && s.score >= SEUIL_SUGGESTION)
    .sort((x, y) => y.score - x.score)
    .slice(0, max);
}

/**
 * LES POSTES D'UNE DEMANDE COMPLÉTÉE : chaque poste prévu reprend un poste existant (même montant, ou le poste repéré),
 * jamais deux fois le même ; sinon il est créé. Un poste déjà historique n'est jamais repris.
 */
export function apparierPostes(
  prevus: readonly { libelle: string; montant: number }[],
  existants: readonly { id: string; libelle: string; montant: number | null; historique: boolean }[],
  posteRepere: string | null,
): (string | null)[] {
  const pris = new Set<string>();
  // Une dépense d'un seul poste sur une demande d'un seul poste : c'est lui (le webinaire SAI accordé 53 350, retenu 53 550).
  const libres = existants.filter((e) => !e.historique);
  if (prevus.length === 1 && libres.length === 1) return [libres[0].id];
  return prevus.map((p, i) => {
    if (i === 0 && posteRepere && !pris.has(posteRepere) && existants.some((e) => e.id === posteRepere && !e.historique)) { pris.add(posteRepere); return posteRepere; }
    const meme = existants.find((e) => !e.historique && !pris.has(e.id) && e.montant === p.montant);
    if (meme) { pris.add(meme.id); return meme.id; }
    const nom = existants.find((e) => !e.historique && !pris.has(e.id) && normaliserTexte(e.libelle) === normaliserTexte(p.libelle));
    if (nom) { pris.add(nom.id); return nom.id; }
    return null;
  });
}
