/**
 * LE NIVEAU D'ACCÈS D'UN RÔLE, en un mot — pour la carte de la plateforme.
 *
 * La matrice dit sept actions par module ; un tableau de 19 rôles × 60 modules ne se lit pas en
 * actions. On les résume en un niveau, et le détail reste disponible au survol. Le niveau se
 * DÉDUIT des actions, il n'est jamais écrit à la main : la matrice reste la seule vérité.
 *
 * Module PUR — zéro import : lu par le serveur (calcul) et par le composant client (types, libellés).
 */

export type Niveau = "gerer" | "valider" | "ecrire" | "lire" | "aucun";

/** Du plus fort au plus faible. */
export const NIVEAUX: readonly Niveau[] = ["gerer", "valider", "ecrire", "lire", "aucun"];

export const LIBELLES_NIVEAU: Record<Niveau, string> = {
  gerer: "Gérer",
  valider: "Valider",
  ecrire: "Contribuer",
  lire: "Lire",
  aucun: "Aucun",
};

export const AIDE_NIVEAU: Record<Niveau, string> = {
  gerer: "Tout : voir, créer, modifier, supprimer, valider, exporter, téléverser.",
  valider: "Peut valider (trancher) sans avoir tous les droits.",
  ecrire: "Peut créer, modifier ou téléverser, sans valider.",
  lire: "Voir (et exporter) seulement.",
  aucun: "Pas d'accès par défaut (la console peut en ouvrir un).",
};

export const LIBELLES_ACTION: Record<string, string> = {
  VIEW: "Voir",
  CREATE: "Créer",
  UPDATE: "Modifier",
  DELETE: "Supprimer",
  VALIDATE: "Valider",
  EXPORT: "Exporter",
  UPLOAD: "Téléverser",
};

/** Le niveau que donnent ces actions. Sans « Voir », aucun écran ne s'ouvre : aucun accès. */
export function niveauDe(actions: readonly string[]): Niveau {
  const a = new Set(actions);
  if (!a.has("VIEW")) return "aucun";
  if (a.has("CREATE") && a.has("DELETE") && a.has("VALIDATE")) return "gerer";
  if (a.has("VALIDATE")) return "valider";
  if (a.has("CREATE") || a.has("UPDATE") || a.has("UPLOAD")) return "ecrire";
  return "lire";
}

/** Le plus fort de plusieurs niveaux (un module de la carte peut couvrir plusieurs clés RBAC). */
export function meilleurNiveau(niveaux: readonly Niveau[]): Niveau {
  for (const n of NIVEAUX) if (niveaux.includes(n)) return n;
  return "aucun";
}

/** L'accès d'UN rôle à UN module de la carte : son niveau, et le détail par clé RBAC. */
export interface AccesRole {
  niveau: Niveau;
  /** Une ligne par clé RBAC : « Sponsoring : Voir, Créer… ». */
  detail: string[];
}

/** moduleId → rôle → accès. */
export type MatriceAcces = Record<string, Record<string, AccesRole>>;
