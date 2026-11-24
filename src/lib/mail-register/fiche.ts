import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { companyScopedWhere, getMyCompanies, companyLabel } from "@/lib/company";
import { clauseCourriersVisibles } from "@/lib/queries/visibilite-listes";
import { listPartyOptions } from "@/lib/queries/company-contacts";
import { mailRoutingOptions } from "@/lib/queries/mail-routing";
import { resolveDriveAccess, canViewDrive } from "@/lib/drive";
import { linksOf, linkedViews } from "@/lib/links/store";
import { buildFolderTree, flattenFolders, indentedLabel } from "@/lib/legal/folders";

/**
 * CE QUE LE PANNEAU D'UN COURRIER AFFICHE — chargé au serveur, derrière la MÊME porte que la liste.
 *
 * La fiche n'est plus une page : le registre ouvre le pli dans un panneau quand l'adresse porte
 * `?courrier=<id>`. Cet identifiant vient du navigateur (lien partagé, notification, adresse tapée) :
 * il ne vaut rien tant que la clause de visibilité du registre (`clauseCourriersVisibles`, celle que
 * la liste et la recherche globale appliquent) ne l'a pas retrouvé. Un pli d'une autre société rend
 * `null`, et le panneau ne s'ouvre pas — exactement comme l'ancienne page répondait 404.
 *
 * Liste et panneau passent par la même clause : un pli qu'on voit dans le tableau s'ouvre toujours
 * (`courrier-visible-mais-404.test.ts`), un pli qu'on n'y voit pas ne s'ouvre jamais.
 */
export async function chargerFicheCourrier(user: CurrentUser, id: string) {
  const entry = await prisma.mailEntry.findFirst({
    where: { AND: [await clauseCourriersVisibles(user.id), { id }] },
    include: {
      createdBy: { select: { name: true } },
      company: { select: { name: true, shortName: true } },
      partner: { select: { name: true } },
      folder: { select: { id: true, name: true } },
      driveNode: { select: { id: true, name: true } },
      department: { select: { name: true } },
      concernedUser: { select: { name: true } },
      // LES PIÈCES NOMINATIVES : un même pli part souvent à plusieurs endroits.
      pieces: { orderBy: { createdAt: "asc" }, include: { driveNode: { select: { name: true } } } },
    },
  });
  if (!entry) return null;

  const canEdit = userCan(user, "MAIL_REGISTER", "UPDATE");
  const droits = {
    canEdit,
    // Le CRÉATEUR d'un pli peut le retirer, même sans le droit `DELETE` (suppression réversible).
    canDelete: userCan(user, "MAIL_REGISTER", "DELETE") || entry.createdById === user.id,
    canUpload: userCan(user, "MAIL_REGISTER", "UPLOAD") || canEdit,
    canCreateContact: userCan(user, "GENERAL_MEANS", "CREATE"),
  };

  const self = { type: "MAIL_ENTRY" as const, id: entry.id };
  const [documents, history, myCompanies, partners, routing, folderRows, liens, partyOptions] = await Promise.all([
    prisma.document.findMany({
      where: { entityType: "MAIL_ENTRY", entityId: entry.id },
      include: { uploadedBy: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
    }),
    prisma.auditLog.findMany({
      where: { entityType: "MAIL_ENTRY", entityId: entry.id },
      include: { actor: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
      take: 60,
    }),
    getMyCompanies(user.id),
    prisma.mailPartner.findMany({ where: { isActive: true }, select: { id: true, name: true, kind: true }, orderBy: { name: "asc" } }),
    mailRoutingOptions(),
    // LES DOSSIERS OÙ CE PLI PEUT ALLER — ceux qu'on voit ET qui acceptent son entité ; plus le
    // sien, toujours : absent du menu, il serait lu « non classé » au premier enregistrement.
    prisma.mailEntryFolder.findMany({
      where: {
        OR: [
          await companyScopedWhere(user.id, entry.companyId ? { companyId: { in: [entry.companyId] } } : {}),
          await companyScopedWhere(user.id, { companyId: null }),
          ...(entry.folderId ? [{ id: entry.folderId }] : []),
        ],
      },
      select: { id: true, name: true, parentId: true, companyId: true },
    }),
    linksOf(self).then((rows) => linkedViews(self, rows)),
    // L'ANNUAIRE — avec l'expéditeur et le destinataire DÉJÀ retenus, même retirés depuis.
    listPartyOptions(user.id, {
      includeIds: [entry.senderContactId, entry.recipientContactId].filter((x): x is string => Boolean(x)),
    }),
  ]);

  // LE DRIVE A SES PROPRES DROITS : lire le pli ne donne pas le droit de lire le fichier qu'il
  // référence. Son NOM même peut être confidentiel — on ne le montre qu'à qui peut l'ouvrir.
  const noeudsDrive = [entry.driveNode?.id, ...entry.pieces.map((p) => p.driveNodeId)].filter((x): x is string => Boolean(x));
  const driveLisible = new Set<string>();
  for (const n of new Set(noeudsDrive)) if (canViewDrive(await resolveDriveAccess(user, n))) driveLisible.add(n);

  return {
    entry,
    droits,
    documents,
    history,
    liens,
    partyOptions,
    driveLisible,
    menus: {
      companies: myCompanies.map((c) => ({ value: c.id, label: companyLabel(c) })),
      partners: partners.map((x) => ({ value: x.id, label: x.kind ? `${x.name} — ${x.kind}` : x.name })),
      departments: routing.departments,
      people: routing.people,
      folders: flattenFolders(buildFolderTree(folderRows)).map((n) => ({ value: n.id, label: indentedLabel(n) })),
    },
  };
}

export type FicheCourrier = NonNullable<Awaited<ReturnType<typeof chargerFicheCourrier>>>;
