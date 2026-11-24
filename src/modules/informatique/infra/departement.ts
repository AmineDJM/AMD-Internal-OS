import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { CLE_DEPARTEMENT_INFORMATIQUE } from "@/lib/rbac";
import { sousVerrou } from "./verrou";

/**
 * LE DÉPARTEMENT INFORMATIQUE D'UNE SOCIÉTÉ — un département ordinaire de l'organigramme (les RH le renomment, lui désignent
 * son responsable comme aux autres), reconnu par sa CLÉ (`Department.cle`), une ligne par société. La migration
 * `departement_informatique` l'a posé pour chaque société active ; une société créée depuis le reçoit à la première lecture.
 */

const NOM = "Informatique";

/** Le code technique d'un département neuf : unique dans tout le groupe (`Department.code`). */
async function codeLibre(tx: Prisma.TransactionClient, companyId: string): Promise<string> {
  const base = `INFORMATIQUE_${companyId.replace(/[^a-zA-Z0-9]/g, "").slice(-6).toUpperCase()}`;
  for (let n = 1; n < 50; n++) {
    const code = n === 1 ? base : `${base}_${n}`;
    if (!(await tx.department.findUnique({ where: { code }, select: { id: true } }))) return code;
  }
  return `${base}_${Date.now()}`;
}

/**
 * TROUVE, SINON POSE, le département Informatique de la société — idempotent. Un département de tête déjà nommé
 * « Informatique » reçoit la clé (jamais de doublon) ; sinon il est créé, sans responsable. Sous verrou de base : deux
 * appels simultanés n'en créent qu'un (et la contrainte d'unicité société × clé reste le dernier rempart).
 */
export async function assurerDepartementInformatique(companyId: string): Promise<{ id: string; cree: boolean }> {
  const existe = await prisma.department.findFirst({ where: { companyId, cle: CLE_DEPARTEMENT_INFORMATIQUE }, select: { id: true } });
  if (existe) return { id: existe.id, cree: false };
  return sousVerrou(`departement-informatique:${companyId}`, async (tx) => {
    const deja = await tx.department.findFirst({ where: { companyId, cle: CLE_DEPARTEMENT_INFORMATIQUE }, select: { id: true } });
    if (deja) return { id: deja.id, cree: false };
    const homonyme = await tx.department.findFirst({
      where: { companyId, parentId: null, cle: null, name: { equals: NOM, mode: "insensitive" } }, select: { id: true },
    });
    if (homonyme) {
      await tx.department.update({ where: { id: homonyme.id }, data: { cle: CLE_DEPARTEMENT_INFORMATIQUE } });
      return { id: homonyme.id, cree: false };
    }
    const cree = await tx.department.create({
      data: { name: NOM, code: await codeLibre(tx, companyId), companyId, cle: CLE_DEPARTEMENT_INFORMATIQUE },
      select: { id: true },
    });
    return { id: cree.id, cree: true };
  });
}

/** Les comptes des RESPONSABLES du département Informatique, par société (le responsable seul : pas l'adjoint). */
export async function responsablesInformatique(companyIds?: readonly string[]): Promise<Map<string, string>> {
  const deps = await prisma.department.findMany({
    where: { cle: CLE_DEPARTEMENT_INFORMATIQUE, ...(companyIds ? { companyId: { in: [...companyIds] } } : {}), head: { userId: { not: null } } },
    select: { companyId: true, head: { select: { userId: true } } },
  });
  const out = new Map<string, string>();
  for (const d of deps) if (d.companyId && d.head?.userId) out.set(d.companyId, d.head.userId);
  return out;
}
