"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { peutPiloterDemandesStocks } from "@/lib/queries/demande-stocks";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { fdStr, fdNum, type ActionResult } from "@/lib/actions/types";
import {
  HEURE_DEFAUT, RECURRENCE_STOCK_DEFAUT, bloquantsDeRecurrence, decrireRecurrence,
  estRecurrenceStock, estStatutRecurrence, prochaineEcheanceStock,
} from "@/lib/stocks/recurrence";
import type { Recurrence } from "@/lib/scheduler/contract";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES RÉCURRENCES DE DEMANDE D'ÉTAT DE STOCK — poser, modifier, mettre en pause, retirer.
 *
 * ── LA MÊME PORTE QUE LA DEMANDE PONCTUELLE ──────────────────────────────────────────────
 *
 * `canRequestStockState` — « réservé à qui tient la chaîne d'approvisionnement ». POSER une
 * récurrence n'est pas un geste plus léger que demander une fois : c'est demander tous les mois,
 * indéfiniment, sans repasser par personne. Lui donner une garde plus faible qu'au geste
 * ponctuel serait offrir la porte à côté de la porte gardée (§118.71).
 *
 * Et le déclenchement RELIT cette autorité à chaque fois (`recurrence-runner.ts`) : une
 * récurrence posée par quelqu'un qui perd le droit s'arrête. La garde d'ici seule ne suffirait
 * pas — elle ne vérifie qu'un instant, et une récurrence vit des années.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const PATH = "/stocks";

const peutReclamer = peutPiloterDemandesStocks;

const REFUS = "Réservé à la Direction / au Super Admin — poser une récurrence, c'est demander tous les mois sans repasser par personne.";

/** Lit la saisie du formulaire, sans rien décider. */
function saisie(formData: FormData) {
  const recurrence = ((fdStr(formData, "recurrence") ?? "") || RECURRENCE_STOCK_DEFAUT).toUpperCase();
  const hRaw = fdNum(formData, "hourLocal");
  const dowRaw = fdNum(formData, "dayOfWeek");
  const domRaw = fdNum(formData, "dayOfMonth");
  // `fdStr` peut rendre `null` (champ absent) : on normalise ICI en chaîne vide, une fois, plutôt
  // que de laisser chaque appelant se demander lequel des deux il tient.
  return {
    nom: fdStr(formData, "name") ?? "",
    assigneeId: fdStr(formData, "assigneeId") ?? "",
    note: fdStr(formData, "note") ?? "",
    recurrence,
    hourLocal: hRaw === null || hRaw === undefined ? HEURE_DEFAUT : Number(hRaw),
    dayOfWeek: dowRaw === null || dowRaw === undefined ? null : Number(dowRaw),
    dayOfMonth: domRaw === null || domRaw === undefined ? null : Number(domRaw),
    hospitalIds: formData.getAll("hospitalIds").map((v) => String(v).trim()).filter(Boolean),
  };
}

/** Les hôpitaux ciblés, VALIDÉS en base — jamais des libellés libres. */
async function hopitauxValides(ids: readonly string[]): Promise<{ id: string; name: string }[] | null> {
  const uniques = [...new Set(ids)];
  if (uniques.length === 0) return [];
  const rows = await prisma.stockAnnex.findMany({
    where: { id: { in: uniques }, kind: { not: "ANNEX" } },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
  return rows.length === uniques.length ? rows : null;
}

/** POSE une récurrence. La première échéance est calculée depuis MAINTENANT. */
export async function createStockRecurrence(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!peutReclamer(user)) return { ok: false, error: REFUS };
  const s = saisie(formData);

  // TOUT CE QUI MANQUE, EN UNE FOIS (§118.18).
  const bloquants = bloquantsDeRecurrence({ ...s, nbHopitaux: s.hospitalIds.length });
  if (bloquants.length > 0) return { ok: false, error: bloquants.join(" · ") };

  const assignee = await prisma.user.findFirst({ where: { id: s.assigneeId, isActive: true }, select: { id: true, name: true } });
  if (!assignee) return { ok: false, error: "Destinataire invalide." };
  const hopitaux = await hopitauxValides(s.hospitalIds);
  if (!hopitaux) return { ok: false, error: "Hôpital inconnu dans la sélection." };

  const planning = {
    recurrence: s.recurrence as Recurrence,
    hourLocal: s.hourLocal, dayOfWeek: s.dayOfWeek, dayOfMonth: s.dayOfMonth,
  };
  const r = await prisma.stockRequestRecurrence.create({
    data: {
      name: s.nom.trim(),
      assigneeId: assignee.id,
      note: s.note.trim() || null,
      recurrence: s.recurrence,
      hourLocal: s.hourLocal, dayOfWeek: s.dayOfWeek, dayOfMonth: s.dayOfMonth,
      nextRunAt: prochaineEcheanceStock(planning, new Date()),
      createdById: user.id,
      hospitals: { create: hopitaux.map((h) => ({ annexId: h.id })) },
    },
    select: { id: true },
  });

  await recordAudit({
    actorId: user.id, action: "CREATE", module: "Stocks", entityType: "TASK", entityId: r.id,
    summary: `Récurrence de demande d'état de stock « ${s.nom.trim()} » — ${decrireRecurrence(planning)}, `
      + `${assignee.name}${hopitaux.length > 0 ? ` (${hopitaux.map((h) => h.name).join(", ")})` : " (sans hôpital ciblé)"}`,
  });
  revalidatePath(PATH);
  return { ok: true, id: r.id };
}

/**
 * MODIFIE une récurrence. L'échéance est RECALCULÉE depuis maintenant quand la cadence change :
 * garder l'ancienne ferait partir la prochaine demande à l'heure du réglage précédent, ce que
 * personne ne comprendrait en relisant « tous les lundis à 8 h ».
 */
export async function updateStockRecurrence(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!peutReclamer(user)) return { ok: false, error: REFUS };
  const id = fdStr(formData, "id") ?? "";
  if (!id) return { ok: false, error: "Récurrence introuvable." };
  const avant = await prisma.stockRequestRecurrence.findUnique({
    where: { id },
    select: { id: true, recurrence: true, hourLocal: true, dayOfWeek: true, dayOfMonth: true, name: true },
  });
  if (!avant) return { ok: false, error: "Récurrence introuvable." };

  const s = saisie(formData);
  const bloquants = bloquantsDeRecurrence({ ...s, nbHopitaux: s.hospitalIds.length });
  if (bloquants.length > 0) return { ok: false, error: bloquants.join(" · ") };
  const assignee = await prisma.user.findFirst({ where: { id: s.assigneeId, isActive: true }, select: { id: true, name: true } });
  if (!assignee) return { ok: false, error: "Destinataire invalide." };
  const hopitaux = await hopitauxValides(s.hospitalIds);
  if (!hopitaux) return { ok: false, error: "Hôpital inconnu dans la sélection." };

  const planning = {
    recurrence: s.recurrence as Recurrence,
    hourLocal: s.hourLocal, dayOfWeek: s.dayOfWeek, dayOfMonth: s.dayOfMonth,
  };
  const cadenceChangee = avant.recurrence !== s.recurrence
    || avant.hourLocal !== s.hourLocal
    || (avant.dayOfWeek ?? null) !== s.dayOfWeek
    || (avant.dayOfMonth ?? null) !== s.dayOfMonth;

  await prisma.$transaction(async (tx) => {
    await tx.stockRequestRecurrence.update({
      where: { id },
      data: {
        name: s.nom.trim(),
        assigneeId: assignee.id,
        note: s.note.trim() || null,
        recurrence: s.recurrence,
        hourLocal: s.hourLocal, dayOfWeek: s.dayOfWeek, dayOfMonth: s.dayOfMonth,
        ...(cadenceChangee ? { nextRunAt: prochaineEcheanceStock(planning, new Date()) } : {}),
      },
    });
    // LA SÉLECTION EST REMPLACÉE — décocher un hôpital le retire. Fusionner ferait qu'un hôpital
    // ne sort jamais d'une récurrence, et l'on continuerait à demander un relevé pour un
    // établissement qu'on ne suit plus.
    await tx.stockRequestRecurrenceHospital.deleteMany({ where: { recurrenceId: id } });
    if (hopitaux.length > 0) {
      await tx.stockRequestRecurrenceHospital.createMany({
        data: hopitaux.map((h) => ({ recurrenceId: id, annexId: h.id })),
      });
    }
  });

  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Stocks", entityType: "TASK", entityId: id,
    summary: `Récurrence « ${avant.name} » → « ${s.nom.trim()} » : ${decrireRecurrence(planning)}, ${assignee.name}`
      + (cadenceChangee ? " (échéance recalculée)" : ""),
  });
  revalidatePath(PATH);
  return { ok: true, id };
}

/**
 * MET EN PAUSE ou REPREND. Une pause garde l'historique et le compteur : reprendre ne doit pas
 * effacer ce qui a déjà été demandé. La reprise recalcule l'échéance depuis maintenant — on ne
 * rattrape pas les occurrences perdues (voir `echeanceApresDeclenchement`).
 */
export async function setStockRecurrenceStatus(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!peutReclamer(user)) return { ok: false, error: REFUS };
  const id = fdStr(formData, "id") ?? "";
  const statut = (fdStr(formData, "status") ?? "").toUpperCase();
  if (!estStatutRecurrence(statut)) return { ok: false, error: "Statut inconnu — ACTIVE ou PAUSED." };
  const r = await prisma.stockRequestRecurrence.findUnique({
    where: { id },
    select: { id: true, name: true, recurrence: true, hourLocal: true, dayOfWeek: true, dayOfMonth: true },
  });
  if (!r) return { ok: false, error: "Récurrence introuvable." };
  if (!estRecurrenceStock(r.recurrence)) return { ok: false, error: "Cadence illisible — modifiez la récurrence avant de la reprendre." };

  await prisma.stockRequestRecurrence.update({
    where: { id },
    data: {
      status: statut,
      ...(statut === "ACTIVE"
        ? {
          nextRunAt: prochaineEcheanceStock(
            { recurrence: r.recurrence as Recurrence, hourLocal: r.hourLocal, dayOfWeek: r.dayOfWeek, dayOfMonth: r.dayOfMonth },
            new Date(),
          ),
          claimedAt: null,
        }
        : {}),
    },
  });
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Stocks", entityType: "TASK", entityId: id,
    summary: `Récurrence « ${r.name} » ${statut === "ACTIVE" ? "reprise" : "mise en pause"}`,
  });
  revalidatePath(PATH);
  return { ok: true, id };
}

/**
 * RETIRE une récurrence. Les demandes DÉJÀ parties ne sont pas touchées : ce sont des tâches
 * assignées, elles appartiennent à la personne qui doit y répondre. Retirer la récurrence arrête
 * les prochaines, il ne réécrit pas le passé (§118.48 : ce qui est déjà parti est nommé, jamais
 * rejoué ni effacé).
 */
export async function deleteStockRecurrence(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!peutReclamer(user)) return { ok: false, error: REFUS };
  const id = fdStr(formData, "id") ?? "";
  const r = await prisma.stockRequestRecurrence.findUnique({ where: { id }, select: { id: true, name: true, runCount: true } });
  if (!r) return { ok: false, error: "Récurrence introuvable." };
  await prisma.stockRequestRecurrence.delete({ where: { id } });
  await recordAudit({
    actorId: user.id, action: "DELETE", module: "Stocks", entityType: "TASK", entityId: id,
    summary: `Récurrence « ${r.name} » retirée — ${r.runCount} demande(s) déjà envoyée(s) restent dans les tâches de leurs destinataires`,
  });
  revalidatePath(PATH);
  return { ok: true, id };
}
