"use server";

import { revalidatePath } from "next/cache";
import { requireUser, type CurrentUser } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { recordAudit } from "@/lib/audit";
import { porte } from "./infra/porte-actions";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA PROACTIVITÉ SOUS MANDAT (J12, décision 0024) — clé `assistant-ia-proactivite-actions`.
 *
 * Les gestes de la personne sur SA veille (veilleurs, préférences, retours, mandats) et le geste de
 * la coque qui fait les gestes sous mandat dans sa requête ; puis ceux de la console (Super Admin).
 * L'identité vient TOUJOURS de la session ; une écriture est refusée en « Vue exacte ».
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const service = () => import("./infra/proactivite/service");
const mandats = () => import("./infra/proactivite/mandats");

export async function lireMaVeille() {
  const p = await porte(false);
  if (!p.ok) return p;
  const { etatDeMaVeille } = await service();
  return { ok: true as const, veille: JSON.parse(JSON.stringify(await etatDeMaVeille(p.user))) as Awaited<ReturnType<typeof etatDeMaVeille>> };
}

/** `actif` ou `seuil` à `null` : inchangé. */
export async function reglerMonVeilleur(code: string, actif: boolean | null, seuil: number | null) {
  const p = await porte(true);
  if (!p.ok) return p;
  if (typeof code !== "string") return { ok: false as const, erreur: "Réglage illisible." };
  const r = await (await service()).reglerVeilleur(p.user.id, code, { actif: typeof actif === "boolean" ? actif : undefined, seuil: typeof seuil === "number" ? seuil : undefined });
  return r.ok ? { ok: true as const } : { ok: false as const, erreur: r.erreur };
}

export async function reglerMaVeille(interruptionsMax: number, calmeDebut: number, calmeFin: number, weekendCalme: boolean, pointDuMatin: boolean) {
  const p = await porte(true);
  if (!p.ok) return p;
  await (await service()).reglerPreferences(p.user.id, { interruptionsMax, calmeDebut, calmeFin, weekendCalme, pointDuMatin });
  return { ok: true as const };
}

/** « Utile » / « pas utile » — un clic. */
export async function jugerConstat(id: string, retour: "UTILE" | "PAS_UTILE") {
  const p = await porte(true);
  if (!p.ok) return p;
  if (typeof id !== "string" || !id || (retour !== "UTILE" && retour !== "PAS_UTILE")) return { ok: false as const, erreur: "Constat introuvable." };
  const r = await (await service()).donnerRetour(p.user.id, id, retour);
  return r.ok ? { ok: true as const } : { ok: false as const, erreur: r.erreur };
}

export async function ecarterConstat(id: string) {
  const p = await porte(true);
  if (!p.ok) return p;
  if (typeof id !== "string" || !id) return { ok: false as const, erreur: "Constat introuvable." };
  return (await (await service()).ecarterSignal(p.user.id, id)) ? { ok: true as const } : { ok: false as const, erreur: "Constat introuvable." };
}

/** À l'ouverture d'un dossier : les constats de la personne sur cette fiche (aucune interruption). */
export async function suggestionsPourDossier(entiteType: string, entiteId: string) {
  const p = await porte(false);
  if (!p.ok) return p;
  if (typeof entiteType !== "string" || typeof entiteId !== "string" || !entiteId) return { ok: true as const, suggestions: [] };
  return { ok: true as const, suggestions: await (await service()).suggestionsDuDossier(p.user.id, entiteType, entiteId) };
}

/** `destinataires` : identifiants séparés par des virgules (vide : ceux que le geste vise déjà). */
export async function accorderMonMandat(capacite: string, jours: number, gestesParJour: number, destinataires: string) {
  const p = await porte(true);
  if (!p.ok) return p;
  const liste = typeof destinataires === "string" ? destinataires.split(",").map((x) => x.trim()).filter(Boolean) : [];
  const r = await (await mandats()).accorderMandat(p.user, { capacite, jours, gestesParJour, destinataires: liste });
  return r.ok ? { ok: true as const, statut: r.mandat.statut } : { ok: false as const, erreur: r.erreur };
}

export async function revoquerMonMandat(id: string) {
  const p = await porte(true);
  if (!p.ok) return p;
  if (typeof id !== "string" || !id) return { ok: false as const, erreur: "Mandat introuvable." };
  return (await (await mandats()).revoquerMandat(p.user, id)) ? { ok: true as const } : { ok: false as const, erreur: "Mandat introuvable ou déjà révoqué." };
}

/**
 * LES GESTES SOUS MANDAT DUS — appelé par la coque de l'ERP, dans la requête de la personne (voir
 * `infra/proactivite/mandats.ts` : les actions métier exigent sa session). Muet : rien à dire si rien n'est dû.
 */
export async function executerMesGestesSousMandat() {
  const p = await porte(true);
  if (!p.ok) return { ok: false as const };
  const b = await (await mandats()).executerGestesSousMandat(p.user);
  return { ok: true as const, faits: b.faits };
}

// ─────────────────────────────── La console (Super Admin) ───────────────────────────────

async function superAdmin(): Promise<CurrentUser | null> {
  const u = await requireUser();
  return u.role === "SUPER_ADMIN" && userCan(u, "ADMIN", "UPDATE") && !u.impersonatedBy ? u : null;
}

export async function lireConsoleProactivite() {
  const admin = await superAdmin();
  if (!admin) return { ok: false as const, erreur: "Réservé au Super Admin." };
  const [{ lireConsoleProactivite: lire }, { mesureProactivite }] = await Promise.all([import("./infra/proactivite/reglages"), service()]);
  return { ok: true as const, reglages: await lire(), mesure: JSON.parse(JSON.stringify(await mesureProactivite())) as Awaited<ReturnType<typeof mesureProactivite>> };
}

/** Une valeur à `null` : inchangée. */
export async function reglerConsoleProactivite(interruptionsMaxJour: number | null, coupee: boolean | null) {
  const admin = await superAdmin();
  if (!admin) return { ok: false as const, erreur: "Réservé au Super Admin." };
  const { ecrireConsoleProactivite } = await import("./infra/proactivite/reglages");
  const n = await ecrireConsoleProactivite({
    ...(typeof interruptionsMaxJour === "number" && Number.isFinite(interruptionsMaxJour) ? { interruptionsMaxJour } : {}),
    ...(typeof coupee === "boolean" ? { coupee } : {}),
  }, admin.id);
  await recordAudit({
    actorId: admin.id, action: "UPDATE", module: "Centre de contrôle IA",
    summary: `Proactivité de l'Assistant IA : ${n.interruptionsMaxJour} interruption(s)/jour/personne au plus${n.coupee ? " — COUPÉE" : ""}`,
  });
  revalidatePath("/admin/ai/acces");
  return { ok: true as const, reglages: n };
}

export async function approuverMandatConsole(id: string) {
  const admin = await superAdmin();
  if (!admin) return { ok: false as const, erreur: "Réservé au Super Admin." };
  if (typeof id !== "string" || !id) return { ok: false as const, erreur: "Mandat introuvable." };
  return (await (await mandats()).approuverMandat(admin, id)) ? { ok: true as const } : { ok: false as const, erreur: "Mandat introuvable ou déjà tranché." };
}

export async function revoquerMandatConsole(id: string) {
  const admin = await superAdmin();
  if (!admin) return { ok: false as const, erreur: "Réservé au Super Admin." };
  if (typeof id !== "string" || !id) return { ok: false as const, erreur: "Mandat introuvable." };
  return (await (await mandats()).revoquerMandat(admin, id)) ? { ok: true as const } : { ok: false as const, erreur: "Mandat introuvable ou déjà révoqué." };
}
