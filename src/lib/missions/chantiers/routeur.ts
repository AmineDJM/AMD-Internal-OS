/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE ROUTEUR DE MODÈLES DES CHANTIERS (lot C1, décision 0042 ; CHANTIERS-DEV.md § 2) — pur, testé, zéro import.
 *
 *   DETERMINISTE → MIMO → TERRA → SOL
 *
 * Le moins coûteux CAPABLE d'abord : un statut de CI, un code HTTP, la présence d'un commit, une regex d'erreur se
 * lisent sans modèle. MiMo lit et écrit du texte (logs, diff, consigne) ; Terra décide quand la suite en dépend ;
 * Sol n'est appelé QUE par la règle d'escalade (même signature d'échec deux fois), un conflit fonctionnel ou un
 * arbitrage d'architecture. Un modèle absent fait descendre d'un cran vers le moins cher — jamais monter en silence.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type NiveauModele = "DETERMINISTE" | "MIMO" | "TERRA" | "SOL";

export type NatureBesoin =
  /** Un état lisible par le code : statut de CI, code HTTP, commit présent, déploiement live. */
  | "statut"
  /** Lire un texte long et en extraire l'utile (logs de CI, diff, journaux Render). */
  | "lecture"
  /** Écrire un texte (consigne de correction, résumé). */
  | "redaction"
  /** Une décision qui engage la suite (accepter un résultat NON déterministe, choisir une voie). */
  | "decision"
  /** Conflit fonctionnel entre chantiers, arbitrage d'architecture. */
  | "arbitrage";

export interface BesoinModele {
  nature: NatureBesoin;
  /** Le texte à lire tient-il sous ce seuil ? Alors le code suffit (on le transmet tel quel). */
  caracteres?: number;
  /** Le risque de la décision : un risque haut fait relire la rédaction de MiMo par Terra. */
  risque?: "bas" | "moyen" | "haut";
  /** La règle d'escalade (anti-boucle) demande Sol pour CET échec. */
  escalade?: boolean;
  /** Ce qui est branché (clé présente). */
  disponibles: { mimo: boolean; terra: boolean; sol: boolean };
}

/** Sous ce volume, un extrait de log se transmet tel quel : le résumer coûterait plus qu'il ne rapporte. */
export const SEUIL_LECTURE_SANS_MODELE = 1_500;

export interface Routage {
  niveau: NiveauModele;
  /** Relecture par Terra d'un texte écrit par MiMo (risque haut). */
  relecture: boolean;
  raison: string;
}

const premierDisponible = (ordre: readonly NiveauModele[], d: BesoinModele["disponibles"]): NiveauModele | null =>
  ordre.find((n) => n === "DETERMINISTE" || (n === "MIMO" && d.mimo) || (n === "TERRA" && d.terra) || (n === "SOL" && d.sol)) ?? null;

export function routerModele(b: BesoinModele): Routage {
  const d = b.disponibles;
  if (b.nature === "statut") return { niveau: "DETERMINISTE", relecture: false, raison: "un état se lit sans modèle" };
  if (b.nature === "lecture" && (b.caracteres ?? 0) <= SEUIL_LECTURE_SANS_MODELE) {
    return { niveau: "DETERMINISTE", relecture: false, raison: "extrait court : transmis tel quel" };
  }
  if (b.escalade || b.nature === "arbitrage") {
    const n = premierDisponible(["SOL", "TERRA"], d);
    if (n) return { niveau: n, relecture: false, raison: n === "SOL" ? (b.escalade ? "même échec deux fois : Sol, une fois" : "arbitrage") : "Sol indisponible : Terra" };
  }
  if (b.nature === "decision") {
    const n = premierDisponible(["TERRA", "MIMO", "DETERMINISTE"], d);
    return { niveau: n ?? "DETERMINISTE", relecture: false, raison: n === "TERRA" ? "une décision engage la suite" : "Terra indisponible" };
  }
  // lecture longue, rédaction : MiMo, l'exécutant bon marché ; Terra relit si le risque est haut.
  const n = premierDisponible(["MIMO", "TERRA", "DETERMINISTE"], d) ?? "DETERMINISTE";
  return {
    niveau: n,
    relecture: n === "MIMO" && b.risque === "haut" && d.terra,
    raison: n === "MIMO" ? "texte à lire ou écrire : MiMo" : n === "TERRA" ? "MiMo indisponible : Terra" : "aucun modèle branché : texte brut",
  };
}

/** Les identifiants des modèles — Terra et Sol sont sur la grille (`tarifs.ts`) ; MiMo se règle par l'environnement. */
export const MODELE_TERRA = "gpt-6.1-terra";
export const MODELE_SOL = "gpt-6.1-sol";
