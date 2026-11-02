/**
 * Registre des suppressions — les entrées : la conversation, la notification, l'élément du Drive.
 * Un morceau CONTIGU de `DELETE_REGISTRY`, dans l'ordre du registre (`registre.ts` les recompose
 * dans cet ordre : `DELETABLE_KINDS` en dépend).
 */

import type { EntityType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { DeletableKind, KindSpec } from "./types";

export const REGISTRE_MESSAGERIE_DRIVE = {
  /**
   * UN GROUPE ou UN CANAL de la messagerie interne — jamais un tête-à-tête.
   *
   * « Supprimer un groupe » n'existait pas : la messagerie ne savait qu'ARCHIVER, et l'archive
   * laisse la conversation vivante pour ses membres. Le geste passe donc par le patron canonique
   * (instantané → corbeille → restaurable → audité), comme les 26 autres types.
   *
   * CE QUE LA RESTAURATION REND, et c'est la moitié qui compte : la ligne PRINCIPALE seule.
   * `ConversationMember` et `Message` partent en CASCADE et ne sont pas instantanés — restaurer
   * rend donc un groupe VIDE, sans membres ni historique. Le dire est obligatoire : une
   * suppression annoncée réversible qui rend une coquille serait un faux succès (§104.16).
   */
  CONVERSATION: {
    label: "conversation de groupe",
    module: "Messagerie",
    redirect: "/admin/messagerie",
    model: "conversation",
    reserve: "Les membres et l'historique des messages partent en CASCADE et ne sont pas instantanés : une restauration depuis la corbeille rendrait un groupe VIDE. Les fichiers partagés restent dans le Drive de leur auteur.",
    // Pas d'`entityType` : `EntityType` n'a aucune valeur pour une conversation, donc aucun
    // Document ni Commentaire polymorphe n'y est rattaché — rien à instantaner de ce côté.
    searchFields: ["title"],
    async describe(id) {
      const c = await prisma.conversation.findUnique({
        where: { id },
        select: { title: true, type: true, _count: { select: { members: true, messages: true } } },
      });
      if (!c) return null;
      const quoi = c.type === "CHANNEL" ? "Canal" : c.type === "GROUP" ? "Groupe" : "Conversation directe";
      const nom = c.title?.trim() || "sans titre";
      return `${quoi} « ${nom} » — ${c._count.members} membre(s), ${c._count.messages} message(s)`;
    },
    async refuse(id) {
      const c = await prisma.conversation.findUnique({ where: { id }, select: { type: true } });
      if (!c) return null; // l'inexistence se dit « introuvable », pas « refusé ».
      // Un tête-à-tête est l'échange PRIVÉ de deux personnes : le supprimer effacerait leur
      // correspondance pour les deux, sans qu'aucune l'ait demandé. Seuls les groupes et les
      // canaux — des espaces d'équipe — se suppriment ici.
      if (c.type === "DIRECT") {
        return "Une conversation directe (tête-à-tête) ne se supprime pas : c'est l'échange privé de deux personnes. Seuls les groupes et les canaux peuvent être supprimés ; un message précis se retire depuis la conversation.";
      }
      return null;
    },
    async remove(id) {
      // Membres et messages suivent en CASCADE (schéma) ; les pièces jointes du Drive, elles,
      // sont en `SetNull` — un fichier partagé dans le groupe reste dans le Drive de son auteur.
      await prisma.conversation.delete({ where: { id } });
    },
  },

  /**
   * UNE NOTIFICATION REÇUE par une personne — elle cesse de la voir.
   *
   * Rien ne permettait de retirer une notification : on ne savait que la marquer LUE, ce qui la
   * laisse dans la liste. Une notification mal rédigée, envoyée à la mauvaise personne ou dont
   * l'objet a disparu restait donc chez elle pour toujours.
   *
   * La suppression reste réversible : la ligne est petite, autonome (destinataire, type, titre,
   * corps, lien, lu, pop-up, date) et n'a aucun enfant — la corbeille la recrée à l'identique.
   */
  NOTIFICATION: {
    label: "notification",
    module: "Administration",
    redirect: "/admin/messagerie",
    model: "notification",
    searchFields: ["title"],
    async describe(id) {
      const n = await prisma.notification.findUnique({
        where: { id },
        select: { title: true, isRead: true, createdAt: true, user: { select: { name: true } } },
      });
      if (!n) return null;
      return `« ${n.title} » — reçue par ${n.user.name} le ${n.createdAt.toLocaleDateString("fr-FR")} (${n.isRead ? "lue" : "non lue"})`;
    },
    async remove(id) {
      await prisma.notification.delete({ where: { id } });
    },
  },

  /**
   * UN ÉLÉMENT DU DRIVE « SUPPRIMÉ DÉFINITIVEMENT » DEPUIS LA CORBEILLE DU DRIVE (Direction, 10/2026 : « quand je
   * supprime, il doit toujours être récupérable — dans la corbeille du Drive, et, une fois supprimé de celle-ci,
   * par la corbeille du Super Admin »).
   *
   * Un LOT : le fichier (ou le dossier et tout son contenu) part avec ses versions, ses partages, ses commentaires,
   * son index de recherche — et revient avec eux. Les OCTETS ne sont jamais libérés ici : les versions de la ligne
   * de corbeille les tiennent (le ramasse-miettes lit les `blobId` des lignes de corbeille), et seule la
   * destruction réelle (`destroyDeletedRecord`) rend les références. Réservé au Super Admin pour la restauration
   * (aucun module délégué : `MODULE_DU_TYPE` ne le nomme pas).
   */
  DRIVE_NODE: {
    label: "élément du Drive",
    module: "Drive",
    redirect: "/drive",
    model: "driveNode",
    entityType: "DRIVE_NODE",
    searchFields: ["name"],
    lot: true,
    async describe(id) {
      const n = await prisma.driveNode.findUnique({ where: { id }, select: { name: true, type: true } });
      return n ? (n.type === "FOLDER" ? `Dossier « ${n.name} »` : n.name) : null;
    },
    async remove(id) {
      await prisma.driveNode.delete({ where: { id } });
    },
    // RESTAURER, C'EST RETROUVER LE FICHIER DANS LE DRIVE — pas dans la corbeille du Drive où il était au moment
    // de la suppression : le Super Admin le rend à son propriétaire. Même règle que « Restaurer » du Drive : dans
    // son dossier s'il est encore là et hors corbeille, sinon à la racine.
    async restored(id) {
      const ids: string[] = [];
      let frontiere = [id];
      while (frontiere.length) {
        ids.push(...frontiere);
        frontiere = (await prisma.driveNode.findMany({ where: { parentId: { in: frontiere } }, select: { id: true } })).map((c) => c.id);
      }
      await prisma.driveNode.updateMany({ where: { id: { in: ids } }, data: { isTrashed: false } });
      const node = await prisma.driveNode.findUnique({ where: { id }, select: { parentId: true } });
      if (node?.parentId) {
        const parent = await prisma.driveNode.findUnique({ where: { id: node.parentId }, select: { isTrashed: true } });
        if (!parent || parent.isTrashed) await prisma.driveNode.update({ where: { id }, data: { parentId: null } });
      }
    },
  },
} satisfies Partial<Record<DeletableKind, KindSpec>>;
