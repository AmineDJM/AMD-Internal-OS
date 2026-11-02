"use client";

import * as React from "react";
import { MessageSquare } from "lucide-react";
import { CommentThread, type CommentItem } from "@/components/shared/comment-thread";
import { commenterConge } from "@/modules/rh/actions-conges-discussion";
import { updateComment, deleteComment } from "@/lib/actions/comment-actions";
import { cn } from "@/lib/utils";

/**
 * LA DISCUSSION D'UN CONGÉ (Direction, 07/10 : « ajoute une possibilité de discussion dans les congés ») — une bulle avec
 * son compteur sur la ligne du congé, qui déplie le fil sous la ligne. Le même fil partout : la table des RH, les congés
 * à signer du N+1, « Mon dossier RH » du salarié (modèle `Comment`, entité `LEAVE_REQUEST`).
 */
export function BulleDiscussion({ nombre, ouvert, onClick, className }: {
  nombre: number; ouvert: boolean; onClick: () => void; className?: string;
}) {
  return (
    <button
      type="button" onClick={onClick} aria-expanded={ouvert}
      aria-label={nombre > 0 ? `Discussion (${nombre} message${nombre > 1 ? "s" : ""})` : "Discussion"}
      title="Discussion"
      className={cn(
        "inline-flex min-h-9 shrink-0 items-center justify-center gap-1 rounded-md border px-2.5 text-xs font-medium transition-colors sm:min-h-8 sm:px-2",
        ouvert ? "border-primary/40 bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-secondary hover:text-foreground",
        className,
      )}
    >
      <MessageSquare className="h-3.5 w-3.5" />
      {nombre > 0 && <span className="tabular-nums">{nombre}</span>}
    </button>
  );
}

export function FilConge({ leaveId, commentaires, currentUserId, canModerate = false, path }: {
  leaveId: string;
  commentaires: CommentItem[];
  currentUserId?: string;
  canModerate?: boolean;
  /** L'écran à revalider après une modification ou une suppression de message. */
  path: string;
}) {
  return (
    <CommentThread
      comments={commentaires}
      action={commenterConge}
      hiddenFields={{ leaveId }}
      currentUserId={currentUserId}
      canModerate={canModerate}
      updateAction={updateComment}
      deleteAction={deleteComment}
      path={path}
    />
  );
}
