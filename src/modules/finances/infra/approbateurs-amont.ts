import type { EntityType } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * QUI A APPROUVÉ CETTE DEMANDE EN AMONT ? — la lecture que la séparation des tâches attend au centre de paiement.
 *
 * Garde-fous de l'argent (Super Admin, 24/11/2026) : « qui décide n'autorise pas au centre ». Un ordre de dépense naît de
 * vingt circuits ; ce qui y vaut APPROBATION est déjà écrit, chacun à sa place :
 *   • une étape de validation APPROUVÉE (`ValidationStep`, centre de validations, demandes de validation directes) ;
 *   • une étape de circuit APPROUVÉE (`WorkflowStepEvent` APPROVE — Ad & Pro, porte DG comprise, achats) ;
 *   • la validation du TOTAL par le Directeur Général (`AdProPorteDg` VALIDEE) et le visa du centre Ad & Pro
 *     (`AdProGateVisa` APPROVED) ;
 *   • l'accord d'un poste Ad & Pro (Direction des opérations puis Direction Marketing, `AdProItem`).
 * On les lit sur la source de l'ordre, sur la demande de paiement qui l'accompagne et sur le dossier auquel celle-ci est
 * rattachée — et pour un poste, sur sa demande parente. Le « bon à payer » des Finances n'en est pas : il vient APRÈS le
 * centre, et la règle du règlement le tient déjà.
 *
 * Lecture seule. Une source inconnue ne rend personne : la règle ne refuse rien qu'elle ne peut pas montrer.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

interface Cible { entityType: EntityType; entityId: string }

/** La demande Ad & Pro qui porte un poste — la porte DG, le visa et le circuit vivent sur elle. */
function parentDuPoste(p: {
  sponsoringId: string | null; congressNationalId: string | null; congressInternationalId: string | null;
  eventId: string | null; otherRequestId: string | null; trainingId: string | null;
}): Cible | null {
  if (p.sponsoringId) return { entityType: "SPONSORING", entityId: p.sponsoringId };
  if (p.congressNationalId) return { entityType: "CONGRESS_NATIONAL", entityId: p.congressNationalId };
  if (p.congressInternationalId) return { entityType: "CONGRESS_INTERNATIONAL", entityId: p.congressInternationalId };
  if (p.eventId) return { entityType: "EVENT", entityId: p.eventId };
  if (p.otherRequestId) return { entityType: "AD_PRO_OTHER", entityId: p.otherRequestId };
  if (p.trainingId) return { entityType: "TRAINING", entityId: p.trainingId };
  return null;
}

type OrdreSource = { id: string; sourceType: EntityType | string | null; sourceId: string | null };
const cle = (c: Cible) => `${c.entityType}:${c.entityId}`;

/** EN LOT (la file du centre) : une poignée de requêtes pour tous les ordres, jamais une série par ordre (§118.102b). */
export async function approbateursEnAmontDesOrdres(ordres: readonly OrdreSource[]): Promise<Map<string, string[]>> {
  const resultat = new Map<string, string[]>();
  if (ordres.length === 0) return resultat;
  const ids = ordres.map((o) => o.id);
  const ciblesDe = new Map<string, Cible[]>(ordres.map((o) => [o.id, o.sourceType && o.sourceId ? [{ entityType: o.sourceType as EntityType, entityId: o.sourceId }] : []]));
  const directs = new Map<string, Set<string>>(ordres.map((o) => [o.id, new Set<string>()]));

  // La demande de paiement qui accompagne l'ordre (ou dont il est né), et le dossier auquel elle est rattachée.
  const prSources = ordres.filter((o) => o.sourceType === "PAYMENT_REQUEST" && o.sourceId).map((o) => o.sourceId as string);
  const demandes = await prisma.paymentRequest.findMany({
    where: { OR: [{ expenseOrderId: { in: ids } }, ...(prSources.length ? [{ id: { in: prSources } }] : [])] },
    select: { id: true, expenseOrderId: true, entityType: true, entityId: true },
  });
  for (const o of ordres) {
    for (const d of demandes.filter((d) => d.expenseOrderId === o.id || (o.sourceType === "PAYMENT_REQUEST" && o.sourceId === d.id))) {
      ciblesDe.get(o.id)!.push({ entityType: "PAYMENT_REQUEST", entityId: d.id });
      if (d.entityType && d.entityId) ciblesDe.get(o.id)!.push({ entityType: d.entityType, entityId: d.entityId });
    }
  }

  // Les postes Ad & Pro : leur accord en deux temps, et leur demande parente.
  const postesIds = [...ciblesDe.values()].flat().filter((c) => c.entityType === "AD_PRO_ITEM").map((c) => c.entityId);
  const postes = await prisma.adProItem.findMany({
    where: { OR: [{ expenseOrderId: { in: ids } }, ...(postesIds.length ? [{ id: { in: postesIds } }] : [])] },
    select: {
      id: true, expenseOrderId: true, status: true, decidedById: true, opsDecidedById: true,
      sponsoringId: true, congressNationalId: true, congressInternationalId: true, eventId: true, otherRequestId: true, trainingId: true,
    },
  });
  for (const o of ordres) {
    const siens = postes.filter((p) => p.expenseOrderId === o.id || ciblesDe.get(o.id)!.some((c) => c.entityType === "AD_PRO_ITEM" && c.entityId === p.id));
    for (const p of siens) {
      if (p.opsDecidedById) directs.get(o.id)!.add(p.opsDecidedById);
      if (p.decidedById && p.status === "APPROVED") directs.get(o.id)!.add(p.decidedById);
      ciblesDe.get(o.id)!.push({ entityType: "AD_PRO_ITEM", entityId: p.id });
      const parent = parentDuPoste(p);
      if (parent) ciblesDe.get(o.id)!.push(parent);
    }
  }

  // Les approbations écrites sur ces dossiers, lues une fois pour toute la file.
  const toutes = [...new Map([...ciblesDe.values()].flat().map((c) => [cle(c), c])).values()];
  const parCible = new Map<string, Set<string>>();
  const note = (c: Cible, acteur: string | null) => {
    if (!acteur) return;
    if (!parCible.has(cle(c))) parCible.set(cle(c), new Set());
    parCible.get(cle(c))!.add(acteur);
  };
  if (toutes.length > 0) {
    const ou = toutes.map((c) => ({ entityType: c.entityType, entityId: c.entityId }));
    const [etapes, circuits, portes, visas] = await Promise.all([
      prisma.validationStep.findMany({ where: { status: "APPROVED", request: { OR: ou } }, select: { validatorId: true, request: { select: { entityType: true, entityId: true } } } }),
      prisma.workflowStepEvent.findMany({ where: { action: "APPROVE", instance: { OR: ou } }, select: { actorId: true, instance: { select: { entityType: true, entityId: true } } } }),
      prisma.adProPorteDg.findMany({ where: { statut: "VALIDEE", decideParId: { not: null }, OR: ou }, select: { decideParId: true, entityType: true, entityId: true } }),
      prisma.adProGateVisa.findMany({ where: { status: "APPROVED", decidedById: { not: null }, OR: ou }, select: { decidedById: true, entityType: true, entityId: true } }),
    ]);
    for (const e of etapes) if (e.request.entityType && e.request.entityId) note({ entityType: e.request.entityType, entityId: e.request.entityId }, e.validatorId);
    for (const c of circuits) note(c.instance, c.actorId);
    for (const p of portes) note(p, p.decideParId);
    for (const v of visas) note(v, v.decidedById);
  }
  for (const o of ordres) {
    const tous = new Set(directs.get(o.id));
    for (const c of ciblesDe.get(o.id)!) for (const a of parCible.get(cle(c)) ?? []) tous.add(a);
    resultat.set(o.id, [...tous]);
  }
  return resultat;
}

/** Pour UN ordre — le geste du centre (`decidePayment`). */
export async function approbateursEnAmont(ordre: OrdreSource): Promise<string[]> {
  return (await approbateursEnAmontDesOrdres([ordre])).get(ordre.id) ?? [];
}
