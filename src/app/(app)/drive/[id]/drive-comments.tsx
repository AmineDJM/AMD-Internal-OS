"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, Send, Trash2, MessageSquare } from "lucide-react";
import { postDriveComment, deleteDriveComment } from "@/lib/actions/drive-comment-actions";

export interface DriveCommentItem {
  id: string;
  author: string;
  body: string;
  createdLabel: string;
  canDelete: boolean;
}

/** Fil de commentaires d'un document du Drive — chaque document a le sien. */
export function DriveComments({ nodeId, comments, onChanged }: { nodeId: string; comments: DriveCommentItem[]; /** Relire le fil après un ajout / une suppression (panneau embarqué). */ onChanged?: () => void }) {
  const router = useRouter();
  const [sending, setSending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const formRef = React.useRef<HTMLFormElement>(null);

  return (
    <div className="space-y-3">
      {comments.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <MessageSquare className="h-4 w-4" /> Aucun commentaire. Ajoutez-en un (ex. motif d&apos;une modification).
        </p>
      ) : (
        <ul className="space-y-2.5">
          {comments.map((c) => (
            <li key={c.id} className="rounded-lg border border-border bg-secondary/30 p-2.5">
              <div className="flex flex-wrap items-center justify-between gap-x-2">
                <span className="min-w-0 truncate text-xs font-medium">{c.author}</span>
                <span className="flex items-center gap-2">
                  <span className="text-[0.6875rem] text-muted-foreground">{c.createdLabel}</span>
                  {c.canDelete && (
                    <form
                      action={async (fd) => { await deleteDriveComment(fd); onChanged?.(); router.refresh(); }}
                      className="inline"
                    >
                      <input type="hidden" name="id" value={c.id} />
                      <button type="submit" title="Supprimer" aria-label="Supprimer" className="inline-flex h-9 w-9 items-center justify-center text-muted-foreground hover:text-destructive sm:h-auto sm:w-auto">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </form>
                  )}
                </span>
              </div>
              <p className="mt-1 whitespace-pre-wrap break-words text-sm [overflow-wrap:anywhere]">{c.body}</p>
            </li>
          ))}
        </ul>
      )}

      <form
        ref={formRef}
        action={async (fd) => {
          setSending(true); setError(null);
          const res = await postDriveComment(fd);
          setSending(false);
          if (res.ok) { formRef.current?.reset(); onChanged?.(); router.refresh(); }
          else setError(res.error ?? "Envoi impossible.");
        }}
        className="space-y-2 border-t border-border pt-3"
      >
        <input type="hidden" name="nodeId" value={nodeId} />
        <textarea
          name="body"
          required
          rows={2}
          placeholder="Écrire un commentaire…"
          className="w-full resize-y rounded-lg border border-input bg-background px-3 py-2 text-base focus:outline-none focus:ring-2 focus:ring-ring sm:text-sm"
        />
        {error && <p className="text-xs text-destructive">{error}</p>}
        <div className="flex justify-end">
          <button
            type="submit"
            disabled={sending}
            className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm sm:w-auto sm:py-1.5 font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
          >
            {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Commenter
          </button>
        </div>
      </form>
    </div>
  );
}
