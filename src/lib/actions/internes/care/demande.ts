/**
 * PRISE EN CHARGE — le PÉRIMÈTRE d'une demande (national / international), ses droits, et ce qu'on en charge :
 * la demande, la personne et son périmètre, un poste de groupe, le nom affichable d'une personne.
 *
 * Sorti de `actions/care-actions.ts` (lot V4) : lectures et règles, AUCUNE écriture — les écrivains locaux
 * (`audit`, `ouvrirFiche`, `ecrireAAssistante`) restent dans le fichier d'actions.
 */
import { revalidatePath } from "next/cache";
import { userCan, hasGlobalView, type SessionUser } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { toNumber } from "@/lib/utils";
import { beneficiaryName } from "@/lib/care";
import { tauxDeLaDemande } from "@/lib/care-fiches";

export type Scope = "NATIONAL" | "INTERNATIONAL";

export const SPEC: Record<Scope, { module: "CONGRESS_NATIONAL" | "CONGRESS_INTERNATIONAL"; path: string }> = {
  NATIONAL: { module: "CONGRESS_NATIONAL", path: "/congress-national" },
  INTERNATIONAL: { module: "CONGRESS_INTERNATIONAL", path: "/congress-international" },
};

export const isScope = (v: string): v is Scope => v === "NATIONAL" || v === "INTERNATIONAL";

/** Statuts à partir desquels la Direction a tranché la demande dans son ensemble. */

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
/** Trancher (accorder une personne, accepter un devis) : Direction. */
export function canDecide(user: SessionUser, scope: Scope): boolean {
  return hasGlobalView(user) || userCan(user, SPEC[scope].module, "VALIDATE");
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

/** Charge un poste de groupe, son périmètre et sa demande. */
export async function chargerPosteGroupe(id: string) {
  const g = await prisma.careGroupPoste.findUnique({ where: { id } });
  if (!g) return null;
  const scope: Scope = g.congressNationalId ? "NATIONAL" : "INTERNATIONAL";
  const requestId = g.congressNationalId ?? g.congressInternationalId;
  return requestId ? { g, scope, requestId } : null;
}
