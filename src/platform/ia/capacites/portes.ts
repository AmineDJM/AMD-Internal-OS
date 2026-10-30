import { plierMot } from "./lexique";
import type { ContratLu } from "./types";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA PORTE D'ÉCRAN D'UNE ACTION, ET CE QUE L'ASSISTANT IA N'APPELLE JAMAIS (lot J6, décision 0020). Pur.
 *
 * ── LA PORTE ─────────────────────────────────────────────────────────────────────────────
 *
 * La SÉLECTION ne doit jamais montrer une capacité hors des droits de la personne. 262 actions nomment leur module
 * dans un `userCan` (lu par le contrat) ; pour les autres, la porte se lit, dans l'ordre, sur le libellé du module de
 * leur audit (« Regulatory »), puis sur le préfixe de leur fichier (vocabulaire ci-dessous). Une action dont la porte
 * ne se lit pas est réservée au Super Admin : on cache ce qu'on ne sait pas situer, on ne le montre pas « au cas où ».
 * La porte N'AUTORISE RIEN : l'action rejuge ses droits à l'exécution, sous la vraie session.
 *
 * ── LES SURFACES HORS DE L'ASSISTANT ─────────────────────────────────────────────────────
 *
 * En plus du refus d'auto-escalade et des attestations (`lib/actions/generique.ts`, injecté), quelques FICHIERS
 * entiers ne sont jamais appelés par l'Assistant IA : ses propres réglages et confirmations (un modèle qui confirmerait
 * ses cartes se signerait lui-même), Adam, la connexion, l'usurpation de vue, le portail des fournisseurs (une autre
 * session), la plomberie d'administration. Refus de CONCEPTION, nommé : le fichier entier, pour qu'une action ajoutée
 * demain y soit refusée sans que personne y pense.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const SURFACES_HORS_ASSISTANT: Readonly<Record<string, string>> = {
  "assistant-ia-actions": "les gestes de l'Assistant IA lui-même (confirmer ses cartes, ses travaux, sa mémoire) — il ne se confirme pas",
  "assistant-ia-atelier-actions": "les boutons de l'Atelier — l'assistant y agit par ses outils d'Atelier, sous les yeux de la personne",
  "assistant-ia-consommation-actions": "les plafonds et accès de l'Assistant IA (console du Super Admin)",
  "assistant-actions": "Adam, l'assistant du Super Admin — un autre produit",
  "adam-settings-actions": "les garde-fous d'Adam",
  "mission-runtime-actions": "le pilotage des missions d'Adam",
  "delegate-plan-actions": "les plans délégués d'Adam",
  "auth-actions": "la connexion d'une personne",
  "impersonation-actions": "la « Vue exacte » du Super Admin",
  "supplier-portal-actions": "le portail des fournisseurs — une autre session, un autre public",
  "onlyoffice-diagnostic-actions": "le diagnostic de l'éditeur de documents",
  "test-center-actions": "le centre de tests de la plateforme",
  "database-admin-actions": "l'administration de la base de données",
  "platform-audit-actions": "l'audit de la plateforme",
  "feature-actions": "les bascules de fonctionnalité",
  "ai-settings-actions": "les réglages des modèles d'IA",
  "access-actions": "les comptes et les droits",
  "company-access-actions": "le rattachement des personnes aux sociétés",
  "admin-delete-actions": "la suppression d'administration (corbeille du Super Admin)",
  "stand-in-actions": "l'intérim des droits d'un absent",
};

export function refusSurface(c: ContratLu): string | null {
  const s = SURFACES_HORS_ASSISTANT[c.fichier];
  return s ? `Cette action appartient à ${s}. L'Assistant IA ne l'appelle jamais : ce geste se fait à l'écran.` : null;
}

/** Les gardes qui réservent une action au Super Admin (ou à l'administration). */
const GARDES_SUPER_ADMIN = new Set(["requireAdmin", "requireChief", "peutPiloterMissionsAdam", "peutVoirAdam", "requireSuperAdmin", "isSuperAdmin"]);

const AD_PRO = ["SPONSORING", "CONGRESS_INTERNATIONAL", "CONGRESS_NATIONAL", "EVENTS", "AD_PRO_OTHER", "PROMO_MATERIAL", "AD_PRO_CENTRE", "VALIDATIONS"];
const BUDGET = ["BUDGETS", "BUDGET_MARKETING", "BUDGET_REGULATORY", "BUDGET_OPERATIONS", "BUDGET_CAMPAIGN"];
const FINANCE = ["FINANCES", "PAYMENT_CENTRE"];
const RH = ["RH", "HR_REQUESTS", "EMPLOYEES"];

/** Le préfixe d'un fichier d'actions → les modules dont l'un ouvre l'écran (vocabulaire, pas une table d'actions). */
const PREFIXES: readonly [RegExp, readonly string[]][] = [
  [/^(ad-pro|care|congress|integration-adpro|rapprochement-adpro|porte-dg|secretariat-devis|reservation-fiche|workflow|mission-actions|fabrique)/, AD_PRO],
  [/^validation/, ["VALIDATIONS", ...AD_PRO]],
  [/^sponsoring/, ["SPONSORING"]], [/^event/, ["EVENTS"]],
  [/^(task|meeting|calendar|reminder|notification|comment|link|entity-attach|partage|my-|onboarding|coaching|intelligence-terrain)/, ["WORKSPACE"]],
  [/^feedback/, ["FEEDBACK"]], [/^messaging/, ["MESSAGING"]],
  [/^(microsoft-mail|smart-mail|mail-actions)/, ["WORKSPACE"]],
  [/^mail-/, ["MAIL_REGISTER"]],
  [/^(hr|payroll-hr|conge|leave|interim)/, RH],
  [/^(expense|finance|invoice|payment|petty-cash|treasury|doublons-factures|relance-paiement|actualisation-soldes|repartition-couts)/, FINANCE],
  [/^(budget|department-budget|promo-budget)/, BUDGET],
  [/^kpi/, ["KPI"]], [/^training/, ["TRAINING"]],
  [/^(recruitment|recrutement|candidatures|offres-emploi)/, ["RECRUITMENT"]],
  [/^pharmacovigilance/, ["PHARMACOVIGILANCE"]], [/^segmentation/, ["SEGMENTATION", "SEGMENTATION_POTENTIEL"]],
  [/^(promo-stock|demande-stocks)/, ["PROMO_STOCK"]], [/^promo-catalogue/, ["PROMO_CATALOG"]], [/^promo/, ["PROMO_MATERIAL", ...AD_PRO]],
  [/^(stock-pch|ventes-pch|pch)/, ["PCH", "PCH_VENTES"]], [/^stock/, ["STOCKS"]],
  [/^medical-info/, ["MEDICAL_INFO"]], [/^(medical|annuaire|etablissement|lieux|personnes|organisation|fournisseurs-annuaire|directory|company-contact)/, ["MEDICAL", "DIRECTORIES"]],
  [/^(field-report|tour-)/, ["FIELD_REPORTS"]], [/^(sales-planning|force-de-vente)/, ["SALES_PLANNING", "SALES"]], [/^sales/, ["SALES"]],
  [/^bd/, ["BUSINESS_DEVELOPMENT", "BD_PROJECTS"]], [/^consulting/, ["CONSULTING"]],
  [/^legal/, ["LEGAL"]], [/^directive/, ["DIRECTIVES"]], [/^support/, ["SUPPORT"]], [/^dossier/, ["DOSSIERS"]],
  [/^(document|bibliotheque|knowledge)/, ["DOCUMENTS", "DRIVE"]], [/^drive/, ["DRIVE"]], [/^regulatory/, ["REGULATORY"]],
  [/^admin-request/, ["ADMIN_REQUESTS"]], [/^site-web/, ["SITE_WEB"]],
  [/^market/, ["PRODUCT_EXPLORER", "MARKETING_COCKPIT"]], [/^(product|produit|prix-produit)/, ["PRODUCTS", "REGULATORY"]],
  [/^(general-means|office-supply|natures-moyens-generaux|besoins-services)/, ["GENERAL_MEANS"]],
  [/^(direction-artistique|brand|letterhead)/, ["ART_DIRECTION"]], [/^consommation/, ["CONSUMPTION"]],
  [/^process-intelligence/, ["PROCESS_INTELLIGENCE"]], [/^logistics/, ["LOGISTICS"]], [/^supplier/, ["FINANCES", "DIRECTORIES"]],
  [/^(purchase-request|bc-)/, ["PURCHASE_ORDERS", ...AD_PRO]], [/^adventum/, ["ADVENTUM_BRAIN"]], [/^coffre/, RH],
  [/^(department|org|company|settings|custom-field|registre-references|refonte|adoption|enrichissement|admin-actions)/, ["ADMIN"]],
];

export interface PorteLueEcran {
  modules: string[];
  verbe: string | null;
  superAdminSeul: boolean;
  /** D'où vient la porte — `contrat` (un `userCan`), `audit` (son module), `fichier`, ou `aucune`. */
  origine: "contrat" | "audit" | "fichier" | "aucune";
}

export function porteDeLAction(c: ContratLu, modules: Readonly<Record<string, string>>): PorteLueEcran {
  const verbe = c.porte.verbe;
  const superAdmin = c.porte.gardes.some((g) => GARDES_SUPER_ADMIN.has(g));
  if (c.porte.module && modules[c.porte.module]) return { modules: [c.porte.module], verbe, superAdminSeul: superAdmin, origine: "contrat" };
  if (c.porte.moduleFr) {
    const fr = plierMot(c.porte.moduleFr).trim();
    const parLibelle = Object.entries(modules).find(([cle, lib]) => plierMot(lib).trim() === fr || cle.toLowerCase() === fr.replace(/\s+/g, "_"));
    if (parLibelle) return { modules: [parLibelle[0]], verbe, superAdminSeul: superAdmin, origine: "audit" };
  }
  const prefixe = PREFIXES.find(([re]) => re.test(c.fichier));
  if (prefixe) return { modules: prefixe[1].filter((m) => modules[m]), verbe, superAdminSeul: superAdmin, origine: "fichier" };
  return { modules: [], verbe, superAdminSeul: true, origine: "aucune" };
}
