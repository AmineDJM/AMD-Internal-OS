import { prisma } from "@/lib/prisma";
import { INTERRUPTIONS_MAX_CONSOLE, INTERRUPTIONS_PAR_DEFAUT } from "../../domaine/proactivite/budget";

/**
 * LES DEUX RÉGLAGES DE CONSOLE DE LA PROACTIVITÉ (J12) — sur la ligne `AssistantIaReglage` (« global ») :
 * le plafond d'interruptions par personne et par jour, et l'interrupteur qui coupe toute la proactivité
 * (veilleurs, point du matin, gestes sous mandat). Lus à chaque passage, jamais mis en cache.
 */
export interface ConsoleProactivite { interruptionsMaxJour: number; coupee: boolean }

let pourTests: ConsoleProactivite | null = null;
export function remplacerConsolePourTests(c: ConsoleProactivite | null): void { pourTests = c; }

export async function lireConsoleProactivite(): Promise<ConsoleProactivite> {
  if (pourTests) return pourTests;
  const r = await prisma.assistantIaReglage.findUnique({ where: { id: "global" }, select: { interruptionsMaxJour: true, proactiviteCoupee: true } }).catch(() => null);
  return { interruptionsMaxJour: r?.interruptionsMaxJour ?? INTERRUPTIONS_PAR_DEFAUT, coupee: r?.proactiviteCoupee ?? false };
}

export async function ecrireConsoleProactivite(c: Partial<ConsoleProactivite>, parId: string): Promise<ConsoleProactivite> {
  const max = c.interruptionsMaxJour === undefined ? undefined : Math.min(INTERRUPTIONS_MAX_CONSOLE, Math.max(0, Math.round(c.interruptionsMaxJour)));
  const data = { ...(max !== undefined ? { interruptionsMaxJour: max } : {}), ...(c.coupee !== undefined ? { proactiviteCoupee: c.coupee } : {}), updatedById: parId };
  await prisma.assistantIaReglage.upsert({ where: { id: "global" }, create: { id: "global", ...data }, update: data });
  return lireConsoleProactivite();
}
