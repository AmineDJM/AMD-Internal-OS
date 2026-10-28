/** La page d'une source, dans l'ordre des identifiants, après `apresId` (exclu) — forme Prisma commune. */
export function page(apresId: string | null, taille: number) {
  return { where: apresId ? { id: { gt: apresId } } : {}, orderBy: { id: "asc" as const }, take: taille };
}
