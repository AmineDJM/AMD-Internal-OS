"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { fdBool, type ActionResult } from "@/lib/actions/types";
import { normaliserReglages } from "@/lib/agent/consommation-regles";
import { UserRole } from "@prisma/client";
import { ROLE_LABELS } from "@/lib/labels";
import { LIBELLE_FAMILLE, normaliserReglageFamilles, type FamilleIa } from "@/lib/agent/acces-regles";

/**
 * LES BORNES DE L'ASSISTANT IA — enregistrées par le Super Admin (Administration › Consommation IA,
 * lot V3-D). Plafonds de jetons (par personne et par jour, par tour), étapes d'un tour, et les
 * décisions de Direction du rapport 06 (filtre de la saisie, retrait des cartes caduques, expiration
 * des cartes). Une valeur hors bornes est RAMENÉE dans les bornes (`normaliserReglages`) — l'écran
 * relit et affiche ce qui a été réellement enregistré.
 */
export async function enregistrerReglagesAssistantIa(formData: FormData): Promise<ActionResult> {
  const admin = await requireUser();
  if (!userCan(admin, "ADMIN", "UPDATE") || admin.role !== "SUPER_ADMIN") {
    return { ok: false, error: "Réservé au Super Admin." };
  }
  const r = normaliserReglages({
    plafondJetonsJour: formData.get("plafondJetonsJour"),
    plafondJetonsTour: formData.get("plafondJetonsTour"),
    etapesMaxTour: formData.get("etapesMaxTour"),
    expirationCartesHeures: formData.get("expirationCartesHeures"),
    censurerSaisie: fdBool(formData, "censurerSaisie"),
    retirerCartesCaduques: fdBool(formData, "retirerCartesCaduques"),
  });
  const data = { ...r, updatedById: admin.id };
  await prisma.assistantIaReglage.upsert({ where: { id: "global" }, create: { id: "global", ...data }, update: data });
  await recordAudit({
    actorId: admin.id, action: "UPDATE", module: "Centre de contrôle IA",
    summary: `Bornes de l'Assistant IA : ${r.plafondJetonsJour} jetons/jour/personne, ${r.plafondJetonsTour} par tour, ${r.etapesMaxTour} étapes`
      + `${r.censurerSaisie ? "" : " — filtre de la saisie COUPÉ"}${r.retirerCartesCaduques ? "" : " — retrait des cartes caduques COUPÉ"}`,
  });
  revalidatePath("/admin/ai/consommation");
  return { ok: true };
}

/**
 * LES ACCÈS DE L'ASSISTANT IA (décision 0012, Direction 29/10/2026) — par rôle (défaut de ses membres) ou par personne
 * (prime sur son rôle) : les familles ouvertes et fermées. Super Admin seul ; le Super Admin lui-même a tout, toujours
 * (aucun réglage ne le vise). Un réglage vidé est SUPPRIMÉ (la cible revient au défaut). Chaque changement à l'audit,
 * avec l'avant et l'après.
 */
export async function enregistrerAccesAssistantIa(formData: FormData): Promise<ActionResult> {
  const admin = await requireUser();
  if (!userCan(admin, "ADMIN", "UPDATE") || admin.role !== "SUPER_ADMIN") return { ok: false, error: "Réservé au Super Admin." };
  const cible = String(formData.get("cible") ?? "");
  const [genre, valeur] = [cible.slice(0, cible.indexOf(":")), cible.slice(cible.indexOf(":") + 1)];
  let ou: { userId: string } | { role: UserRole };
  let nom: string;
  if (genre === "role" && (Object.values(UserRole) as string[]).includes(valeur) && valeur !== "SUPER_ADMIN") {
    ou = { role: valeur as UserRole };
    nom = `rôle ${ROLE_LABELS[valeur as UserRole] ?? valeur}`;
  } else if (genre === "user" && valeur) {
    const u = await prisma.user.findUnique({ where: { id: valeur }, select: { id: true, name: true, role: true } });
    if (!u) return { ok: false, error: "Personne introuvable." };
    if (u.role === "SUPER_ADMIN") return { ok: false, error: "Le Super Admin a tout, toujours : aucun réglage ne le vise." };
    ou = { userId: u.id };
    nom = u.name;
  } else {
    return { ok: false, error: "Cible inconnue." };
  }
  const r = normaliserReglageFamilles(formData.get("ouvertes"), formData.get("fermees"));
  const avant = await prisma.assistantIaAcces.findUnique({ where: ou as never });
  const dire = (x: { ouvertes: string[]; fermees: string[] } | null) => {
    const n = x ? normaliserReglageFamilles(x.ouvertes, x.fermees) : { ouvertes: [], fermees: [] };
    const part = (l: FamilleIa[], mot: string) => (l.length ? `${mot} : ${l.map((f) => LIBELLE_FAMILLE[f]).join(", ")}` : "");
    return [part(n.ouvertes, "ouvertes"), part(n.fermees, "fermées")].filter(Boolean).join(" ; ") || "défaut";
  };
  if (!r.ouvertes.length && !r.fermees.length) await prisma.assistantIaAcces.deleteMany({ where: ou });
  else {
    const data = { ouvertes: r.ouvertes, fermees: r.fermees, updatedById: admin.id };
    await prisma.assistantIaAcces.upsert({ where: ou as never, create: { ...ou, ...data }, update: data });
  }
  await recordAudit({
    actorId: admin.id, action: "UPDATE", module: "Centre de contrôle IA", field: "Assistant IA — accès",
    oldValue: dire(avant), newValue: dire(r),
    summary: `Assistant IA — accès de ${nom} : ${dire(avant)} → ${dire(r)}`,
  });
  revalidatePath("/admin/ai/acces");
  return { ok: true };
}
