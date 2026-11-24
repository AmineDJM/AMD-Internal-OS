"use server";

import { gesteReversible } from "@/lib/effets/ecran";
import { ouvrirPourEcrire } from "@/lib/queries/porte-ecriture";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { entitePermisePourFiche, getMyCompanies } from "@/lib/company";
import { dossierAccepteLePli } from "@/lib/mail-register/regles";
import { canReparent, type FolderLite } from "@/lib/legal/folders";
import { fdStr, type ActionResult } from "@/lib/actions/types";

/**
 * LES DOSSIERS DE CLASSEMENT DU COURRIER — le pendant exact de Legal.
 *
 * Un dossier RANGE, il n'AUTORISE pas : le cloisonnement par entité reste la seule règle d'accès,
 * exactement comme pour les engagements de Legal. Ces actions ne touchent donc jamais à qui voit
 * un pli — y ranger un courrier n'ouvre rien à personne. La logique d'arbre (boucles interdites,
 * chemin, sous-arbre) est mutualisée avec Legal : c'est le même problème, résolu une fois.
 */

const PATH = "/courriers";

/**
 * LE JOURNAL D'UN DOSSIER N'EST PAS CELUI D'UN COURRIER (audit Courrier, 24/11).
 *
 * Ces gestes s'écrivaient `entityType: "MAIL_ENTRY"` avec l'identifiant du DOSSIER : la création
 * d'un dossier émettait le fait métier « courrier enregistré » (`from-audit.ts`), et le journal
 * global menait vers `/courriers/<id du dossier>` — un 404. L'énumération `EntityType` n'a aucune
 * valeur pour un dossier de classement, et aucune voisine n'est juste : `DOSSIER` est un sujet
 * (lien vers `/dossiers/…`), `DRIVE_NODE` un nœud du Drive (lien vers `/drive/…`) — chacune
 * fabriquerait le même faux lien ailleurs. On écrit donc la ligne SANS type d'entité, comme le
 * classement des plis (`moveMailEntries`) le faisait déjà : l'identifiant du dossier reste au
 * journal pour le retrouver, aucun lien n'est fabriqué, aucun fait n'est émis.
 */

/** Tous les dossiers, en forme légère — ce dont les règles pures ont besoin. */
async function allFolders(): Promise<FolderLite[]> {
  return prisma.mailEntryFolder.findMany({ select: { id: true, name: true, parentId: true, companyId: true } });
}

/**
 * LE DOSSIER VISÉ PAR LE FORMULAIRE, PORTE D'ÉCRITURE FRANCHIE (audit 27/10, SA-16) : le droit du module ET la
 * société du dossier — la création la vérifiait déjà. Renommer et supprimer passent par elle.
 */
async function porteDuDossier(formData: FormData, action: "UPDATE" | "DELETE") {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false as const, error: "Dossier introuvable." };
  const porte = await ouvrirPourEcrire(user, "MAIL_FOLDER", id, action);
  if (!porte.ok) return porte;
  const existing = await prisma.mailEntryFolder.findUnique({ where: { id }, select: { name: true } });
  if (!existing) return { ok: false as const, error: "Dossier introuvable." };
  return { ok: true as const, user, id, existing };
}

/** L'entité demandée est-elle dans le périmètre ? On ne classe pas dans une société qu'on ne voit pas. */
async function companyAllowed(userId: string, companyId: string | null): Promise<boolean> {
  if (!companyId) return true;
  const mine = await getMyCompanies(userId);
  return mine.some((c) => c.id === companyId);
}

export async function createMailFolder(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  return gesteReversible(user, { capaciteId: "mail-folder-actions:createMailFolder", libelle: "Dossier de classement créé" }, async () => {
    if (!userCan(user, "MAIL_REGISTER", "CREATE")) return { ok: false, error: "Non autorisé." };
    const name = fdStr(formData, "name");
    if (!name) return { ok: false, error: "Donnez un nom au dossier." };

    const companyId = fdStr(formData, "companyId");
    if (!(await companyAllowed(user.id, companyId))) return { ok: false, error: "Cette entité n'est pas dans votre périmètre." };

    const parentId = fdStr(formData, "parentId");
    if (parentId) {
      // Le parent est un dossier qu'on VOIT, et de la même entité : un sous-dossier d'Alpha rangé
      // sous un dossier de Beta n'apparaîtrait dans l'arbre de personne.
      const parent = await prisma.mailEntryFolder.findUnique({ where: { id: parentId }, select: { companyId: true } });
      if (!parent || !(await entitePermisePourFiche(user.id, parent.companyId))) return { ok: false, error: "Dossier parent introuvable." };
      if (!dossierAccepteLePli(parent.companyId, companyId)) {
        return { ok: false, error: "Le dossier parent appartient à une autre entité — choisissez un parent de la même entité, ou un dossier commun." };
      }
    }

    const created = await prisma.mailEntryFolder.create({
      data: { name, companyId: companyId || null, parentId: parentId || null, description: fdStr(formData, "description"), createdById: user.id },
      select: { id: true },
    });
    await recordAudit({
      actorId: user.id, action: "CREATE", module: "Courriers", entityId: created.id,
      summary: `Dossier de classement « ${name} » créé`,
    });
    revalidatePath(PATH);
    return { ok: true, id: created.id };
  });
}

/** Renomme un dossier, ou le déplace sous un autre. */
export async function updateMailFolder(formData: FormData): Promise<ActionResult> {
  return gesteReversible(await requireUser(), { capaciteId: "mail-folder-actions:updateMailFolder", libelle: "Dossier de classement modifié" }, async () => {
    const dossier = await porteDuDossier(formData, "UPDATE");
    if (!dossier.ok) return dossier;
    const { user, id, existing } = dossier;

    const parentRaw = formData.get("parentId");
    const nextParent = parentRaw != null ? (String(parentRaw) || null) : undefined;
    if (nextParent !== undefined && !canReparent(await allFolders(), id, nextParent)) {
      // Créer une boucle ferait disparaître le dossier — et tout ce qu'il contient — de l'arbre.
      return { ok: false, error: "Un dossier ne peut pas être rangé dans lui-même ni dans l'un de ses sous-dossiers." };
    }
    if (nextParent) {
      // On ne range pas sous le dossier d'une société qu'on ne voit pas — il est, pour nous, introuvable.
      const parent = await prisma.mailEntryFolder.findUnique({ where: { id: nextParent }, select: { companyId: true } });
      if (!parent || !(await entitePermisePourFiche(user.id, parent.companyId))) return { ok: false, error: "Dossier parent introuvable." };
    }

    const companyRaw = formData.get("companyId");
    if (companyRaw != null && !(await companyAllowed(user.id, String(companyRaw) || null))) {
      return { ok: false, error: "Cette entité n'est pas dans votre périmètre." };
    }
    // Rattacher le dossier à une entité ne doit pas y laisser les plis d'une autre (`dossierAccepteLePli`).
    const nextCompany = companyRaw != null ? (String(companyRaw) || null) : null;
    if (nextCompany) {
      const etrangers = await prisma.mailEntry.count({ where: { folderId: id, companyId: { not: null }, NOT: { companyId: nextCompany } } });
      if (etrangers > 0) {
        return { ok: false, error: `Ce dossier contient ${etrangers} courrier(s) d'une autre entité — déplacez-les d'abord, ou laissez le dossier commun au groupe.` };
      }
    }

    const name = fdStr(formData, "name") || existing.name;
    await prisma.mailEntryFolder.update({
      where: { id },
      data: {
        name,
        description: formData.has("description") ? fdStr(formData, "description") : undefined,
        ...(nextParent !== undefined ? { parentId: nextParent } : {}),
        ...(companyRaw != null ? { companyId: String(companyRaw) || null } : {}),
      },
    });
    await recordAudit({
      actorId: user.id, action: "UPDATE", module: "Courriers", entityId: id,
      summary: `Dossier de classement modifié : ${existing.name}${name !== existing.name ? ` → ${name}` : ""}`,
    });
    revalidatePath(PATH);
    return { ok: true };
  });
}

/**
 * Supprime un dossier. Ses SOUS-DOSSIERS partent avec lui (ils n'ont pas de sens sans leur
 * parent) ; ses COURRIERS repassent « non classés » — jamais supprimés. C'est la contrainte
 * `ON DELETE SET NULL` qui le garantit, pas une précaution d'écran.
 */
export async function deleteMailFolder(formData: FormData): Promise<ActionResult> {
  const dossier = await porteDuDossier(formData, "DELETE");
  if (!dossier.ok) return dossier;
  const { user, id, existing } = dossier;

  await prisma.mailEntryFolder.delete({ where: { id } });
  await recordAudit({
    actorId: user.id, action: "DELETE", module: "Courriers", entityId: id,
    summary: `Dossier de classement « ${existing.name} » supprimé (courriers déclassés, non supprimés)`,
  });
  revalidatePath(PATH);
  return { ok: true };
}

/**
 * Range un ou plusieurs courriers dans un dossier — ou les en sort (`folderId` vide).
 *
 * Le contrôle porte sur chaque pli : on ne range que ce qui est dans son périmètre d'entité, et
 * le classement ne change RIEN à qui peut le lire.
 */
export async function moveMailEntries(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  return gesteReversible(user, { capaciteId: "mail-folder-actions:moveMailEntries", libelle: "Courriers déplacés" }, async () => {
    if (!userCan(user, "MAIL_REGISTER", "UPDATE")) return { ok: false, error: "Non autorisé." };
    const ids = [...new Set(formData.getAll("entryId").map(String).filter(Boolean))];
    if (ids.length === 0) return { ok: false, error: "Aucun courrier sélectionné." };

    const folderId = fdStr(formData, "folderId");
    let folderName = "Non classés";
    let folderCompanyId: string | null = null;
    if (folderId) {
      // On ne range pas dans le dossier d'une société qu'on ne voit pas (SA-16).
      const porte = await ouvrirPourEcrire(user, "MAIL_FOLDER", folderId, "UPDATE");
      if (!porte.ok) return porte;
      const folder = await prisma.mailEntryFolder.findUnique({ where: { id: folderId }, select: { name: true, companyId: true } });
      if (!folder) return { ok: false, error: "Dossier introuvable." };
      folderName = folder.name;
      folderCompanyId = folder.companyId;
    }

    const mine = await getMyCompanies(user.id);
    const movable = await prisma.mailEntry.findMany({
      where: { id: { in: ids }, OR: [{ companyId: null }, { companyId: { in: mine.map((c) => c.id) } }] },
      select: { id: true, companyId: true },
    });
    if (movable.length === 0) return { ok: false, error: "Ces courriers ne sont pas dans votre périmètre." };
    // UN DOSSIER D'UNE ENTITÉ NE RANGE QUE SES PLIS. Refus franc, rien de déplacé : ranger « une
    // partie » laisserait la personne chercher lesquels sont partis.
    const etrangers = movable.filter((m) => !dossierAccepteLePli(folderCompanyId, m.companyId)).length;
    if (etrangers > 0) {
      return { ok: false, error: `${etrangers} courrier(s) relève(nt) d'une autre entité que le dossier « ${folderName} » — rangez-les dans un dossier de leur entité, ou dans un dossier commun.` };
    }

    // porte d'écriture : `movable` ne garde que les pièces des sociétés de la personne (filtre ci-dessus).
    await prisma.mailEntry.updateMany({
      where: { id: { in: movable.map((d) => d.id) } },
      data: { folderId: folderId || null },
    });
    await recordAudit({
      actorId: user.id, action: "UPDATE", module: "Courriers",
      summary: `${movable.length} courrier(s) rangé(s) dans « ${folderName} »`,
    });
    revalidatePath(PATH);
    return { ok: true, message: `${movable.length} courrier(s) rangé(s) dans « ${folderName} ».` };
  });
}
