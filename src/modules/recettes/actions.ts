"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { recordAudit } from "@/lib/audit";
import type { ActionResult } from "@/lib/actions/types";
import { corrigerEtValider, designerResponsable, proposerLesRecettes, rejeterVersion, retirerRecette, validerVersion } from "@/modules/recettes/api";

/**
 * LES GESTES SUR LES RECETTES (J10, décision 0028) — le responsable du processus tranche ; la Direction désigne.
 * Chaque geste est rejugé côté serveur (`infra/recettes.ts`) et audité. Rien n'est appris en silence.
 */

const CHEMIN = "/recettes";
const MODULE = "Recettes";

const issue = async (user: { id: string }, r: { ok: true; message: string; recetteId: string } | { ok: false; erreur: string }, resume: string): Promise<ActionResult> => {
  if (!r.ok) return { ok: false, error: r.erreur };
  await recordAudit({ actorId: user.id, action: "UPDATE", module: MODULE, entityId: r.recetteId, summary: `${resume} — ${r.message}` });
  revalidatePath(CHEMIN);
  return { ok: true, message: r.message, id: r.recetteId };
};

export async function validerRecetteAction(versionId: string): Promise<ActionResult> {
  const user = await requireUser();
  return issue(user, await validerVersion(user, String(versionId)), "Recette validée");
}

/** `correction` : le JSON de la correction (titre, résumé, étapes, pièces, pièges, note) — relu par `corrigerContenu`. */
export async function corrigerRecetteAction(versionId: string, correction: string): Promise<ActionResult> {
  const user = await requireUser();
  let lue: unknown = null;
  try { lue = JSON.parse(String(correction)); } catch { return { ok: false, error: "Correction illisible." }; }
  return issue(user, await corrigerEtValider(user, String(versionId), lue), "Recette corrigée et validée");
}

export async function rejeterRecetteAction(versionId: string, motif: string): Promise<ActionResult> {
  const user = await requireUser();
  return issue(user, await rejeterVersion(user, String(versionId), String(motif ?? "")), "Recette rejetée");
}

export async function retirerRecetteAction(versionId: string, motif: string): Promise<ActionResult> {
  const user = await requireUser();
  return issue(user, await retirerRecette(user, String(versionId), String(motif ?? "")), "Recette retirée");
}

export async function designerResponsableAction(processus: string, role: string | null, seuil: number | null): Promise<ActionResult> {
  const user = await requireUser();
  const r = await designerResponsable(user, String(processus), { role: role || null, seuil });
  if (!r.ok) return { ok: false, error: r.erreur };
  await recordAudit({ actorId: user.id, action: "UPDATE", module: MODULE, entityId: processus, summary: `Responsable des recettes « ${processus} » : ${role ?? "aucun"}${seuil ? `, seuil ${seuil}` : ""}` });
  revalidatePath(CHEMIN);
  return { ok: true, message: "Responsable enregistré." };
}

/** Relire les circuits tout de suite (au lieu du passage quotidien) — la Direction. */
export async function relireLesCircuitsAction(): Promise<ActionResult> {
  const user = await requireUser();
  if (user.role !== "SUPER_ADMIN" && user.role !== "DIRECTION") return { ok: false, error: "Réservé à la Direction." };
  const b = await proposerLesRecettes();
  await recordAudit({ actorId: user.id, action: "UPDATE", module: MODULE, summary: `Extraction manuelle : ${b.creees} proposée(s), ${b.nouvellesVersions} nouvelle(s) version(s), ${b.sousLeSeuil} circuit(s) sous le seuil` });
  revalidatePath(CHEMIN);
  return { ok: true, message: `${b.circuits} circuit(s) relu(s) : ${b.creees} recette(s) proposée(s), ${b.nouvellesVersions} nouvelle(s) version(s), ${b.rafraichies + b.remplacees} proposition(s) mise(s) à jour, ${b.sousLeSeuil} sous le seuil.` };
}
