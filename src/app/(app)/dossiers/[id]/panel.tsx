"use client";

import * as React from "react";

import { Loader2, Send, AlertCircle, Play, Pause, CheckCircle2, Archive, Users, Trash2, Pencil, Check, X, Paperclip, AtSign, FileText, Download } from "lucide-react";
import { updateDossierStatus, archiveDossier, postDossierMessage, assignDossier, deleteDossierMessage, editDossierMessage } from "@/lib/actions/dossier-actions";
import { Button } from "@/components/ui/button";
import { Textarea, Select, Label } from "@/components/ui/input";
import { formatBytes } from "../../messages/format";
import { useAction } from "@/components/shared/use-action";

interface UserLite { id: string; name: string }
export interface MsgAttachment { id: string; name: string; mime: string; size: number }

/** Pièces jointes d'un message (images en vignette, autres fichiers en puce téléchargeable). */
function MessageAttachments({ attachments, onDark }: { attachments: MsgAttachment[]; onDark: boolean }) {
  if (attachments.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {attachments.map((a) => a.mime.startsWith("image/") ? (
        <a key={a.id} href={`/api/dossiers/message-attachment/${a.id}`} target="_blank" rel="noopener noreferrer" title={a.name}>
          {/* Aperçu d'une pièce jointe servie par une route API AUTHENTIFIÉE : next/image est
              contre-indiqué (son optimiseur refetche l'URL côté serveur, sans la session). */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`/api/dossiers/message-attachment/${a.id}`} alt={a.name} className="max-h-40 max-w-full rounded-lg border border-black/10 object-cover" />
        </a>
      ) : (
        <a key={a.id} href={`/api/dossiers/message-attachment/${a.id}?dl=1`}
          className={`inline-flex max-w-full items-center gap-1.5 rounded-lg px-2.5 py-2 text-xs sm:max-w-[15rem] sm:py-1.5 ${onDark ? "bg-white/15 hover:bg-white/25" : "border border-border bg-background hover:bg-secondary"}`}>
          <FileText className="h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{a.name}</span>
          <span className="opacity-70">{formatBytes(a.size)}</span>
          <Download className="h-3.5 w-3.5 shrink-0" />
        </a>
      ))}
    </div>
  );
}

/**
 * Bulle d'un message du fil « Suivi & discussion » : affichage, et — pour l'auteur,
 * le responsable/créateur ou le Super Admin/Direction — modification en ligne et
 * suppression.
 */
export function DossierMessageItem({
  id, body, author, createdAt, mine, canManage, attachments = [], mentionNames = [],
}: { id: string; body: string; author: string; createdAt: string; mine: boolean; canManage: boolean; attachments?: MsgAttachment[]; mentionNames?: string[] }) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(body);
  // Les icônes d'un message n'ont pas de place pour parler : un refus part en avis flottant.
  const { busy, run } = useAction({ signalerErreurs: true });

  async function save() {
    if (!draft.trim()) return;
    const fd = new FormData(); fd.set("id", id); fd.set("body", draft);
    await run(() => editDossierMessage(fd), () => setEditing(false));
  }
  async function remove() {
    const fd = new FormData(); fd.set("id", id);
    await run(() => deleteDossierMessage(fd), undefined, { confirmer: "Supprimer ce message ?" });
  }

  return (
    <div className={`group max-w-[88%] rounded-2xl px-3.5 py-2 text-sm sm:max-w-[80%] ${mine ? "bg-primary text-primary-foreground" : "bg-secondary"}`}>
      {editing ? (
        <div className="space-y-1.5">
          <Textarea value={draft} onChange={(e) => setDraft(e.target.value)} disabled={busy}
            className="min-h-[56px] bg-background text-foreground" />
          <div className="flex justify-end gap-1.5">
            <button type="button" onClick={() => { setEditing(false); setDraft(body); }} disabled={busy}
              className="rounded p-2 text-muted-foreground hover:bg-background/40 sm:p-1" title="Annuler" aria-label="Annuler"><X className="h-3.5 w-3.5" /></button>
            <button type="button" onClick={save} disabled={busy || !draft.trim()}
              className="rounded p-2 text-success hover:bg-background/40 sm:p-1" title="Enregistrer" aria-label="Enregistrer">
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
            </button>
          </div>
        </div>
      ) : (
        <>
          {mentionNames.length > 0 && (
            <p className={`mb-1 flex flex-wrap items-center gap-1 text-[0.6875rem] font-medium ${mine ? "text-primary-foreground/90" : "text-primary"}`}>
              {mentionNames.map((n) => <span key={n} className="inline-flex items-center gap-0.5"><AtSign className="h-3 w-3" />{n}</span>)}
            </p>
          )}
          {body && <p className="whitespace-pre-wrap break-words">{body}</p>}
          <MessageAttachments attachments={attachments} onDark={mine} />
        </>
      )}
      <p className={`mt-1 flex flex-wrap items-center gap-1.5 text-[0.6875rem] ${mine ? "text-primary-foreground/70" : "text-muted-foreground"}`}>
        <span>{author} · {createdAt}</span>
        {canManage && !editing && (
          // Au doigt, pas de survol : les actions restent visibles ; à la souris, elles apparaissent au survol.
          <span className="flex items-center gap-1 transition [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-focus-within:opacity-100 [@media(hover:hover)]:group-hover:opacity-100">
            <button type="button" onClick={() => { setDraft(body); setEditing(true); }} title="Modifier" aria-label="Modifier"
              className={`-my-1 rounded p-1.5 sm:my-0 sm:p-0.5 ${mine ? "text-primary-foreground/70 hover:text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>
              <Pencil className="h-3.5 w-3.5" />
            </button>
            <button type="button" onClick={remove} disabled={busy} title="Supprimer" aria-label="Supprimer"
              className={`-my-1 rounded p-1.5 sm:my-0 sm:p-0.5 ${mine ? "text-primary-foreground/70 hover:text-primary-foreground" : "text-muted-foreground hover:text-destructive"}`}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
            </button>
          </span>
        )}
      </p>
    </div>
  );
}


const Err = ({ msg }: { msg: string | null }) =>
  msg ? <div className="flex items-center gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"><AlertCircle className="h-4 w-4 shrink-0" /> {msg}</div> : null;

export function DossierStatusControls({ id, status, canManage }: { id: string; status: string; canManage: boolean }) {
  const { saving, err, run } = useAction();
  if (!canManage) return <p className="text-xs text-muted-foreground">Le créateur ou le responsable pilote l'avancement.</p>;
  const set = (s: string) => { const fd = new FormData(); fd.set("id", id); fd.set("status", s); return updateDossierStatus(fd); };
  const archive = () => { const fd = new FormData(); fd.set("id", id); return archiveDossier(fd); };
  const archived = status === "ARCHIVED";
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {status !== "IN_PROGRESS" && !archived && (
          <Button size="sm" variant="outline" disabled={saving} onClick={() => run(() => set("IN_PROGRESS"))}><Play className="h-4 w-4" /> En cours</Button>
        )}
        {status !== "ON_HOLD" && !archived && (
          <Button size="sm" variant="outline" disabled={saving} onClick={() => run(() => set("ON_HOLD"))}><Pause className="h-4 w-4" /> En attente</Button>
        )}
        {status !== "DONE" && !archived && (
          <Button size="sm" variant="outline" disabled={saving} onClick={() => run(() => set("DONE"))}><CheckCircle2 className="h-4 w-4" /> Abouti</Button>
        )}
        {!archived && (
          <Button size="sm" variant="ghost" disabled={saving} onClick={() => run(archive)}><Archive className="h-4 w-4" /> Archiver</Button>
        )}
        {saving && <Loader2 className="h-4 w-4 animate-spin self-center text-muted-foreground" />}
      </div>
      <Err msg={err} />
    </div>
  );
}

export function DossierAssign({
  id, users, currentAssignee, currentParticipants,
}: {
  id: string;
  users: UserLite[];
  currentAssignee: string | null;
  currentParticipants: string[];
}) {
  const { saving, err, run } = useAction();
  const [parts, setParts] = React.useState<Set<string>>(new Set(currentParticipants));
  const toggle = (uid: string) => setParts((s) => { const n = new Set(s); n.has(uid) ? n.delete(uid) : n.add(uid); return n; });

  return (
    <details className="rounded-lg border border-border">
      <summary className="flex min-h-11 cursor-pointer items-center gap-2 px-3 py-2 text-sm font-medium sm:min-h-0"><Users className="h-4 w-4 text-primary" /> Responsable & participants</summary>
      <form
        action={(fd) => { fd.set("id", id); parts.forEach((p) => fd.append("participantIds", p)); run(() => assignDossier(fd)); }}
        className="space-y-3 border-t border-border p-3"
      >
        <div className="space-y-1">
          <Label htmlFor="assignedToId">Responsable principal</Label>
          <Select id="assignedToId" name="assignedToId" defaultValue={currentAssignee ?? ""}>
            <option value="">— Aucun —</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </Select>
        </div>
        <div className="space-y-1">
          <Label>Participants</Label>
          <div className="max-h-44 space-y-0.5 overflow-y-auto rounded-lg border border-border p-1">
            {users.map((u) => (
              <label key={u.id} className="flex items-center gap-2 rounded-md px-2 py-2 text-sm hover:bg-secondary/50 sm:py-1">
                <input type="checkbox" checked={parts.has(u.id)} onChange={() => toggle(u.id)} className="h-4 w-4 rounded border-input" />
                {u.name}
              </label>
            ))}
          </div>
        </div>
        <Err msg={err} />
        <Button type="submit" size="sm" disabled={saving} className="w-full sm:w-auto">{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Enregistrer</Button>
      </form>
    </details>
  );
}

/**
 * Composeur de chat du fil « Suivi & discussion » : texte + pièces jointes (comme la messagerie)
 * + mentions (@) limitées aux participants du dossier. À l'envoi, tout part dans un seul message.
 */
export function DossierMessageForm({ id, members }: { id: string; members: UserLite[] }) {
  const { saving, err, run } = useAction();
  const [body, setBody] = React.useState("");
  const [files, setFiles] = React.useState<File[]>([]);
  const [mentions, setMentions] = React.useState<Set<string>>(new Set());
  const [pickMentions, setPickMentions] = React.useState(false);
  const fileRef = React.useRef<HTMLInputElement>(null);

  const toggleMention = (uid: string) => setMentions((s) => { const n = new Set(s); n.has(uid) ? n.delete(uid) : n.add(uid); return n; });
  const reset = () => { setBody(""); setFiles([]); setMentions(new Set()); setPickMentions(false); };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!body.trim() && files.length === 0) return;
    const fd = new FormData();
    fd.set("id", id);
    fd.set("body", body);
    files.forEach((f) => fd.append("files", f));
    mentions.forEach((m) => fd.append("mentionIds", m));
    run(() => postDossierMessage(fd), reset);
  };

  const mentionNames = [...mentions].map((mid) => members.find((m) => m.id === mid)?.name).filter(Boolean) as string[];

  return (
    <form onSubmit={submit} className="space-y-2">
      <Textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="Un point d'avancement, une question, un lien… Joignez un fichier ou mentionnez un participant." className="min-h-[70px]" />

      {/* Pièces jointes sélectionnées */}
      {files.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {files.map((f, i) => (
            <span key={i} className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-secondary/50 px-2.5 py-1 text-xs">
              <FileText className="h-3.5 w-3.5 shrink-0" /> <span className="min-w-0 max-w-[10rem] truncate">{f.name}</span>
              <button type="button" onClick={() => setFiles((arr) => arr.filter((_, j) => j !== i))} aria-label={`Retirer ${f.name}`} className="-my-1 -mr-1.5 shrink-0 rounded-full p-1.5 text-muted-foreground hover:text-destructive sm:m-0 sm:p-0"><X className="h-3.5 w-3.5" /></button>
            </span>
          ))}
        </div>
      )}

      {/* Mentions choisies */}
      {mentionNames.length > 0 && (
        <p className="flex flex-wrap items-center gap-1 text-xs text-primary">
          {mentionNames.map((n) => <span key={n} className="inline-flex items-center gap-0.5 rounded-full bg-primary/10 px-2 py-0.5"><AtSign className="h-3 w-3" />{n}</span>)}
        </p>
      )}

      {/* Sélecteur de mentions (participants uniquement) */}
      {pickMentions && (
        members.length === 0 ? (
          <p className="rounded-lg border border-border p-2 text-xs text-muted-foreground">Ajoutez d&apos;abord des participants (panneau « Responsable &amp; participants ») pour pouvoir les mentionner.</p>
        ) : (
          <div className="max-h-40 space-y-0.5 overflow-y-auto rounded-lg border border-border p-1">
            {members.map((m) => (
              <label key={m.id} className="flex items-center gap-2 rounded-md px-2 py-2 text-sm hover:bg-secondary/50 sm:py-1">
                <input type="checkbox" checked={mentions.has(m.id)} onChange={() => toggleMention(m.id)} className="h-4 w-4 rounded border-input" />
                {m.name}
              </label>
            ))}
          </div>
        )
      )}

      <Err msg={err} />

      <div className="flex items-center gap-2">
        <input ref={fileRef} type="file" multiple className="hidden"
          onChange={(e) => { const fs = Array.from(e.target.files ?? []); if (fs.length) setFiles((arr) => [...arr, ...fs]); e.target.value = ""; }} />
        <Button type="button" size="sm" variant="outline" onClick={() => fileRef.current?.click()} title="Joindre un fichier"><Paperclip className="h-4 w-4" /></Button>
        <Button type="button" size="sm" variant={pickMentions ? "secondary" : "outline"} onClick={() => setPickMentions((v) => !v)} title="Mentionner un participant"><AtSign className="h-4 w-4" /></Button>
        <Button type="submit" size="sm" disabled={saving || (!body.trim() && files.length === 0)} className="ml-auto">
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Envoyer
        </Button>
      </div>
    </form>
  );
}
