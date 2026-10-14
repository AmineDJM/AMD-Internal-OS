"use client";

import * as React from "react";
import { CommentThread, type CommentItem } from "@/components/shared/comment-thread";
import { addRequestComment } from "@/lib/actions/admin-request-actions";
import { updateComment, deleteComment } from "@/lib/actions/comment-actions";
import type { EntreeHistorique } from "@/lib/secretariat/fil-demande";
import { cn, formatDateTime } from "@/lib/utils";

/**
 * DISCUSSION / HISTORIQUE — deux onglets, deux natures (maquette validée, 10/2026). La discussion ne
 * garde que ce que les personnes se sont écrit ; l'historique, ce que le système a noté (les traces
 * déposées au fil, et le journal de la demande et de ses pièces), dans l'ordre du temps. La règle
 * de partage est `separerLeFil` (`secretariat/fil-demande.ts`).
 */
export function FilDemande({ requestId, discussion, historique, currentUserId, canModerate }: {
  requestId: string;
  discussion: CommentItem[];
  historique: EntreeHistorique[];
  currentUserId: string;
  canModerate: boolean;
}) {
  const [onglet, setOnglet] = React.useState<"disc" | "hist">("disc");
  const tab = (cle: "disc" | "hist", libelle: string, n: number) => (
    <button
      type="button" role="tab" aria-selected={onglet === cle} onClick={() => setOnglet(cle)}
      className={cn("-mb-px border-b-2 px-1.5 py-2.5 text-sm font-semibold", onglet === cle ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground")}
    >
      {libelle} <span className="font-normal text-muted-foreground">({n})</span>
    </button>
  );
  return (
    <section className="surface rounded-xl">
      <div role="tablist" className="flex gap-4 border-b border-border px-4">
        {tab("disc", "Discussion", discussion.length)}
        {tab("hist", "Historique", historique.length)}
      </div>
      <div className="p-4">
        {onglet === "disc" ? (
          <CommentThread comments={discussion} action={addRequestComment} hiddenFields={{ requestId }} currentUserId={currentUserId} canModerate={canModerate} updateAction={updateComment} deleteAction={deleteComment} path={`/demandes/${requestId}`} />
        ) : historique.length === 0 ? (
          <p className="text-sm text-muted-foreground">Rien n&apos;est encore noté.</p>
        ) : (
          <ol className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
            {historique.map((h) => (
              <li key={h.id} className="contents">
                <span className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">{formatDateTime(h.le)}</span>
                <span className="min-w-0 break-words">{h.texte}{h.par && <span className="text-muted-foreground"> — {h.par}</span>}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
