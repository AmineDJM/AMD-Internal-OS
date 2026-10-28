"use client";

import * as React from "react";
import { Paperclip, Download, Trash2, Loader2 } from "lucide-react";
import { removeFeedbackAttachment } from "@/lib/actions/feedback-actions";
import { useKeyedAction } from "@/components/shared/use-action";
import { Retour } from "@/components/ui/retour";

/**
 * LES PIÈCES D'UN RETOUR — visibles, ouvrables, retirables.
 *
 * Une pièce jointe qu'on ne peut pas rouvrir ne sert à rien : c'est ce qui distingue un vrai
 * dépôt d'un champ de formulaire décoratif. Chaque ligne mène au fichier RÉEL, servi par
 * `/api/feedback/attachment/[id]` — qui revérifie le droit d'accès à chaque requête plutôt que
 * de faire confiance au fait que le lien a été affiché.
 *
 * La suppression demande confirmation : une pièce retirée l'est pour de bon (le contenu n'est
 * conservé que s'il sert ailleurs, par son compteur de références).
 */

export interface FeedbackAttachmentRow {
  id: string;
  name: string;
  mime: string;
  size: number;
  /** Le retrait n'est proposé qu'à qui en a le droit — la règle est tranchée côté serveur. */
  canRemove: boolean;
}

/** Une taille lisible : « 2,4 Mo » plutôt que « 2517195 ». */
function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(".", ",")} Mo`;
}

export function FeedbackAttachments({ items }: { items: FeedbackAttachmentRow[] }) {
  const { busy, error, run } = useKeyedAction();

  if (items.length === 0) return null;

  const remove = async (id: string, name: string) => {
    const fd = new FormData();
    fd.set("id", id);
    await run(id, async () => {
      const r = await removeFeedbackAttachment(fd);
      return r.ok ? r : { ...r, error: r.error ?? "Le retrait a échoué." };
    }, { confirmer: `Retirer « ${name} » de ce retour ?` });
  };

  return (
    <div className="space-y-1.5">
      <ul className="flex flex-wrap gap-1.5">
        {items.map((a) => (
          <li
            key={a.id}
            className="inline-flex max-w-full items-center gap-2 rounded-md border border-border bg-secondary/40 px-2 py-1.5 text-xs sm:gap-1.5 sm:py-1"
          >
            <Paperclip className="h-3 w-3 shrink-0 text-muted-foreground" />
            {/* Ouvre le fichier réel. `target=_blank` + `rel=noopener` : la page servie ne doit
                jamais pouvoir manipuler l'onglet de l'ERP. */}
            <a
              href={`/api/feedback/attachment/${a.id}`}
              target="_blank"
              rel="noopener noreferrer"
              className="min-w-0 truncate font-medium hover:underline"
              title={`${a.name} — ${humanSize(a.size)}`}
            >
              {a.name}
            </a>
            <span className="shrink-0 text-muted-foreground">{humanSize(a.size)}</span>
            <a
              href={`/api/feedback/attachment/${a.id}?dl=1`}
              className="-m-1.5 shrink-0 p-1.5 text-muted-foreground hover:text-foreground sm:m-0 sm:p-0"
              aria-label={`Télécharger ${a.name}`}
            >
              <Download className="h-3 w-3" />
            </a>
            {a.canRemove && (
              <button
                type="button"
                onClick={() => void remove(a.id, a.name)}
                disabled={busy === a.id}
                className="-m-1.5 shrink-0 p-1.5 text-muted-foreground hover:text-destructive disabled:opacity-50 sm:m-0 sm:p-0"
                aria-label={`Retirer ${a.name}`}
              >
                {busy === a.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
              </button>
            )}
          </li>
        ))}
      </ul>
      <Retour ton="erreur">{error}</Retour>
    </div>
  );
}
