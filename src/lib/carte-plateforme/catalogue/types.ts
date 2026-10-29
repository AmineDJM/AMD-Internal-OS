/**
 * LA CARTE DE LA PLATEFORME — les TYPES du catalogue (domaine, module, geste, circuit, mécanisme)
 * et les libellés des types d'acteur. Zéro import : lu par un composant `"use client"`.
 */

export type CleDomaine =
  | "pilotage" | "regulatory" | "marketing" | "operations" | "administration"
  | "argent" | "transverse" | "systeme" | "externe";

export interface Domaine {
  cle: CleDomaine;
  nom: string;
  resume: string;
}

/** Qui agit à une étape — décide la couleur de l'étape dans un circuit. */
export type TypeActeur = "demandeur" | "decideur" | "execution" | "argent" | "systeme" | "externe";

export interface Geste {
  /** Le libellé du bouton ou du geste, tel qu'on le voit à l'écran. */
  label: string;
  qui: string;
  effet: string;
}

export interface Lien {
  vers: string;
  pourquoi: string;
}

export interface ModulePlateforme {
  id: string;
  nom: string;
  /** L'adresse de l'écran ; `null` quand le module n'a pas d'écran propre. */
  route: string | null;
  domaine: CleDomaine;
  /** Les clés de module RBAC qui gouvernent l'écran (lues dans `PERMISSIONS` par la page). */
  rbac: readonly string[];
  resume: string;
  pourQui: string;
  gestes: readonly Geste[];
  regles: readonly string[];
  liens: readonly Lien[];
}

export interface EtapeCircuit {
  acteur: string;
  type: TypeActeur;
  /** L'id du module où l'étape se joue. */
  module: string;
  action: string;
  effet: string;
  /** Une étape qui peut dire non (approuver / refuser / renvoyer). */
  decision?: boolean;
}

export interface Circuit {
  id: string;
  titre: string;
  domaine: CleDomaine;
  resume: string;
  declencheur: string;
  etapes: readonly EtapeCircuit[];
  aRetenir: readonly string[];
}

export interface Mecanisme {
  titre: string;
  resume: string;
  details: readonly string[];
}

export const TYPES_ACTEUR: Record<TypeActeur, string> = {
  demandeur: "Demandeur",
  decideur: "Décideur",
  execution: "Exécution",
  argent: "Argent",
  systeme: "Automatique",
  externe: "Externe",
};
