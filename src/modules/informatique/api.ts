/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * PORTE SERVEUR du département Informatique (Super Admin, 24/11/2026 : « un département informatique, avec ses propres
 * modules, bases de données, etc. Et il aura son propre budget également »).
 *
 * Tables possédées : `AbonnementInformatique`, `MaterielInformatique`, `ImputationCoutIa`. Lit (sans les posséder) le
 * journal des appels de modèle (`ModelCallLog`), l'organigramme (`Department.cle = INFORMATIQUE`) et le budget
 * (`BudgetEnvelope` / `BudgetCategoryLine` / `BudgetExpenseLine` : il ouvre l'enveloppe Informatique et y impute le coût IA).
 *
 * Un composant client n'importe jamais cette porte : il lit `partage.ts` et appelle les actions.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export * from "./partage";

// ── L'organigramme et le budget
export { assurerDepartementInformatique, responsablesInformatique } from "./infra/departement";
export { enveloppeInformatique, type EnveloppeInformatique } from "./infra/budget";

// ── Le coût de l'IA, imputé chaque mois
export {
  agregerJournalDuMois, calculerCoutIaDuMois, dernierTauxFixe, imputerCoutIaDuMois, rattachementsDesPersonnes,
  type ImputationSociete, type ResultatImputation,
} from "./infra/imputation";

// ── Les tâches de fond (`lib/scheduled.ts`)
export { tacheCoutIa, tacheRappelsAbonnements } from "./infra/taches";

// ── Les lectures des écrans
export {
  vueAbonnements, vueCoutIa, vueParc,
  type ApercuMois, type LigneAbonnement, type LigneMateriel, type RapprochementSociete, type Societe, type VueAbonnements, type VueCoutIa, type VueParc,
} from "./infra/requetes";
