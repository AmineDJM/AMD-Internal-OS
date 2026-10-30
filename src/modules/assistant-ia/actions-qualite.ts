"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { recordAudit } from "@/lib/audit";
import type { ActionResult } from "@/lib/actions/types";
import {
  calendrierLisible, changerModeleRole, demanderPassage, enregistrerReglageBanc, lireCandidat, revenirModeleEnvironnement, ROLES_MODELE,
} from "@/modules/assistant-ia/api";

/**
 * LA QUALITÉ CONTINUE DE L'ASSISTANT IA (J5 + J14, décision 0022) — les gestes du Super Admin sur `/admin/ai/qualite` :
 * le calendrier du banc programmé, un passage maintenant, un banc A/B d'un modèle candidat, et le changement du modèle
 * d'un rôle — permis SEULEMENT sur un banc A/B vert enregistré (`changerModeleRole` le rejuge en base). Le retour au
 * modèle de l'environnement est toujours permis. Chaque geste à l'audit.
 */
async function superAdmin() {
  const u = await requireUser();
  return userCan(u, "ADMIN", "UPDATE") && u.role === "SUPER_ADMIN" ? u : null;
}
const REFUS = { ok: false as const, error: "Réservé au Super Admin." };

export async function enregistrerCalendrierBanc(formData: FormData): Promise<ActionResult> {
  const admin = await superAdmin();
  if (!admin) return REFUS;
  const r = await enregistrerReglageBanc({
    actif: formData.get("actif") === "true", frequence: formData.get("frequence"), jour: formData.get("jour"),
    heure: formData.get("heure"), plafondUsd: formData.get("plafondUsd"),
  }, admin.id);
  await recordAudit({ actorId: admin.id, action: "UPDATE", module: "Centre de contrôle IA", summary: `Banc programmé de l'Assistant IA : ${calendrierLisible(r)}, plafond ${r.plafondUsd} $ par passage` });
  revalidatePath("/admin/ai/qualite");
  return { ok: true };
}

export async function lancerBancMaintenant(): Promise<ActionResult> {
  const admin = await superAdmin();
  if (!admin) return REFUS;
  const d = await demanderPassage({ declencheur: "MANUEL", parId: admin.id });
  if (!d.ok) return { ok: false, error: d.raison };
  await recordAudit({ actorId: admin.id, action: "CREATE", module: "Centre de contrôle IA", summary: "Banc de l'Assistant IA demandé (le worker le lance à son prochain battement)" });
  revalidatePath("/admin/ai/qualite");
  return { ok: true };
}

export async function lancerBancAB(formData: FormData): Promise<ActionResult> {
  const admin = await superAdmin();
  if (!admin) return REFUS;
  const c = lireCandidat({ role: formData.get("role"), modelId: formData.get("modelId"), effort: formData.get("effort") });
  if (!c) return { ok: false, error: "Candidat illisible : rôle, nom de modèle et effort de raisonnement sont exigés." };
  const d = await demanderPassage({ declencheur: "AB", parId: admin.id, candidat: c });
  if (!d.ok) return { ok: false, error: d.raison };
  await recordAudit({ actorId: admin.id, action: "CREATE", module: "Centre de contrôle IA", summary: `Banc A/B demandé : ${c.modelId} (effort ${c.effort}) pour le rôle « ${c.role} »` });
  revalidatePath("/admin/ai/qualite");
  return { ok: true };
}

export async function appliquerModeleRole(formData: FormData): Promise<ActionResult> {
  const admin = await superAdmin();
  if (!admin) return REFUS;
  const c = lireCandidat({ role: formData.get("role"), modelId: formData.get("modelId"), effort: formData.get("effort") });
  if (!c) return { ok: false, error: "Candidat illisible." };
  const r = await changerModeleRole(c, admin.id);
  if (!r.ok) return { ok: false, error: r.raison };
  revalidatePath("/admin/ai/qualite");
  return { ok: true };
}

export async function revenirModeleRole(formData: FormData): Promise<ActionResult> {
  const admin = await superAdmin();
  if (!admin) return REFUS;
  const role = String(formData.get("role") ?? "");
  if (!(ROLES_MODELE as readonly string[]).includes(role)) return { ok: false, error: "Rôle inconnu." };
  await revenirModeleEnvironnement(role as (typeof ROLES_MODELE)[number], admin.id);
  revalidatePath("/admin/ai/qualite");
  return { ok: true };
}
