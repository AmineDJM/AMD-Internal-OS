import { CHEMIN_AGENCES, LIBELLE_AGENCES } from "@/lib/chemins/ad-pro";

/**
 * LES RACCOURCIS DE « AUJOURD'HUI » — un libellé, une adresse, et le module dont la porte décide (filtré par l'appelant,
 * `composerRaccourcis`). Sortis de `aujourdhui.ts` (cliquet des 1 000 lignes) ; module PUR, lu aussi par le navigateur.
 */

export type CleRaccourci =
  | "validations" | "paiements" | "centre_paiement" | "info_med" | "adoption" | "admin" | "ad_pro"
  | "budget_marketing" | "budgets" | "directives" | "regulatory" | "pipeline" | "stocks" | "logistique"
  | "ventes" | "non_servi" | "pch" | "moyens_generaux" | "ma_journee" | "plan_tournee" | "coaching"
  | "rapports_terrain" | "secretariat" | "legal" | "drive" | "documents" | "bd" | "demandes_rh"
  | "conges_rh" | "formations" | "pieces" | "taches" | "promo" | "agences";

/** Le raccourci : un libellé, une adresse, et le module dont la porte décide (filtré par l'appelant). */
export const RACCOURCIS: Record<CleRaccourci, { label: string; href: string; module: string }> = {
  validations: { label: "Centre de validations", href: "/validations", module: "VALIDATIONS" },
  paiements: { label: "Paiements à faire", href: "/finances/paiements-a-faire", module: "FINANCES_BANQUE" },
  centre_paiement: { label: "Centre de paiement", href: "/centre-de-paiement", module: "PAYMENT_CENTRE" },
  info_med: { label: "Information médicale", href: "/information-medicale", module: "MEDICAL_INFO" },
  adoption: { label: "Score d'adoption", href: "/admin/adoption", module: "ADMIN" },
  admin: { label: "Administration", href: "/admin", module: "ADMIN" },
  ad_pro: { label: "Ad & Pro", href: "/ad-pro", module: "SPONSORING" },
  budget_marketing: { label: "Budget Marketing", href: "/budget-marketing", module: "BUDGET_MARKETING" },
  budgets: { label: "Budgets", href: "/budgets", module: "BUDGETS" },
  directives: { label: "Directives", href: "/directives", module: "DIRECTIVES" },
  regulatory: { label: "Suivi des dossiers", href: "/regulatory", module: "REGULATORY" },
  pipeline: { label: "Pipeline", href: "/regulatory/pipeline", module: "REGULATORY_PIPELINE" },
  stocks: { label: "Stocks", href: "/stocks", module: "STOCKS" },
  logistique: { label: "Logistique", href: "/logistics", module: "LOGISTICS" },
  ventes: { label: "Ventes PCH", href: "/sales", module: "PCH_VENTES" },
  non_servi: { label: "Non servi", href: "/sales/non-servi", module: "PCH_VENTES" },
  pch: { label: "Marchés PCH", href: "/pch", module: "PCH" },
  moyens_generaux: { label: "Moyens généraux", href: "/moyens-generaux", module: "GENERAL_MEANS" },
  ma_journee: { label: "Ma journée", href: "/medical/ma-journee", module: "MEDICAL" },
  plan_tournee: { label: "Plan de tournée", href: "/medical/plan-de-tournee", module: "MEDICAL" },
  coaching: { label: "Coaching", href: "/medical/coaching", module: "MEDICAL" },
  rapports_terrain: { label: "Rapports terrain", href: "/medical/rapports", module: "FIELD_REPORTS" },
  secretariat: { label: "Bureau du secrétariat", href: "/demandes", module: "ADMIN_REQUESTS" },
  legal: { label: "Legal", href: "/legal", module: "LEGAL" },
  drive: { label: "Drive", href: "/drive", module: "DRIVE" },
  documents: { label: "Documents", href: "/documents", module: "DOCUMENTS" },
  bd: { label: "Business Development", href: "/business-development/projets", module: "BD_PROJECTS" },
  demandes_rh: { label: "Demandes RH", href: "/rh/demandes", module: "HR_REQUESTS" },
  conges_rh: { label: "Congés et absences", href: "/rh/conges", module: "HR_REQUESTS" },
  formations: { label: "Formations", href: "/formations", module: "TRAINING" },
  pieces: { label: "Pièces demandées", href: "/pieces", module: "WORKSPACE" },
  taches: { label: "Mes tâches", href: "/mon-espace/taches", module: "WORKSPACE" },
  promo: { label: "Matériel promotionnel", href: "/promo-material", module: "PROMO_MATERIAL" },
  agences: { label: LIBELLE_AGENCES, href: CHEMIN_AGENCES, module: "WORKSPACE" },
};
