import type { Ligne } from "@/platform/ia/analyse/analyse";
import { MOTS_CLES_SENSIBLES } from "../filtre-confidentialite";

/**
 * LES COLONNES CONFIDENTIELLES D'UN TABLEAU (lot K1, décision 0031) — décision 0012 appliquée aux EN-TÊTES.
 *
 * Le filtre de confidentialité reconnaît une clé JSON exacte (« salaire ») ; un tableur, lui, nomme ses colonnes
 * comme il veut : « Salaire de base (DZD) », « N° IBAN », « Rémunération brute ». Une colonne dont l'en-tête
 * CONTIENT un mot sensible est masquée AVANT tout calcul : le modèle n'en reçoit ni les valeurs ni un agrégat
 * (une somme de salaires est un salaire), et l'écran dit qu'elle a été masquée. Les mots très courts (« rib »,
 * « nin », « cni ») ne valent qu'en mot entier — « attribution » n'est pas un RIB.
 */

const plier = (t: string): string => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const LONGS = MOTS_CLES_SENSIBLES.filter((m) => m.length >= 5);
const COURTS = MOTS_CLES_SENSIBLES.filter((m) => m.length < 5);
/** Les formes d'en-tête qu'un tableur écrit en plusieurs mots. */
const EXPRESSIONS = [/salaire/, /remuneration/, /net a payer/, /brut mensuel/, /prime[s]? (de|d')/, /coordonnees? bancaires?/, /numero de compte/, /n° ?(de )?compte/, /piece d'identite/, /carte d'identite/, /passeport/];

export const MASQUE_COLONNE = "[confidentiel]";

export function estColonneConfidentielle(entete: string): boolean {
  const p = plier(entete);
  const colle = p.replace(/[^a-z0-9]/g, "");
  if (LONGS.some((m) => colle.includes(m))) return true;
  if (EXPRESSIONS.some((re) => re.test(p))) return true;
  const mots = p.split(/[^a-z0-9]+/).filter(Boolean);
  return COURTS.some((m) => mots.includes(m));
}

/** MASQUER : les valeurs des colonnes confidentielles deviennent « [confidentiel] » — avant le moindre calcul. */
export function masquerColonnes(lignes: readonly Ligne[]): { lignes: Ligne[]; masquees: string[] } {
  const cles = [...new Set(lignes.slice(0, 2_000).flatMap((l) => Object.keys(l)))];
  const masquees = cles.filter(estColonneConfidentielle);
  if (!masquees.length) return { lignes: [...lignes], masquees };
  const set = new Set(masquees);
  return {
    lignes: lignes.map((l) => Object.fromEntries(Object.entries(l).map(([k, v]) => [k, set.has(k) && v !== null && v !== undefined && v !== "" ? MASQUE_COLONNE : v]))),
    masquees,
  };
}
