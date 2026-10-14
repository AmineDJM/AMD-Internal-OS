import { prisma } from "@/lib/prisma";
import { getMyCompanies, companyIdForNew, companyLabel } from "@/lib/company";

/**
 * LA PAPETERIE DISPONIBLE — ce qu'on peut proposer à quelqu'un qui crée un document.
 *
 * Deux règles, et rien de plus : on voit les en-têtes de SES entités, plus les en-têtes
 * communs au groupe (sans entité). Le cloisonnement s'applique donc au papier à en-tête
 * comme au reste — écrire sur l'en-tête d'une société qu'on ne voit pas, ce serait engager
 * cette société.
 */

export interface LetterheadOption {
  id: string;
  name: string;
  kind: string;
  companyId: string | null;
  companyLabel: string | null;
  isActive: boolean;
  size: number;
  updatedAt: string;
  uploadedBy: string | null;
}

export interface LetterheadContext {
  letterheads: LetterheadOption[];
  /** L'entité « courante » : celle dont l'en-tête arrivera en tête de liste. */
  companyId: string | null;
}

/**
 * Les en-têtes proposables à cette personne, et l'entité qui décide de l'ordre.
 *
 * `includeInactive` sert à l'écran de gestion : l'assistante de direction doit voir ce
 * qu'elle a désactivé, sinon un en-tête retiré devient introuvable et se re-téléverse
 * en double.
 */
export async function letterheadContextFor(
  userId: string,
  opts: { includeInactive?: boolean } = {},
): Promise<LetterheadContext> {
  const [mine, companyId] = await Promise.all([getMyCompanies(userId), companyIdForNew(userId)]);
  const rows = await prisma.officeLetterhead.findMany({
    where: {
      ...(opts.includeInactive ? {} : { isActive: true }),
      OR: [{ companyId: null }, { companyId: { in: mine.map((c) => c.id) } }],
    },
    select: {
      id: true, name: true, kind: true, companyId: true, isActive: true, size: true, updatedAt: true,
      uploadedById: true,
    },
    orderBy: [{ kind: "asc" }, { name: "asc" }],
  });

  // Qui a déposé quoi : lu à part plutôt qu'en relation Prisma — un en-tête survit au départ
  // de la personne qui l'a téléversé, et la papeterie de la société ne doit pas dépendre d'elle.
  const uploaderIds = [...new Set(rows.map((r) => r.uploadedById).filter((v): v is string => !!v))];
  const uploaders = uploaderIds.length
    ? await prisma.user.findMany({ where: { id: { in: uploaderIds } }, select: { id: true, name: true } })
    : [];
  const names = new Map(uploaders.map((u) => [u.id, u.name]));
  const labels = new Map(mine.map((c) => [c.id, companyLabel(c)]));

  return {
    companyId,
    letterheads: rows.map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.kind,
      companyId: r.companyId,
      companyLabel: r.companyId ? labels.get(r.companyId) ?? null : null,
      isActive: r.isActive,
      size: r.size,
      updatedAt: r.updatedAt.toISOString(),
      uploadedBy: r.uploadedById ? names.get(r.uploadedById) ?? null : null,
    })),
  };
}

/**
 * LA PAPETERIE D'UNE PIÈCE COMPOSÉE SOUS DÉLÉGATION — l'aperçu d'un bon de commande (poste Ad & Pro, demande au secrétariat) :
 * les en-têtes actifs de la société QUI COMMANDE, plus ceux communs au groupe. Pas ceux des entités de la personne : sous
 * délégation, c'est la société du dossier qui émet, et la fabrique refuse le papier d'une autre société.
 */
export async function papeterieDeLaSociete(companyId: string): Promise<{ id: string; name: string; companyId: string | null; companyLabel: string | null }[]> {
  const [rows, societe] = await Promise.all([
    prisma.officeLetterhead.findMany({
      where: { isActive: true, OR: [{ companyId: null }, { companyId }] },
      select: { id: true, name: true, companyId: true },
      orderBy: [{ kind: "asc" }, { name: "asc" }],
    }),
    prisma.company.findUnique({ where: { id: companyId }, select: { name: true, shortName: true } }),
  ]);
  const libelle = societe ? societe.shortName || societe.name : null;
  return rows.map((r) => ({ id: r.id, name: r.name, companyId: r.companyId, companyLabel: r.companyId ? libelle : null }));
}
