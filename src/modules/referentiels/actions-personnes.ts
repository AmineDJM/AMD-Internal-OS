"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import type { ActionResult } from "@/lib/actions/types";
import { MODULE_JOURNAL_REFONTE, RefusFusionPersonne, annulerFusionPersonnes, ecarterDoublon, fusionnerPersonnes } from "@/modules/referentiels/api";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * PERSONNES (refonte des données, lot V2-B) — les gestes HUMAINS du référentiel : trancher un doublon
 * proposé (fusionner, écarter, défaire une fusion) et allumer / éteindre la double écriture.
 *
 * Qui tranche : le Super Admin (proposition de la Direction en attente : « responsable du module + Super
 * Admin », `refonte-donnees-et-monolithe-modulaire.md` §6.2). Chaque geste est écrit à l'audit avec les
 * deux Personnes et ce qui a été déplacé ; la fusion elle-même est tracée en base (`fusionneeDansId`,
 * `DoublonPersonne.deplacees`).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const PATHS = ["/personnes/doublons", "/admin/refonte-donnees"];

async function superAdmin() {
  const user = await requireUser();
  return user.role === "SUPER_ADMIN" ? user : null;
}

const refus = (e: unknown): ActionResult => {
  if (e instanceof RefusFusionPersonne) return { ok: false, error: e.message };
  throw e;
};

export async function fusionnerDoublonPersonne(doublonId: string, gardeeId: string): Promise<ActionResult> {
  const user = await superAdmin();
  if (!user) return { ok: false, error: "Réservé au Super Admin." };
  try {
    const r = await prisma.$transaction((tx) => fusionnerPersonnes(tx, { doublonId, gardeeId, parId: user.id }));
    await recordAudit({
      actorId: user.id, action: "UPDATE", module: MODULE_JOURNAL_REFONTE, field: "personnes-fusion", oldValue: r.absorbeeId, newValue: gardeeId,
      summary: `Personnes fusionnées : ${r.absorbeeId} → ${gardeeId} (${r.deplacees.length} fiche(s) déplacée(s) : ${r.deplacees.join(", ") || "aucune"})`,
    });
    PATHS.forEach((p) => revalidatePath(p));
    return { ok: true, message: "Fusion faite.", id: gardeeId };
  } catch (e) {
    return refus(e);
  }
}

export async function ecarterDoublonPersonne(doublonId: string): Promise<ActionResult> {
  const user = await superAdmin();
  if (!user) return { ok: false, error: "Réservé au Super Admin." };
  try {
    await ecarterDoublon(prisma, { doublonId, parId: user.id });
    await recordAudit({ actorId: user.id, action: "REFUSE", module: MODULE_JOURNAL_REFONTE, field: "personnes-fusion", newValue: doublonId, summary: `Doublon de personnes écarté (${doublonId}) : ce ne sont pas les mêmes.` });
    PATHS.forEach((p) => revalidatePath(p));
    return { ok: true, message: "Proposition écartée." };
  } catch (e) {
    return refus(e);
  }
}

export async function defaireFusionPersonne(doublonId: string): Promise<ActionResult> {
  const user = await superAdmin();
  if (!user) return { ok: false, error: "Réservé au Super Admin." };
  try {
    const r = await prisma.$transaction((tx) => annulerFusionPersonnes(tx, { doublonId, parId: user.id }));
    await recordAudit({ actorId: user.id, action: "UPDATE", module: MODULE_JOURNAL_REFONTE, field: "personnes-fusion", newValue: doublonId, summary: `Fusion de personnes défaite (${doublonId}) : ${r.revenues} fiche(s) revenue(s).` });
    PATHS.forEach((p) => revalidatePath(p));
    return { ok: true, message: "Fusion défaite." };
  } catch (e) {
    return refus(e);
  }
}

export async function basculerDoubleEcriturePersonnes(actif: boolean): Promise<ActionResult> {
  const user = await superAdmin();
  if (!user) return { ok: false, error: "Réservé au Super Admin." };
  await prisma.appSetting.upsert({
    where: { id: "global" },
    create: { id: "global", refontePersonnesDoubleEcriture: actif, updatedById: user.id },
    update: { refontePersonnesDoubleEcriture: actif, updatedById: user.id },
  });
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: MODULE_JOURNAL_REFONTE, field: "personnes-double-ecriture", oldValue: String(!actif), newValue: String(actif),
    summary: `Double écriture des Personnes ${actif ? "ALLUMÉE" : "éteinte"}.`,
  });
  revalidatePath("/admin/refonte-donnees");
  return { ok: true, message: actif ? "Double écriture allumée." : "Double écriture éteinte." };
}
