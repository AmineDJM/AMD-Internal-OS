// ⚠️  Module de CHARGEMENT — les données vivent dans `contrat.genere.json`, produit par
// `npm run actions:contrat` depuis la SOURCE du parc (src/lib/actions/ et
// les actions.ts des modules, voir parc.ts). Le cliquet
// `contrat.test.ts` redérive et compare : toute dérive échoue.
//
// Pourquoi du JSON et non du TypeScript : 715 littéraux d'objet en `.ts` faisaient BLOQUER
// l'extraction Graphify indéfiniment (mesuré). Une donnée générée est une donnée.
import type { ContratAction } from "./contrat";
import donnees from "./contrat.genere.json";

export const CONTRATS_ACTIONS: readonly ContratAction[] = donnees as readonly ContratAction[];

/** Index par id — `fichier:fonction`, la même clé que le registre de parité. */
export const CONTRAT_PAR_ID: ReadonlyMap<string, ContratAction> =
  new Map(CONTRATS_ACTIONS.map((c) => [c.id, c]));
