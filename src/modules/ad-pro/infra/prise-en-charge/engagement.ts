import type { CareBeneficiaryStatus, CareQuoteStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { beneficiaryName } from "../../domaine/prise-en-charge/regles";
import { sansBloquer } from "@/lib/journal";

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

/**
 * DEUX DEVIS DIFFÉRENTS SUR LES MÊMES CASES, ACCEPTÉS À LA MÊME MINUTE (audit 2026-10-27, DONNEES-08). La garde
 * `quoteConflicts` lit les autres devis en mémoire : le PDG accepte A pendant que le DG accepte B, chacun voit
 * l'autre encore « en attente », et les mêmes billets partaient payés deux fois. Les CASES se prennent donc
 * aussi, sous verrou et dans un ordre fixe (deux preneurs ne peuvent pas s'entre-bloquer) : seul le devis qui
 * les trouve toutes libres les marque à son nom ; l'autre rend sa réserve et le dit.
 */
export async function prendreLesCasesDuDevis(quoteId: string, cellIds: string[]): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const lues = await tx.$queryRaw<{ id: string; quoteId: string | null }[]>`
      SELECT id, "quoteId" FROM "CareCell" WHERE id = ANY(${cellIds}::text[]) ORDER BY id FOR UPDATE`;
    if (lues.length !== cellIds.length || lues.some((c) => c.quoteId !== null && c.quoteId !== quoteId)) return false;
    await tx.careCell.updateMany({ where: { id: { in: cellIds } }, data: { quoteId } });
    return true;
  });
}

/**
 * RENDRE LA RÉSERVE d'un devis accepté qui n'a pas abouti (cases prises par un rival, ordre non émis) : ses seules
 * cases, et le devis revient à l'état lu. L'appelant (`decideCareQuote`) a vérifié qu'il tranche (`canDecide`).
 */
export async function rendreLaReserveDuDevis(
  quoteId: string, cellIds: string[],
  avant: { status: CareQuoteStatus; decidedById: string | null; decidedAt: Date | null },
): Promise<void> {
  await prisma.careCell.updateMany({ where: { id: { in: cellIds }, quoteId, expenseOrderId: null }, data: { quoteId: null } }).catch(sansBloquer("care-engagement.rendreLaReserve.careCell"));
  await prisma.careQuote.updateMany({
    where: { id: quoteId, expenseOrderId: null, status: "ACCEPTED" },
    data: { status: avant.status, decidedById: avant.decidedById, decidedAt: avant.decidedAt },
  }).catch(sansBloquer("care-engagement.rendreLaReserve.careQuote"));
}
