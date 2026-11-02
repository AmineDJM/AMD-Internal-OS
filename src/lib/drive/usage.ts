import { prisma } from "@/lib/prisma";
import { makeTtlCache } from "./quota";

/**
 * L'OCTET TOTAL DU STOCKAGE PHYSIQUE — la mesure qui coûtait cher à chaque téléversement.
 *
 * `SUM(size)` sur toute la table des blobs n'a aucun filtre : Postgres la parcourt entièrement.
 * C'était fait **par fichier envoyé**, donc six fois en parallèle sur un lot — avant le premier
 * octet écrit. Pour un garde-fou qui se compte en téra-octets, une relecture toutes les
 * 30 secondes suffit, et on ajoute au vol ce qu'on vient d'écrire pour rester juste en rafale.
 */
const CAPACITY_TTL_MS = 30_000;

const physicalCache = makeTtlCache(async () => {
  // Ce qui est RÉELLEMENT stocké : la taille compressée quand le contenu l'est (`storedSize`), celle
  // du clair sinon. Additionner `size` compterait l'espace que la compression vient de rendre.
  const rows = await prisma.$queryRaw<{ total: number | null }[]>`
    SELECT COALESCE(SUM(COALESCE("storedSize", "size")), 0)::float8 AS total FROM "FileBlob"`;
  return Number(rows[0]?.total ?? 0);
}, CAPACITY_TTL_MS);

/** Octets physiques occupés (contenu chiffré dédupliqué), à 30 secondes près. */
export function physicalUsageBytes(): Promise<number> {
  return physicalCache.get();
}

/**
 * Comptabilise des octets fraîchement écrits sans relire la table.
 *
 * À n'appeler que quand un blob NEUF a été créé : un contenu dédupliqué n'occupe pas de place
 * supplémentaire, et le compter gonflerait artificiellement l'occupation jusqu'à refuser des
 * envois qui tiennent parfaitement.
 */
export function addPhysicalUsage(bytes: number): void {
  physicalCache.patch((v) => v + bytes);
}

/**
 * Octets détenus par une personne — NON mis en cache, volontairement : c'est le plafond qui
 * refuse un envoi, et refuser à tort sur une valeur périmée serait incompréhensible. Il porte un
 * index sur `ownerId` : il est bon marché.
 */
export async function userUsageBytes(userId: string): Promise<number> {
  const agg = await prisma.driveNode.aggregate({
    where: { ownerId: userId, type: "FILE", isTrashed: false },
    _sum: { size: true },
  });
  return agg._sum.size ?? 0;
}
