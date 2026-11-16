"use server";

import { auth } from "@/auth";
import { prisma, prismaBrut } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { cookies } from "next/headers";
import { poserVueExacte, effacerVueExacte, AGIR_COMME_COOKIE } from "@/lib/vue-exacte";
import { fdStr, type ActionResult } from "@/lib/actions/types";
import { getUtilisateurReel } from "@/lib/session";
import { revalidatePath } from "next/cache";
import { annulerGeste } from "@/lib/effets/annulation";

/**
 * Démarre la « Vue exacte » : le Super Admin visualise l'OS comme l'utilisateur
 * cible. On lit la session RÉELLE via auth() (le JWT), jamais la session
 * éventuellement déjà impersonifiée.
 */
export async function startImpersonation(formData: FormData): Promise<ActionResult> {
  return ouvrirLaVue(formData, "voir");
}

/**
 * « AGIR COMME CET UTILISATEUR » (Direction, 16/11/2026) — la même vue, mais le Super Admin AGIT au nom de la personne :
 * ses droits, son circuit, ses postes. Chaque geste est marqué (audit, lu par le Super Admin seul) et s'annule depuis la page
 * « Agir comme — vos gestes » (`/admin/agir-comme`). La signature en ligne reste refusée : on ne signe que de son compte.
 */
export async function startActingAs(formData: FormData): Promise<ActionResult> {
  return ouvrirLaVue(formData, "agir");
}

async function ouvrirLaVue(formData: FormData, mode: "voir" | "agir"): Promise<ActionResult> {
  // L'identité RÉELLE (jamais la vue), relue en base : session non révoquée, compte actif, rôle EN DIRECT.
  // `auth()` lisait le rôle figé dans le JWT — un Super Admin rétrogradé ouvrait encore la vue (audit 27/10).
  const moi = await getUtilisateurReel();
  if (moi?.role !== "SUPER_ADMIN") return { ok: false, error: "Réservé au Super Admin." };
  const targetId = fdStr(formData, "userId");
  if (!targetId) return { ok: false, error: "Utilisateur manquant." };
  if (targetId === moi.id) return { ok: false, error: "Vous êtes déjà connecté avec ce compte." };

  const target = await prisma.user.findUnique({ where: { id: targetId }, select: { name: true, isActive: true, isSystem: true } });
  if (!target || !target.isActive) return { ok: false, error: "Utilisateur introuvable ou inactif." };
  // Le compte système (Adam) n'a pas d'écran à regarder, et une demande créée « au nom de la vue » serait la sienne.
  if (target.isSystem) return { ok: false, error: "Un compte système ne se visualise pas." };

  // Cookie de la vue + témoin lu par l'écran, posés ensemble (`vue-exacte.ts`) : un autre onglet ouvert
  // se recharge en entier au lieu de mêler deux personnes (`GardeIdentite`).
  if (mode === "agir") await poserVueExacte(targetId, "agir");
  else await poserVueExacte(targetId);
  await recordAudit({
    actorId: moi.id, action: "LOGIN", module: "Administration",
    summary: mode === "agir" ? `Agir comme démarré — ${target.name}` : `Vue exacte démarrée — ${target.name}`,
  });
  // PAS DE `redirect()` ICI (Direction, 06/10 : « je prends la peau de Leila, et c'est toujours Amine Djouamai qui
  // s'affiche en haut ; je dois tout rafraîchir ») : une redirection d'action est une navigation DOUCE — Next ne
  // recharge que la page, et garde la coque (barre du haut, menu, bandeau) rendue pour l'administrateur. Le bouton
  // recharge donc la page ENTIÈRE (`window.location`), coque comprise, rendue pour la personne visualisée.
  return { ok: true, message: "/mon-espace" };
}

/** Quitte la « Vue exacte ». Même raison : le bouton recharge toute la page (la coque redevient celle de l'administrateur). */
export async function stopImpersonation(): Promise<ActionResult> {
  const session = await auth();
  // En sortant d'« Agir comme », le Super Admin arrive sur SES gestes : il les relit, et annule ce qu'il veut.
  const agir = Boolean((await cookies()).get(AGIR_COMME_COOKIE)?.value);
  await effacerVueExacte();
  if (session?.user?.id) {
    await recordAudit({ actorId: session.user.id, action: "LOGOUT", module: "Administration", summary: "Vue exacte terminée" });
  }
  return { ok: true, message: agir ? "/admin/agir-comme" : "/admin" };
}

/**
 * ANNULER CE QUE LE SUPER ADMIN A FAIT EN « AGIR COMME » (Direction, 16/11/2026) — un geste, ou tous ceux faits dans la peau
 * d'une personne (du plus récent au plus ancien : chaque annulation retrouve l'état que la suivante a laissé). Le Super Admin
 * RÉEL seulement, hors de toute vue ; chaque annulation est elle-même journalisée (elle se rétablit).
 */
async function superAdminReel() {
  const u = await getUtilisateurReel();
  if (!u || u.role !== "SUPER_ADMIN") return { error: "Réservé au Super Admin." } as const;
  if (u.visualise) return { error: "Quittez d'abord la vue (bouton « Quitter » en haut à droite), puis annulez depuis cette page." } as const;
  return { u } as const;
}

export async function annulerGesteAgirComme(gesteId: string): Promise<ActionResult> {
  const r = await superAdminReel();
  if ("error" in r) return { ok: false, error: r.error };
  const g = await prismaBrut.assistantGesteJournal.findUnique({ where: { id: gesteId }, select: { parVueExacteId: true } });
  if (!g?.parVueExacteId) return { ok: false, error: "Ce geste n'a pas été fait en « Agir comme »." };
  const res = await annulerGeste(gesteId, r.u);
  revalidatePath("/admin/agir-comme");
  if ("refus" in res) return { ok: false, error: res.refus };
  return { ok: true, message: res.resume };
}

export async function annulerToutAgirComme(personneId: string): Promise<ActionResult> {
  const r = await superAdminReel();
  if ("error" in r) return { ok: false, error: r.error };
  const gestes = await prismaBrut.assistantGesteJournal.findMany({
    where: { principalId: personneId, parVueExacteId: { not: null }, annuleLe: null, origine: { not: "annulation" } },
    orderBy: { creeLe: "desc" }, select: { id: true, libelle: true },
  });
  let faits = 0;
  const refus: string[] = [];
  for (const g of gestes) {
    const res = await annulerGeste(g.id, r.u);
    if ("refus" in res) refus.push(`« ${g.libelle} » : ${res.refus}`);
    else faits++;
  }
  revalidatePath("/admin/agir-comme");
  if (refus.length) return { ok: false, error: `${faits} geste(s) annulé(s), ${refus.length} non annulé(s) — ${refus.join(" ; ")}`.slice(0, 1500) };
  return { ok: true, message: faits ? `${faits} geste(s) annulé(s).` : "Rien à annuler." };
}
