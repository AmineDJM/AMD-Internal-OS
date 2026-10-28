import { randomUUID } from "crypto";
import type { UserRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { anyRoleFilter } from "@/lib/rbac";
import { getAppSettings } from "@/lib/settings";
import { saveFile, validateUpload } from "@/lib/storage";
import { rejouerNotifications } from "@/lib/notifications/ecrire";
import { sendPushToUser } from "@/lib/push";
import type { DirectiveAudience, DirectiveScope } from "./audience";
import { sansBloquer } from "@/lib/journal";

/**
 * DE LA PORTÉE AUX PERSONNES — et de la publication à l'envoi.
 *
 * `audience.ts` dit à QUI une directive s'adresse en pure logique ; ici on va chercher les
 * comptes réels. C'est la seule partie qui a besoin de la base — et elle est volontairement
 * mince : la règle vit dans le module pur, ce fichier ne fait que la servir.
 *
 * Module SERVEUR (prisma, stockage, push) : jamais importé par un composant client.
 */

/**
 * Les comptes ACTIFS visés par une portée. Un compte désactivé n'est pas un destinataire :
 * lui empiler des notes qu'il ne lira jamais fausserait tous les compteurs d'accusé de réception.
 */
export async function resolveRecipientIds(d: {
  audience: DirectiveAudience;
  targetUserIds: string[];
  targetRole: string | null;
  companyId: string | null;
}): Promise<string[]> {
  switch (d.audience) {
    case "USERS": {
      const ids = [...new Set(d.targetUserIds.filter(Boolean))];
      if (ids.length === 0) return [];
      const rows = await prisma.user.findMany({ where: { id: { in: ids }, isActive: true }, select: { id: true } });
      return rows.map((u) => u.id);
    }
    case "ROLE": {
      if (!d.targetRole) return [];
      const rows = await prisma.user.findMany({
        where: { isActive: true, ...anyRoleFilter([d.targetRole as UserRole]) },
        select: { id: true },
      });
      return rows.map((u) => u.id);
    }
    case "COMPANY": {
      if (!d.companyId) return [];
      // L'entité se lit sur la FICHE EMPLOYÉ : c'est elle qui dit de quelle société on relève.
      // Les accès accordés (`UserCompanyAccess`) disent ce qu'on a le droit de CONSULTER —
      // une assistante de direction voit deux entités sans être salariée des deux, et une note
      // adressée « aux salariés d'Adventum » ne la concerne pas pour autant.
      const rows = await prisma.employee.findMany({
        where: { companyId: d.companyId, isActive: true, userId: { not: null } },
        select: { userId: true },
      });
      const ids = [...new Set(rows.map((e) => e.userId).filter((id): id is string => !!id))];
      if (ids.length === 0) return [];
      const actifs = await prisma.user.findMany({ where: { id: { in: ids }, isActive: true }, select: { id: true } });
      return actifs.map((u) => u.id);
    }
    case "ALL": {
      const rows = await prisma.user.findMany({ where: { isActive: true }, select: { id: true } });
      return rows.map((u) => u.id);
    }
    default:
      return [];
  }
}

/**
 * ENVOYER (ou RENVOYER) une directive à sa portée.
 *
 * Le même geste sert à la première diffusion et à la relance : une relance qui emprunterait un
 * autre chemin finirait par ne plus toucher les mêmes personnes que l'envoi initial — c'est
 * exactement ce qu'on ne veut pas d'un bouton « renvoyer ».
 *
 * L'émetteur ne se notifie pas lui-même ; il vient d'écrire la note.
 * Renvoie le nombre de destinataires réellement notifiés.
 */
export async function sendDirective(directive: {
  id: string;
  reference: string;
  title: string;
  audience: DirectiveAudience;
  targetUserIds: string[];
  targetRole: string | null;
  companyId: string | null;
  popup: boolean;
  fromId: string | null;
}, opts: { relance?: boolean } = {}): Promise<number> {
  const ids = (await resolveRecipientIds(directive)).filter((id) => id !== directive.fromId);
  if (ids.length === 0) return 0;

  const title = opts.relance ? "Directive — rappel" : "Nouvelle directive";
  const body = `${directive.reference} — ${directive.title}`;
  const link = `/directives/${directive.id}`;

  /**
   * UNE DIFFUSION LARGE NE DOIT PAS ÊTRE TOUT-OU-RIEN — et la règle ne vit plus ici.
   *
   * `createMany` insère en une transaction : il suffit qu'UN compte ait été supprimé entre la
   * résolution des destinataires et l'insertion pour que la clé étrangère échoue — et alors les
   * 200 autres personnes ne reçoivent rien, en silence. Ce fichier a longtemps porté SEUL le
   * remède pendant que cinq autres écrivains du dépôt refaisaient le défaut ; le REJEU est
   * descendu dans `notifications/ecrire`, que les six empruntent désormais (§118.58, §118.71).
   * L'écriture, elle, reste ici : sortie du corps, elle disparaîtrait de ce que la dérivation
   * des contrats sait dire de cette action (§118.137).
   */
  const lignes = ids.map((userId) => ({
    userId, type: "ASSIGNMENT" as const, title, body, link, popup: directive.popup,
  }));
  let ecrites = lignes.length;
  try {
    await prisma.notification.createMany({ data: lignes });
  } catch (err) {
    ecrites = await rejouerNotifications(lignes, err);
  }

  // Push (PWA) — best-effort, comme partout ailleurs : un appareil injoignable ne doit pas
  // faire échouer la diffusion aux autres.
  await Promise.all(ids.map((userId) =>
    sendPushToUser(userId, { title, body, url: link }).catch(sansBloquer("recipients.sendDirective.sendPushToUser")),
  ));
  return ecrites;
}

/**
 * PIÈCE JOINTE — la note de service EST souvent le document (un PDF signé, un formulaire).
 * Le fichier se dépose sur la directive elle-même, avec le même mécanisme que partout
 * (`Document` + `entityType`/`entityId`), donc la même route de téléchargement et le même
 * contrôle d'accès. Le stockage peut tomber ; la directive, elle, doit vivre — on garde alors
 * la trace du fichier plutôt que de perdre la note.
 */
export async function attachDirectiveFiles(
  directiveId: string,
  files: File[],
  uploaderId: string,
): Promise<string | null> {
  const maxMb = (await getAppSettings()).maxUploadMb;
  for (const file of files) {
    const invalid = validateUpload(file.name, file.size, maxMb);
    if (invalid) return invalid;
    const key = `DIRECTIVE/${directiveId}/${randomUUID()}__${file.name}`;
    try {
      await saveFile(key, Buffer.from(await file.arrayBuffer()));
    } catch (err) {
      console.error("[directive] storage write failed, recording metadata only", err);
    }
    await prisma.document.create({
      data: {
        name: file.name, category: "OTHER", entityType: "DIRECTIVE", entityId: directiveId,
        fileKey: key, mimeType: file.type || null, sizeBytes: file.size,
        confidentiality: "INTERNAL", uploadedById: uploaderId,
      },
    });
  }
  return null;
}

/** Les pièces d'une directive, dans l'ordre de dépôt — ce que l'écran ouvre à l'arrivée. */
export async function directiveAttachments(directiveId: string) {
  return prisma.document.findMany({
    where: { entityType: "DIRECTIVE", entityId: directiveId },
    select: { id: true, name: true, mimeType: true, sizeBytes: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
}

/**
 * Les entités auxquelles une personne est rattachée — nécessaires pour juger si une note
 * « aux salariés d'Adventum » la concerne. La fiche employé fait foi (voir COMPANY ci-dessus).
 */
export async function companyIdsOf(userId: string): Promise<string[]> {
  const emp = await prisma.employee.findUnique({ where: { userId }, select: { companyId: true } });
  return emp?.companyId ? [emp.companyId] : [];
}

/** La portée d'une directive, telle que le module pur l'attend. */
export function scopeOf(d: {
  audience: DirectiveAudience; targetUserIds: string[]; targetRole: string | null; companyId: string | null;
}): DirectiveScope {
  return { audience: d.audience, targetUserIds: d.targetUserIds, targetRole: d.targetRole, companyId: d.companyId };
}
