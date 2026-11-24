"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { notifyUser } from "@/lib/notify";
import { equipeDuDelegue } from "@/lib/queries/equipe-delegue";
import { fdStr, type ActionResult } from "@/lib/actions/types";
import { COMMENTAIRE_RELECTURE_MAX, peutRelireRapport } from "@/lib/sfe/rapport-visite";
import { CHEMIN_RAPPORTS_TERRAIN } from "@/lib/chemins/rapports-terrain";
import { sansBloquer } from "@/lib/journal";

/**
 * RELIRE LE RAPPORT D'UNE VISITE (Visite médicale, Super Admin 11/2026 : « le superviseur relit les rapports et suit les
 * retards »).
 *
 * Le superviseur de la BU du délégué — ou son N+1 d'organigramme, la même équipe que celle qui valide son plan de
 * tournée (`reviseurDuPlan`) — marque le rapport « relu », avec un mot facultatif que le délégué lira sur son rapport.
 * Un rapport relu sort de la file « à relire » de Mon équipe terrain. Le suivi des retards (fenêtre de 48 h) ne change pas.
 *
 * L'écriture est CONDITIONNELLE (§118.151) : relu une seule fois, et sur le texte que le superviseur a eu sous les yeux —
 * un compte rendu corrigé entre-temps (le délégué a 48 h) n'est pas déclaré relu à sa place.
 */

const MODULE_AUDIT = "Promotion médicale";
const PATH_EQUIPE = "/planning";

export async function relireRapportVisite(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const visitId = fdStr(formData, "visitId");
  if (!visitId) return { ok: false, error: "Visite introuvable." };
  const commentaire = fdStr(formData, "commentaire");
  if (commentaire && commentaire.length > COMMENTAIRE_RELECTURE_MAX) {
    return { ok: false, error: `Votre mot au délégué dépasse ${COMMENTAIRE_RELECTURE_MAX.toLocaleString("fr-FR")} caractères : raccourcissez-le.` };
  }

  const visite = await prisma.medicalVisit.findUnique({
    where: { id: visitId },
    select: { id: true, date: true, status: true, report: true, delegateId: true, reluLe: true, doctor: { select: { name: true } } },
  });
  if (!visite) return { ok: false, error: "Visite introuvable." };

  // L'ÉQUIPE, LUE COMME LE PLAN DE TOURNÉE LA LIT : la BU du délégué et son N+1. Le refus dit qui peut relire.
  const equipe = visite.delegateId ? await equipeDuDelegue(visite.delegateId) : { superviseurBuId: null, managerRhId: null };
  if (!peutRelireRapport({ userId: user.id, repId: visite.delegateId, ...equipe })) {
    return { ok: false, error: "Seul le superviseur de la Business Unit de ce délégué, ou son N+1, relit ses rapports." };
  }
  if (visite.status !== "COMPLETED" || !visite.report) {
    return { ok: false, error: "Cette visite n'a pas encore de compte rendu : il n'y a rien à relire." };
  }
  if (visite.reluLe) return { ok: false, error: `Ce rapport est déjà relu (le ${visite.reluLe.toLocaleDateString("fr-FR")}).` };

  const maintenant = new Date();
  const relu = await prisma.medicalVisit.updateMany({
    where: { id: visite.id, reluLe: null, report: visite.report },
    data: { reluLe: maintenant, reluParId: user.id, reluCommentaire: commentaire?.slice(0, COMMENTAIRE_RELECTURE_MAX) ?? null },
  });
  if (relu.count === 0) {
    return { ok: false, error: "Le rapport a changé entre-temps (corrigé par le délégué, ou déjà relu) : rechargez l'écran et relisez-le." };
  }

  const jour = visite.date.toLocaleDateString("fr-FR");
  await recordAudit({
    actorId: user.id, action: "VALIDATE", module: MODULE_AUDIT, entityType: "VISIT", entityId: visite.id,
    summary: `Rapport de visite relu — ${visite.doctor?.name ?? "praticien non précisé"}, ${jour}${commentaire ? " (avec un mot au délégué)" : ""}`,
  });
  if (visite.delegateId) {
    await notifyUser({
      userId: visite.delegateId, type: "GENERIC",
      title: commentaire ? `${user.name} a relu votre rapport et vous laisse un mot` : `${user.name} a relu votre rapport`,
      body: `Visite du ${jour}${visite.doctor?.name ? ` — ${visite.doctor.name}` : ""}${commentaire ? ` : ${commentaire.slice(0, 160)}` : "."}`,
      link: CHEMIN_RAPPORTS_TERRAIN,
    }).catch(sansBloquer("relecture-visite-actions.relireRapportVisite.notifyUser"));
  }
  revalidatePath(PATH_EQUIPE);
  revalidatePath(CHEMIN_RAPPORTS_TERRAIN);
  return { ok: true, id: visite.id, message: "Rapport relu." };
}
