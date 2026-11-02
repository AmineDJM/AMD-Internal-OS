import type { NotificationType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { anyRoleFilter } from "@/lib/rbac";
import { notifyUser } from "@/lib/notify";
import { recordAudit } from "@/lib/audit";
import { annulerOrdreNonRegle } from "@/modules/finances/api";
import { sansBloquer } from "@/lib/journal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * ANNULER UNE DEMANDE AU SECRÉTARIAT, ET CE QUI EN DÉPEND — UN SEUL GESTE (§118.187 — audit 360°, R08, R10).
 *
 * Une demande au secrétariat peut porter trois choses qui lui survivraient si l'on ne changeait que son
 * statut : une VALIDATION en attente (celle de la demande, ou celle d'une pièce jointe), une APPROBATION
 * en attente, et un ORDRE DE DÉPENSE non réglé. Les trois sont des portes d'à côté (§118.71) : approuver
 * l'une émettait un paiement pour une demande que son auteur venait d'annuler — `decideApproval` et la
 * décision d'une pièce créent un ordre dès qu'un montant est saisi. Deux appelants annulent une demande :
 * son DEMANDEUR (au-delà de la fenêtre discrète) et le POSTE Ad & Pro qui l'avait ouverte (refus, retrait
 * de la demande de BC, suppression). Deux copies auraient fini par n'annuler pas la même chose.
 *
 * L'ordre des écritures est la moitié de la règle :
 *   1. l'argent PARTI se lit d'abord, et refuse AVANT de toucher quoi que ce soit — une demande dont le
 *      paiement est réglé ne s'annule plus, elle se termine ;
 *   2. la demande passe ANNULÉE par une écriture CONDITIONNELLE — terminée ou annulée entre-temps, elle
 *      n'est pas rouverte pour être annulée, et l'appelant le lit (`annulee: false`) ;
 *   3. alors seulement ce qui en dépend : validations retirées (leurs validateurs prévenus), approbations
 *      en attente retirées (comme au retrait d'une demande d'achat), ordres non réglés — RELUS ici, après
 *      l'écriture conditionnelle, jamais repris de la lecture du point 1 — annulés par la porte unique
 *      (`annulerOrdreNonRegle`, conditionnelle). Un ordre réglé ENTRE la lecture et l'annulation n'est
 *      pas défait : la réserve le DIT au lieu de se taire ;
 *   4. la trace : le motif dans la discussion de la demande, et le secrétariat prévenu (le responsable
 *      désigné, sinon chaque assistante de direction — jamais l'auteur du geste).
 *
 * Pas de suppression : une demande que quelqu'un a peut-être déjà travaillée se CLÔT, motif à l'appui.
 * La fenêtre discrète du demandeur, elle, garde sa suppression douce — personne n'y a encore rien fait.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

interface Avis { type: NotificationType; title: string; body?: string; link?: string }

/**
 * PRÉVENIR LE SECRÉTARIAT (audit 360°, R09) : le responsable désigné ; à défaut, chaque assistante de
 * direction active. Les demandes ouvertes par un poste naissent SANS responsable — notifier le seul
 * `assignedToId` revenait à ne prévenir personne. L'auteur du geste n'est jamais prévenu de son propre geste.
 */
export async function prevenirLeSecretariat(assignedToId: string | null, avis: Avis, auteurId: string): Promise<number> {
  if (assignedToId) {
    if (assignedToId === auteurId) return 0;
    await notifyUser({ userId: assignedToId, ...avis }).catch(sansBloquer("annulation.prevenirLeSecretariat.notifyUser"));
    return 1;
  }
  const assistantes = await prisma.user.findMany({
    where: { AND: [anyRoleFilter(["DIRECTION_ASSISTANT"]), { isActive: true }, { id: { not: auteurId } }] },
    select: { id: true },
  });
  for (const a of assistantes) await notifyUser({ userId: a.id, ...avis }).catch(sansBloquer("annulation.prevenirLeSecretariat.notifyUser"));
  return assistantes.length;
}

export type AnnulationDemande =
  | { ok: true; annulee: boolean; reference: string; ordresAnnules: string[]; retraits: number; reserve: string | null }
  | { ok: false; error: string };

export async function annulerDemandeSecretariat(
  id: string,
  opts: { acteurId: string; motif: string; /** « par son demandeur », « par le retrait du poste »… */ cause: string },
): Promise<AnnulationDemande> {
  const d = await prisma.administrativeRequest.findUnique({
    where: { id },
    select: { reference: true, title: true, assignedToId: true, deletedAt: true },
  });
  if (!d || d.deletedAt) return { ok: false, error: "Demande introuvable." };

  // 1. L'argent parti refuse, avant toute écriture. Cette lecture ne sert QU'À refuser : la liste des
  //    ordres à annuler se relit au point 3, après l'écriture conditionnelle (voir plus bas).
  const regle = await prisma.expenseOrder.findFirst({
    where: { sourceType: "ADMIN_REQUEST", sourceId: id, status: "PAID" },
    select: { reference: true },
  });
  if (regle) {
    return {
      ok: false,
      error: `Le paiement ${regle.reference} de la demande ${d.reference} est déjà réglé : l'argent est parti, la demande ne s'annule plus — elle se termine. Écrivez à l'assistante dans sa discussion.`,
    };
  }

  // 2. La demande, sous condition.
  const r = await prisma.administrativeRequest.updateMany({
    where: { id, deletedAt: null, status: { notIn: ["DONE", "CANCELLED"] } },
    data: { status: "CANCELLED", cancelledAt: new Date() },
  });
  if (r.count === 0) return { ok: true, annulee: false, reference: d.reference, ordresAnnules: [], retraits: 0, reserve: null };

  // 3. Ce qui en dépend.
  const lien = `/demandes/${id}`;
  let retraits = 0;
  const validations = await prisma.validationRequest.findMany({
    where: { entityType: "ADMIN_REQUEST", entityId: id, status: "PENDING" },
    select: { id: true, reference: true, steps: { select: { validatorId: true, status: true } } },
  });
  for (const v of validations) {
    const u = await prisma.validationRequest.updateMany({ where: { id: v.id, status: "PENDING" }, data: { status: "CANCELLED", decidedAt: new Date() } });
    if (u.count === 0) continue;
    retraits += 1;
    for (const s of v.steps) {
      if (s.status !== "PENDING" || s.validatorId === opts.acteurId) continue;
      await notifyUser({
        userId: s.validatorId, type: "GENERIC", title: "Validation retirée",
        body: `${v.reference} — la demande ${d.reference} a été annulée ${opts.cause} : ${opts.motif}`, link: lien,
      }).catch(sansBloquer("annulation.annulerDemandeSecretariat.notifyUser"));
    }
  }
  const approbations = await prisma.adminApproval.findMany({ where: { requestId: id, status: "PENDING" }, select: { id: true, validatorId: true } });
  if (approbations.length > 0) {
    const del = await prisma.adminApproval.deleteMany({ where: { id: { in: approbations.map((a) => a.id) }, status: "PENDING" } });
    retraits += del.count;
    for (const a of approbations) {
      if (!a.validatorId || a.validatorId === opts.acteurId) continue;
      await notifyUser({
        userId: a.validatorId, type: "GENERIC", title: "Validation retirée",
        body: `La demande ${d.reference} a été annulée ${opts.cause} : ${opts.motif}`, link: lien,
      }).catch(sansBloquer("annulation.annulerDemandeSecretariat.notifyUser"));
    }
  }
  // LES ORDRES SE RELISENT ICI, APRÈS L'ÉCRITURE CONDITIONNELLE (vague « restes »). Lus au point 1, ils
  // laissaient passer l'ordre qu'une décision émettait ENTRE cette lecture et l'annulation — une pièce
  // validée, une approbation tranchée à la même seconde : la demande partait « annulée » et son paiement
  // restait payable au centre, sans un mot (§118.5 : deux vérités sur le même paiement). Relus après la
  // demande close, ses validations et ses approbations retirées, ils couvrent tout ordre né avant la
  // clôture. Celui qu'une décision émettrait encore APRÈS est rattrapé par la décision elle-même :
  // `decideApproval` et `decideValidation` (une pièce validée, vague « restes 2 ») relisent la demande
  // après avoir émis, et annulent par la porte unique l'ordre qu'ils viennent d'émettre. Chacun des deux
  // gestes écrit avant de relire l'autre : l'un des deux voit forcément l'annulation.
  const ordres = await prisma.expenseOrder.findMany({
    where: { sourceType: "ADMIN_REQUEST", sourceId: id, status: { not: "CANCELLED" } },
    select: { id: true },
  });
  const ordresAnnules: string[] = [];
  let reserve: string | null = null;
  for (const o of ordres) {
    const a = await annulerOrdreNonRegle(o.id, { acteurId: opts.acteurId, motif: `demande ${d.reference} annulée ${opts.cause} — ${opts.motif}` });
    if (!a.ok) { reserve = a.error; continue; }
    if (a.annule && a.reference) ordresAnnules.push(a.reference);
  }

  // 4. La trace.
  await prisma.comment.create({
    data: { entityType: "ADMIN_REQUEST", entityId: id, body: `Demande annulée ${opts.cause} : ${opts.motif}`, authorId: opts.acteurId },
  }).catch(sansBloquer("annulation.annulerDemandeSecretariat.comment"));
  await recordAudit({
    actorId: opts.acteurId, action: "UPDATE", module: "Bureau du secrétariat", entityType: "ADMIN_REQUEST", entityId: id,
    field: "status", newValue: "CANCELLED",
    summary: `Demande ${d.reference} annulée ${opts.cause} — ${opts.motif}${ordresAnnules.length ? ` ; paiement(s) annulé(s) : ${ordresAnnules.join(", ")}` : ""}`,
  });
  await prevenirLeSecretariat(d.assignedToId, {
    type: "GENERIC", title: "Demande au secrétariat annulée", body: `${d.reference} — ${d.title} : ${opts.motif}`, link: lien,
  }, opts.acteurId);
  return { ok: true, annulee: true, reference: d.reference, ordresAnnules, retraits, reserve };
}
