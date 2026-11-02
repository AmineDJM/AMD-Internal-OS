/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE VOCABULAIRE DU RÉFÉRENTIEL D'ENTITÉS (§10) — zéro import.
 *
 * ── CE QUE « RÉSOUDRE UNE ENTITÉ » VEUT DIRE ─────────────────────────────────────────────
 *
 * Quelqu'un écrit « Keytruda », « pembrolizumab », « REG-2026-041 » ou « SD Pharma ». Ces quatre
 * chaînes désignent des choses que l'ERP connaît déjà, sous d'autres noms. Résoudre, c'est
 * retrouver LAQUELLE — avec un score, une raison, et le droit de dire « je ne sais pas ».
 *
 * ── LA RÈGLE QUI TIENT TOUT LE RESTE ─────────────────────────────────────────────────────
 *
 * **Aucun savoir pharmaceutique n'est codé ici.** Que Keytruda soit du pembrolizumab n'est pas
 * une connaissance de ce module : c'est une ligne de `RegulatoryProduct`, où `brandName` et `dci`
 * cohabitent. La projection LIT cette ligne. Un dictionnaire écrit à la main serait faux le
 * lendemain, incomplet sur les produits d'Adventum — précisément ceux qui comptent — et
 * personne ne saurait dire d'où il tient ce qu'il affirme.
 *
 * ── POURQUOI UNE FUSION SILENCIEUSE EST INTERDITE ────────────────────────────────────────
 *
 * Deux sociétés qui se ressemblent restent deux sociétés. Le résolveur RANGE des candidats ; il
 * ne décide « c'est celle-là » que lorsqu'un candidat s'impose nettement. Ailleurs, il rend la
 * liste et laisse l'appelant demander. Poser une question coûte une seconde ; confondre deux
 * fournisseurs dans une écriture financière coûte beaucoup plus.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/**
 * LES FAMILLES D'ENTITÉS. Liste FERMÉE, pour la même raison que les prédicats de relation : un
 * vocabulaire qui s'invente au fil de l'eau devient impossible à interroger sans deviner.
 */
export type EntityKind =
  | "person"        // un humain : compte ERP, fiche RH, contact d'annuaire
  | "company"       // une entité juridique du groupe (Adventum, Pharmagène…)
  | "supplier"      // un fournisseur / laboratoire partenaire
  | "product"       // un dossier produit (une ligne Regulatory)
  | "molecule"      // une DCI — plusieurs produits peuvent la partager
  | "organization"; // un tiers : agence, imprimeur, autorité, société externe

/**
 * D'OÙ VIENT UNE GRAPHIE.
 *
 * `erp:<colonne>` est le seul cas où l'alias est un FAIT de l'entreprise. `derived` est un calcul
 * (des initiales), donc une hypothèse : il pèse moins. `user` est une saisie humaine, qui fait
 * autorité sur l'usage mais pas sur l'orthographe officielle.
 */
export type AliasSource = `erp:${string}` | "derived" | "user";

/**
 * LE POIDS D'UNE GRAPHIE — combien elle identifie l'entité, et non combien elle lui ressemble.
 *
 * Une référence (« REG-2026-041 ») est unique par construction : elle vaut 1. Un acronyme dérivé
 * est ambigu par construction — « SAI » peut désigner trois organisations — donc il vaut moins,
 * et cela suffit à le faire perdre contre une vraie raison sociale sans avoir à l'exclure.
 */
export const ALIAS_WEIGHT = {
  reference: 1,     // identifiant unique de l'ERP
  canonical: 1,     // le nom officiel
  commercial: 0.95, // nom déposé / nom commercial
  scientific: 0.9,  // DCI, dénomination scientifique
  short: 0.85,      // libellé court, nom d'usage
  derived: 0.6,     // calculé (initiales) — une hypothèse, pas un fait
} as const;

/** Un candidat rendu par le résolveur. */
export interface EntityCandidate {
  entityId: string;
  kind: EntityKind;
  canonicalName: string;
  refType: string | null;
  refId: string | null;
  companyId: string | null;
  /** 0..1, comparable d'une requête à l'autre. */
  score: number;
  /** La raison LISIBLE — la confiance s'explique, elle ne s'affirme pas. */
  why: string;
  /** La graphie qui a produit le rapprochement. */
  matchedAlias: string;
}

export interface EntityResolution {
  /** `decisive` : un candidat s'impose. `ambiguous` : plusieurs. `none` : rien de crédible. */
  kind: "decisive" | "ambiguous" | "none";
  best: EntityCandidate | null;
  candidates: EntityCandidate[];
}

/**
 * LE SEUIL DE DÉCISION et l'ÉCART MINIMAL.
 *
 * Deux conditions, pas une : le meilleur doit être bon DANS L'ABSOLU (0,82) *et* nettement devant
 * le suivant (0,15). Un seul de ces deux tests laisserait passer le cas dangereux — deux
 * fournisseurs presque homonymes, tous deux à 0,9, dont on choisirait le premier par hasard
 * d'ordre de tri.
 */
export const DECISIVE_SCORE = 0.82;
export const DECISIVE_GAP = 0.15;

/**
 * SOUS CE SCORE, ON NE PROPOSE MÊME PAS. Un candidat à 0,3 n'aide personne : il allonge la liste,
 * dilue l'attention, et donne à un rapprochement hasardeux l'apparence d'une piste.
 */
export const MIN_CANDIDATE_SCORE = 0.45;

/**
 * COMBIEN DE MENTIONS ON RETIENT PAR DOCUMENT.
 *
 * Une borne existe parce qu'un contrat de 40 pages cite parfois 200 fois la même poignée de
 * sociétés : au-delà, chaque arête supplémentaire coûte une écriture et n'apprend rien.
 */
export const MAX_MENTIONS_PER_ITEM = 40;

/**
 * L'ENTITÉ EST-ELLE ASSEZ SÛRE POUR ÊTRE ÉCRITE COMME UN LIEN ?
 *
 * §22 : une donnée structurée ne se remplit jamais silencieusement depuis une extraction
 * incertaine. Une arête de graphe est une donnée structurée.
 */
export function isDecisive(best: EntityCandidate | null, second: EntityCandidate | null): boolean {
  if (!best || best.score < DECISIVE_SCORE) return false;
  if (!second) return true;
  // Deux graphies de la MÊME entité ne sont pas une ambiguïté — c'est le même objet deux fois.
  if (second.entityId === best.entityId) return true;
  return best.score - second.score >= DECISIVE_GAP;
}
