"use client";

import * as React from "react";
import { Paperclip, MessageSquare, ChevronDown, ChevronRight } from "lucide-react";
import { DocumentUpload } from "@/components/documents/document-upload";
import { DocumentList, type DocItem } from "@/components/documents/document-list";
import { CommentThread, type CommentItem } from "@/components/shared/comment-thread";
import { addHrRequestComment } from "@/modules/rh/actions-documents";
import { updateComment, deleteComment } from "@/lib/actions/comment-actions";

/**
 * Pièces jointes + fil d'échange d'une demande RH, partagé entre « Mon dossier RH »
 * (le demandeur) et la vue RH (le responsable). Repliable pour ne pas alourdir la liste.
 */
export function HrRequestThread({
  requestId, documents, comments, canManage, currentUserId, path = "/mon-dossier",
}: {
  requestId: string;
  documents: DocItem[];
  comments: CommentItem[];
  canManage: boolean;
  currentUserId: string;
  path?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const total = documents.length + comments.length;

  return (
    <div className="mt-1 w-full">
      <button onClick={() => setOpen((v) => !v)} className="inline-flex flex-wrap items-center gap-1.5 py-1.5 text-left text-xs font-medium text-muted-foreground hover:text-foreground sm:py-0">
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        <Paperclip className="h-3.5 w-3.5" /> {documents.length}
        <MessageSquare className="h-3.5 w-3.5" /> {comments.length}
        <span>Pièces &amp; échanges{total > 0 ? "" : " — joindre / répondre"}</span>
      </button>

      {open && (
        <div className="mt-2 space-y-3 rounded-lg border border-border bg-muted/20 p-3">
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">Pièces jointes</p>
            <DocumentUpload entityType="HR_REQUEST" entityId={requestId} categories={["SUPPORTING_DOC", "ID_DOCUMENT", "OTHER"]} compact />
            <DocumentList documents={documents} canDelete path={path} />
          </div>
          <div className="border-t border-border pt-2">
            <p className="mb-1.5 text-xs font-medium text-muted-foreground">Échanges</p>
            <CommentThread
              comments={comments}
              action={addHrRequestComment}
              hiddenFields={{ requestId }}
              currentUserId={currentUserId}
              canModerate={canManage}
              updateAction={updateComment}
              deleteAction={deleteComment}
              path={path}
            />
          </div>
        </div>
      )}
    </div>
  );
}
