import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/lib/rbac";
import { piecesOuvrables } from "./recherche";

/**
 * LES FAITS CONFIRMÉS, POUR UN MODÈLE (J4, décision 0018) — ce que le référentiel tient pour vrai, tiré d'une pièce.
 *
 * Un fait se rend s'il n'est pas sensible ET si la personne peut ouvrir la pièce dont il vient (`piecesOuvrables`, la
 * règle de la recherche). Un fait sans pièce (saisie, import) n'a pas d'autre juge que le Super Admin. Un fait sensible
 * (qui pointe le coffre) ne se rend jamais. Ici plutôt qu'au socle IA : la Bibliothèque tient le registre des pièces.
 */
export interface FaitRendu {
  sujet: string;
  attribut: string;
  valeur: string | null;
  source: string;
  confirmeLe: string;
}

async function faitsVisibles(user: SessionUser, faits: { pieceId: string | null; sensible: boolean }[]): Promise<boolean[]> {
  const ouvrables = await piecesOuvrables(user, faits.map((f) => f.pieceId).filter((x): x is string => !!x));
  return faits.map((f) => !f.sensible && (f.pieceId ? ouvrables.has(f.pieceId) : user.role === "SUPER_ADMIN"));
}

/** Les faits des sujets (5 au plus) dont une valeur répond à la recherche ; `caches` = trouvés mais non rendus. */
export async function faitsConfirmesPourModele(user: SessionUser, recherche: string): Promise<{ faits: FaitRendu[]; caches: number; existe: boolean }> {
  const q = recherche.trim().slice(0, 120);
  const touches = await prisma.faitConfirme.findMany({
    where: { actif: true, sensible: false, OR: [{ valeur: { contains: q, mode: "insensitive" } }, { valeurNormalisee: { contains: q.toLowerCase() } }] },
    select: { sujetType: true, sujetId: true },
    take: 20,
  });
  const sujets = [...new Map(touches.map((t) => [`${t.sujetType}:${t.sujetId}`, t])).values()].slice(0, 5);
  if (!sujets.length) return { faits: [], caches: 0, existe: false };
  const lus = await prisma.faitConfirme.findMany({
    where: { actif: true, OR: sujets.map((s) => ({ sujetType: s.sujetType, sujetId: s.sujetId })) },
    select: { sujetType: true, sujetId: true, attribut: true, valeur: true, sensible: true, pieceId: true, source: true, confirmeLe: true },
    orderBy: { confirmeLe: "desc" },
    take: 60,
  });
  const visibles = await faitsVisibles(user, lus);
  const faits = lus.filter((_, i) => visibles[i]).map((f) => ({
    sujet: `${f.sujetType}:${f.sujetId}`, attribut: f.attribut, valeur: f.valeur, source: f.source, confirmeLe: f.confirmeLe.toISOString().slice(0, 10),
  }));
  return { faits, caches: lus.length - faits.length, existe: true };
}
