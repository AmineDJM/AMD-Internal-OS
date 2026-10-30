"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { fdBool, type ActionResult } from "@/lib/actions/types";
import { UserRole } from "@prisma/client";
import { ROLE_LABELS } from "@/lib/labels";
import { LIBELLE_FAMILLE, normaliserReglageFamilles, normaliserReglages, type FamilleIa } from "@/modules/assistant-ia/api";

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
    modeleVoix: formData.get("modeleVoix"),
  });
  const data = { ...r, modeleVoix: r.modeleVoix || null, updatedById: admin.id };
  await prisma.assistantIaReglage.upsert({ where: { id: "global" }, create: { id: "global", ...data }, update: data });
  await recordAudit({
    actorId: admin.id, action: "UPDATE", module: "Centre de contrôle IA",
    summary: `Bornes de l'Assistant IA : ${r.plafondJetonsJour} jetons/jour/personne, ${r.plafondJetonsTour} par tour, ${r.etapesMaxTour} étapes`
      + `${r.modeleVoix ? ` — voix temps réel : ${r.modeleVoix}` : ""}${r.censurerSaisie ? "" : " — filtre de la saisie COUPÉ"}${r.retirerCartesCaduques ? "" : " — retrait des cartes caduques COUPÉ"}`,
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
  const c = await lireCible(String(formData.get("cible") ?? ""));
  if ("error" in c) return { ok: false, error: c.error };
  const { ou, nom } = c;
  const r = normaliserReglageFamilles(formData.get("ouvertes"), formData.get("fermees"));
  const avant = await prisma.assistantIaAcces.findUnique({ where: ou as never });
  const dire = (x: { ouvertes: string[]; fermees: string[] } | null) => {
    const n = x ? normaliserReglageFamilles(x.ouvertes, x.fermees) : { ouvertes: [], fermees: [] };
    const part = (l: FamilleIa[], mot: string) => (l.length ? `${mot} : ${l.map((f) => LIBELLE_FAMILLE[f]).join(", ")}` : "");
    return [part(n.ouvertes, "ouvertes"), part(n.fermees, "fermées")].filter(Boolean).join(" ; ") || "défaut";
  };
  // Vidé ET sans plafond propre (J2) : la ligne disparaît ; avec un plafond propre, seules ses familles reviennent au défaut.
  if (!r.ouvertes.length && !r.fermees.length && avant?.plafondTravailUsd == null && avant?.plafondMensuelUsd == null) await prisma.assistantIaAcces.deleteMany({ where: ou });
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

/** La cible d'un réglage de la console : un rôle (hors Super Admin) ou une personne (hors Super Admin). */
async function lireCible(cible: string): Promise<{ ou: { userId: string } | { role: UserRole }; nom: string } | { error: string }> {
  const [genre, valeur] = [cible.slice(0, cible.indexOf(":")), cible.slice(cible.indexOf(":") + 1)];
  if (genre === "role" && (Object.values(UserRole) as string[]).includes(valeur) && valeur !== "SUPER_ADMIN") {
    return { ou: { role: valeur as UserRole }, nom: `rôle ${ROLE_LABELS[valeur as UserRole] ?? valeur}` };
  }
  if (genre === "user" && valeur) {
    const u = await prisma.user.findUnique({ where: { id: valeur }, select: { id: true, name: true, role: true } });
    if (!u) return { error: "Personne introuvable." };
    if (u.role === "SUPER_ADMIN") return { error: "Le Super Admin a tout, toujours : aucun réglage ne le vise." };
    return { ou: { userId: u.id }, nom: u.name };
  }
  return { error: "Cible inconnue." };
}

/**
 * LES PLAFONDS DE DÉPENSE DES TRAVAUX (J2, décision 4 de la Direction) — par travail (20 $ par défaut) et par personne et
 * par mois. `global` règle les défauts ; un rôle ou une personne peut avoir les siens (vide = le défaut). Atteint, un
 * travail DORT (il n'échoue pas) et repart seul quand le plafond le permet. Super Admin seul ; chaque changement à l'audit.
 */
export async function enregistrerPlafondsTravaux(formData: FormData): Promise<ActionResult> {
  const admin = await requireUser();
  if (!userCan(admin, "ADMIN", "UPDATE") || admin.role !== "SUPER_ADMIN") return { ok: false, error: "Réservé au Super Admin." };
  const lire = (k: string, max: number): number | null | "faux" => {
    const v = String(formData.get(k) ?? "").trim().replace(",", ".");
    if (!v) return null;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 && n <= max ? Math.round(n * 100) / 100 : "faux";
  };
  const travail = lire("plafondTravailUsd", 1_000);
  const mensuel = lire("plafondMensuelUsd", 10_000);
  if (travail === "faux" || mensuel === "faux") return { ok: false, error: "Un plafond est un montant en dollars, supérieur à 0 (au plus 1 000 $ par travail, 10 000 $ par mois)." };
  const dire = (t: number | null | undefined, m: number | null | undefined) => `${t ?? "défaut"} $ par travail, ${m ?? "défaut"} $ par mois`;
  const cible = String(formData.get("cible") ?? "");
  if (cible === "global") {
    if (travail === null || mensuel === null) return { ok: false, error: "Les deux plafonds par défaut sont obligatoires." };
    const avant = await prisma.assistantIaReglage.findUnique({ where: { id: "global" }, select: { plafondTravailUsd: true, plafondMensuelUsd: true } });
    const data = { plafondTravailUsd: travail, plafondMensuelUsd: mensuel, updatedById: admin.id };
    await prisma.assistantIaReglage.upsert({ where: { id: "global" }, create: { id: "global", ...data }, update: data });
    await recordAudit({
      actorId: admin.id, action: "UPDATE", module: "Centre de contrôle IA", field: "Travaux — plafonds par défaut",
      oldValue: dire(avant?.plafondTravailUsd, avant?.plafondMensuelUsd), newValue: dire(travail, mensuel),
      summary: `Plafonds des travaux par défaut : ${dire(travail, mensuel)}`,
    });
  } else {
    const c = await lireCible(cible);
    if ("error" in c) return { ok: false, error: c.error };
    const avant = await prisma.assistantIaAcces.findUnique({ where: c.ou as never });
    const data = { plafondTravailUsd: travail, plafondMensuelUsd: mensuel, updatedById: admin.id };
    if (avant) await prisma.assistantIaAcces.update({ where: { id: avant.id }, data });
    else if (travail !== null || mensuel !== null) await prisma.assistantIaAcces.create({ data: { ...c.ou, ...data } });
    await recordAudit({
      actorId: admin.id, action: "UPDATE", module: "Centre de contrôle IA", field: "Travaux — plafonds",
      oldValue: dire(avant?.plafondTravailUsd, avant?.plafondMensuelUsd), newValue: dire(travail, mensuel),
      summary: `Plafonds des travaux de ${c.nom} : ${dire(travail, mensuel)}`,
    });
  }
  revalidatePath("/admin/ai/acces");
  return { ok: true };
}

/**
 * J8 (décision 0023) — UN RESPONSABLE VOIT-IL LES TRAVAUX DE SON ÉQUIPE ? Super Admin seul ; défaut : non. Le
 * changement est à l'audit, comme chaque consultation qu'il rend possible (`infra/travaux-equipe.ts`).
 */
export async function enregistrerVisibiliteEquipe(formData: FormData): Promise<ActionResult> {
  const admin = await requireUser();
  if (!userCan(admin, "ADMIN", "UPDATE") || admin.role !== "SUPER_ADMIN") return { ok: false, error: "Réservé au Super Admin." };
  const voit = fdBool(formData, "managerVoitEquipe");
  const avant = await prisma.assistantIaReglage.findUnique({ where: { id: "global" }, select: { managerVoitEquipe: true } });
  const data = { managerVoitEquipe: voit, updatedById: admin.id };
  await prisma.assistantIaReglage.upsert({ where: { id: "global" }, create: { id: "global", ...data }, update: data });
  const dire = (v: boolean | undefined) => (v ? "oui" : "non");
  await recordAudit({
    actorId: admin.id, action: "UPDATE", module: "Centre de contrôle IA", field: "Travaux — un responsable voit ceux de son équipe",
    oldValue: dire(avant?.managerVoitEquipe), newValue: dire(voit),
    summary: `Les responsables ${voit ? "voient désormais" : "ne voient plus"} les travaux de leur équipe (résumé et étapes, chaque consultation à l'audit)`,
  });
  revalidatePath("/admin/ai/acces");
  return { ok: true };
}
