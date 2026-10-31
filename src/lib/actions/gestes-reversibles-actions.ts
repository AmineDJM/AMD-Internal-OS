"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { annulerGeste, planDAnnulation, retablirGeste, type CompteRenduAnnulation, type RefusAnnulation } from "@/lib/effets/annulation";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * ANNULER, RÉTABLIR — le bouton de l'écran de l'objet, et l'Assistant IA (K10c, décision 0036).
 *
 * Toute action métier réversible entre au journal des effets (`lib/effets/reversible.ts`). Ici, la personne qui l'a
 * faite — ou le Super Admin — la défait : D'ABORD le plan (rien n'est écrit), puis l'annulation (tout ou rien pour
 * une action métier : un effet qui ne se défait pas sans incohérence bloque tout, et la liste le dit), puis, si elle
 * le veut, le rétablissement (l'annulation est elle-même un geste journalisé). RBAC inchangé : la garde est celle du
 * journal (`charger` : le principal du geste, ou le Super Admin).
 *
 * L'Assistant IA peut PROPOSER ces gestes (carte confirmée, ou « vas-y » à la voix) : c'est la personne qui décide.
 * En simulation (la carte se prépare), l'annulation rend son plan et n'écrit rien.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface GesteAnnulable {
  id: string;
  quand: string;
  libelle: string;
  origine: string;
  capaciteId: string | null;
  annuleLe: string | null;
  /** Annulé, et rétablissable (l'annulation a été journalisée). */
  retablissable: boolean;
}

const vue = (r: CompteRenduAnnulation | RefusAnnulation) => JSON.parse(JSON.stringify(r)) as CompteRenduAnnulation | RefusAnnulation;
const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Ce que l'annulation ferait — rien n'est écrit. */
export async function apercevoirAnnulationDeMonGeste(gesteId: string) {
  const user = await requireUser();
  if (typeof gesteId !== "string" || !ID.test(gesteId)) return { refus: "Geste introuvable." };
  return vue(await planDAnnulation(gesteId, user));
}

/** Annuler un de mes gestes (le Super Admin : n'importe lequel). */
export async function annulerMonGeste(gesteId: string) {
  const user = await requireUser();
  if (typeof gesteId !== "string" || !ID.test(gesteId)) return { refus: "Geste introuvable." };
  const r = await annulerGeste(gesteId, user);
  revalidatePath("/", "layout");
  return vue(r);
}

/** Rétablir ce qu'une annulation a défait. */
export async function retablirMonGeste(gesteId: string) {
  const user = await requireUser();
  if (typeof gesteId !== "string" || !ID.test(gesteId)) return { refus: "Geste introuvable." };
  const r = await retablirGeste(gesteId, user);
  revalidatePath("/", "layout");
  return vue(r);
}

/**
 * Mes gestes annulables des 30 derniers jours — ceux qui ont touché les fiches nommées (`ids`), ou tous. Les
 * annulations elles-mêmes n'y figurent pas : elles se rétablissent depuis le geste qu'elles ont défait.
 */
export async function listerMesGestesAnnulables(ids: string[] = []): Promise<GesteAnnulable[]> {
  const user = await requireUser();
  const cibles = (Array.isArray(ids) ? ids : []).filter((x) => typeof x === "string" && ID.test(x)).slice(0, 20);
  const gestes = await prisma.assistantGesteJournal.findMany({
    where: {
      principalId: user.id, resultat: "FAIT", origine: { not: "annulation" }, creeLe: { gte: new Date(Date.now() - 30 * 86_400_000) },
      ...(cibles.length ? { effets: { some: { enregistrementId: { in: cibles } } } } : {}),
    },
    orderBy: { creeLe: "desc" }, take: 20,
    select: { id: true, creeLe: true, libelle: true, origine: true, capaciteId: true, annuleLe: true, annulation: true },
  });
  return gestes.map((g) => ({
    id: g.id, quand: g.creeLe.toISOString(), libelle: g.libelle, origine: g.origine, capaciteId: g.capaciteId,
    annuleLe: g.annuleLe?.toISOString() ?? null,
    retablissable: !!g.annuleLe && !!(g.annulation as { gesteAnnulationId?: string | null } | null)?.gesteAnnulationId,
  }));
}
