import { prisma } from "@/lib/prisma";
import { tauxAcceptation, type TauxFonction } from "../domaine/propositions";
import { estSource } from "../domaine/signaux";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LIRE LES SIGNAUX DATÉS — réservé au SUPER ADMIN pour l'instant (décision du 24/11/2026 : ROI, influence, Brain, Adam au
 * Super Admin seul ; les vues par direction viendront avec leurs droits). Le rôle PRINCIPAL, jamais une casquette
 * secondaire (même règle que la console « Intelligence terrain »). Un refus dit pourquoi, il ne lève pas.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const REFUS_SIGNAUX = "Les signaux datés sont réservés au Super Admin.";

export const peutLireSignaux = (u: { role: string }): boolean => u.role === "SUPER_ADMIN";

export interface FiltreSignaux {
  source?: string | null;
  nature?: string | null;
  companyId?: string | null;
  productId?: string | null;
  buId?: string | null;
  /** AAAA-MM-JJ inclus. */
  depuis?: string | null;
  jusqua?: string | null;
  limite?: number;
}

export interface SignalLu {
  id: string; jour: string; source: string; nature: string; cle: string; producteur: string; statut: string;
  companyId: string | null; buId: string | null; wilayaCode: string | null; productId: string | null; doctorId: string | null;
  budgetEnvelopeId: string | null; entiteType: string | null; entiteId: string | null;
  valeur: number | null; unite: string | null; gravite: string | null; charge: unknown; retenu: unknown;
  auteurId: string | null; decideParId: string | null; decideLe: Date | null; creeLe: Date;
}

const JOUR = /^\d{4}-\d{2}-\d{2}$/;

/** LES SIGNAUX, du plus récent au plus ancien (bornés), selon le filtre. */
export async function lireSignaux(user: { role: string }, f: FiltreSignaux = {}): Promise<{ ok: true; lignes: SignalLu[] } | { ok: false; error: string }> {
  if (!peutLireSignaux(user)) return { ok: false, error: REFUS_SIGNAUX };
  const jour = { ...(f.depuis && JOUR.test(f.depuis) ? { gte: f.depuis } : {}), ...(f.jusqua && JOUR.test(f.jusqua) ? { lte: f.jusqua } : {}) };
  const lignes = await prisma.signalDate.findMany({
    where: {
      ...(f.source && estSource(f.source) ? { source: f.source } : {}),
      ...(f.nature ? { nature: f.nature } : {}),
      ...(f.companyId ? { companyId: f.companyId } : {}),
      ...(f.productId ? { productId: f.productId } : {}),
      ...(f.buId ? { buId: f.buId } : {}),
      ...(Object.keys(jour).length ? { jour } : {}),
    },
    orderBy: [{ jour: "desc" }, { creeLe: "desc" }],
    take: Math.max(1, Math.min(2000, f.limite ?? 500)),
  });
  return { ok: true, lignes };
}

/** LE TAUX D'ACCEPTATION des propositions d'IA, par fonction, depuis `depuis` (90 jours par défaut). */
export async function lireTauxAcceptation(
  user: { role: string }, opts: { maintenant?: Date; depuisJours?: number } = {},
): Promise<{ ok: true; taux: TauxFonction[] } | { ok: false; error: string }> {
  if (!peutLireSignaux(user)) return { ok: false, error: REFUS_SIGNAUX };
  const maintenant = opts.maintenant ?? new Date();
  const lignes = await prisma.signalDate.findMany({
    where: { statut: { in: ["PROPOSE", "ACCEPTE", "MODIFIE", "REJETE"] }, creeLe: { gte: new Date(maintenant.getTime() - (opts.depuisJours ?? 90) * 86_400_000) } },
    select: { source: true, nature: true, statut: true, producteur: true, creeLe: true },
  });
  return { ok: true, taux: tauxAcceptation(lignes, maintenant) };
}
