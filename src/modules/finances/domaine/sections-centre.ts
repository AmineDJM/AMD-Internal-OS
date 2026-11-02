import type { EntityType } from "@prisma/client";

/**
 * LES TROIS SECTIONS DU CENTRE DE PAIEMENT — Regulatory, Sales & Marketing, Autres (§118.211).
 *
 * « On aura les entités en haut, et ensuite chaque entité aura trois types de demandes de paiement :
 * Regulatory / Sales & Marketing / Autres. » (Direction, 05/10/2026.)
 *
 * ── CE QUI DÉCIDE, ET CE QUI NE DÉCIDE JAMAIS ───────────────────────────────────────────────
 *
 * Le classement lit un FAIT déjà en base : d'où l'ordre de dépense vient (`ExpenseOrder.sourceType`)
 * — jamais son libellé, jamais son bénéficiaire. Le pôle d'un type d'origine est celui que le MENU
 * lui donne (`labels.ts`, `pole:`) : le dossier réglementaire, l'information médicale (rangée au
 * pôle Regulatory depuis §118.118 : une déclaration est un acte réglementaire) → Regulatory ;
 * Ad & Pro, matériel promotionnel, congrès, événements, promotion médicale, force de vente,
 * ventes → Sales & Marketing ; tout le reste → Autres.
 *
 * `Record<EntityType, …>` : un type d'origine ajouté demain NE COMPILE PAS tant que personne n'a
 * dit dans quelle section son argent se décide (§118.130). La table est ÉCRITE, pas dérivée : le
 * pôle d'un menu et la section d'un paiement sont deux décisions qui peuvent diverger un jour, et
 * c'est ici qu'on le dira.
 *
 * ── DEUX NIVEAUX D'ORIGINE, JAMAIS PLUS ─────────────────────────────────────────────────────
 *
 * Trois types ne sont pas une origine mais un PORTEUR : une demande de paiement déposée à la main,
 * une demande au secrétariat, une pièce du registre Legal (la facture d'un bon de commande). Un
 * ordre né d'eux se classe sur ce que le porteur dit lui-même de son origine (`entityType` de la
 * demande de paiement, `linkedEntityType` de la demande au secrétariat, `sourceType` de la pièce).
 * Un seul niveau : suivre la chaîne plus loin, c'est deviner. Un porteur dont l'origine ne se lit
 * pas à coup sûr retombe sur AUTRES — le seul repli — et il se COMPTE (`repli`) : la section
 * « Autres » dit combien de ses lignes y sont faute d'origine lisible, pas parce qu'on a décidé
 * qu'elles y étaient.
 *
 * Un CONTRAT DE CONSULTING n'a pas de section fixe : son PÔLE le dit (§118.150). Passé aux RH, il
 * se paie dans « Autres » ; sinon c'est une dépense Ad & Pro.
 *
 * Module PUR — zéro import (`import type` s'efface) : l'écran, le chargeur et les bancs le lisent
 * sans rien exécuter.
 */

export type SectionCentre = "REGULATORY" | "SALES_MARKETING" | "AUTRES";

/** L'ordre d'affichage des onglets. */
export const SECTIONS_CENTRE: readonly SectionCentre[] = ["REGULATORY", "SALES_MARKETING", "AUTRES"];

export const SECTION_CENTRE_LABEL: Record<SectionCentre, string> = {
  REGULATORY: "Regulatory",
  SALES_MARKETING: "Sales & Marketing",
  AUTRES: "Autres",
};

/** Ce que l'adresse porte (`?section=`) — sans accent, sans espace, stable. */
export const SECTION_CENTRE_SLUG: Record<SectionCentre, string> = {
  REGULATORY: "regulatory",
  SALES_MARKETING: "sales-marketing",
  AUTRES: "autres",
};

export function sectionDepuisSlug(slug: string | null | undefined): SectionCentre | null {
  return SECTIONS_CENTRE.find((s) => SECTION_CENTRE_SLUG[s] === slug) ?? null;
}

const R: SectionCentre = "REGULATORY";
const S: SectionCentre = "SALES_MARKETING";
const A: SectionCentre = "AUTRES";

/**
 * LA SECTION DE CHAQUE TYPE D'ORIGINE — une ligne par valeur de l'énumération, exhaustive.
 * Les porteurs (PAYMENT_REQUEST, ADMIN_REQUEST, LEGAL_DOCUMENT) valent AUTRES ICI : c'est ce qu'ils
 * valent quand leur origine ne se lit pas ; `sectionDuType` ne les consulte qu'en dernier recours.
 */
export const SECTION_DU_TYPE: Record<EntityType, SectionCentre> = {
  // ── Regulatory : le dossier d'enregistrement, ses taxes, ses fournisseurs, l'information médicale.
  REGULATORY_PRODUCT: R,
  REGULATORY_STEP: R,
  PRODUCT: R,
  SUPPLIER: R,
  MEDICAL_INFO_DECLARATION: R,
  PHARMACOVIGILANCE_CASE: R,

  // ── Sales & Marketing : Ad & Pro, matériel promotionnel, congrès, événements, force de vente.
  SPONSORING: S,
  AD_PRO_ITEM: S,
  AD_PRO_OTHER: S,
  CONGRESS_INTERNATIONAL: S,
  CONGRESS_NATIONAL: S,
  EVENT: S,
  PROMO_MATERIAL: S,
  CONSULTING_CONTRACT: S, // sauf contrat passé aux RH : voir `sectionDuType`
  SALE: S,
  DOCTOR: S,
  VISIT: S,
  DELEGATE_PLAN: S,
  TOUR_PLAN: S,
  BUSINESS_UNIT: S,
  SALES_SECTOR: S,
  INSTITUTION: S,
  SPECIALTY: S,

  // ── Autres : tout ce qui relève de l'administration, de la paie, du Legal, de la chaîne
  //    d'approvisionnement, du business development — et les PORTEURS sans origine lisible.
  BUDGET: A,
  LOGISTICS: A,
  RECLAMATION: A, // module retiré le 09/10 ; valeur d'énumération conservée avec sa table
  STOCK_PCH_RELEVE: A,
  BD_OPPORTUNITY: A,
  BD_PROJECT: A,
  FINANCE_TRANSACTION: A,
  EMPLOYEE: A,
  PAYROLL: A,
  LEAVE_REQUEST: A,
  TASK: A,
  SALARY_ADVANCE: A,
  EXPENSE_ORDER: A,
  DRIVE_NODE: A,
  ADMIN_REQUEST: A,
  DRIVER_MISSION: A,
  FEEDBACK: A,
  VALIDATION_REQUEST: A,
  DIRECTIVE: A,
  SUPPORT_REQUEST: A,
  DOSSIER: A,
  HR_REQUEST: A,
  MISSION_ASSIGNMENT: A,
  OFFICE_SUPPLY_ARTICLE: A,
  PCH_TENDER: A,
  PCH_ORDER: A,
  DEPARTMENT_EXPENSE: A,
  DOCUMENT_REQUEST: A,
  PAYMENT_REQUEST: A,
  MAIL_ENTRY: A,
  LEGAL_DOCUMENT: A,
  COMPANY: A,
  RECRUITMENT_REQUEST: A,
  RECRUITMENT_CANDIDATE: A,
  INVOICE: A,
  TRAINING: A,
};

/**
 * LES PORTEURS D'ORIGINE — ils n'ont pas de section à eux, ils renvoient à celle de leur origine.
 * Liste FERMÉE : en ajouter un est une décision (il faut aussi dire où le chargeur lit son origine).
 */
export const PORTEURS_D_ORIGINE: ReadonlySet<EntityType> = new Set<EntityType>([
  "PAYMENT_REQUEST", "ADMIN_REQUEST", "LEGAL_DOCUMENT",
]);

/**
 * L'ORIGINE QU'ON CLASSE — le type de l'ordre, ou, pour un PORTEUR, l'origine qu'il déclare.
 * Un seul niveau : l'origine d'un porteur qui serait lui-même un porteur ne se suit pas.
 * Rend `null` quand rien ne se lit à coup sûr (aucun type, ou porteur muet).
 */
export function origineEffective(sourceType: EntityType | null | undefined, origineDuPorteur?: EntityType | null): EntityType | null {
  if (!sourceType) return null;
  if (!PORTEURS_D_ORIGINE.has(sourceType)) return sourceType;
  if (origineDuPorteur && !PORTEURS_D_ORIGINE.has(origineDuPorteur)) return origineDuPorteur;
  return null;
}

export interface FaitsDeClassement {
  /** `ExpenseOrder.sourceType`. */
  sourceType: EntityType | null | undefined;
  /** L'origine déclarée par le porteur (`PaymentRequest.entityType`, `linkedEntityType`, `sourceType` du registre). */
  origineDuPorteur?: EntityType | null;
  /** L'origine effective est un contrat de consulting dont le pôle est RH. */
  contratRH?: boolean;
}

/** La section d'un TYPE d'origine déjà établi — `contratRH` n'a de sens que pour un contrat de consulting. */
export function sectionDuType(type: EntityType, opts: { contratRH?: boolean } = {}): SectionCentre {
  if (type === "CONSULTING_CONTRACT" && opts.contratRH) return "AUTRES";
  return SECTION_DU_TYPE[type];
}

/**
 * LA SECTION D'UN ORDRE DE DÉPENSE — et si elle tient à un REPLI.
 * `repli` : l'ordre est dans « Autres » faute d'origine lisible (aucun type, ou porteur muet),
 * non parce qu'une décision l'y range.
 */
export function classerOrdre(faits: FaitsDeClassement): { section: SectionCentre; repli: boolean } {
  const origine = origineEffective(faits.sourceType, faits.origineDuPorteur);
  if (!origine) return { section: "AUTRES", repli: true };
  return { section: sectionDuType(origine, { contratRH: faits.contratRH === true }), repli: false };
}

/**
 * LA SECTION À METTRE DANS UN LIEN (`?section=`) vers un ordre — `null` quand elle ne tient qu'au
 * REPLI (porteur dont l'origine ne se lit pas ici) : mieux vaut laisser le centre choisir que
 * d'envoyer sur « Autres » un paiement que le chargeur rangera ailleurs.
 */
export function slugSectionDeLOrdre(sourceType: EntityType | null | undefined): string | null {
  const c = classerOrdre({ sourceType });
  return c.repli ? null : SECTION_CENTRE_SLUG[c.section];
}

// ───────────────────────────── L'ENTITÉ ET LA SECTION CHOISIES ─────────────────────────────

/** La clé d'adresse de la pastille « Sans entité ». */
export const ENTITE_SANS = "sans-entite";

export interface EntiteChoisissable {
  /** Identifiant de la société, ou `ENTITE_SANS`. */
  cle: string;
  enAttente: number;
}

/**
 * L'ENTITÉ AFFICHÉE — jamais une valeur lue telle quelle.
 *
 * Ordre : la demande de l'adresse, si elle désigne une pastille PRÉSENTE (une valeur forgée ou
 * périmée ne désigne rien) ; sinon l'entité sélectionnée dans la barre supérieure, VALIDÉE contre
 * les droits par l'appelant (`preferee`) ; sinon celle qui attend le plus de décisions ; sinon la
 * première. `null` seulement quand il n'y a aucune pastille.
 */
export function choisirEntite(
  entites: readonly EntiteChoisissable[], demandee: string | null | undefined, preferee: string | null | undefined,
): string | null {
  if (entites.length === 0) return null;
  const presente = (cle: string | null | undefined) => (cle && entites.some((e) => e.cle === cle) ? cle : null);
  const demande = presente(demandee);
  if (demande) return demande;
  const pref = presente(preferee);
  if (pref) return pref;
  let meilleure = entites[0]!;
  for (const e of entites) if (e.enAttente > meilleure.enAttente) meilleure = e;
  return meilleure.cle;
}

/**
 * LA SECTION AFFICHÉE — la demandée si elle se lit ; sinon la première qui attend une décision ;
 * sinon la première qui porte des paiements ; sinon Regulatory.
 */
export function choisirSection(
  demandee: string | null | undefined,
  comptes: Record<SectionCentre, { enAttente: number; total: number }>,
): SectionCentre {
  const demande = sectionDepuisSlug(demandee);
  if (demande) return demande;
  return SECTIONS_CENTRE.find((s) => comptes[s].enAttente > 0)
    ?? SECTIONS_CENTRE.find((s) => comptes[s].total > 0)
    ?? "REGULATORY";
}
