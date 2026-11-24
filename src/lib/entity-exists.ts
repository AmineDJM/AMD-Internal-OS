import type { EntityType } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * L'OBJET EXISTE-T-IL ENCORE ? — la question qu'un lien doit poser avant de s'afficher.
 *
 * ── LE DÉFAUT QU'ON CORRIGE ─────────────────────────────────────────────────────────────────
 *
 * Un ordre de dépense garde la trace de ce qui l'a fait naître (`sourceType`, `sourceId`) ; une
 * demande de paiement, de ce à quoi elle se rattache. Quand cet objet d'origine est SUPPRIMÉ —
 * une demande annulée, un congrès effacé — la trace reste, et `entityHref` en fait un lien tout
 * à fait normal… vers une page qui répond 404. L'audit navigateur en a compté cinquante sur le
 * seul centre de paiement : « Demande d'origine » cliqué, page introuvable, et l'on conclut que
 * le centre est cassé.
 *
 * ── POURQUOI UN LOT, ET NON `canAccessEntity` ───────────────────────────────────────────────
 *
 * `canAccessEntity` répond « cette personne peut-elle ouvrir cet objet ? » — une question de
 * DROITS, par objet, avec ses règles par type. Ici la question est plus modeste et se pose pour
 * trois cents lignes d'un coup : « lesquels de ces identifiants désignent encore quelque
 * chose ? » Une requête par type, pas une par ligne. Les droits restent l'affaire de la page
 * d'arrivée, comme le dit `entity-href.ts`.
 *
 * Les types dont la route ne dépend pas de l'identifiant (`EXPENSE_ORDER` → la file, `TRAINING`
 * → les formations…) n'ont rien à vérifier : leur lien n'est jamais mort.
 */

type Lookup = (ids: string[]) => Promise<{ id: string }[]>;

const ids = (rows: Promise<{ id: string }[]>) => rows;
const TABLE: Partial<Record<EntityType, Lookup>> = {
  PAYMENT_REQUEST: (i) => ids(prisma.paymentRequest.findMany({ where: { id: { in: i } }, select: { id: true } })),
  FIXED_CHARGE: (i) => ids(prisma.echeanceChargeFixe.findMany({ where: { id: { in: i } }, select: { id: true } })),
  ADMIN_REQUEST: (i) => ids(prisma.administrativeRequest.findMany({ where: { id: { in: i }, deletedAt: null }, select: { id: true } })),
  INVOICE: (i) => ids(prisma.legalDocument.findMany({ where: { id: { in: i } }, select: { id: true } })),
  LEGAL_DOCUMENT: (i) => ids(prisma.legalDocument.findMany({ where: { id: { in: i } }, select: { id: true } })),
  REGULATORY_PRODUCT: (i) => ids(prisma.regulatoryProduct.findMany({ where: { id: { in: i } }, select: { id: true } })),
  SPONSORING: (i) => ids(prisma.sponsoringRequest.findMany({ where: { id: { in: i } }, select: { id: true } })),
  CONGRESS_INTERNATIONAL: (i) => ids(prisma.congressInternational.findMany({ where: { id: { in: i } }, select: { id: true } })),
  CONGRESS_NATIONAL: (i) => ids(prisma.congressNational.findMany({ where: { id: { in: i } }, select: { id: true } })),
  EVENT: (i) => ids(prisma.event.findMany({ where: { id: { in: i } }, select: { id: true } })),
  MEDICAL_INFO_DECLARATION: (i) => ids(prisma.medicalInfoDeclaration.findMany({ where: { id: { in: i } }, select: { id: true } })),
  PROMO_MATERIAL: (i) => ids(prisma.promoMaterial.findMany({ where: { id: { in: i } }, select: { id: true } })),
  AD_PRO_ITEM: (i) => ids(prisma.adProItem.findMany({ where: { id: { in: i } }, select: { id: true } })),
  CONSULTING_CONTRACT: (i) => ids(prisma.consultingContract.findMany({ where: { id: { in: i } }, select: { id: true } })),
  RECRUITMENT_REQUEST: (i) => ids(prisma.recruitmentRequest.findMany({ where: { id: { in: i } }, select: { id: true } })),
  MAIL_ENTRY: (i) => ids(prisma.mailEntry.findMany({ where: { id: { in: i } }, select: { id: true } })),
  PCH_TENDER: (i) => ids(prisma.pchTender.findMany({ where: { id: { in: i } }, select: { id: true } })),
  VALIDATION_REQUEST: (i) => ids(prisma.validationRequest.findMany({ where: { id: { in: i } }, select: { id: true } })),
  DOSSIER: (i) => ids(prisma.dossier.findMany({ where: { id: { in: i } }, select: { id: true } })),
  SUPPORT_REQUEST: (i) => ids(prisma.supportRequest.findMany({ where: { id: { in: i } }, select: { id: true } })),
  DRIVE_NODE: (i) => ids(prisma.driveNode.findMany({ where: { id: { in: i }, isTrashed: false }, select: { id: true } })),
  EMPLOYEE: (i) => ids(prisma.employee.findMany({ where: { id: { in: i } }, select: { id: true } })),
};

/**
 * Parmi `ids`, ceux qui désignent encore un objet de ce type. Un type inconnu de la table rend
 * TOUS les identifiants : on ne retire jamais un lien par ignorance, seulement par constat.
 */
export async function existingEntityIds(type: EntityType | string | null | undefined, ids: readonly string[]): Promise<Set<string>> {
  const uniques = [...new Set(ids.filter(Boolean))];
  if (uniques.length === 0) return new Set();
  const lookup = type ? TABLE[type as EntityType] : undefined;
  if (!lookup) return new Set(uniques);
  try {
    return new Set((await lookup(uniques)).map((r) => r.id));
  } catch {
    // Une base indisponible ne doit pas faire disparaître tous les liens d'un écran : dans le
    // doute, on les garde — la page d'arrivée dira ce qu'il en est.
    return new Set(uniques);
  }
}

/**
 * LE MÊME CONSTAT, POUR UNE LISTE HÉTÉROGÈNE — les ordres du centre de paiement viennent de
 * treize circuits. Rend, pour chaque `(type, id)`, si l'objet existe encore ; une requête par
 * type rencontré.
 */
export async function existingSources(
  refs: readonly { type: string | null | undefined; id: string | null | undefined }[],
): Promise<(type: string | null | undefined, id: string | null | undefined) => boolean> {
  const parType = new Map<string, Set<string>>();
  for (const r of refs) {
    if (!r.type || !r.id) continue;
    if (!parType.has(r.type)) parType.set(r.type, new Set());
    parType.get(r.type)!.add(r.id);
  }
  const vivants = new Map<string, Set<string>>();
  await Promise.all([...parType].map(async ([type, set]) => {
    vivants.set(type, await existingEntityIds(type, [...set]));
  }));
  return (type, id) => Boolean(type && id && vivants.get(type)?.has(id));
}
