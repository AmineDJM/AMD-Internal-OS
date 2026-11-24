import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";

/**
 * UN VERROU DE BASE POUR UNE OUVERTURE « TROUVER, SINON CRÉER » — `pg_advisory_xact_lock` sur la clé, tenu le temps de la
 * transaction. Deux onglets, deux serveurs ou la tâche de fond et un clic qui ouvrent en même temps l'enveloppe d'une société
 * ou imputent le même mois ne créent jamais deux lignes : le second attend, puis TROUVE ce que le premier a créé.
 */
export async function sousVerrou<T>(cle: string, corps: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${cle}))`;
    return corps(tx);
  }, { timeout: 20_000 });
}
