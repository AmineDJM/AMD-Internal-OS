/**
 * OÙ ATTERRIT UN FICHIER IMPORTÉ, DANS LE DRIVE.
 *
 * On importe une pièce depuis un sponsoring, un appel d'offres, une demande RH — et elle
 * disparaît dans l'objet métier. Six semaines plus tard, on la cherche « dans le Drive », parce
 * que c'est là qu'on cherche les fichiers. Elle n'y est pas : elle est restée accrochée à sa
 * demande. Le Drive doit donc recevoir une copie de TOUT ce qui entre dans l'ERP, rangée là où
 * on la cherchera : par module, puis par objet.
 *
 * Ce module ne fait que dire OÙ. Il ne touche ni à la base, ni au stockage — d'où les tests.
 */

import type { Confidentiality, EntityType } from "@prisma/client";
import { ENTITY_TYPE_LABELS } from "@/lib/labels";

/** La boîte, à la racine du Drive de celui qui importe. Une seule, pas une par module. */
export const IMPORT_DRIVE_ROOT = "Mes documents importés";

/**
 * CE QUI PEUT ÊTRE COPIÉ DANS LE DRIVE, TYPE D'OBJET PAR TYPE D'OBJET (audit Drive du 24/11, F2).
 *
 * La copie vit hors de son objet : la portée ALL du Drive la lit, elle survit aux droits de l'objet. Les pièces des
 * personnes — RH, données médicales, pharmacovigilance, voyageurs (passeports, billets, hôtels) — n'y vont donc JAMAIS.
 * La table couvre TOUT `EntityType` (le typage l'exige, `mirror-path.test.ts` le vérifie contre le schéma) : un type
 * ajouté demain ne se copie pas par défaut, il se range ici, en connaissance de cause.
 *   · `copie`        : copié sous « Mes documents importés / <module> / <objet> » ;
 *   · `miroir-propre`: a son propre rangement (Regulatory) ou vit déjà dans le Drive ;
 *   · `jamais`       : aucune copie.
 */
export const COPIE_AU_DRIVE: Record<EntityType, "copie" | "miroir-propre" | "jamais"> = {
  REGULATORY_PRODUCT: "miroir-propre", DRIVE_NODE: "miroir-propre",
  // RH
  EMPLOYEE: "jamais", PAYROLL: "jamais", LEAVE_REQUEST: "jamais", SALARY_ADVANCE: "jamais", HR_REQUEST: "jamais",
  RECRUITMENT_REQUEST: "jamais", RECRUITMENT_CANDIDATE: "jamais", TRAINING: "jamais",
  // Informatique : le contrat d'un abonnement (montants, conditions) reste au registre.
  IT_SUBSCRIPTION: "jamais",
  // Médical
  MEDICAL_INFO_DECLARATION: "jamais", DOCTOR: "jamais", VISIT: "jamais",
  // Pharmacovigilance et qualité (une réclamation peut décrire un patient)
  PHARMACOVIGILANCE_CASE: "jamais", RECLAMATION: "jamais",
  // Une échéance de charge fixe : sa facture vit sur l'ordre de paiement.
  FIXED_CHARGE: "jamais",
  // Un paiement d'impôt (G50, bordereau) : comme la charge fixe, sa pièce vit sur l'ordre de paiement.
  TAX_PAYMENT: "jamais",
  // Voyageurs : ordres de mission, prises en charge, billets et hôtels du secrétariat, missions chauffeur
  MISSION_ASSIGNMENT: "jamais", CONGRESS_INTERNATIONAL: "jamais", CONGRESS_NATIONAL: "jamais", AD_PRO_ITEM: "jamais",
  ADMIN_REQUEST: "jamais", DRIVER_MISSION: "jamais",
  // Le reste : pièces d'entreprise
  REGULATORY_STEP: "copie", SPONSORING: "copie", BUDGET: "copie", SALE: "copie", LOGISTICS: "copie", DELEGATE_PLAN: "copie",
  BD_OPPORTUNITY: "copie", BD_PROJECT: "copie", FINANCE_TRANSACTION: "copie", TASK: "copie", EXPENSE_ORDER: "copie",
  FEEDBACK: "copie", VALIDATION_REQUEST: "copie", SUPPLIER: "copie", DIRECTIVE: "copie", SUPPORT_REQUEST: "copie",
  DOSSIER: "copie", PROMO_MATERIAL: "copie", EVENT: "copie", OFFICE_SUPPLY_ARTICLE: "copie", PCH_TENDER: "copie",
  DEPARTMENT_EXPENSE: "copie", CONSULTING_CONTRACT: "copie", AD_PRO_OTHER: "copie", DOCUMENT_REQUEST: "copie",
  PAYMENT_REQUEST: "copie", MAIL_ENTRY: "copie", LEGAL_DOCUMENT: "copie", COMPANY: "copie", PCH_ORDER: "copie",
  INVOICE: "copie", PRODUCT: "copie", BUSINESS_UNIT: "copie", TOUR_PLAN: "copie", SALES_SECTOR: "copie",
  INSTITUTION: "copie", SPECIALTY: "copie", STOCK_PCH_RELEVE: "copie",
};

/**
 * Une pièce peut-elle avoir une copie dans le Drive — quel que soit le rangement ? Seulement INTERNE, et d'un type
 * d'objet qui n'est pas `jamais`. Un type inconnu de la table : non.
 */
export function copieAuDriveAutorisee(entityType: string, confidentiality: Confidentiality): boolean {
  const regle = (COPIE_AU_DRIVE as Record<string, string | undefined>)[entityType];
  return confidentiality === "INTERNAL" && regle !== undefined && regle !== "jamais";
}

/** Ce téléversement doit-il aussi atterrir dans « Mes documents importés » de celui qui importe ? */
export function shouldMirrorToDrive(entityType: string, confidentiality: Confidentiality): boolean {
  return copieAuDriveAutorisee(entityType, confidentiality) && COPIE_AU_DRIVE[entityType as EntityType] === "copie";
}

/**
 * Un nom de dossier acceptable : pas de séparateur (qui fabriquerait une arborescence fantôme),
 * pas de caractère de contrôle, pas de nom vide, et une longueur qui reste lisible dans une liste.
 */
export function safeFolderName(raw: string, fallback = "Sans nom"): string {
  const cleaned = raw
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/[/\\]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  // Un nom qui ne contient ni lettre ni chiffre (« --- », « … ») n'est pas un nom : il occupe une
  // ligne dans la liste sans rien apprendre. On préfère le repli, qui dit au moins de quoi il s'agit.
  if (!/[\p{L}\p{N}]/u.test(cleaned)) return fallback;
  return cleaned.slice(0, 120).trim() || fallback;
}

/**
 * Le chemin du dossier d'accueil : « Mes documents importés / <module> / <objet> ».
 *
 * L'objet porte sa référence quand il en a une (« SPO-2026-014 ») — c'est ce que la personne a
 * sous les yeux dans l'écran d'où elle importe. Sans référence, on retombe sur un identifiant
 * abrégé : moins parlant, mais au moins deux demandes différentes ne se mélangent pas.
 */
export function importFolderPath(entityType: string, reference: string | null | undefined, entityId: string): string[] {
  const moduleName = safeFolderName(ENTITY_TYPE_LABELS[entityType] ?? entityType, "Autres");
  const ref = (reference ?? "").trim();
  const objectName = safeFolderName(ref || `Dossier ${entityId.slice(0, 8)}`, `Dossier ${entityId.slice(0, 8)}`);
  return [IMPORT_DRIVE_ROOT, moduleName, objectName];
}
