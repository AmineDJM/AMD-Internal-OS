import type { EntityType } from "@prisma/client";
import { ChevronDown } from "lucide-react";
import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/lib/rbac";
import { canModerateEntity } from "@/lib/entity-access";
import { entityHref } from "@/lib/entity-href";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CommentThread } from "@/components/shared/comment-thread";
import { DISCUSSION_TITRE } from "../domaine/discussion";
import { PREFIXE_PIECE_MESSAGE, piecesParMessage } from "@/lib/fil-pieces";
import { addAdProComment } from "../actions-discussion";
import { updateComment, deleteComment } from "@/lib/actions/comment-actions";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA SECTION DISCUSSION — UN composant serveur, monté sur les SEPT natures du pôle.
 *
 * Sept blocs recopiés auraient divergé sur le titre, la phrase d'aide, la porte de modération ou
 * la liste chargée — et le premier correctif n'aurait touché qu'un écran (§118.5). D'où un
 * composant SERVEUR qui charge le fil et compose le bloc : l'écran n'écrit qu'une ligne.
 *
 * ── CE QU'IL NE FAIT PAS ────────────────────────────────────────────────────────────────
 *
 * Il ne garde RIEN : l'écran qui le monte a déjà refusé qui ne peut pas lire la fiche
 * (`notFound()` sur sa propre porte), et l'ACTION revérifie par enregistrement — c'est elle qui
 * fait foi, parce qu'un composant ne protège que l'affichage. Le poser sans sa porte d'écran
 * serait une seconde vérité en retard (§118.74).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export async function AdProDiscussionCard({
  entityType, entityId, user, replie = false,
}: {
  entityType: EntityType;
  entityId: string;
  user: SessionUser & { id: string };
  /** Repliée sous « Discussion · n » (fiche du matériel promotionnel, maquette validée 10/2026) — le fil s'ouvre d'un clic. */
  replie?: boolean;
}) {
  const [rows, pieces] = await Promise.all([
    prisma.comment.findMany({
      where: { entityType, entityId },
      select: { id: true, body: true, createdAt: true, editedAt: true, authorId: true, author: { select: { name: true } } },
      orderBy: { createdAt: "asc" },
    }),
    // LES PIÈCES JOINTES DES MESSAGES — des pièces du dossier désignées par leur message (`lib/fil-pieces`).
    prisma.document.findMany({
      where: { entityType, entityId, stepKey: { startsWith: PREFIXE_PIECE_MESSAGE } },
      select: { id: true, name: true, fileKey: true, stepKey: true },
      orderBy: { createdAt: "asc" },
    }),
  ]);
  const piecesDe = piecesParMessage(pieces);

  // LE MÊME FAIT QUE L'ACTION, jamais un second : `canModerateEntity` est exactement ce que
  // `updateComment` / `deleteComment` vérifient. Un prédicat à part ici afficherait un bouton
  // que l'action refuse (§118.5).
  const canModerate = await canModerateEntity(user, entityType, entityId);

  const fil = (
    <CommentThread
      comments={rows.map((c) => ({
        id: c.id,
        author: c.author?.name ?? "—",
        authorId: c.authorId,
        body: c.body,
        createdAt: c.createdAt.toISOString(),
        editedAt: c.editedAt?.toISOString() ?? null,
        attachments: (piecesDe.get(c.id) ?? []).map((d) => ({ id: d.id, name: d.name, hasFile: Boolean(d.fileKey) })),
      }))}
      action={addAdProComment}
      // DES PIÈCES JOINTES SUR TOUS LES FILS DU PÔLE (Direction, 10/2026) — un seul composant, un seul écrivain.
      piecesJointes
      hiddenFields={{ entityType, entityId }}
      currentUserId={user.id}
      canModerate={canModerate}
      updateAction={updateComment}
      deleteAction={deleteComment}
      // LE CHEMIN VOYAGE : les actions canoniques revalident ce que le composant leur donne,
      // et l'adresse d'une entité se lit UNE fois (`entityHref`) — la recopier par nature
      // ferait sept chemins qui divergent au premier renommage de route.
      path={entityHref(entityType, entityId) ?? undefined}
    />
  );
  if (replie) {
    return (
      <details className="surface group">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-4 py-3 text-[0.9375rem] font-semibold [&::-webkit-details-marker]:hidden">
          <span>{DISCUSSION_TITRE} <span className="font-normal text-muted-foreground">· {rows.length}</span></span>
          <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-180" aria-hidden />
        </summary>
        <div className="border-t border-border px-4 py-3">{fil}</div>
      </details>
    );
  }

  return (
    <Card>
      {/* PLUS DE PARAGRAPHE D'AIDE NI DE PHRASE « AUCUN ÉCHANGE » (Direction, 07/10) : le titre et le fil suffisent. */}
      <CardHeader>
        <CardTitle>{DISCUSSION_TITRE}</CardTitle>
      </CardHeader>
      <CardContent>{fil}</CardContent>
    </Card>
  );
}
