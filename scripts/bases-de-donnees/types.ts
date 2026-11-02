/**
 * LE CATALOGUE DES « BASES » (lot D1, demande de la Direction du 02/11/2026) — les types.
 *
 * Il n'y a qu'UNE base PostgreSQL. Une « base », ici, est une FAMILLE de tables métier (RH, paie, finances…),
 * au sens où la Direction l'entend : ce qu'on voudrait pouvoir ouvrir ou fermer d'un bloc.
 * Chaque modèle de `prisma/schema.prisma` est rangé dans EXACTEMENT une base ; le test
 * `src/platform/bases-de-donnees.test.ts` le garantit (une table neuve non rangée fait échouer la suite).
 *
 * Règle de rangement : LE CONTENU SUIT SA BASE. Une table technique qui porte le contenu d'un métier (le cache
 * des appels IA du réglementaire, les morceaux d'un dépôt réglementaire) reste dans la base de ce métier : fermer
 * la base doit fermer aussi ses copies. Les bases « techniques » ne rangent que ce qui ne porte le contenu d'aucun
 * métier, ou le porte pour TOUS (journaux, comptes, IA, plateforme).
 */
import type { Action, Module } from "@/lib/rbac/modules";
import type { FamilleIa } from "@/platform/ia/capacites/familles";

/** Du moins au plus sensible. */
export const NIVEAUX = ["public-interne", "restreint", "confidentiel", "secret"] as const;
export type Sensibilite = (typeof NIVEAUX)[number];

export const LIBELLE_NIVEAU: Record<Sensibilite, string> = {
  "public-interne": "Public interne",
  restreint: "Restreint",
  confidentiel: "Confidentiel",
  secret: "Secret",
};

export interface BaseDef {
  /** Clé stable (kebab-case), celle qu'un futur réglage « accès par base » enregistrerait. */
  cle: string;
  nom: string;
  nature: "metier" | "technique";
  /** Sa raison d'être, en une phrase. */
  raison: string;
  /** Le niveau de la base ; une table plus sensible le dit dans `plusSensibles`. */
  sensibilite: Sensibilite;
  /** Le module ERP (écran + code) qui l'écrit. Les écrivains mesurés table par table viennent du contrat des actions. */
  ecritPar: string;
  /** Les modules RBAC qui en ouvrent la lecture aujourd'hui (matrice `PERMISSIONS` + surcharges `UserAccess`). */
  modules: Module[];
  /** Le geste qu'exige la LECTURE quand ce n'est pas `VIEW` (la paie : RH en modification). */
  lectureExige?: Action;
  /** Les familles de l'assistant IA qui la couvrent (`AssistantIaAcces`, décision 0012 / S1). */
  famillesIa: FamilleIa[];
  /** Les autres mécanismes qui bornent l'accès aujourd'hui (périmètre d'entité, coffre, règle propre…). */
  mecanismes: string[];
  /** Modèle Prisma → libellé français. */
  tables: Record<string, string>;
  /** Tables plus sensibles que leur base, avec la raison (les champs en cause). */
  plusSensibles?: Record<string, { niveau: Sensibilite; pourquoi: string }>;
}
