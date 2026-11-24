import type { Prisma, UserRole } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { PERMISSIONS, anyRoleFilter, getAccess, userCan, type SessionUser } from "@/lib/rbac";
import { syncStatusFromWorkflow } from "@/lib/regulatory/sync-status";
import type { RegWorkflowState } from "@/lib/regulatory-workflow";
import { ETAPES_BV } from "@/lib/budget-regulatory/bv";
import { etapeDeDemandeSelonLaDecision, natureDeLObjetBv } from "@/lib/regulatory/bv-validation";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE BV D'UN DOSSIER AU CENTRE DE VALIDATIONS — QUI TRANCHE, ET CE QUE LA DÉCISION ENTRAÎNE (Super Admin, 24/11/2026).
 *
 * « Toutes les personnes qui ont accès au Centre de validations peuvent accepter ou refuser » : c'est l'ACCÈS EFFECTIF
 * au module `VALIDATION_CENTRE` (rôle, autre rôle, console du Super Admin — `getAccess`/`userCan`) qui fait le
 * décideur, jamais un rôle écrit ici. On le lit deux fois :
 *   • à la demande, pour saisir et prévenir les personnes qui ont l'accès À CET INSTANT (une étape chacune) ;
 *   • à la décision, pour autoriser TOUTE personne qui l'a À CET INSTANT — y compris quelqu'un à qui la console l'a
 *     ouvert après la demande (il reçoit alors sa propre étape au moment de trancher), et jamais quelqu'un à qui on
 *     l'a retiré depuis.
 * Une décision suffit (`unSeulSuffit`) ; on ne tranche jamais sa propre demande.
 *
 * Module SERVEUR ordinaire (pas `"use server"`) : ces fonctions reçoivent un utilisateur en argument.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Le module dont l'accès fait le décideur d'un BV. */
const MODULE_DU_CENTRE = "VALIDATION_CENTRE" as const;

/** Cette personne peut-elle trancher un BV ? — l'accès effectif au Centre de validations, rien d'autre. */
export function peutTrancherLesBv(user: Pick<SessionUser, "access">): boolean {
  return userCan(user as SessionUser, MODULE_DU_CENTRE, "VIEW");
}

/** La même question pour une personne désignée par son identifiant (sa ligne lue, son accès résolu). */
export async function voitLesBvDuCentre(userId: string): Promise<boolean> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { role: true, isActive: true } });
  if (!u || !u.isActive) return false;
  return peutTrancherLesBv({ access: await getAccess(userId, u.role) });
}

/**
 * LES VALIDATEURS D'UN BV — les comptes ACTIFS qui ont l'accès effectif au Centre de validations, sauf le demandeur.
 * Les candidats sont ceux à qui un rôle (principal ou autre) ou la console donne le module ; chacun est ensuite
 * confirmé par son accès RÉSOLU — un blocage posé dans la console l'emporte sur le rôle.
 */
export async function validateursDuCentre(demandeurId: string): Promise<string[]> {
  const roles = (Object.keys(PERMISSIONS) as UserRole[]).filter((r) => PERMISSIONS[r]?.[MODULE_DU_CENTRE]?.includes("VIEW"));
  const [parRole, parConsole] = await Promise.all([
    prisma.user.findMany({ where: { isActive: true, ...anyRoleFilter(roles) }, select: { id: true, role: true } }),
    prisma.userAccess.findMany({
      where: { module: MODULE_DU_CENTRE, canView: true, user: { isActive: true } },
      select: { user: { select: { id: true, role: true } } },
    }),
  ]);
  const candidats = new Map<string, UserRole>();
  for (const u of parRole) candidats.set(u.id, u.role);
  for (const a of parConsole) candidats.set(a.user.id, a.user.role);
  candidats.delete(demandeurId);
  const retenus: string[] = [];
  for (const [id, role] of candidats) {
    if (peutTrancherLesBv({ access: await getAccess(id, role) })) retenus.push(id);
  }
  return retenus.sort();
}

/**
 * L'ÉTAPE QUE CETTE PERSONNE TRANCHE SUR UNE DEMANDE DE BV — la sienne ; à défaut (l'accès lui a été ouvert après la
 * demande), une étape créée pour elle, sous le verrou de la demande, tant qu'elle est en attente. Rend :
 *   • `null` — ce n'est pas une demande de BV : le circuit ordinaire s'applique ;
 *   • `{ refus }` — elle n'a pas (ou plus) l'accès, ou c'est sa propre demande ;
 *   • `{ stepId }` — l'étape à trancher (la décision est enregistrée à son nom, pas à celui d'un autre).
 */
export async function etapeDuCentrePourLeBv(
  user: Pick<SessionUser, "id" | "access">,
  request: { id: string; objectType: string | null; requesterId: string },
): Promise<null | { refus: string } | { stepId: string }> {
  if (!natureDeLObjetBv(request.objectType)) return null;
  if (request.requesterId === user.id) return { refus: "Vous avez demandé ce BV : un autre membre du Centre de validations doit le trancher." };
  if (!peutTrancherLesBv(user)) {
    return { refus: "Seules les personnes qui ont accès au Centre de validations tranchent un BV : le Super Admin ouvre cet accès depuis la console." };
  }
  const stepId = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "ValidationRequest" WHERE id = ${request.id} FOR UPDATE`;
    const frais = await tx.validationRequest.findUnique({ where: { id: request.id }, select: { status: true, steps: { select: { id: true, validatorId: true, status: true } } } });
    if (!frais) return null;
    const mienne = frais.steps.find((s) => s.validatorId === user.id && s.status === "PENDING");
    if (mienne) return mienne.id;
    if (frais.status !== "PENDING") return frais.steps.find((s) => s.validatorId === user.id)?.id ?? frais.steps[0]?.id ?? null;
    return (await tx.validationStep.create({ data: { requestId: request.id, order: 1, validatorId: user.id, status: "PENDING" }, select: { id: true } })).id;
  });
  return stepId ? { stepId } : { refus: "Demande introuvable." };
}

/**
 * APRÈS LA DÉCISION D'UN BV — l'étape « Demande du BV » suit (fait si accepté, à faire si refusé), le niveau de
 * process est recalculé par son seul écrivain, le dossier garde la trace, et ses écrans se rafraîchissent. Le
 * demandeur, lui, est prévenu par la décision elle-même (`decideValidation`), avec le lien vers la fiche
 * (`suiteDecisionBv`). Ne lève jamais : la décision est déjà enregistrée.
 */
export async function apresDecisionBv(
  req: { id: string; reference: string; objectType: string | null; entityType: string | null; entityId: string | null; amount: Prisma.Decimal | number | null },
  statut: string,
  acteurId: string,
): Promise<void> {
  const nature = natureDeLObjetBv(req.objectType);
  if (!nature || req.entityType !== "REGULATORY_PRODUCT" || !req.entityId || statut === "PENDING") return;
  const productId = req.entityId;
  const produit = await prisma.regulatoryProduct.findUnique({ where: { id: productId }, select: { workflow: true, status: true, reference: true } });
  if (!produit) return;
  const cle = ETAPES_BV[nature].demande;
  const wf = { ...((produit.workflow as RegWorkflowState | null) ?? {}) };
  const voulu = etapeDeDemandeSelonLaDecision(statut);
  if (wf[cle]?.status !== voulu) {
    wf[cle] = { ...wf[cle], status: voulu, date: voulu === "DONE" ? new Date().toISOString().slice(0, 10) : wf[cle]?.date };
    await prisma.regulatoryProduct.update({ where: { id: productId }, data: { workflow: wf as unknown as Prisma.InputJsonValue } });
    await syncStatusFromWorkflow(productId, wf, produit.status, produit.reference, acteurId);
  }
  const montant = req.amount === null ? null : Number(req.amount);
  await recordAudit({
    actorId: acteurId, action: statut === "APPROVED" ? "VALIDATE" : "REFUSE", module: "Regulatory",
    entityType: "REGULATORY_PRODUCT", entityId: productId, field: `BV ${nature} %`, newValue: statut,
    summary: `BV ${nature} % ${statut === "APPROVED" ? "accepté" : "refusé"} au Centre de validations (${req.reference}${montant !== null ? `, ${montant.toLocaleString("fr-FR")} DZD` : ""})${statut === "APPROVED" ? " — montant engagé au budget Regulatory" : ""}`,
  });
  revalidatePath(`/regulatory/${productId}`);
  revalidatePath("/budget-regulatory");
  revalidatePath("/budget-regulatory/bv");
}

/** Ce que la notification de la décision ajoute pour un BV : le geste suivant, et le lien vers la FICHE du dossier. */
export function suiteDecisionBv(
  req: { objectType: string | null; entityId: string | null },
  statut: string,
): { suite: string; lien: string } | null {
  const nature = natureDeLObjetBv(req.objectType);
  if (!nature || !req.entityId) return null;
  return {
    lien: `/regulatory/${req.entityId}`,
    suite: statut === "APPROVED"
      ? ` Le BV ${nature} % est accepté et son montant engagé au budget Regulatory : l'étape « Paiement du BV ${nature} % » est déverrouillée.`
      : ` Vous pouvez redemander le BV ${nature} % depuis la fiche du dossier.`,
  };
}
