"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { notifyUser } from "@/lib/notify";
import { fdStr, type ActionResult } from "@/lib/actions/types";
import { encadrantDuDelegue } from "@/lib/queries/equipe-delegue";
import { refusEcarterAlertePv } from "@/lib/sfe/compte-rendu-envoye";
import { CHEMIN_RAPPORTS_TERRAIN, lienRelireRapport } from "@/lib/chemins/rapports-terrain";
import { MODULE_AUDIT_VISITE } from "@/lib/medical/module-visite";
import { sansBloquer } from "@/lib/journal";

/**
 * « CE N'EST PAS UN CAS » — la réponse du délégué à l'alerte de pharmacovigilance que l'IA a levée sur son compte rendu
 * (interface du délégué, maquette VALIDÉE le 24/11/2026 ; DECISIONS : « tracé, visible du superviseur »).
 *
 * Le geste ne FERME rien : le rapport reste « à relire en priorité » chez le superviseur, qui lit la réponse à côté de la
 * phrase relevée et tranche à la relecture. Il est tracé trois fois — sur la visite (`pvEcarteLe`, `pvEcarteParId`), au
 * journal d'audit, et dans la notification du superviseur.
 *
 * L'écriture est CONDITIONNELLE (§118.151) : sur le texte lu par l'IA, sans cas déclaré entre-temps, une seule fois. Un
 * compte rendu corrigé efface la réponse avec la lecture (`LECTURES_A_REFAIRE`) : elle portait sur l'ancien texte.
 */

const PATH_JOURNEE = "/medical/ma-journee";

export async function ecarterAlertePvVisite(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, "MEDICAL", "VIEW")) return { ok: false, error: "La Visite médicale ne vous est pas ouverte : demandez l'accès à votre administrateur." };
  const visitId = fdStr(formData, "visitId");
  if (!visitId) return { ok: false, error: "Visite introuvable." };

  const visite = await prisma.medicalVisit.findUnique({
    where: { id: visitId },
    select: {
      id: true, date: true, delegateId: true, report: true, pvIa: true, pvIaExtrait: true, pvEcarteLe: true,
      doctor: { select: { name: true } }, delegate: { select: { name: true } },
      _count: { select: { casPharmacovigilance: true } },
    },
  });
  if (!visite) return { ok: false, error: "Visite introuvable." };
  const refus = refusEcarterAlertePv({
    delegateId: visite.delegateId, userId: user.id, pvIa: visite.pvIa, nbCas: visite._count.casPharmacovigilance, ecarteLe: visite.pvEcarteLe,
  });
  if (refus) return { ok: false, error: refus };

  const maintenant = new Date();
  // porte d'écriture : le délégué de CETTE visite (relu plus haut, et dans la condition `delegateId`).
  const ecrit = await prisma.medicalVisit.updateMany({
    where: {
      id: visite.id, delegateId: user.id, report: visite.report, pvIa: visite.pvIa, pvEcarteLe: null,
      casPharmacovigilance: { none: {} },
    },
    data: { pvEcarteLe: maintenant, pvEcarteParId: user.id },
  });
  if (ecrit.count === 0) {
    return { ok: false, error: "Le compte rendu a changé entre-temps (corrigé, relu par l'IA ou un cas déclaré) : rechargez l'écran." };
  }

  const jour = visite.date.toLocaleDateString("fr-FR");
  const qui = visite.doctor?.name ?? "praticien non précisé";
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: MODULE_AUDIT_VISITE, entityType: "VISIT", entityId: visite.id,
    summary: `Alerte de pharmacovigilance de l'IA : « ce n'est pas un cas » selon le délégué — ${qui}, ${jour}`,
  });
  // LE SUPERVISEUR LE SAIT TOUT DE SUITE : c'est lui qui tranche, sur la phrase relevée et cette réponse.
  const encadrant = await encadrantDuDelegue(user.id).catch(sansBloquer("visite-pv-ecart.encadrant", null));
  if (encadrant && encadrant !== user.id) {
    await notifyUser({
      userId: encadrant, type: "GENERIC",
      title: `${visite.delegate?.name ?? user.name} indique : « ce n'est pas un cas »`,
      body: `Visite du ${jour} — ${qui}${visite.pvIaExtrait ? ` : « ${visite.pvIaExtrait} »` : ""}. Le rapport reste à relire en priorité.`,
      link: lienRelireRapport(visite.id),
    }).catch(sansBloquer("visite-pv-ecart.notifier"));
  }
  revalidatePath(PATH_JOURNEE);
  revalidatePath(CHEMIN_RAPPORTS_TERRAIN);
  revalidatePath("/planning");
  return { ok: true, id: visite.id, message: "Noté. Votre superviseur tranchera à la relecture." };
}
