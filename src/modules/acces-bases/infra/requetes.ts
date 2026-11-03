/**
 * Les lectures de la console « Accès par base » (lot D2) — la page ne touche pas Prisma.
 */
import { prisma } from "@/lib/prisma";

/** Les personnes actives, pour choisir une cible. */
export function personnesActives() {
  return prisma.user.findMany({ where: { isActive: true }, select: { id: true, name: true }, orderBy: { name: "asc" } });
}

/** Le nom des personnes visées par des réglages (révoquées ou inactives comprises). */
export async function nomsDe(ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const l = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
  return new Map(l.map((u) => [u.id, u.name]));
}
