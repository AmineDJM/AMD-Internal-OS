import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";
import { companyIdForNew, companyScopedWhere, getMyCompanies } from "@/lib/company";
import { findPartyByName } from "@/lib/queries/company-contacts";
import { accesAuxPiecesLegal } from "@/lib/entity-access/acces-entite";
import { legalReaderWhere } from "@/lib/lecteurs/legal";
import { et } from "@/lib/acces/compose";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES LECTURES DU REGISTRE JURIDIQUE, POUR CEUX QUI N'ONT PAS L'ÉCRAN (lot T1, décision 0051) — l'Assistant IA.
 *
 * La porte est CELLE DE L'ÉCRAN, écrite une fois ailleurs et seulement appelée ici : l'entité (`getMyCompanies`), les
 * LECTEURS DÉSIGNÉS (`legalReaderWhere`), puis la règle unitaire des pièces Legal (`accesAuxPiecesLegal`). Une pièce qu'on
 * ne lit pas n'existe pas : ni dans une liste, ni comme candidate d'un nom ambigu (§118.71). Lectures seulement — les
 * écritures passent par les actions (`legal-actions.ts`, `legal-folder-actions.ts`, `company-contact-actions.ts`).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Les sociétés de la personne (identifiants) — le cloisonnement d'entité du registre. */
export async function societesDe(user: CurrentUser): Promise<{ id: string; name: string; shortName?: string | null }[]> {
  return getMyCompanies(user.id);
}

/** La société de rattachement (son identifiant) — l'entité d'un dossier de classement créé en rangeant. */
export const societeDeRattachementId = (user: CurrentUser): Promise<string | null> => companyIdForNew(user.id);

/** Le nom de la société de rattachement (la partie des pièces internes : statuts, PV). */
export async function societeDeRattachement(user: CurrentUser): Promise<string> {
  const id = await companyIdForNew(user.id);
  return id ? (await prisma.company.findUnique({ where: { id }, select: { name: true } }))?.name ?? "" : "";
}

/** Les pièces du registre que la personne LIT, parmi `where` — entité, lecteurs, puis la règle unitaire. Bornées. */
export async function piecesJuridiquesLisibles(user: CurrentUser, where: object, take = 60) {
  const lecteurs = legalReaderWhere({ viewerId: user.id, isSuperAdmin: user.role === "SUPER_ADMIN" });
  const mine = (await getMyCompanies(user.id)).map((c) => c.id);
  const rows = await prisma.legalDocument.findMany({
    where: { AND: [where, { OR: [{ companyId: null }, { companyId: { in: mine } }] }, ...(lecteurs ? [lecteurs] : [])] },
    select: {
      id: true, title: true, kind: true, reference: true, counterparty: true, counterpartyIds: true, notes: true, startDate: true, endDate: true, status: true,
      amount: true, createdAt: true, folderId: true, chainFromId: true, direction: true, paidDate: true,
      driveNodeId: true, folder: { select: { name: true } }, driveNode: { select: { name: true, isTrashed: true } }, company: { select: { name: true } },
    },
    orderBy: [{ startDate: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
    take,
  });
  const vues = (await accesAuxPiecesLegal(user, rows.map((r) => r.id), ["VIEW"])).get("VIEW") ?? new Set<string>();
  return rows.filter((r) => vues.has(r.id));
}

/** Les pièces (parmi `ids`) que la personne peut MODIFIER — la règle de la fiche. */
export async function piecesJuridiquesModifiables(user: CurrentUser, ids: string[]): Promise<Set<string>> {
  return (await accesAuxPiecesLegal(user, ids, ["UPDATE"])).get("UPDATE") ?? new Set<string>();
}

/** Les dossiers de classement visibles (communs au groupe ou d'une société de la personne). */
export async function dossiersJuridiques(user: CurrentUser, nom?: string): Promise<{ id: string; name: string }[]> {
  const mine = (await getMyCompanies(user.id)).map((c) => c.id);
  return prisma.legalFolder.findMany({
    where: { OR: [{ companyId: null }, { companyId: { in: mine } }], ...(nom ? { name: { equals: nom, mode: "insensitive" } } : {}) },
    select: { id: true, name: true }, orderBy: [{ createdAt: "asc" }], take: 200,
  });
}

/** Une partie par son NOM, résolue sans ambiguïté à l'annuaire — la règle d'`attachDriveNodeToLegal`. */
export const partieParNom = (user: CurrentUser, nom: string) => findPartyByName(user.id, nom);

/** Les contacts actifs de l'annuaire dans le périmètre de la personne (pour repérer la partie citée dans une pièce). */
export async function contactsDuPerimetre(user: CurrentUser): Promise<{ id: string; name: string }[]> {
  const scope = await companyScopedWhere(user.id, {});
  return prisma.companyContact.findMany({ where: et(scope, { isActive: true }), select: { id: true, name: true }, take: 2000 });
}
