"use client";

import * as React from "react";
import {
  RefreshCw, Search, Send, Reply, ReplyAll, Forward, Trash2, Archive, MailOpen, Mail as MailIcon,
  Paperclip, X, Loader2, Printer, ChevronLeft, Plus, HardDriveDownload, Link2,
} from "lucide-react";
import { Icon } from "@/components/ui/icon";
import { actionFailureMessage } from "@/lib/action-outcome";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { folderLabel, folderBadge, FOLDER_ICON, defaultFolderId } from "@/lib/mail/folders";
import { buildReplyDraft, formatAddress, type ReplyMode } from "@/lib/mail/reply";
import type { MailFolder, MailSummary, MailMessage } from "@/lib/mail/provider";
import {
  sendMessage, setMessageRead, moveMessage, deleteMessage, saveAttachmentToDrive,
} from "@/lib/actions/microsoft-mail-actions";
import { sansBloquer } from "@/lib/journal";

/**
 * LA MESSAGERIE — trois volets, comme toutes les messageries du monde.
 *
 * Dossiers · liste · lecture. On ne réinvente rien : quiconque a déjà utilisé Outlook ou Gmail
 * sait où regarder, et une disposition originale coûterait à chacun, tous les jours, le prix de
 * l'apprentissage d'une interface qu'il ne demandait pas.
 *
 * Sur MOBILE, les trois volets deviennent trois écrans successifs — afficher une liste de messages
 * dans une colonne de 120 px n'aide personne. La flèche « retour » remplace le volet de gauche.
 *
 * Les pièces jointes : le geste mis en avant est **« Enregistrer dans le Drive »**, pas
 * « Télécharger ». Un fichier qui part sur un poste sort de l'ERP — plus de droits, plus d'audit,
 * plus de version. Le téléchargement reste possible, en second.
 */

interface Props {
  address: string;
  signature: string;
}

type Pane = "folders" | "list" | "read";

/** L'heure pour un message du jour, la date sinon — « 23/08 » sur un message d'il y a dix minutes ne dit rien. */
function listStamp(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.getDate() === now.getDate() && d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  return sameDay
    ? d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" });
}

export function MailWorkspace({ address, signature }: Props) {
  const [folders, setFolders] = React.useState<MailFolder[]>([]);
  const [folderId, setFolderId] = React.useState<string | null>(null);
  const [items, setItems] = React.useState<MailSummary[]>([]);
  const [cursor, setCursor] = React.useState<string | null>(null);
  const [openMsg, setOpenMsg] = React.useState<MailMessage | null>(null);
  const [query, setQuery] = React.useState("");
  const [pane, setPane] = React.useState<Pane>("list");
  const [busy, setBusy] = React.useState(false);
  const [loadingList, setLoadingList] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  // Ce que Microsoft a réellement confirmé — voir le message affiché plus bas : « accepté » n'est
  // pas « remis », et c'est exactement la distinction qui manquait quand un envoi disparaissait.
  const [notice, setNotice] = React.useState<string | null>(null);
  const [compose, setCompose] = React.useState<null | { mode: "new" | ReplyMode; draft: ReturnType<typeof buildReplyDraft> | null }>(null);

  const call = React.useCallback(async (params: Record<string, string>) => {
    const qs = new URLSearchParams(params).toString();
    const res = await fetch(`/api/mail/ms/data?${qs}`);
    const json = (await res.json().catch(sansBloquer("mail-workspace.MailWorkspace.json", {}))) as Record<string, unknown>;
    if (!res.ok) throw new Error(String(json.error ?? "La messagerie n'a pas pu répondre."));
    return json;
  }, []);

  const loadFolders = React.useCallback(async () => {
    try {
      const j = await call({ view: "folders" });
      const list = (j.folders ?? []) as MailFolder[];
      setFolders(list);
      setFolderId((cur) => cur ?? defaultFolderId(list));
    } catch (e) { setErr(e instanceof Error ? e.message : "Erreur."); }
  }, [call]);

  const loadList = React.useCallback(async (fid: string, q: string, more = false) => {
    setLoadingList(true);
    try {
      const j = await call({
        view: "messages", folder: fid,
        ...(q ? { q } : {}),
        ...(more && cursor ? { cursor } : {}),
      });
      const page = (j.items ?? []) as MailSummary[];
      setItems((cur) => (more ? [...cur, ...page] : page));
      setCursor((j.nextCursor as string | null) ?? null);
      setErr(null);
    } catch (e) { setErr(e instanceof Error ? e.message : "Erreur."); }
    finally { setLoadingList(false); }
  }, [call, cursor]);

  React.useEffect(() => { void loadFolders(); }, [loadFolders]);
  // Recharger UNIQUEMENT au changement de dossier — pas à chaque frappe (query a son bouton de
  // recherche) ni à chaque page chargée (loadList change avec le curseur de pagination).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  React.useEffect(() => { if (folderId) void loadList(folderId, query.trim()); }, [folderId]);

  const open = async (s: MailSummary) => {
    setPane("read");
    setOpenMsg(null);
    setNotice(null);
    try {
      const j = await call({ view: "message", id: s.id });
      const m = j.message as MailMessage;
      setOpenMsg(m);
      // Marquer lu à l'ouverture, comme partout — et mettre à jour la liste sans la recharger,
      // pour que le compteur ne clignote pas.
      if (!s.isRead) {
        void setMessageRead(s.id, true);
        setItems((cur) => cur.map((x) => (x.id === s.id ? { ...x, isRead: true } : x)));
      }
    } catch (e) { setErr(e instanceof Error ? e.message : "Erreur."); }
  };

  const act = async (fn: () => Promise<{ ok: boolean; error?: string }>, removeId?: string) => {
    setBusy(true);
    let r: { ok: boolean; error?: string };
    try {
      r = await fn();
    } catch {
      setErr(actionFailureMessage("THROWN"));
      return;
    } finally {
      setBusy(false);
    }
    if (!r.ok) { setErr(r.error ?? "L'action sur le message n'a pas abouti."); return; }
    if (removeId) {
      setItems((cur) => cur.filter((x) => x.id !== removeId));
      setOpenMsg(null);
      setPane("list");
    }
    void loadFolders();
  };

  const folderByKind = (k: string) => folders.find((f) => f.wellKnown === k)?.id;

  // Dans Envoyés et Brouillons, la colonne « expéditeur » afficherait VOTRE nom sur chaque ligne —
  // c'est le destinataire qui distingue les messages là-bas, comme dans tout client mail.
  const currentFolder = folders.find((f) => f.id === folderId);
  const showRecipients = currentFolder?.wellKnown === "sent" || currentFolder?.wellKnown === "drafts";

  const startReply = (mode: ReplyMode) => {
    if (!openMsg) return;
    setCompose({ mode, draft: buildReplyDraft(openMsg, mode, address, signature) });
  };

  return (
    // Au téléphone et sur tablette, un seul volet à la fois, à la hauteur de son contenu (la page défile) ;
    // les trois volets à hauteur fixe ne reviennent qu'à partir de `lg`.
    <div className="flex flex-col gap-3 lg:h-[calc(100dvh-9rem)] lg:flex-row">
      {/* ── Volet 1 : dossiers ── */}
      <nav className={`surface w-full shrink-0 overflow-y-auto p-2 lg:block lg:w-56 ${pane === "folders" ? "block" : "hidden lg:block"}`}>
        <Button className="mb-2 w-full" onClick={() => setCompose({ mode: "new", draft: null })}>
          <Plus className="h-4 w-4" /> Nouveau message
        </Button>
        <ul className="space-y-0.5">
          {folders.map((f) => {
            const n = folderBadge(f);
            const active = f.id === folderId;
            return (
              <li key={f.id}>
                <button
                  type="button"
                  onClick={() => { setFolderId(f.id); setPane("list"); setOpenMsg(null); setCursor(null); setNotice(null); }}
                  className={`flex w-full items-center gap-2 rounded-lg px-2 py-2.5 text-sm transition-colors lg:py-2 ${
                    active ? "bg-primary/10 font-medium text-primary" : "text-foreground hover:bg-secondary"
                  }`}
                >
                  <Icon name={f.wellKnown ? FOLDER_ICON[f.wellKnown] : "Folder"} className="h-4 w-4 shrink-0 opacity-80" />
                  <span className="min-w-0 flex-1 truncate text-left">{folderLabel(f)}</span>
                  {n > 0 && <span className="shrink-0 rounded-full bg-secondary px-1.5 text-[0.6875rem] font-semibold">{n}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* ── Volet 2 : liste ── */}
      <section className={`surface flex min-w-0 flex-col lg:flex lg:w-96 ${pane === "list" ? "flex" : "hidden lg:flex"}`}>
        <div className="sticky top-0 z-10 flex items-center gap-2 rounded-t-[var(--radius)] border-b border-border bg-card p-2 lg:static">
          <button type="button" onClick={() => setPane("folders")} className="shrink-0 rounded-lg p-2 text-muted-foreground hover:bg-secondary lg:hidden" aria-label="Dossiers">
            <ChevronLeft className="h-5 w-5" />
          </button>
          <div className="relative min-w-0 flex-1">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query} onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && folderId) { setCursor(null); void loadList(folderId, query.trim()); } }}
              placeholder="Rechercher…" className="pl-8 text-base lg:text-sm"
              type="search" enterKeyHint="search"
            />
          </div>
          <button
            type="button" onClick={() => { if (folderId) { setCursor(null); void loadList(folderId, query.trim()); } void loadFolders(); }}
            className="shrink-0 rounded-lg p-2.5 text-muted-foreground hover:bg-secondary lg:p-2" aria-label="Actualiser"
          >
            <RefreshCw className={`h-4 w-4 ${loadingList ? "animate-spin" : ""}`} />
          </button>
        </div>

        <ul className="min-h-0 flex-1 divide-y divide-border overflow-y-auto">
          {items.length === 0 && !loadingList && (
            <li className="p-6 text-center text-sm text-muted-foreground">Aucun message.</li>
          )}
          {items.map((m) => (
            <li key={m.id}>
              <button
                type="button" onClick={() => void open(m)}
                className={`w-full px-3 py-2.5 text-left transition-colors hover:bg-secondary/60 ${openMsg?.id === m.id ? "bg-accent/40" : ""}`}
              >
                <div className="flex items-baseline gap-2">
                  <span className={`min-w-0 flex-1 truncate text-sm ${m.isRead ? "text-muted-foreground" : "font-semibold"}`}>
                    {showRecipients
                      ? `À : ${m.to.map((a) => a.name ?? a.address).join(", ") || "(sans destinataire)"}`
                      : m.from?.name ?? m.from?.address ?? "(inconnu)"}
                  </span>
                  {m.hasAttachments && <Paperclip className="h-3 w-3 shrink-0 text-muted-foreground" />}
                  <span className="shrink-0 text-[0.6875rem] tabular-nums text-muted-foreground">{listStamp(m.receivedAt)}</span>
                </div>
                <p className={`truncate text-sm ${m.isRead ? "" : "font-medium"}`}>{m.subject}</p>
                <p className="truncate text-xs text-muted-foreground">{m.preview}</p>
              </button>
            </li>
          ))}
          {cursor && (
            <li className="p-2">
              <button
                type="button" onClick={() => folderId && void loadList(folderId, query.trim(), true)}
                className="w-full rounded-lg border border-input py-2 text-sm text-muted-foreground hover:bg-secondary"
              >
                Charger plus
              </button>
            </li>
          )}
        </ul>
      </section>

      {/* ── Volet 3 : lecture ── */}
      <section className={`surface min-w-0 flex-1 overflow-y-auto ${pane === "read" ? "block" : "hidden lg:block"}`}>
        {err && (
          <div className="m-3 flex items-start justify-between gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
            <p>{err}</p>
            <button type="button" onClick={() => setErr(null)} aria-label="Fermer" className="-m-1.5 shrink-0 rounded p-2 hover:bg-destructive/10 sm:m-0 sm:p-0.5">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
        {notice && (
          <div className="m-3 flex items-start justify-between gap-2 rounded-lg border border-success/20 bg-success/10 px-3 py-2 text-sm text-success">
            <p>{notice}</p>
            <button type="button" onClick={() => setNotice(null)} aria-label="Fermer" className="-m-1.5 shrink-0 rounded p-2 hover:bg-success/10 sm:m-0 sm:p-0.5">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {!openMsg ? (
          <div className="flex h-full items-center justify-center p-10 text-center text-sm text-muted-foreground">
            Sélectionnez un message.
          </div>
        ) : (
          <article className="space-y-3 p-3">
            {/* Une seule rangée : répondre à gauche — les gestes fréquents —, ranger/supprimer à
                droite. Sept boutons étiquetés en vrac se lisaient comme un menu, pas comme une
                barre d'outils. */}
            <div className="flex flex-wrap items-center gap-1 border-b border-border pb-2">
              <button type="button" onClick={() => setPane("list")} className="rounded-lg p-2 text-muted-foreground hover:bg-secondary lg:hidden" aria-label="Retour">
                <ChevronLeft className="h-5 w-5" />
              </button>
              <ToolButton icon={Reply} label="Répondre" onClick={() => startReply("reply")} />
              <ToolButton icon={ReplyAll} label="Répondre à tous" onClick={() => startReply("replyAll")} />
              <ToolButton icon={Forward} label="Transférer" onClick={() => startReply("forward")} />
              <span className="flex-1" />
              {busy && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
              <ToolButton
                compact
                icon={openMsg.isRead ? MailIcon : MailOpen}
                label={openMsg.isRead ? "Marquer non lu" : "Marquer lu"}
                onClick={() => void act(async () => {
                  const r = await setMessageRead(openMsg.id, !openMsg.isRead);
                  if (r.ok) {
                    setOpenMsg({ ...openMsg, isRead: !openMsg.isRead });
                    setItems((cur) => cur.map((x) => (x.id === openMsg.id ? { ...x, isRead: !openMsg.isRead } : x)));
                  }
                  return r;
                })}
              />
              {folderByKind("archive") && (
                <ToolButton compact icon={Archive} label="Archiver"
                  onClick={() => void act(() => moveMessage(openMsg.id, folderByKind("archive")!), openMsg.id)} />
              )}
              <ToolButton compact icon={Printer} label="Imprimer" onClick={() => window.print()} />
              <span className="mx-0.5 h-4 w-px bg-border" />
              <ToolButton compact danger icon={Trash2} label="Supprimer"
                onClick={() => void act(() => deleteMessage(openMsg.id), openMsg.id)} />
            </div>

            <header className="space-y-1 border-b border-border pb-3">
              <h1 className="text-lg font-semibold leading-snug [overflow-wrap:anywhere]">{openMsg.subject}</h1>
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                <p className="min-w-0 truncate text-sm font-medium">
                  {openMsg.from ? formatAddress(openMsg.from) : "(inconnu)"}
                </p>
                <p className="shrink-0 text-xs text-muted-foreground">
                  {openMsg.receivedAt ? new Date(openMsg.receivedAt).toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" }) : ""}
                </p>
              </div>
              <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                À {openMsg.to.map(formatAddress).join(", ") || "—"}
                {openMsg.cc.length > 0 && ` · Cc ${openMsg.cc.map(formatAddress).join(", ")}`}
              </p>
            </header>

            {openMsg.attachments.length > 0 && (
              <AttachmentBar messageId={openMsg.id} attachments={openMsg.attachments} />
            )}

            {/* Le corps est DÉJÀ assaini par le provider ; l'iframe sandbox est la seconde
                protection — sans `allow-scripts`, rien ne s'exécute même si l'on avait oublié
                quelque chose au nettoyage. */}
            <iframe
              title="Message"
              sandbox=""
              srcDoc={`<!doctype html><meta charset="utf-8"><style>body{font:14px/1.5 system-ui,sans-serif;color:#111;margin:0;padding:4px;word-break:break-word}img{max-width:100%;height:auto}</style>${openMsg.bodyHtml}`}
              className="min-h-[24rem] w-full rounded-lg border border-border bg-white max-lg:h-[65dvh]"
            />
          </article>
        )}
      </section>

      {compose && (
        <Composer
          address={address}
          signature={signature}
          initial={compose.draft}
          onClose={() => setCompose(null)}
          onSent={() => {
            setCompose(null);
            setErr(null);
            // ACCEPTÉ, PAS REMIS — et la nuance n'est pas de la prudence de façade.
            //
            // Microsoft répond `202` : il prend le message en charge, il ne promet pas qu'il
            // arrivera. Quand un message se perd, la première question est « est-il seulement
            // parti ? » — et « Éléments envoyés » y répond en trois secondes. Écrire « envoyé »
            // tout court aurait fait chercher la panne du mauvais côté.
            setNotice("Message accepté par Microsoft. Il apparaît dans « Éléments envoyés » ; sa remise dépend ensuite du serveur du destinataire.");
            void loadFolders();
            if (folderId) void loadList(folderId, query.trim());
          }}
        />
      )}
    </div>
  );
}

/**
 * Un bouton d'outil : étiquette visible pour les gestes fréquents, icône seule (`compact`) pour
 * les gestes de rangement — l'infobulle garde le nom. `danger` réserve le rouge au survol de la
 * suppression, seul geste de la barre qui retire quelque chose.
 */
function ToolButton({ icon: I, label, onClick, compact = false, danger = false }: {
  icon: React.ElementType; label: string; onClick: () => void; compact?: boolean; danger?: boolean;
}) {
  return (
    <button
      type="button" onClick={onClick} title={label} aria-label={label}
      className={`inline-flex items-center gap-1.5 rounded-lg p-2.5 text-sm text-muted-foreground transition-colors lg:px-2 lg:py-1.5 ${
        danger ? "hover:bg-destructive/10 hover:text-destructive" : "hover:bg-secondary hover:text-foreground"
      }`}
    >
      <I className="h-4 w-4" />
      <span className={compact ? "sr-only" : "hidden lg:inline"}>{label}</span>
    </button>
  );
}

/**
 * LES PIÈCES JOINTES — « Ouvrir » et « Enregistrer dans le Drive » d'abord.
 *
 * « Télécharger » existe, mais en dernier et en discret : c'est le geste qui fait SORTIR un
 * document de l'ERP, où il perd ses droits, son audit et son historique de versions.
 */
function AttachmentBar({ messageId, attachments }: { messageId: string; attachments: { id: string; name: string; size: number; contentType: string }[] }) {
  const [savingId, setSavingId] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState<Record<string, string>>({});
  const [err, setErr] = React.useState<string | null>(null);

  const save = async (a: { id: string; name: string }) => {
    setSavingId(a.id); setErr(null);
    const fd = new FormData();
    fd.set("messageId", messageId);
    fd.set("attachmentId", a.id);
    try {
      const r = await saveAttachmentToDrive(fd);
      if (!r.ok) { setErr(r.error ?? "Enregistrement impossible."); return; }
      if (r.nodeId) setSaved((s) => ({ ...s, [a.id]: r.nodeId! }));
    } catch {
      setErr(actionFailureMessage("THROWN"));
    } finally {
      setSavingId(null);
    }
  };

  return (
    <div className="space-y-1.5 rounded-lg border border-border p-2">
      <p className="text-xs font-medium text-muted-foreground">{attachments.length} pièce·s jointe·s</p>
      {err && <p className="rounded bg-destructive/10 px-2 py-1 text-xs text-destructive">{err}</p>}
      <ul className="space-y-1">
        {attachments.map((a) => (
          <li key={a.id} className="flex flex-wrap items-center gap-2 rounded-md px-1 py-1 text-sm hover:bg-secondary/50">
            <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            {/* Base de 10rem : au téléphone, le nom garde sa ligne et les boutons passent dessous. */}
            <span className="min-w-0 flex-1 basis-40 truncate">{a.name}</span>
            <span className="shrink-0 text-xs text-muted-foreground">{Math.max(1, Math.round(a.size / 1024))} Ko</span>

            <span className="ml-auto flex shrink-0 items-center gap-2">
              <a
                href={`/api/mail/ms/attachment?message=${encodeURIComponent(messageId)}&attachment=${encodeURIComponent(a.id)}`}
                target="_blank" rel="noopener noreferrer"
                className="shrink-0 rounded-lg border border-input px-3 py-2 text-xs font-medium hover:bg-secondary sm:px-2 sm:py-1"
              >
                Ouvrir
              </a>
              {saved[a.id] ? (
                <a href={`/drive/${saved[a.id]}`} className="shrink-0 rounded-lg px-2 py-2 text-xs font-medium text-success sm:py-1">
                  ✓ Dans le Drive
                </a>
              ) : (
                <button
                  type="button" onClick={() => void save(a)} disabled={savingId === a.id}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground disabled:opacity-60 sm:px-2 sm:py-1"
                >
                  {savingId === a.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <HardDriveDownload className="h-3 w-3" />}
                  Enregistrer dans le Drive
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>
      <p className="flex items-start gap-1 pt-0.5 text-[0.6875rem] text-muted-foreground">
        <Link2 className="mt-0.5 h-3 w-3 shrink-0" /> Les documents enregistrés dans le Drive gardent leurs droits, leur historique et leur provenance.
      </p>
    </div>
  );
}

/** La fenêtre de rédaction — Cc/Bcc repliés tant qu'on ne s'en sert pas. */
function Composer({
  address, signature, initial, onClose, onSent,
}: {
  address: string;
  signature: string;
  initial: ReturnType<typeof buildReplyDraft> | null;
  onClose: () => void;
  onSent: () => void;
}) {
  const [to, setTo] = React.useState((initial?.to ?? []).map(formatAddress).join(", "));
  const [cc, setCc] = React.useState((initial?.cc ?? []).map(formatAddress).join(", "));
  const [bcc, setBcc] = React.useState("");
  const [showMore, setShowMore] = React.useState((initial?.cc ?? []).length > 0);
  const [subject, setSubject] = React.useState(initial?.subject ?? "");
  const [body, setBody] = React.useState(initial?.bodyHtml ?? signature);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  const submit = async () => {
    setBusy(true); setErr(null);
    const fd = new FormData();
    fd.set("to", to); fd.set("cc", cc); fd.set("bcc", bcc);
    fd.set("subject", subject); fd.set("bodyHtml", body);
    if (initial?.inReplyTo) { fd.set("replyToId", initial.inReplyTo.messageId); fd.set("replyMode", initial.inReplyTo.mode); }
    try {
      const r = await sendMessage(fd);
      if (!r.ok) { setErr(r.error ?? "Envoi impossible."); return; }
      onSent();
    } catch {
      setErr(actionFailureMessage("THROWN"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/30 p-0 sm:items-center sm:p-6">
      <div className="flex h-[92dvh] w-full max-w-3xl flex-col overflow-hidden rounded-t-xl border border-border bg-card shadow-xl sm:h-[80dvh] sm:rounded-xl">
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2">
          <p className="min-w-0 truncate text-sm font-medium">
            {initial?.inReplyTo ? (initial.inReplyTo.mode === "forward" ? "Transférer" : "Répondre") : "Nouveau message"}
            {" — "}<span className="text-muted-foreground">{address}</span>
          </p>
          <button type="button" onClick={onClose} className="-mr-1 shrink-0 rounded p-2 text-muted-foreground hover:bg-secondary sm:mr-0 sm:p-1" aria-label="Fermer">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="shrink-0 space-y-2 border-b border-border p-3">
          <Field label="À" value={to} onChange={setTo} placeholder="nom@exemple.com, autre@exemple.com" email />
          {showMore ? (
            <>
              <Field label="Cc" value={cc} onChange={setCc} email />
              <Field label="Cci" value={bcc} onChange={setBcc} email />
            </>
          ) : (
            <button type="button" onClick={() => setShowMore(true)} className="py-1 text-xs text-primary hover:underline">Cc / Cci</button>
          )}
          <Field label="Objet" value={subject} onChange={setSubject} />
        </div>

        <textarea
          value={body} onChange={(e) => setBody(e.target.value)}
          className="min-h-0 flex-1 resize-none bg-transparent p-3 text-base outline-none lg:text-sm"
          placeholder="Votre message…"
        />

        {err && <p className="mx-3 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>}

        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] sm:pb-3">
          <span className="min-w-0 truncate text-xs text-muted-foreground">Envoyé depuis {address}</span>
          <Button type="button" onClick={() => void submit()} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Envoyer
          </Button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, value, onChange, placeholder, email = false }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; email?: boolean }) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="w-10 shrink-0 text-xs text-muted-foreground">{label}</span>
      {/* Clavier d'adresses au téléphone, sans `type="email"` : le champ accepte plusieurs adresses et des « Nom <adresse> ». */}
      <input
        value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
        {...(email ? { inputMode: "email" as const, autoCapitalize: "off", autoCorrect: "off", spellCheck: false } : {})}
        className="min-w-0 flex-1 border-0 bg-transparent py-1.5 text-base outline-none lg:py-1 lg:text-sm"
      />
    </label>
  );
}
