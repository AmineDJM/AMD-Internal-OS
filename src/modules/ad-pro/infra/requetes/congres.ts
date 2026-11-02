import { et } from "@/lib/acces/compose";
import { prisma } from "@/lib/prisma";
import { clauseCongresInternationauxVisibles, clauseCongresNationauxVisibles } from "@/lib/queries/visibilite-listes";
import { scopeCongressIntl, scopeCongressNational, type SessionUser } from "@/lib/rbac";
import { toNumber } from "@/lib/utils";

export type CongressType = "INTL" | "NATIONAL";

export interface CongressListRow {
  id: string;
  name: string;
  location: string;
  date: string | null;
  specialty: string;
  eventType: string | null;
  requestStatus: string;
  estimatedBudget: number | null;
  productManagerBudget: number | null;
  requester: string;
  participantCount: number;
  doctorCount: number;
}

const dec = (v: unknown): number | null => (v === null || v === undefined ? null : toNumber(v));

async function userNameMap(ids: string[]): Promise<Map<string, string>> {
  const uniq = [...new Set(ids.filter(Boolean))];
  if (uniq.length === 0) return new Map();
  const users = await prisma.user.findMany({ where: { id: { in: uniq } }, select: { id: true, name: true } });
  return new Map(users.map((u) => [u.id, u.name]));
}

export async function getCongressList(type: CongressType, user: SessionUser): Promise<CongressListRow[]> {
  // Cloisonnement par entité : la vue « Adventum » ne montre que les demandes d'Adventum.
  const items =
    type === "INTL"
      ? await prisma.congressInternational.findMany({ where: await clauseCongresInternationauxVisibles(user), orderBy: [{ createdAt: "desc" }], include: { _count: { select: { careBeneficiaries: true } } } })
      : await prisma.congressNational.findMany({ where: await clauseCongresNationauxVisibles(user), orderBy: [{ createdAt: "desc" }], include: { _count: { select: { careBeneficiaries: true } } } });

  const names = await userNameMap(items.map((c) => c.requesterId ?? "").filter(Boolean));

  return items.map((c) => ({
    id: c.id,
    name: c.name,
    location: type === "INTL"
      ? [(c as { country?: string | null }).country, (c as { city?: string | null }).city].filter(Boolean).join(", ")
      : [(c as { city?: string | null }).city, (c as { hostInstitution?: string | null }).hostInstitution].filter(Boolean).join(" · "),
    date: (type === "INTL" ? (c as { startDate?: Date | null }).startDate : (c as { date?: Date | null }).date)?.toISOString() ?? null,
    // La spécialité n'est plus SAISIE sur une prise en charge (décision du 04/10/2026) : la liste ne
    // l'affiche plus. La colonne reste en base pour les demandes d'avant.
    specialty: "",
    eventType: (c as { eventType?: string }).eventType ?? null,
    requestStatus: c.requestStatus,
    estimatedBudget: dec(c.estimatedBudget),
    productManagerBudget: dec(c.productManagerBudget),
    requester: c.requesterId ? names.get(c.requesterId) ?? "" : "",
    participantCount: c.participantIds.length,
    // LES PROFESSIONNELS PROPOSÉS — la source UNIQUE (`CareBeneficiary`). `invitedDoctorIds` n'est plus
    // écrit par l'écran ; la migration du 04/10 y a repris ce qu'il portait.
    doctorCount: c._count.careBeneficiaries,
  }));
}

export async function getCongressDetail(type: CongressType, user: SessionUser, id: string) {
  const c =
    type === "INTL"
      ? await prisma.congressInternational.findFirst({ where: et({ id }, scopeCongressIntl(user)) })
      : await prisma.congressNational.findFirst({ where: et({ id }, scopeCongressNational(user)) });
  if (!c) return null;

  const names = await userNameMap([c.requesterId, c.productManagerId, c.preliminaryById, c.finalById].filter((x): x is string => Boolean(x)));
  const participants = c.participantIds.length
    ? await prisma.user.findMany({ where: { id: { in: c.participantIds } }, select: { id: true, name: true, title: true } })
    : [];
  // « Initiative du médecin » : le ou les médecins À L'ORIGINE de la demande (pas des prises en charge).
  const origine = c.initiativeDoctorIds.length
    ? await prisma.medicalDoctor.findMany({ where: { id: { in: c.initiativeDoctorIds } }, select: { name: true } })
    : [];
  const expenseOrder = c.expenseOrderId
    ? await prisma.expenseOrder.findUnique({ where: { id: c.expenseOrderId }, select: { reference: true, status: true, amount: true } })
    : null;

  return {
    type,
    id: c.id,
    name: c.name,
    specialty: c.specialty ?? "",
    /*
     * LES PRODUITS PROMUS — deux noms de colonne pour le même fait, sur deux modèles frères
     * (`products` à l'international, `promotedProducts` au national). On ne renomme pas une
     * colonne qui a des lecteurs ; on lit celle que chaque modèle porte.
     *
     * Le champ existait des DEUX côtés et n'avait AUCUN lecteur : ni écrit, ni affiché. Une
     * colonne que rien ne montre est du code mort (§118.14, §118.50), et l'ajouter à la seule
     * ÉCRITURE aurait laissé le demandeur cocher trois produits qu'il ne reverrait jamais.
     */
    products: (type === "INTL"
      ? (c as { products?: string | null }).products
      : (c as { promotedProducts?: string | null }).promotedProducts) ?? "",
    businessUnitId: c.businessUnitId,
    location: type === "INTL"
      ? [(c as { country?: string | null }).country, (c as { city?: string | null }).city].filter(Boolean).join(", ")
      : [(c as { city?: string | null }).city, (c as { hostInstitution?: string | null }).hostInstitution].filter(Boolean).join(" · "),
    // VILLE ET PAYS, SÉPARÉS (Direction, 10/2026). Au national, le pays tu est l'Algérie — un pays saisi
    // sur une demande d'avant reste lu tel quel.
    ville: c.city ?? null,
    pays: c.country ?? (type === "NATIONAL" ? "Algérie" : null),
    medecinsOrigine: origine.map((d) => d.name),
    date: (type === "INTL" ? (c as { startDate?: Date | null }).startDate : (c as { date?: Date | null }).date)?.toISOString() ?? null,
    // LA FIN DE L'ÉVÉNEMENT, des deux côtés désormais : une prise en charge nationale se tient sur
    // plusieurs jours aussi (décision du 04/10/2026 — `CongressNational.endDate`).
    endDate: (c as { endDate?: Date | null }).endDate?.toISOString() ?? null,
    eventType: (c as { eventType?: string }).eventType ?? null,
    /** « DEMANDEUR » | « MEDECIN » — qui est à l'origine de l'événement (Direction, 07/10) ; `null` sur les demandes d'avant. */
    initiative: c.initiative ?? null,
    requestStatus: c.requestStatus,
    estimatedBudget: dec(c.estimatedBudget),
    productManagerBudget: dec(c.productManagerBudget),
    finalAmount: dec(c.finalAmount),
    productManagerNotes: c.productManagerNotes ?? "",
    preliminaryNote: c.preliminaryNote ?? "",
    finalNote: c.finalNote ?? "",
    rejectionReason: c.rejectionReason ?? "",
    preliminaryAt: c.preliminaryAt?.toISOString() ?? null,
    finalAt: c.finalAt?.toISOString() ?? null,
    requester: c.requesterId ? names.get(c.requesterId) ?? "" : "",
    requesterId: c.requesterId,
    productManager: c.productManagerId ? names.get(c.productManagerId) ?? "" : "",
    productManagerId: c.productManagerId,
    preliminaryBy: c.preliminaryById ? names.get(c.preliminaryById) ?? "" : "",
    finalBy: c.finalById ? names.get(c.finalById) ?? "" : "",
    participants: participants.map((p) => ({ id: p.id, name: p.name, title: p.title ?? "" })),
    expenseOrder: expenseOrder ? { reference: expenseOrder.reference, status: expenseOrder.status, amount: toNumber(expenseOrder.amount) } : null,
    createdAt: c.createdAt.toISOString(),
  };
}

export type CongressDetail = NonNullable<Awaited<ReturnType<typeof getCongressDetail>>>;

/*
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * `getCongressFormData` A ÉTÉ RETIRÉE — elle n'avait plus aucun lecteur de production.
 *
 * Elle chargeait les médecins et les collaborateurs pour le formulaire de demande. Depuis que ce
 * formulaire propose AUSSI les produits promouvables, les spécialités du référentiel et les
 * gammes (décision de la Direction, 22/09/2026), ses deux appelants lisent le chargeur COMMUN du
 * pôle — `queries/ad-pro.ts:getAdProCreateData` — qui rend les cinq référentiels d'un seul appel.
 *
 * La garder aurait fait DEUX lectures du même fait, dont une plus pauvre : deux listes de
 * médecins qui divergent à la première colonne ajoutée (§118.5), et une requête payée par tout
 * le monde au bénéfice de personne (§118.14).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
