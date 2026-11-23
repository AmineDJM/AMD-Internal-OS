"use client";

import { CommentThread } from "@/components/shared/comment-thread";
import { SectionRepliable } from "@/components/shared/section-repliable";
import { updateComment, deleteComment } from "@/lib/actions/comment-actions";
import { addAdProComment } from "../../actions-discussion";
import type { ItemRow } from "../items-panel";

/**
 * LA DISCUSSION D'UN POSTE (Direction, 23/11/2026) — repliée sous « Discussion (n) » au pied de la carte : messages et
 * fichiers, que lisent et où écrivent tous ceux qui ouvrent la demande (et l'assistante qui prospecte le poste).
 *
 * Le fil canonique, sans second mécanisme : `CommentThread` (pièces jointes, édition, suppression), l'écrivain unique des
 * fils Ad & Pro (`addAdProComment`, entité `AD_PRO_ITEM` — porte du poste, notification des participants) et les actions
 * canoniques de modération (`comment-actions`, qui revalident le chemin donné).
 */
export function DiscussionDuPoste({ item, moiId, modere = false, chemin, dense = true }: {
  item: ItemRow;
  moiId?: string;
  /** La personne modère le fil (le message d'un autre) — calculé au serveur, la porte même des actions. */
  modere?: boolean;
  /** La fiche de la demande — ce que l'édition et la suppression revalident. */
  chemin: string;
  dense?: boolean;
}) {
  const messages = item.discussion ?? [];
  return (
    <SectionRepliable dense={dense} sansCadre titre="Discussion" compte={messages.length} id={`discussion-${item.id}`}>
      <CommentThread
        comments={messages}
        action={addAdProComment}
        piecesJointes
        hiddenFields={{ entityType: "AD_PRO_ITEM", entityId: item.id }}
        currentUserId={moiId}
        canModerate={modere}
        updateAction={updateComment}
        deleteAction={deleteComment}
        path={chemin}
      />
    </SectionRepliable>
  );
}
