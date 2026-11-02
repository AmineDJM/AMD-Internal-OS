"use client";

import * as React from "react";
import { Send, Loader2, Pencil, Trash2, Check, X, Paperclip } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { formatDateTime } from "@/lib/utils";
import { DocumentPreview } from "@/components/documents/document-preview";
import { ChoixFichiers } from "@/components/shared/choix-fichiers";
import { messageRecevable } from "@/lib/fil-pieces";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { useConfirmer } from "@/components/ui/dialogue";
import { useRetours } from "@/components/ui/retour";
import { actionFailureMessage } from "@/lib/action-outcome";

export interface CommentItem {
  id: string;
  author: string;
  authorId?: string | null;
  body: string;
  createdAt: string;
  editedAt?: string | null;
  /** Les pièces jointes du message (des `Document` de l'entité, `stepKey` = le message — voir `lib/fil-pieces`). */
  attachments?: { id: string; name: string; hasFile: boolean }[];
}

type ModAction = (formData: FormData) => Promise<{ ok: boolean; error?: string }>;

interface CommentThreadProps {
  comments: CommentItem[];
  action: (formData: FormData) => Promise<{ ok: boolean; error?: string; message?: string }>;
  hiddenFields: Record<string, string>;
  /** Utilisateur courant (pour autoriser l'édition/suppression de ses propres commentaires). */
  currentUserId?: string;
  /** Modérateur (admin / responsable de l'objet) : peut éditer/supprimer n'importe quel commentaire. */
  canModerate?: boolean;
  /** Actions de modération (si non fournies, l'édition/suppression est désactivée). */
  updateAction?: ModAction;
  deleteAction?: ModAction;
  /** Chemin à revalider après modération. */
  path?: string;
  /**
   * Le formulaire accepte des PIÈCES JOINTES (plusieurs) envoyées avec le message, sous le champ `files`.
   * L'action doit les rattacher (fils Ad & Pro : `addAdProComment`). Absent : le fil reste texte seul.
   */
  piecesJointes?: boolean;
}

export function CommentThread({
  comments, action, hiddenFields, currentUserId, canModerate = false, updateAction, deleteAction, path, piecesJointes = false,
}: CommentThreadProps) {
  const { rafraichir } = useRafraichir();
  const confirmer = useConfirmer();
  const retours = useRetours();
  const [pending, setPending] = React.useState(false);
  const [editing, setEditing] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const formRef = React.useRef<HTMLFormElement>(null);
  const [texte, setTexte] = React.useState("");
  const [fichiers, setFichiers] = React.useState<File[]>([]);
  const [retour, setRetour] = React.useState<{ ok: boolean; texte: string } | null>(null);

  const canManage = (c: CommentItem) => Boolean((updateAction || deleteAction) && (canModerate || (c.authorId && c.authorId === currentUserId)));

  async function save(id: string, body: string) {
    if (!updateAction || !body.trim()) { setEditing(null); return; }
    setBusy(id);
    const fd = new FormData(); fd.set("id", id); fd.set("body", body); if (path) fd.set("path", path);
    try {
      const r = await updateAction(fd);
      if (!r.ok) retours.erreur(r.error ?? "Le commentaire n'a pas été modifié.");
    } catch {
      retours.erreur(actionFailureMessage("THROWN"));
    } finally {
      setBusy(null);
    }
    setEditing(null); rafraichir();
  }
  async function remove(id: string, nbPieces: number) {
    // SUPPRIMER UN MESSAGE EMPORTE SES PIÈCES : la question le dit, rien ne disparaît en silence.
    const question = nbPieces > 0
      ? `Supprimer ce commentaire et ${nbPieces > 1 ? `ses ${nbPieces} pièces jointes` : "sa pièce jointe"} ?`
      : "Supprimer ce commentaire ?";
    if (!deleteAction || !(await confirmer(question))) return;
    setBusy(id);
    const fd = new FormData(); fd.set("id", id); if (path) fd.set("path", path);
    try {
      const r = await deleteAction(fd);
      if (!r.ok) retours.erreur(r.error ?? "Le commentaire n'a pas été supprimé.");
    } catch {
      retours.erreur(actionFailureMessage("THROWN"));
    } finally {
      setBusy(null);
    }
    rafraichir();
  }

  async function publier(fd: FormData) {
    if (!messageRecevable(texte, fichiers.length)) return;
    setPending(true);
    setRetour(null);
    for (const f of fichiers) fd.append("files", f);
    let r: { ok: boolean; error?: string; message?: string };
    try {
      r = await action(fd);
    } catch {
      setRetour({ ok: false, texte: actionFailureMessage("THROWN") });
      return;
    } finally {
      setPending(false);
    }
    // UN REFUS GARDE LA SAISIE : le texte et les fichiers choisis restent, la phrase du serveur s'affiche.
    if (!r.ok) { setRetour({ ok: false, texte: r.error ?? "Le message n'a pas pu être publié." }); return; }
    if (r.message) setRetour({ ok: true, texte: r.message });
    const avecPieces = fichiers.length > 0;
    formRef.current?.reset();
    setTexte("");
    setFichiers([]);
    if (avecPieces) rafraichir();
  }

  return (
    <div className="space-y-4">
      <ul className="space-y-3">
        {comments.length === 0 && <p className="text-sm text-muted-foreground">Aucun commentaire pour le moment.</p>}
        {comments.map((c) => (
          <li key={c.id} className="group flex gap-2.5">
            <Avatar name={c.author} size="sm" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-sm font-medium">{c.author}</span>
                <span className="text-xs text-muted-foreground">{formatDateTime(c.createdAt)}</span>
                {c.editedAt && <span className="text-[0.6875rem] italic text-muted-foreground">(modifié)</span>}
                {canManage(c) && editing !== c.id && (
                  <span className="ml-auto flex shrink-0 items-center gap-0.5 transition sm:opacity-0 sm:focus-within:opacity-100 sm:group-hover:opacity-100">
                    {updateAction && (
                      <button type="button" onClick={() => setEditing(c.id)} title="Modifier" aria-label="Modifier le commentaire" className="rounded p-2 text-muted-foreground hover:bg-secondary hover:text-foreground sm:p-1">
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                    )}
                    {deleteAction && (
                      <button type="button" onClick={() => remove(c.id, c.attachments?.length ?? 0)} disabled={busy === c.id} title="Supprimer" aria-label="Supprimer le commentaire" className="rounded p-2 text-muted-foreground hover:bg-destructive/10 hover:text-destructive sm:p-1">
                        {busy === c.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                      </button>
                    )}
                  </span>
                )}
              </div>
              {editing === c.id ? (
                <EditRow initial={c.body} busy={busy === c.id} onCancel={() => setEditing(null)} onSave={(v) => save(c.id, v)} />
              ) : c.body ? (
                <p className="whitespace-pre-wrap break-words text-sm text-foreground/90">{c.body}</p>
              ) : null}
              {/* LES PIÈCES DU MESSAGE, sous lui : un clic ouvre l'aperçu (même porte que le fil — celle du dossier). */}
              {c.attachments && c.attachments.length > 0 && (
                <ul className="mt-1.5 flex flex-col gap-1" aria-label="Pièces jointes du message">
                  {c.attachments.map((a) => (
                    <li key={a.id} className="flex min-w-0 items-center gap-1.5 text-xs">
                      <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <DocumentPreview id={a.id} name={a.name} hasFile={a.hasFile} />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </li>
        ))}
      </ul>

      <form ref={formRef} action={publier} className="space-y-2">
        <div className="flex items-end gap-2">
          {Object.entries(hiddenFields).map(([k, v]) => (
            <input key={k} type="hidden" name={k} value={v} />
          ))}
          <Textarea
            name="body" required={!piecesJointes || fichiers.length === 0} value={texte} onChange={(e) => setTexte(e.target.value)}
            placeholder="Ajouter un commentaire…" className="min-h-[40px] flex-1"
          />
          <Button type="submit" size="icon" disabled={pending} aria-label="Publier le commentaire">
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </Button>
        </div>
        {piecesJointes && (
          <ChoixFichiers fichiers={fichiers} onChange={setFichiers} disabled={pending} libelle="Joindre des fichiers" ariaLabel="Pièces jointes du message" />
        )}
        {retour && (
          <p className={`text-xs ${retour.ok ? "text-warning" : "text-destructive"}`} role="status">{retour.texte}</p>
        )}
      </form>
    </div>
  );
}

function EditRow({ initial, busy, onSave, onCancel }: { initial: string; busy: boolean; onSave: (v: string) => void; onCancel: () => void }) {
  const [value, setValue] = React.useState(initial);
  return (
    <div className="mt-1 space-y-1.5">
      <Textarea value={value} onChange={(e) => setValue(e.target.value)} className="min-h-[40px]" autoFocus />
      <div className="flex flex-wrap gap-1.5">
        <Button type="button" size="sm" onClick={() => onSave(value)} disabled={busy || !value.trim()}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} Enregistrer
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onCancel} disabled={busy}><X className="h-3.5 w-3.5" /> Annuler</Button>
      </div>
    </div>
  );
}
