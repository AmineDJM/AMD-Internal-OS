"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import {
  SmilePlus, Reply, Pin, PinOff, Bookmark, BookmarkCheck, Pencil, Trash2, Copy, Check, CheckCheck,
  Download, FileText, Folder, CornerDownRight,
} from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import { useConfirmer } from "@/components/ui/dialogue";
import type { MessageDTO, AttachmentDTO } from "@/lib/queries/messaging";
import { timeOf, renderRich, formatBytes } from "./format";
import { peutRetirerUnMessage } from "@/lib/messaging-ui";
import { driveRefHref, imagesDuMessage, ouverturePiece, urlContenuPiece } from "@/lib/messaging-attachments";
import type { PieceVisionnee } from "@/components/documents/visionneuse";
import { QUICK_REACTIONS, EMOJI_PALETTE } from "./emoji";

// La visionneuse (et l'aperçu universel qu'elle embarque) ne se charge qu'au premier clic sur une pièce.
const Visionneuse = dynamic(() => import("@/components/documents/visionneuse").then((m) => m.Visionneuse), { ssr: false });

/** Une pièce jointe telle que la visionneuse la montre — le contenu passe TOUJOURS par la route de la messagerie. */
function versVisionnee(a: AttachmentDTO): PieceVisionnee {
  return {
    id: a.id,
    nom: a.name,
    mime: a.mime,
    image: ouverturePiece(a) === "image",
    src: urlContenuPiece(a),
    telechargement: urlContenuPiece(a, { telecharger: true }),
    lienDrive: a.driveNodeId ? driveRefHref(a.driveNodeId, false) : null,
    // Référence au Drive : Word/Excel/PowerPoint s'ouvrent dans l'éditeur Office (lecture seule sans droit d'écriture).
    cible: a.driveNodeId ? { type: "drive", id: a.driveNodeId } : undefined,
  };
}

interface Props {
  m: MessageDTO;
  selfId: string;
  showHeader: boolean;
  memberNames: string[];
  /** Rôle à vue globale de l'ERP (Super Admin, Direction) : modération transverse. */
  vueGlobale: boolean;
  /** Je suis propriétaire ou administrateur de cette conversation. */
  gereLaConversation: boolean;
  onReact: (id: string, emoji: string) => void;
  onReply: (m: MessageDTO) => void;
  onTogglePin: (id: string) => void;
  onBookmark: (id: string) => void;
  onDelete: (id: string) => void;
  onSaveEdit: (id: string, body: string) => Promise<boolean>;
  onJumpToParent: (id: string) => void;
}

export function MessageItem({
  m, selfId, showHeader, memberNames, vueGlobale, gereLaConversation,
  onReact, onReply, onTogglePin, onBookmark, onDelete, onSaveEdit, onJumpToParent,
}: Props) {
  const isOwn = m.senderId === selfId;
  const mentionsMe = m.mentionIds.includes(selfId);
  const confirmer = useConfirmer();
  const [showEmoji, setShowEmoji] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  const [editValue, setEditValue] = React.useState(m.body);
  const [copied, setCopied] = React.useState(false);
  const [vue, setVue] = React.useState<{ pieces: PieceVisionnee[]; index: number } | null>(null);
  const editRef = React.useRef<HTMLTextAreaElement>(null);

  React.useEffect(() => {
    if (editing) {
      const el = editRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      }
    }
  }, [editing]);

  if (m.kind === "SYSTEM") {
    return (
      <div className="my-2 flex justify-center">
        <span className="rounded-full bg-secondary/70 px-3 py-1 text-center text-xs text-muted-foreground">{m.body}</span>
      </div>
    );
  }

  if (m.deleted) {
    return (
      <div className={cn("flex gap-2.5 px-3", isOwn && "flex-row-reverse", showHeader ? "mt-3" : "mt-0.5")}>
        {!isOwn && <span className="w-9 shrink-0" />}
        <span className="rounded-full bg-secondary/50 px-3 py-1 text-xs italic text-muted-foreground">message supprimé</span>
      </div>
    );
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(m.body);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* ignore */
    }
  };

  const saveEdit = async () => {
    const v = editValue.trim();
    if (!v || v === m.body) return setEditing(false);
    const ok = await onSaveEdit(m.id, v);
    if (ok) setEditing(false);
  };

  /** Ouvrir une pièce EN SURIMPRESSION : une image avec ses voisines du même message, un document seul. */
  const ouvrir = (a: AttachmentDTO) => {
    if (ouverturePiece(a) === "image") {
      const images = imagesDuMessage(m.attachments);
      setVue({ pieces: images.map(versVisionnee), index: Math.max(0, images.findIndex((x) => x.id === a.id)) });
    } else {
      setVue({ pieces: [versVisionnee(a)], index: 0 });
    }
  };

  const react = (emoji: string) => {
    onReact(m.id, emoji);
    setShowEmoji(false);
  };

  return (
    // Focusable : au doigt, un appui sur le message suffit à faire paraître sa barre d'actions
    // (il n'y a pas de survol sur un écran tactile).
    <div
      id={`msg-${m.id}`}
      tabIndex={0}
      className={cn("group relative flex gap-2 px-2.5 outline-none sm:gap-2.5 sm:px-3", isOwn && "flex-row-reverse", showHeader ? "mt-3" : "mt-0.5")}
    >
      {!isOwn &&
        (showHeader ? (
          <Avatar name={m.senderName} color={m.senderColor} size="sm" className="mt-0.5" />
        ) : (
          <span className="w-7 shrink-0" />
        ))}

      <div className={cn("flex min-w-0 max-w-[85%] flex-col sm:max-w-[80%]", isOwn ? "items-end" : "items-start")}>
        {showHeader && !isOwn && (
          <div className="mb-0.5 flex min-w-0 max-w-full items-baseline gap-2 px-1">
            <span className="truncate text-xs font-semibold text-foreground">{m.senderName}</span>
            <span className="shrink-0 text-[0.6875rem] text-muted-foreground">{timeOf(m.createdAt)}</span>
          </div>
        )}

        {m.parent && (
          <button
            onClick={() => onJumpToParent(m.parent!.id)}
            className={cn(
              "mb-1 flex max-w-full items-center gap-1.5 rounded-lg border-l-2 border-primary/50 bg-secondary/60 px-2 py-1 text-left text-[0.6875rem] text-muted-foreground hover:bg-secondary",
            )}
          >
            <CornerDownRight className="h-3 w-3 shrink-0" />
            <span className="max-w-[45%] shrink-0 truncate font-medium text-foreground">{m.parent.senderName}</span>
            <span className="min-w-0 truncate">{m.parent.preview}</span>
          </button>
        )}

        {editing ? (
          <div className="w-full min-w-[min(260px,70vw)]">
            <textarea
              ref={editRef}
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void saveEdit();
                } else if (e.key === "Escape") {
                  setEditing(false);
                  setEditValue(m.body);
                }
              }}
              rows={2}
              className="w-full resize-none rounded-lg border border-input bg-card px-3 py-2 text-base focus-visible:outline-none lg:text-sm focus-visible:ring-2 focus-visible:ring-ring"
            />
            <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
              <button onClick={() => void saveEdit()} className="py-2 font-medium text-primary hover:underline sm:py-0">Enregistrer</button>
              <span>·</span>
              <button onClick={() => { setEditing(false); setEditValue(m.body); }} className="py-2 hover:underline sm:py-0">Annuler</button>
              <span className="ml-1 hidden sm:inline">Échap pour annuler</span>
            </div>
          </div>
        ) : (
          <div
            className={cn(
              "relative rounded-2xl px-3.5 py-2 text-sm shadow-sm",
              isOwn ? "bg-primary text-primary-foreground" : "bg-secondary text-foreground",
              showHeader && (isOwn ? "rounded-tr-md" : "rounded-tl-md"),
              mentionsMe && "ring-2 ring-warning ring-offset-1 ring-offset-card",
            )}
          >
            {m.body && <div className="whitespace-pre-wrap break-words leading-relaxed [overflow-wrap:anywhere]">{renderRich(m.body, memberNames)}</div>}

            {m.attachments.length > 0 && (
              <div className={cn("flex flex-col gap-2", m.body && "mt-2")}>
                {m.attachments.map((a) =>
                  a.driveNodeId && a.isFolder ? (
                    // UN DOSSIER DU DRIVE se navigue : il reste une page du Drive.
                    <a
                      key={a.id}
                      href={driveRefHref(a.driveNodeId, true)}
                      className="flex min-w-0 max-w-full items-center gap-2 rounded-lg border border-primary/40 bg-card px-3 py-2 text-foreground hover:bg-secondary/60"
                    >
                      <Folder className="h-5 w-5 shrink-0 text-primary" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{a.name}</span>
                        <span className="block text-[0.6875rem] text-muted-foreground">Dossier du Drive · version courante</span>
                      </span>
                    </a>
                  ) : ouverturePiece(a) === "image" ? (
                    <MiniatureImage key={a.id} a={a} onOuvrir={() => ouvrir(a)} />
                  ) : (
                    <CartePiece key={a.id} a={a} onOuvrir={() => ouvrir(a)} />
                  ),
                )}
              </div>
            )}

            <span className={cn("mt-0.5 flex items-center justify-end gap-1 text-[0.6875rem]", isOwn ? "text-primary-foreground/60" : "text-muted-foreground")}>
              {m.editedAt && <span>modifié ·</span>}
              <span>{timeOf(m.createdAt)}</span>
              {isOwn && m.receipt && (
                m.receipt === "sent"
                  ? <Check className="h-3.5 w-3.5 shrink-0" aria-label="Envoyé" />
                  : <CheckCheck className={cn("h-3.5 w-3.5 shrink-0", m.receipt === "read" ? "text-sky-300" : "")} aria-label={m.receipt === "read" ? "Lu" : "Distribué"} />
              )}
            </span>
          </div>
        )}

        {m.reactions.length > 0 && (
          <div className={cn("mt-1 flex flex-wrap gap-1", isOwn && "justify-end")}>
            {m.reactions.map((r) => (
              <button
                key={r.emoji}
                onClick={() => onReact(m.id, r.emoji)}
                title={r.users.join(", ")}
                className={cn(
                  "inline-flex items-center gap-1 rounded-full border px-2 py-1 text-xs transition-colors sm:px-1.5 sm:py-0.5",
                  r.mine ? "border-primary/40 bg-accent text-accent-foreground" : "border-border bg-card hover:bg-secondary",
                )}
              >
                <span>{r.emoji}</span>
                <span className="tabular-nums">{r.count}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Barre d'actions : au survol (souris) ou à l'appui sur le message (doigt, clavier).
          Masquée, elle ne capte aucun appui — sinon elle intercepterait les touches sur le message du dessus. */}
      {!editing && (
        <div
          className={cn(
            "pointer-events-none absolute -top-4 z-10 flex items-center gap-0.5 rounded-lg border border-border bg-card px-0.5 py-0.5 opacity-0 shadow-md transition-opacity sm:-top-3",
            "group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100",
            isOwn ? "left-2.5 sm:left-3" : "right-2.5 sm:right-3",
          )}
        >
          <div className="relative">
            <ActionBtn title="Réagir" onClick={() => setShowEmoji((v) => !v)}><SmilePlus className="h-4 w-4" /></ActionBtn>
            {showEmoji && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setShowEmoji(false)} />
                {/* Au téléphone, le sélecteur s'ancre à l'écran (pleine largeur, au-dessus du compositeur) :
                    accroché au bouton, il sortirait de l'écran d'un côté ou de l'autre. */}
                <div className={cn(
                  "fixed inset-x-3 bottom-[calc(var(--app-chrome-bottom)_+_5rem)] z-20 rounded-xl border border-border bg-popover p-2 shadow-xl",
                  "sm:absolute sm:inset-x-auto sm:bottom-auto sm:mt-1 sm:w-64",
                  isOwn ? "sm:left-0" : "sm:right-0",
                )}>
                  <div className="mb-1.5 flex flex-wrap justify-between gap-1 border-b border-border pb-1.5 sm:justify-start">
                    {QUICK_REACTIONS.map((e) => (
                      <button key={e} onClick={() => react(e)} className="rounded-md px-1.5 py-1 text-xl hover:bg-secondary sm:text-lg">{e}</button>
                    ))}
                  </div>
                  <div className="grid max-h-48 grid-cols-8 gap-0.5 overflow-y-auto sm:max-h-40">
                    {EMOJI_PALETTE.map((e) => (
                      <button key={e} onClick={() => react(e)} className="rounded-md p-1.5 text-lg hover:bg-secondary sm:p-1 sm:text-base">{e}</button>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>
          <ActionBtn title="Répondre" onClick={() => onReply(m)}><Reply className="h-4 w-4" /></ActionBtn>
          <ActionBtn title={m.bookmarked ? "Retirer des favoris" : "Enregistrer"} onClick={() => onBookmark(m.id)}>
            {m.bookmarked ? <BookmarkCheck className="h-4 w-4 text-primary" /> : <Bookmark className="h-4 w-4" />}
          </ActionBtn>
          <ActionBtn title={m.isPinned ? "Désépingler" : "Épingler"} onClick={() => onTogglePin(m.id)}>
            {m.isPinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
          </ActionBtn>
          <ActionBtn title="Copier" onClick={copy}>{copied ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}</ActionBtn>
          {isOwn && <ActionBtn title="Modifier" onClick={() => { setEditValue(m.body); setEditing(true); }}><Pencil className="h-4 w-4" /></ActionBtn>}
          {/* La MÊME règle que `deleteMessage` : trois faits, une seule lecture (§118.5).
              Avant, l'écran ignorait la vue globale — le Super Admin ne voyait jamais
              le bouton que l'action aurait accepté (§118.50). */}
          {peutRetirerUnMessage({ vueGlobale, auteur: isOwn, gereLaConversation }) && (
            <ActionBtn title="Supprimer" onClick={async () => { if (await confirmer("Supprimer ce message ?")) onDelete(m.id); }}>
              <Trash2 className="h-4 w-4 text-destructive" />
            </ActionBtn>
          )}
        </div>
      )}

      {/* Rendue dans un portail (au-dessus de tout) : la conversation reste derrière, intacte. */}
      {vue && (
        <Visionneuse
          pieces={vue.pieces}
          index={vue.index}
          onIndex={(index) => setVue((v) => (v ? { ...v, index } : v))}
          onClose={() => setVue(null)}
        />
      )}
    </div>
  );
}

/**
 * UNE IMAGE JOINTE : sa miniature, dans la bulle. Un clic l'ouvre dans la visionneuse — on reste dans
 * la conversation. Une référence au Drive garde sa mention (ce n'est pas une copie reçue). Si l'image
 * ne se charge pas (retirée du Drive, accès changé), la carte fichier prend sa place.
 */
function MiniatureImage({ a, onOuvrir }: { a: AttachmentDTO; onOuvrir: () => void }) {
  const [enEchec, setEnEchec] = React.useState(false);
  if (enEchec) return <CartePiece a={a} onOuvrir={onOuvrir} />;
  return (
    <span className="flex max-w-full flex-col items-start gap-0.5">
      <button
        type="button"
        onClick={onOuvrir}
        title={`Voir ${a.name}`}
        aria-label={`Voir l'image ${a.name}`}
        className="block max-w-full overflow-hidden rounded-lg border border-border bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={urlContenuPiece(a)}
          alt={a.name}
          loading="lazy"
          onError={() => setEnEchec(true)}
          className="block max-h-64 max-w-full cursor-zoom-in object-cover"
        />
      </button>
      {a.driveNodeId && (
        <span className="max-w-full truncate px-0.5 text-[0.6875rem] opacity-75">{a.name} · Fichier du Drive</span>
      )}
    </span>
  );
}

/**
 * UN FICHIER JOINT (téléversé ou référencé au Drive) : un clic l'OUVRE en surimpression (PDF, Word,
 * Excel, texte…) ; ce qui n'a pas d'aperçu (archive, binaire) se télécharge. Le bouton de
 * téléchargement reste à côté, explicite.
 */
function CartePiece({ a, onOuvrir }: { a: AttachmentDTO; onOuvrir: () => void }) {
  const telechargement = urlContenuPiece(a, { telecharger: true });
  const ouvrable = ouverturePiece(a) !== "telechargement";
  const contenu = (
    <>
      <FileText className="h-5 w-5 shrink-0 text-primary" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{a.name}</span>
        {/* UNE RÉFÉRENCE AU DRIVE — le document lui-même, pas une copie reçue. On le dit
            explicitement : sans cette mention, on croit avoir une pièce jointe et on la
            re-téléverse ailleurs, ce que ce partage existe précisément pour éviter. */}
        {a.driveNodeId && <span className="block text-[0.6875rem] text-muted-foreground">Fichier du Drive · version courante</span>}
      </span>
      {a.size > 0 && <span className="shrink-0 text-[0.6875rem] text-muted-foreground">{formatBytes(a.size)}</span>}
    </>
  );
  const zone = "flex min-w-0 flex-1 items-center gap-2 rounded-md py-1.5 pl-3 text-left sm:py-2 hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
  return (
    <div className={cn(
      "flex min-w-0 max-w-full items-center gap-1 rounded-lg border bg-card pr-1.5 text-foreground sm:pr-2",
      a.driveNodeId ? "border-primary/40" : "border-border",
    )}>
      {ouvrable ? (
        <button type="button" onClick={onOuvrir} title="Aperçu" className={zone}>{contenu}</button>
      ) : (
        <a href={telechargement} download={a.name} title="Télécharger" className={zone}>{contenu}</a>
      )}
      {/* Téléchargement explicite. */}
      <a
        href={telechargement}
        download={a.name}
        title="Télécharger"
        aria-label={`Télécharger ${a.name}`}
        className="shrink-0 rounded-md p-2 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground sm:p-1"
      >
        <Download className="h-4 w-4 shrink-0" />
      </a>
    </div>
  );
}

function ActionBtn({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button title={title} aria-label={title} onClick={onClick} className="rounded-md p-2 text-muted-foreground hover:bg-secondary hover:text-foreground sm:p-1.5">
      {children}
    </button>
  );
}
