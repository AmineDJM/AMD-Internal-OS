import type { CareBeneficiaryStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { beneficiaryName } from "@/lib/care";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * PRISE EN CHARGE — RIEN NE S'ENGAGE AVANT LA PRÉVALIDATION ET L'ACCORD (Direction, 27/10/2026).
 *
 * Aucun devis, aucun BC, aucun ordre de dépense tant que :
 *   • la demande n'est pas PRÉVALIDÉE — son circuit (N+1 → Directeur des opérations → Direction
 *     Marketing) est terminé : son `WorkflowInstance` est `APPROVED` ;
 *   • chaque personne couverte n'est pas « Accordée » (`CareBeneficiary.status = APPROVED`).
 *
 * Une demande SANS instance de circuit (née avant le moteur, jamais ouverte depuis) se lit comme le
 * moteur la positionnerait à sa création paresseuse (`positionFromLegacy`, `workflow/engine.ts`) :
 * son statut d'origine dit si le circuit est terminé. L'instance, quand elle existe, fait foi.
 *
 * Les gardes vivent ici, côté serveur : l'écran peut griser, c'est le serveur qui refuse.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

type Scope = "NATIONAL" | "INTERNATIONAL";

/** Les statuts d'origine qui disent « circuit terminé » — ceux de `positionFromLegacy`. */
const CIRCUIT_TERMINE = ["APPROVED", "VALIDATED", "PAID", "CLOSED", "COMPLETED", "ACCEPTED", "PRE_VALIDATED"];

export const REFUS_NON_PREVALIDEE =
  "La demande n'est pas encore prévalidée (N+1 → Directeur des opérations → Direction Marketing) : aucun devis, BC ni ordre de dépense avant.";

/** Prévalidée ? L'instance de circuit fait foi ; sans instance, le statut d'origine de la demande. */
export function estPrevalidee(instanceStatus: string | null | undefined, statutDemande: string | null | undefined): boolean {
  if (instanceStatus != null) return instanceStatus === "APPROVED";
  return CIRCUIT_TERMINE.includes(statutDemande ?? "");
}

/** Le refus pour des personnes pas encore accordées — `null` si toutes le sont. */
export function refusPersonnesNonAccordees(personnes: readonly { nom: string; status: CareBeneficiaryStatus }[]): string | null {
  const pas = personnes.filter((p) => p.status !== "APPROVED");
  if (pas.length === 0) return null;
  const LIB: Record<CareBeneficiaryStatus, string> = { PROPOSED: "proposée", APPROVED: "accordée", REJECTED: "écartée", WITHDRAWN: "retirée" };
  const liste = pas.map((p) => `${p.nom} (${LIB[p.status]})`).join(", ");
  return `Chaque personne couverte doit être « Accordée » avant tout devis, BC ou ordre de dépense — pas encore : ${liste}.`;
}

/** La demande est-elle prévalidée ? Lit son instance de circuit, sinon son statut. */
export async function demandePrevalidee(scope: Scope, requestId: string): Promise<boolean> {
  const entityType = scope === "NATIONAL" ? "CONGRESS_NATIONAL" : "CONGRESS_INTERNATIONAL";
  const [instance, demande] = await Promise.all([
    prisma.workflowInstance.findUnique({ where: { entityType_entityId: { entityType, entityId: requestId } }, select: { status: true } }),
    scope === "NATIONAL"
      ? prisma.congressNational.findUnique({ where: { id: requestId }, select: { requestStatus: true } })
      : prisma.congressInternational.findUnique({ where: { id: requestId }, select: { requestStatus: true } }),
  ]);
  return estPrevalidee(instance?.status ?? null, demande?.requestStatus ?? null);
}

/**
 * LA GARDE D'ENGAGEMENT : `null` si l'on peut engager (devis, BC, ordre) sur ces cases, sinon le refus.
 * Les personnes contrôlées sont celles qui portent les cases couvertes.
 */
export async function refusEngagementPriseEnCharge(scope: Scope, requestId: string, cellIds: readonly string[]): Promise<string | null> {
  if (!(await demandePrevalidee(scope, requestId))) return REFUS_NON_PREVALIDEE;
  if (cellIds.length === 0) return null;
  const personnes = await prisma.careBeneficiary.findMany({
    where: { cells: { some: { id: { in: [...cellIds] } } } },
    select: { status: true, firstName: true, lastName: true, doctorId: true },
    orderBy: { createdAt: "asc" },
  });
  const pas = personnes.filter((p) => p.status !== "APPROVED");
  if (pas.length === 0) return null;
  const ids = pas.map((p) => p.doctorId).filter((v): v is string => Boolean(v));
  const medecins = ids.length ? await prisma.medicalDoctor.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [];
  const nomMedecin = new Map(medecins.map((m) => [m.id, m.name]));
  return refusPersonnesNonAccordees(pas.map((p) => ({
    status: p.status,
    nom: beneficiaryName({ ...p, doctorName: p.doctorId ? nomMedecin.get(p.doctorId) ?? null : null }),
  })));
}
