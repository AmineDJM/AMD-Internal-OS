"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { enLecture } from "@/lib/vue-lecture";
import { userCan } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { fdBool, type ActionResult } from "@/lib/actions/types";
import { UserRole } from "@prisma/client";
import { ROLE_LABELS } from "@/lib/labels";
import {
  LIBELLE_FAMILLE, LIBELLE_VALEURS_SENSIBLES, lireConsommation, MODES_VALEURS_SENSIBLES, modeValeursSensibles, normaliserReglageFamilles, normaliserReglages,
  normaliserReglagesVisuels, type FamilleIa,
} from "@/modules/assistant-ia/api";
import type { VueConsommation } from "@/modules/assistant-ia/partage";

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
  // Le mode des valeurs sensibles (décision 0034) a son propre réglage, dans la console d'accès : ce formulaire n'y touche pas.
  const { valeursSensibles: _horsFormulaire, ...bornes } = r;
  void _horsFormulaire;
  const data = { ...bornes, modeleVoix: r.modeleVoix || null, updatedById: admin.id };
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
  if (!r.ouvertes.length && !r.fermees.length && avant?.plafondTravailUsd == null && avant?.plafondMensuelUsd == null && avant?.travauxDOffice == null) await prisma.assistantIaAcces.deleteMany({ where: ou });
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
 * K3 (décision 0033) — « DÉMARRER D'OFFICE LES TRAVAUX SANS GESTE » pour un rôle ou une personne : un plan de lecture,
 * d'analyse et de livrable part sans clic (tout geste reste approuvé). « oui », « non », ou vide (le défaut : non ; le
 * Super Admin, oui). La préférence de la personne prime. Super Admin seul ; chaque changement à l'audit.
 */
export async function enregistrerTravauxDOffice(formData: FormData): Promise<ActionResult> {
  const brut = String(formData.get("valeur") ?? "");
  const valeur = brut === "oui" ? true : brut === "non" ? false : null;
  const admin = await requireUser();
  const c = userCan(admin, "ADMIN", "UPDATE") && admin.role === "SUPER_ADMIN" ? await lireCible(String(formData.get("cible") ?? "")) : { error: "Réservé au Super Admin." };
  if ("error" in c) return { ok: false, error: c.error };
  const avant = await prisma.assistantIaAcces.findUnique({ where: c.ou as never });
  if (avant) await prisma.assistantIaAcces.update({ where: { id: avant.id }, data: { travauxDOffice: valeur, updatedById: admin.id } });
  else if (valeur !== null) await prisma.assistantIaAcces.create({ data: { ...c.ou, travauxDOffice: valeur, updatedById: admin.id } });
  const dire = (v: boolean | null | undefined) => (v === true ? "oui" : v === false ? "non" : "défaut");
  await recordAudit({
    actorId: admin.id, action: "UPDATE", module: "Centre de contrôle IA", field: "Travaux — démarrage d'office",
    oldValue: dire(avant?.travauxDOffice), newValue: dire(valeur),
    summary: `Démarrage d'office des travaux sans geste — ${c.nom} : ${dire(avant?.travauxDOffice)} → ${dire(valeur)}`,
  });
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

/**
 * DÉCISION 0034 (Direction, 31/10/2026) — LES VALEURS SENSIBLES ET LE MODÈLE : « en clair pour qui a le droit de les voir »
 * (défaut) ou « masquées (repères ⟦Sn⟧) ». Super Admin seul ; chaque changement à l'audit (avant → après). Les DROITS ne
 * bougent pas : une personne ne reçoit toujours que ce que le RBAC et la console lui ouvrent.
 */
export async function enregistrerValeursSensibles(formData: FormData): Promise<ActionResult> {
  const admin = await requireUser();
  if (!userCan(admin, "ADMIN", "UPDATE") || admin.role !== "SUPER_ADMIN") return { ok: false, error: "Réservé au Super Admin." };
  const brut = String(formData.get("valeursSensibles") ?? "");
  if (!(MODES_VALEURS_SENSIBLES as readonly string[]).includes(brut)) return { ok: false, error: "Choix inconnu : « en clair » ou « masquées »." };
  const mode = modeValeursSensibles(brut);
  const avant = await prisma.assistantIaReglage.findUnique({ where: { id: "global" }, select: { valeursSensibles: true } });
  const data = { valeursSensibles: mode, updatedById: admin.id };
  await prisma.assistantIaReglage.upsert({ where: { id: "global" }, create: { id: "global", ...data }, update: data });
  const ancien = LIBELLE_VALEURS_SENSIBLES[modeValeursSensibles(avant?.valeursSensibles)];
  await recordAudit({
    actorId: admin.id, action: "UPDATE", module: "Centre de contrôle IA", field: "Assistant IA — valeurs sensibles",
    oldValue: ancien, newValue: LIBELLE_VALEURS_SENSIBLES[mode],
    summary: `Assistant IA — valeurs sensibles (salaires, IBAN / RIB, pièces d'identité) : ${ancien} → ${LIBELLE_VALEURS_SENSIBLES[mode]}`,
  });
  revalidatePath("/admin/ai/acces");
  return { ok: true };
}

/**
 * J7 (décision 0029) — LA DURÉE DE GARDE DU JOURNAL DES EFFETS : combien de jours un geste de l'assistant reste
 * annulable (sa valeur AVANT gardée). Super Admin seul ; entre 7 jours et 3 ans ; à l'audit.
 */
export async function enregistrerRetentionEffets(formData: FormData): Promise<ActionResult> {
  const admin = await requireUser();
  if (!userCan(admin, "ADMIN", "UPDATE") || admin.role !== "SUPER_ADMIN") return { ok: false, error: "Réservé au Super Admin." };
  const jours = Number(String(formData.get("retentionEffetsJours") ?? "").trim());
  if (!Number.isInteger(jours) || jours < 7 || jours > 1095) return { ok: false, error: "Une durée en jours, entre 7 et 1 095 (trois ans)." };
  const avant = await prisma.assistantIaReglage.findUnique({ where: { id: "global" }, select: { retentionEffetsJours: true } });
  const data = { retentionEffetsJours: jours, updatedById: admin.id };
  await prisma.assistantIaReglage.upsert({ where: { id: "global" }, create: { id: "global", ...data }, update: data });
  await recordAudit({
    actorId: admin.id, action: "UPDATE", module: "Centre de contrôle IA", field: "Journal des effets — durée de garde",
    oldValue: `${avant?.retentionEffetsJours ?? 180} jours`, newValue: `${jours} jours`,
    summary: `Les gestes de l'assistant restent annulables ${jours} jours (journal des effets)`,
  });
  revalidatePath("/admin/ai/acces");
  return { ok: true };
}

/**
 * K2 (décision 0032) — LES VISUELS GÉNÉRÉS : interrupteurs (images, vidéos du modèle, vidéos de données), plafonds de dépense
 * du mois civil (dollars), modèles et durée max d'une vidéo. Super Admin seul ; ramenés dans les bornes
 * (`normaliserReglagesVisuels`) ; chaque changement à l'audit, avec l'avant et l'après.
 */
export async function enregistrerReglagesVisuels(formData: FormData): Promise<ActionResult> {
  const admin = await requireUser();
  if (!userCan(admin, "ADMIN", "UPDATE") || admin.role !== "SUPER_ADMIN") return { ok: false, error: "Réservé au Super Admin." };
  const r = normaliserReglagesVisuels({
    visuelsImagesActives: fdBool(formData, "imagesActives"),
    visuelsImagesPlafondUsd: formData.get("imagesPlafondUsd"),
    visuelsModeleImage: formData.get("modeleImage"),
    visuelsVideosActives: fdBool(formData, "videosActives"),
    visuelsVideosPlafondUsd: formData.get("videosPlafondUsd"),
    visuelsModeleVideo: formData.get("modeleVideo"),
    visuelsVideoSecondesMax: formData.get("videoSecondesMax"),
    visuelsDonneesActives: fdBool(formData, "donneesActives"),
  });
  const avant = normaliserReglagesVisuels(await prisma.assistantIaReglage.findUnique({ where: { id: "global" } }) as unknown as Record<string, unknown> | null);
  const data = {
    visuelsImagesActives: r.imagesActives, visuelsImagesPlafondUsd: r.imagesPlafondUsd, visuelsModeleImage: r.modeleImage,
    visuelsVideosActives: r.videosActives, visuelsVideosPlafondUsd: r.videosPlafondUsd, visuelsModeleVideo: r.modeleVideo,
    visuelsVideoSecondesMax: r.videoSecondesMax, visuelsDonneesActives: r.donneesActives, updatedById: admin.id,
  };
  await prisma.assistantIaReglage.upsert({ where: { id: "global" }, create: { id: "global", ...data }, update: data });
  const dire = (x: typeof r) => `images ${x.imagesActives ? "actives" : "coupées"} (${x.modeleImage}, ${x.imagesPlafondUsd} $/mois) ; `
    + `vidéos ${x.videosActives ? "actives" : "coupées"} (${x.modeleVideo}, ${x.videoSecondesMax} s max, ${x.videosPlafondUsd} $/mois) ; vidéos de données ${x.donneesActives ? "actives" : "coupées"}`;
  await recordAudit({
    actorId: admin.id, action: "UPDATE", module: "Centre de contrôle IA", field: "Assistant IA — visuels générés",
    oldValue: dire(avant), newValue: dire(r), summary: `Visuels générés de l'Assistant IA : ${dire(r)}`,
  });
  revalidatePath("/admin/ai");
  return { ok: true };
}

/**
 * C1 (décision 0041) — LES CHANTIERS DE DÉVELOPPEMENT : plafond en dollars par chantier, lancements Claude Code et
 * déploiements au plus, tentatives par étape, plafonds globaux du jour, chantiers en parallèle. Super Admin seul ;
 * bornés (`lireReglagesChantiers`) ; chaque changement à l'audit, avant et après.
 */
export async function enregistrerReglagesChantiers(formData: FormData): Promise<ActionResult> {
  const admin = await requireUser();
  if (!userCan(admin, "ADMIN", "UPDATE") || admin.role !== "SUPER_ADMIN") return { ok: false, error: "Réservé au Super Admin." };
  const { normaliserReglagesChantiers: lireReglagesChantiers } = await import("@/modules/assistant-ia/api");
  const r = lireReglagesChantiers(Object.fromEntries(formData.entries()));
  const avant = await prisma.appSetting.findUnique({ where: { id: "global" }, select: { chantiersReglages: true } });
  const json = { ...r } as Record<string, number>;
  await prisma.appSetting.upsert({ where: { id: "global" }, create: { id: "global", chantiersReglages: json }, update: { chantiersReglages: json } });
  const dire = (x: unknown) => JSON.stringify(lireReglagesChantiers(x));
  await recordAudit({
    actorId: admin.id, action: "UPDATE", module: "Centre de contrôle IA", field: "Chantiers de développement — plafonds",
    oldValue: dire(avant?.chantiersReglages ?? null), newValue: dire(r), summary: `Plafonds des chantiers : ${r.plafondUsd} $ par chantier, ${r.lancementsMax} lancements, ${r.deploiementsMax} déploiements, ${r.tentativesMax} tentatives ; jour ${r.jourUsdMax} $`,
  });
  revalidatePath("/admin/ai");
  return { ok: true };
}

/**
 * LA CONSOMMATION IA (lot K8, décision 0035) — jetons et dollars, appel par appel, lus dans le journal.
 * « moi » : la personne connectée, et elle seule (la garde est dans la requête). « entreprise » : toute
 * l'entreprise, par personne, avec les plafonds et le rapprochement — Super Admin seul.
 */
export async function lireConsommationIa(p: { perimetre: "moi" | "entreprise"; du?: string | null; au?: string | null; personne?: string | null }): Promise<
  { ok: true; vue: VueConsommation } | { ok: false; erreur: string }
> {
  // Une LECTURE d'écran : en Vue exacte, c'est la consommation de la personne visualisée qui s'affiche.
  const user = await enLecture(requireUser);
  const r = await lireConsommation({
    perimetre: p.perimetre === "entreprise" ? "entreprise" : "moi", userId: user.id, estSuperAdmin: user.role === "SUPER_ADMIN",
    du: typeof p.du === "string" ? p.du : null, au: typeof p.au === "string" ? p.au : null,
    personne: typeof p.personne === "string" ? p.personne : null,
  });
  return "refus" in r ? { ok: false, erreur: r.refus } : { ok: true, vue: r };
}
