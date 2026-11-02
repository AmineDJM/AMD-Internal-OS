import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { userCan, hasGlobalView, anyRoleFilter, type SessionUser } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { toNumber } from "@/lib/utils";
import { recordAudit } from "@/lib/audit";
import { beneficiaryName } from "../../domaine/prise-en-charge/regles";
import { detailsStockes, etapesDuBillet, etapesStockees, tauxDeLaDemande, type CellRow } from "../../domaine/prise-en-charge/fiches";
import { createDossierRecord, ecrireDansLeSujet } from "@/lib/dossiers-core";
import { sansBloquer } from "@/lib/journal";

// ═══════════════════════════════════════════════════════════════════════════════════════════
// LE SOCLE COMMUN DES ACTIONS DE PRISE EN CHARGE — la portée (nationale / internationale), les droits,
// le chargement d'une demande, l'ouverture d'une fiche : ce que les deux morceaux de la clé
// `care-actions` emploient (`src/lib/actions/parc.ts`). Privées au fichier d'actions d'avant, ces aides
// le restent au module (aucune porte ne les exporte) ; les actions les importent en RELATIF.
// ═══════════════════════════════════════════════════════════════════════════════════════════

/**
 * PRISE EN CHARGE — actions serveur (nationale et internationale).
 *
 * Ce que ce fichier tient, et qui n'existait pas :
 *   • une **décision par personne** — sur une même demande, l'une est accordée et l'autre
 *     écartée, sans qu'on ait à refuser l'ensemble ;
 *   • une **liste de besoins propre à chaque personne** — l'une a besoin d'un visa et pas
 *     l'autre ;
 *   • des **devis qui couvrent ce qu'ils couvrent réellement** : une agence chiffre le groupe,
 *     on ne lui demande pas de découper en dix lignes.
 *
 * ⚠️ Le garde-fou central : **une case déjà couverte par un devis accepté ne peut pas être
 * couverte par un second**. C'est la seule façon de ne pas payer deux fois le même hôtel — et
 * personne ne s'en apercevrait avant la facture.
 */

export type Scope = "NATIONAL" | "INTERNATIONAL";

export const SPEC: Record<Scope, { module: "CONGRESS_NATIONAL" | "CONGRESS_INTERNATIONAL"; path: string }> = {
  NATIONAL: { module: "CONGRESS_NATIONAL", path: "/congress-national" },
  INTERNATIONAL: { module: "CONGRESS_INTERNATIONAL", path: "/congress-international" },
};

export const isScope = (v: string): v is Scope => v === "NATIONAL" || v === "INTERNATIONAL";


export function revalidate(scope: Scope, id: string) {
  revalidatePath(SPEC[scope].path);
  revalidatePath(`${SPEC[scope].path}/${id}`);
  revalidatePath(`${SPEC[scope].path}/${id}/devis`);
}

/** Décrire les personnes et leurs besoins : ouvert aux acteurs de la demande. */
export function canEdit(user: SessionUser, scope: Scope): boolean {
  const m = SPEC[scope].module;
  return userCan(user, m, "CREATE") || userCan(user, m, "UPDATE") || hasGlobalView(user);
}

export async function audit(user: SessionUser, scope: Scope, id: string, action: "CREATE" | "UPDATE" | "DELETE", detail: string) {
  await recordAudit({
    actorId: user.id, module: SPEC[scope].module, entityType: SPEC[scope].module, entityId: id, action, summary: detail,
  }).catch(sansBloquer("care-actions.audit.recordAudit"));
}

/** Ce qu'on lit d'une demande, quel que soit son périmètre. */
export const REQUEST_SELECT = {
  id: true, name: true, requestStatus: true, requesterId: true, finalAmount: true,
  careMode: true, usdDzdRate: true, city: true, companyId: true, careReservationDossierId: true,
} as const;

/** Charge la demande, quel que soit son périmètre. */
export async function loadRequest(scope: Scope, id: string) {
  if (scope === "NATIONAL") {
    const r = await prisma.congressNational.findUnique({ where: { id }, select: REQUEST_SELECT });
    return r;
  }
  return prisma.congressInternational.findUnique({ where: { id }, select: REQUEST_SELECT });
}

/** Le taux figé de la demande (international), ou aucun (national). */
export const tauxDe = (scope: Scope, req: { usdDzdRate: unknown } | null) =>
  tauxDeLaDemande(scope, req?.usdDzdRate != null ? toNumber(req.usdDzdRate) : null);

/** Une case lue pour les règles des fiches (dates en AAAA-MM-JJ). */
export const CELL_FICHE_SELECT = {
  id: true, kind: true, serviceKind: true, label: true, notes: true, status: true, amountDzd: true, amount: true, currency: true,
  expenseOrderId: true, promoMaterialId: true, documentId: true, dateStart: true, dateEnd: true, trajet: true, transport: true,
  fromCity: true, toCity: true, segments: true, hotelName: true, city: true, roomType: true,
  issuedDocumentId: true, bookingRef: true, legDetails: true, timeStart: true, address: true,
} as const;

export type CellFicheDb = Prisma.CareCellGetPayload<{ select: typeof CELL_FICHE_SELECT }>;

export function versCellRow(c: CellFicheDb): CellRow {
  const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
  const base = {
    id: c.id, kind: c.kind, serviceKind: c.serviceKind, label: c.label, notes: c.notes, status: c.status,
    amountDzd: c.amountDzd != null ? toNumber(c.amountDzd) : null, amount: c.amount != null ? toNumber(c.amount) : null,
    currency: c.currency, expenseOrderId: c.expenseOrderId, promoMaterialId: c.promoMaterialId, documentId: c.documentId,
    promoMaterial: null, dateStart: iso(c.dateStart), dateEnd: iso(c.dateEnd), trajet: c.trajet, transport: c.transport,
    fromCity: c.fromCity, toCity: c.toCity, segments: etapesStockees(c.segments), hotelName: c.hotelName, city: c.city, roomType: c.roomType,
    issuedDocumentId: c.issuedDocumentId, bookingRef: c.bookingRef, timeStart: c.timeStart, address: c.address,
  };
  return { ...base, legDetails: detailsStockes(c.legDetails, c.serviceKind === "TICKET" ? etapesDuBillet(base).length : 0) };
}

/**
 * LE SUJET DE L'ASSISTANTE DE DIRECTION pour cette prise en charge — celui déjà ouvert (on y écrit), sinon un
 * nouveau. Même règle qu'au sponsoring : une seule assistante active en est responsable ; plusieurs, toutes
 * participantes ; aucune, la demande n'a personne à qui partir, et on le dit.
 */
export async function ecrireAAssistante(
  scope: Scope, req: NonNullable<Awaited<ReturnType<typeof loadRequest>>>, user: SessionUser, titre: string, corps: string,
): Promise<{ ok: true; id: string; reference: string; nouveau: boolean } | { ok: false; error: string }> {
  if (req.careReservationDossierId) {
    const ecrit = await ecrireDansLeSujet({ dossierId: req.careReservationDossierId, authorId: user.id, body: `${titre}\n${corps}` });
    if (ecrit) {
      const d = await prisma.dossier.findUnique({ where: { id: req.careReservationDossierId }, select: { reference: true } });
      return { ok: true, id: req.careReservationDossierId, reference: d?.reference ?? "", nouveau: false };
    }
  }
  const assistantes = await prisma.user.findMany({
    where: { isActive: true, ...anyRoleFilter(["DIRECTION_ASSISTANT"]) },
    select: { id: true }, orderBy: { createdAt: "asc" },
  });
  if (assistantes.length === 0) {
    return { ok: false, error: "Aucune assistante de direction active : la demande n'a personne à qui partir (Administration › Comptes)." };
  }
  const seule = assistantes.length === 1 ? assistantes[0]!.id : null;
  const sujet = await createDossierRecord({
    title: `Prise en charge — ${req.name}`,
    description: `${titre}\n${corps}`,
    category: "Billets",
    priority: "HIGH",
    assignedToId: seule,
    participantIds: [...(seule ? [] : assistantes.map((a) => a.id)), ...(req.requesterId ? [req.requesterId] : [])],
    sourceType: SPEC[scope].module,
    sourceId: req.id,
    companyId: req.companyId ?? null,
  }, user.id);
  if (scope === "NATIONAL") await prisma.congressNational.update({ where: { id: req.id }, data: { careReservationDossierId: sujet.id } });
  else await prisma.congressInternational.update({ where: { id: req.id }, data: { careReservationDossierId: sujet.id } });
  return { ok: true, id: sujet.id, reference: sujet.reference, nouveau: true };
}

/** Le lien parent d'une personne / d'un devis, selon le périmètre. */
export const parentWhere = (scope: Scope, id: string) =>
  scope === "NATIONAL" ? { congressNationalId: id } : { congressInternationalId: id };

/** Retrouve le périmètre et la demande depuis une personne. */
export async function scopeOfBeneficiary(beneficiaryId: string) {
  const b = await prisma.careBeneficiary.findUnique({
    where: { id: beneficiaryId },
    select: { id: true, congressNationalId: true, congressInternationalId: true, status: true, doctorId: true, firstName: true, lastName: true },
  });
  if (!b) return null;
  const scope: Scope = b.congressNationalId ? "NATIONAL" : "INTERNATIONAL";
  const requestId = b.congressNationalId ?? b.congressInternationalId;
  return requestId ? { beneficiary: b, scope, requestId } : null;
}

/** Nom affichable d'une personne — résout l'annuaire si besoin. */
export async function nameOf(b: { doctorId: string | null; firstName: string | null; lastName: string | null }): Promise<string> {
  let doctorName: string | null = null;
  if (b.doctorId) {
    doctorName = (await prisma.medicalDoctor.findUnique({ where: { id: b.doctorId }, select: { name: true } }))?.name ?? null;
  }
  return beneficiaryName({ ...b, doctorName });
}

/** Les rôles d'une personne (principal et secondaire) — ce que `peutTeleverserBillet` lit. */
export const rolesDe = (u: SessionUser): string[] => [u.role, (u as { secondaryRole?: string | null }).secondaryRole].filter((r): r is string => Boolean(r));
