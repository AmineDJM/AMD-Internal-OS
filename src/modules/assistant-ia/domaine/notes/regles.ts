import type { BlocNote } from "./blocs";

/**
 * « MES NOTES » — LES RÈGLES DE GARDE (décision 0026) — PURES : quand garder une version, quand la corbeille
 * oublie, ce que le modèle lit d'une page.
 */

/** Une version au plus toutes les 5 minutes de frappe (l'enregistrement automatique part toutes les secondes). */
export const VERSION_TOUTES_LES_MS = 5 * 60_000;
export const VERSIONS_MAX = 50;
export const CORBEILLE_JOURS = 30;
const JOUR_MS = 86_400_000;

/**
 * GARDER L'ÉTAT D'AVANT ? Toujours avant une modification de l'IA ou une restauration ; sinon si la dernière version
 * date de plus de 5 minutes (ou n'existe pas).
 */
export function doitGarderVersion(derniere: Date | null, maintenant: Date, auteur: "PERSONNE" | "IA" | "RESTAURATION"): boolean {
  if (auteur !== "PERSONNE") return true;
  return !derniere || maintenant.getTime() - derniere.getTime() >= VERSION_TOUTES_LES_MS;
}

/** La date au-delà de laquelle la corbeille oublie (30 jours). */
export function limiteCorbeille(maintenant: Date): Date {
  return new Date(maintenant.getTime() - CORBEILLE_JOURS * JOUR_MS);
}

/** Les jours qui restent avant l'oubli (affiché : « encore 12 jours »). */
export function joursRestants(supprimeLe: Date, maintenant: Date): number {
  return Math.max(0, CORBEILLE_JOURS - Math.floor((maintenant.getTime() - supprimeLe.getTime()) / JOUR_MS));
}

/**
 * UNE LIGNE AU CONTEXTE SENSIBLE — une note de paie, une prime, un IBAN : TOUS ses montants partent au modèle en
 * repères ⟦Sn⟧ (le filtre général ne reconnaît un salaire que s'il est nommé juste à côté du chiffre).
 */
export const CONTEXTE_SENSIBLE = /\b(salaires?|paies?|primes?|r[ée]mun[ée]rations?|net|brut|bulletins?|virements?\s+de\s+salaire|iban|rib|ccp|passeports?|cni|nin|augmentations?|indemnit[ée]s?)\b/i;

export const estLigneSensible = (texte: string): boolean => CONTEXTE_SENSIBLE.test(texte);

/** Au plus ce que le modèle lit des notes en un appel — le reste est dit tronqué. */
export const CARACTERES_MAX_MODELE = 6_000;

const PUCE: Record<BlocNote["type"], (b: BlocNote) => string> = {
  texte: () => "",
  titre: () => "# ",
  puce: () => "- ",
  tache: (b) => (b.fait ? "[x] " : "[ ] "),
};

/**
 * CE QUE LE MODÈLE LIT d'une page : une ligne par bloc, indentée, avec sa référence (l'identifiant que les gestes
 * citent). `transformer` passe sur chaque texte (le serveur y jetonne les montants d'une ligne sensible).
 */
export function lignesPourModele(blocs: readonly BlocNote[], transformer: (texte: string) => string = (t) => t): string[] {
  return blocs.map((b) => `${"  ".repeat(b.niveau)}${PUCE[b.type](b)}${transformer(b.texte) || "(vide)"}  ⟨${b.id}⟩`);
}

/** Les lignes bornées à `max` caractères : `tronque` dit qu'il en manque. */
export function borner(lignes: string[], max = CARACTERES_MAX_MODELE): { lignes: string[]; tronque: boolean } {
  const out: string[] = [];
  let n = 0;
  for (const l of lignes) {
    if (n + l.length + 1 > max) return { lignes: out, tronque: true };
    out.push(l);
    n += l.length + 1;
  }
  return { lignes: out, tronque: false };
}

/** La règle des notes dite au modèle — seulement quand l'un de ses outils est offert (`contexte.ts`, `REGLE_SI_OUTIL`). */
export const REGLE_NOTES =
  "Mes notes (bloc-notes privé de la personne) : « ajoute X à ma liste / à mes notes », « note que… », « coche… », « qu'est-ce qu'il me reste ? » → lire_notes puis "
  + "ajouter_note, modifier_note, cocher_note, deplacer_note, supprimer_note, creer_page, renommer_page (références ⟨…⟩ de lire_notes). Chaque geste n'est qu'une "
  + "PROPOSITION que la personne accepte ou refuse dans son panneau : dis « je vous propose », jamais « c'est fait ». Ne lis ses notes que si la demande s'y rapporte. "
  + "« Fais-en une tâche / une demande / un travail » : lis la ligne, puis l'outil habituel (create_task, preparer_*, lancer_un_travail) avec sa carte ; "
  + "propose ensuite de cocher la ligne. « Retiens que… » reste la mémoire (proposer_memoire), pas les notes.";
