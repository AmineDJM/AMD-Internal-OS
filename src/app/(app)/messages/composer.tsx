"use client";

import * as React from "react";
import { Send, Paperclip, Smile, X, Loader2, FileText, Folder, FolderUp, FolderSearch, Reply, UploadCloud, CheckCircle2, AlertCircle } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import type { ConvMemberDTO, MessageDTO } from "@/lib/queries/messaging";
import { EMOJI_PALETTE } from "./emoji";
import { formatBytes } from "./format";
import { DriveExplorerSheet, type DrivePickerValue } from "@/components/drive/drive-picker";
import { MAX_ATTACHMENTS, rootFolderName, shareWarning, libelleLot, type EtatLot } from "@/lib/messaging-attachments";
import { useBackgroundUpload } from "@/components/layout/background-upload";
import { useLimitesEnvoi } from "@/components/layout/use-limites-envoi";
import { envoiArborescenceDrive, dossierDuCheminDrive } from "@/components/drive/envoi-drive";
import { lireDepot, FICHIER_PARASITE, type EntreeDepot } from "@/components/documents/envoi-document";
import { preparerDepotMessagerie } from "@/lib/actions/messaging-actions";
import { trashNode } from "@/lib/actions/drive-actions";
import { cleParPersonne } from "@/lib/vue-exacte-ui";
import { sansBloquer } from "@/lib/journal";

export interface UploadedAttachment {
  blobId: string;
  sig: string;
  name: string;
  mime: string;
  size: number;
}

/** Un nœud du Drive JOINT PAR RÉFÉRENCE — rien n'est recopié, l'accès suivra. */
export interface DriveRef {
  id: string;
  name: string;
  isFolder: boolean;
}

export interface SendPayload {
  body: string;
  attachments: UploadedAttachment[];
  /** Références au Drive : le serveur revalide les droits et accorde la lecture aux membres. */
  driveRefs: DriveRef[];
  /** Lots déposés (gros fichiers, dossiers), déjà arrivés dans le Drive de l'expéditeur. */
  driveLots: { id: string; name: string }[];
  mentions: string[];
  parentId: string | null;
}

/** Un envoi confié au gestionnaire d'envois, dans le lot de la conversation. */
interface EnvoiDuLot { total: number; recus: number; echecs: number; annules: number; fini: boolean }

/**
 * LE LOT DÉPOSÉ DANS LE COMPOSITEUR — un dossier du Drive de l'expéditeur (« Messagerie / … / Envoi
 * du … ») où montent les fichiers, par le moteur du Drive. Plusieurs dépôts successifs s'y ajoutent ;
 * le message le joint quand TOUT est arrivé.
 */
interface LotDepot {
  conversationId: string;
  lotId: string;
  noms: string[];
  envois: Record<string, EnvoiDuLot>;
}

function etatDuLot(l: LotDepot): EtatLot {
  const e = Object.values(l.envois);
  return {
    total: e.reduce((a, x) => a + x.total, 0),
    recus: e.reduce((a, x) => a + x.recus, 0),
    echecs: e.reduce((a, x) => a + x.echecs, 0),
    annules: e.reduce((a, x) => a + x.annules, 0),
    enCours: e.some((x) => !x.fini),
  };
}

/** Le nom d'un dépôt : le fichier seul, le dossier déposé, ou le compte. */
function nomDuDepot(entrees: readonly EntreeDepot[]): string {
  if (entrees.length === 1) return entrees[0].path.split("/").pop() || entrees[0].file.name;
  const racines = new Set(entrees.map((e) => e.path.split("/")[0]));
  const racine = rootFolderName(entrees.map((e) => e.path));
  if (racines.size === 1 && racine && entrees.every((e) => e.path.includes("/"))) return racine;
  return `${entrees.length} fichiers`;
}

interface Props {
  conversationId: string;
  members: ConvMemberDTO[];
  selfId: string;
  replyTo: MessageDTO | null;
  onCancelReply: () => void;
  onSend: (payload: SendPayload) => Promise<boolean>;
}

export function Composer({ conversationId, members, selfId, replyTo, onCancelReply, onSend }: Props) {
  const [text, setText] = React.useState("");
  const [driveRefs, setDriveRefs] = React.useState<DriveRef[]>([]);
  const [attachMenu, setAttachMenu] = React.useState(false);
  const [drivePicker, setDrivePicker] = React.useState(false);
  // Les lots déposés, PAR conversation : un envoi continue en arrière-plan si l'on passe à une autre,
  // et son lot est retrouvé au retour.
  const [lots, setLots] = React.useState<LotDepot[]>([]);
  const [preparing, setPreparing] = React.useState(false);
  const [dragOver, setDragOver] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [sending, setSending] = React.useState(false);
  const [showEmoji, setShowEmoji] = React.useState(false);
  const [mention, setMention] = React.useState<{ open: boolean; query: string; start: number; caret: number }>({
    open: false, query: "", start: 0, caret: 0,
  });
  const [mentionIndex, setMentionIndex] = React.useState(0);

  const taRef = React.useRef<HTMLTextAreaElement>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const folderRef = React.useRef<HTMLInputElement>(null);
  const lastPing = React.useRef(0);
  // Brouillon rangé par conversation ET par personne : une conversation entre l'administrateur et Leila a le
  // même identifiant des deux côtés — en Vue exacte, Leila ne voit pas le brouillon de l'administrateur.
  const draftKey = cleParPersonne(`amd-msg-draft-${conversationId}`, selfId);
  const { enqueue } = useBackgroundUpload();
  const limites = useLimitesEnvoi();

  const lot = lots.find((l) => l.conversationId === conversationId) ?? null;
  const etatLot = lot ? etatDuLot(lot) : null;
  const libelle = etatLot ? libelleLot(etatLot) : null;
  // Un lot dont rien n'est arrivé (échec, annulation) n'est pas joint : il ne bloque pas non plus l'envoi du texte.
  const lotPret = Boolean(libelle?.pret);
  const lotEnCours = Boolean(etatLot?.enCours) || preparing;

  const others = React.useMemo(() => members.filter((m) => m.userId !== selfId), [members, selfId]);
  const mentionMatches = mention.open
    ? others.filter((m) => m.name.toLowerCase().includes(mention.query.toLowerCase())).slice(0, 6)
    : [];

  // Charge / restaure le brouillon par conversation.
  React.useEffect(() => {
    const saved = typeof window !== "undefined" ? window.localStorage.getItem(draftKey) : null;
    setText(saved ?? "");
    setDriveRefs([]);
    setError(null);
    setShowEmoji(false);
    setMention((m) => ({ ...m, open: false }));
    setTimeout(() => taRef.current?.focus(), 50);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  const autoGrow = () => {
    const ta = taRef.current;
    if (ta) {
      ta.style.height = "auto";
      ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
    }
  };
  React.useEffect(autoGrow, [text]);

  const pingTyping = () => {
    const now = Date.now();
    if (now - lastPing.current < 2500) return;
    lastPing.current = now;
    fetch("/api/messaging/typing", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId }),
      keepalive: true,
    }).catch(sansBloquer("composer.pingTyping.fetch"));
  };

  const onChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setText(val);
    setError(null);
    if (typeof window !== "undefined") window.localStorage.setItem(draftKey, val);
    if (val.trim()) pingTyping();

    const caret = e.target.selectionStart ?? val.length;
    const upto = val.slice(0, caret);
    const match = /(?:^|\s)@([^\s@]*)$/.exec(upto);
    if (match) {
      setMention({ open: true, query: match[1], start: caret - match[1].length - 1, caret });
      setMentionIndex(0);
    } else if (mention.open) {
      setMention((m) => ({ ...m, open: false }));
    }
  };

  const pickMention = (member: ConvMemberDTO) => {
    const before = text.slice(0, mention.start);
    const after = text.slice(mention.caret);
    const next = `${before}@${member.name} ${after}`;
    setText(next);
    setMention((m) => ({ ...m, open: false }));
    if (typeof window !== "undefined") window.localStorage.setItem(draftKey, next);
    setTimeout(() => {
      const ta = taRef.current;
      if (ta) {
        const pos = before.length + member.name.length + 2;
        ta.focus();
        ta.setSelectionRange(pos, pos);
      }
    }, 0);
  };

  const insertEmoji = (emoji: string) => {
    const ta = taRef.current;
    const caret = ta?.selectionStart ?? text.length;
    const next = text.slice(0, caret) + emoji + text.slice(caret);
    setText(next);
    setShowEmoji(false);
    setTimeout(() => {
      if (ta) {
        ta.focus();
        ta.setSelectionRange(caret + emoji.length, caret + emoji.length);
      }
    }, 0);
  };

  /** Met à jour UN envoi du lot de la conversation `conv` (les rappels arrivent en arrière-plan). */
  const majEnvoi = React.useCallback((conv: string, cle: string, fn: (e: EnvoiDuLot) => EnvoiDuLot) => {
    setLots((ls) => ls.map((l) => (l.conversationId === conv && l.envois[cle] ? { ...l, envois: { ...l.envois, [cle]: fn(l.envois[cle]) } } : l)));
  }, []);

  /**
   * DÉPOSER DES FICHIERS, DES ZIP, DES DOSSIERS — par le chemin du Drive, aux mêmes performances
   * (Direction, 06/10 : « pas que Drive ou Regulatory, et avec les exactes et mêmes performances »).
   *
   * Avant : dix fichiers au plus, un par un, chacun tenu en mémoire par le serveur, 200 Mo de limite ; un
   * dossier montait d'UNE requête et le serveur en faisait un .zip en mémoire. Désormais le serveur crée
   * le dossier de l'envoi (et l'arborescence d'un dossier déposé) dans le Drive de l'expéditeur, puis le
   * gestionnaire d'envois y monte chaque fichier exactement comme l'import de dossier du Drive : six en
   * parallèle, reprise, envoi direct au stockage au-delà du seuil, contenu déjà connu non retransféré.
   * L'envoi continue si l'on change d'écran ; le message attend que tout soit arrivé.
   */
  const deposer = async (brutes: EntreeDepot[]) => {
    setError(null);
    // .DS_Store, Thumbs.db… posés par le système, jamais par la personne.
    const entrees = brutes.filter((e) => !FICHIER_PARASITE.test(e.file.name));
    if (entrees.length === 0 || preparing) return;
    const conv = conversationId;
    const lotCourant = lots.find((l) => l.conversationId === conv) ?? null;
    const fd = new FormData();
    fd.set("conversationId", conv);
    if (lotCourant) fd.set("lotId", lotCourant.lotId);
    for (const d of new Set(entrees.map((e) => dossierDuCheminDrive(e.path)).filter(Boolean))) fd.append("dir", d);
    setPreparing(true);
    let r: Awaited<ReturnType<typeof preparerDepotMessagerie>>;
    try {
      r = await preparerDepotMessagerie(fd);
    } catch {
      r = { ok: false, error: "Impossible de préparer l'envoi — réseau indisponible ?" };
    } finally {
      setPreparing(false);
    }
    if (!r.ok || !r.lotId || !r.map) { setError(r.error ?? "Impossible de préparer l'envoi."); return; }
    const lotId = r.lotId;
    const cle = crypto.randomUUID();
    const nom = nomDuDepot(entrees);
    const envoi: EnvoiDuLot = { total: entrees.length, recus: 0, echecs: 0, annules: 0, fini: false };
    setLots((ls) => {
      const l = ls.find((x) => x.conversationId === conv && x.lotId === lotId);
      if (l) return ls.map((x) => (x === l ? { ...x, noms: [...x.noms, nom], envois: { ...x.envois, [cle]: envoi } } : x));
      return [...ls.filter((x) => x.conversationId !== conv), { conversationId: conv, lotId, noms: [nom], envois: { [cle]: envoi } }];
    });
    enqueue(envoiArborescenceDrive({
      label: `Messagerie — ${nom}${entrees.length > 1 ? ` (${entrees.length} fichiers)` : ""}`,
      entrees,
      map: r.map,
      parentId: lotId,
      limites,
      onFileDone: () => majEnvoi(conv, cle, (e) => ({ ...e, recus: e.recus + 1 })),
      onJobStart: () => majEnvoi(conv, cle, (e) => ({ ...e, echecs: 0, annules: 0, fini: false })),
      onJobDone: (b) => majEnvoi(conv, cle, () => ({ total: b.total, recus: b.recus, echecs: b.echecs, annules: b.annules, fini: true })),
    }));
  };

  const fichiersChoisis = (files: FileList) =>
    void deposer(Array.from(files).map((file) => ({ file, path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name })));

  /** Retirer le lot avant l'envoi : ses fichiers partent à la CORBEILLE du Drive (récupérables). */
  const retirerLot = () => {
    if (!lot || lotEnCours) return;
    const fd = new FormData();
    fd.set("id", lot.lotId);
    void trashNode(fd).catch(sansBloquer("composer.retirerLot.trashNode"));
    setLots((ls) => ls.filter((l) => l !== lot));
  };

  // GLISSER-DÉPOSER sur le compositeur : fichiers ET dossiers (parcours récursif).
  const aDesFichiers = (e: React.DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
  const onDragOver = (e: React.DragEvent) => {
    if (!aDesFichiers(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    if (!dragOver) setDragOver(true);
  };
  const onDragLeave = (e: React.DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDragOver(false);
  };
  const onDrop = async (e: React.DragEvent) => {
    if (!aDesFichiers(e)) return;
    e.preventDefault();
    setDragOver(false);
    try {
      await deposer(await lireDepot(e.dataTransfer));
    } catch {
      setError("Lecture du dépôt impossible — réessayez avec le trombone.");
    }
  };

  /**
   * ENVOYER. Un dossier déposé n'est plus une archive : il arrive dans le Drive avec son arborescence
   * exacte, et le message en joint le contenu par référence. TANT QUE LE LOT MONTE, on n'envoie pas :
   * un message parti avant ses fichiers annoncerait des pièces que personne ne trouverait.
   */
  const submit = async () => {
    const body = text.trim();
    if (sending) return;
    if (lotEnCours) { setError("Les fichiers ne sont pas encore tous arrivés — le message pourra partir dès la fin de l'envoi."); return; }
    if (!body && driveRefs.length === 0 && !lotPret) return;
    const mentions = others.filter((m) => body.includes(`@${m.name}`)).map((m) => m.userId);
    const lotEnvoye = lotPret && lot ? lot : null;
    setSending(true);
    const ok = await onSend({
      body, attachments: [], driveRefs, mentions, parentId: replyTo?.id ?? null,
      driveLots: lotEnvoye ? [{ id: lotEnvoye.lotId, name: lotEnvoye.noms.join(", ") }] : [],
    });
    setSending(false);
    if (ok) {
      setText("");
      // Le lot ENVOYÉ quitte le compositeur (ses fichiers restent dans le Drive, joints au message).
      if (lotEnvoye) setLots((ls) => ls.filter((l) => l.lotId !== lotEnvoye.lotId));
      setDriveRefs([]);
      setShowEmoji(false);
      if (typeof window !== "undefined") window.localStorage.removeItem(draftKey);
      onCancelReply();
      setTimeout(() => taRef.current?.focus(), 0);
    } else {
      setError("Échec de l'envoi.");
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention.open && mentionMatches.length > 0) {
      if (e.key === "ArrowDown") { e.preventDefault(); setMentionIndex((i) => (i + 1) % mentionMatches.length); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setMentionIndex((i) => (i - 1 + mentionMatches.length) % mentionMatches.length); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pickMention(mentionMatches[mentionIndex]); return; }
      if (e.key === "Escape") { setMention((m) => ({ ...m, open: false })); return; }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };

  const canSend = (text.trim().length > 0 || driveRefs.length > 0 || lotPret) && !sending && !lotEnCours;

  return (
    // Marge basse : la zone de sécurité de l'écran n'est ajoutée que si aucune barre d'onglets ne
    // l'absorbe déjà en dessous (sur téléphone, `--app-chrome-bottom` la contient).
    <div
      className="relative shrink-0 border-t border-border bg-card px-2 pb-[calc(0.625rem_+_max(0px,_env(safe-area-inset-bottom)_-_var(--app-chrome-bottom)))] pt-2.5 sm:px-3"
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={(e) => void onDrop(e)}
    >
      {dragOver && (
        <div className="pointer-events-none absolute inset-1 z-40 flex items-center justify-center gap-2 rounded-xl border-2 border-dashed border-primary bg-primary/10 text-sm font-medium text-primary">
          <UploadCloud className="h-5 w-5" /> Déposez fichiers, ZIP ou dossiers — ils partent dans la conversation
        </div>
      )}
      {replyTo && (
        <div className="mb-2 flex items-center gap-2 rounded-lg border-l-2 border-primary bg-secondary/60 px-3 py-1.5 text-xs">
          <Reply className="h-3.5 w-3.5 shrink-0 text-primary" />
          <span className="max-w-[40%] shrink-0 truncate font-medium text-foreground">{replyTo.senderName}</span>
          <span className="min-w-0 flex-1 truncate text-muted-foreground">{replyTo.body || "Pièce jointe"}</span>
          <button onClick={onCancelReply} aria-label="Annuler la réponse" className="-my-1 shrink-0 rounded p-2 text-muted-foreground hover:bg-secondary sm:my-0 sm:p-0.5"><X className="h-3.5 w-3.5" /></button>
        </div>
      )}

      {(driveRefs.length > 0 || lot || preparing) && (
        <div className="mb-2 flex flex-wrap gap-2">
          {/* LES RÉFÉRENCES AU DRIVE, distinguées des fichiers téléversés : bordure de couleur et
              mention explicite. Confondre les deux, c'est ne pas savoir qu'on est sur le point
              d'OUVRIR UN ACCÈS — et un accès ne se reprend pas d'un clic. */}
          {driveRefs.map((r, i) => (
            <div key={r.id + i} className="flex max-w-full items-center gap-2 rounded-lg border border-primary/50 bg-primary/5 py-1.5 pl-2.5 pr-1 text-xs sm:pr-2.5">
              {r.isFolder ? <Folder className="h-4 w-4 shrink-0 text-primary" /> : <FileText className="h-4 w-4 shrink-0 text-primary" />}
              <span className="min-w-0 max-w-[160px] truncate font-medium">{r.name}</span>
              <span className="text-muted-foreground">Drive</span>
              <button onClick={() => setDriveRefs((list) => list.filter((_, j) => j !== i))} aria-label="Retirer" className="-my-1 shrink-0 rounded p-2 text-muted-foreground hover:bg-secondary sm:my-0 sm:p-0.5">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
          {/* LE LOT DÉPOSÉ : où en est l'envoi (le détail, débit et temps restant, est dans la pastille
              des envois). Le message ne part qu'une fois tout arrivé. */}
          {lot && etatLot && libelle && (
            <div
              className={cn(
                "flex max-w-full items-center gap-2 rounded-lg border py-1.5 pl-2.5 pr-1 text-xs sm:pr-2.5",
                etatLot.enCours ? "border-dashed border-border bg-background text-muted-foreground"
                  : libelle.pret ? "border-primary/50 bg-primary/5" : "border-destructive/50 bg-destructive/5 text-destructive",
              )}
              title={lot.noms.join(", ")}
            >
              {etatLot.enCours ? <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
                : libelle.pret ? <CheckCircle2 className="h-4 w-4 shrink-0 text-primary" />
                : <AlertCircle className="h-4 w-4 shrink-0" />}
              <span className="min-w-0 max-w-[180px] truncate font-medium">
                {lot.noms[0]}{lot.noms.length > 1 ? ` + ${lot.noms.length - 1}` : ""}
              </span>
              <span className="min-w-0 text-muted-foreground">{libelle.texte}</span>
              <button
                onClick={retirerLot}
                disabled={lotEnCours}
                title={lotEnCours ? "Envoi en cours — annulez-le depuis la pastille des envois." : "Retirer (les fichiers vont à la corbeille du Drive)"}
                aria-label="Retirer"
                className="-my-1 shrink-0 rounded p-2 text-muted-foreground hover:bg-secondary disabled:opacity-40 sm:my-0 sm:p-0.5"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
          {preparing && (
            <div className="flex items-center gap-2 rounded-lg border border-dashed border-border bg-background px-2.5 py-1.5 text-xs text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>Préparation de l&apos;envoi…</span>
            </div>
          )}
        </div>
      )}

      {(driveRefs.length > 0 || lot) && (
        <p className="mb-2 px-1 text-xs text-muted-foreground">{shareWarning(others.length)}</p>
      )}
      {lotEnCours && (
        <p className="mb-2 px-1 text-xs text-muted-foreground">
          L&apos;envoi continue en arrière-plan, même si vous changez d&apos;écran ; le message pourra partir quand tout sera arrivé.
        </p>
      )}

      {error && <p className="mb-2 px-1 text-xs text-destructive">{error}</p>}

      {mention.open && mentionMatches.length > 0 && (
        <div className="absolute bottom-full left-2 right-2 z-30 mb-1 overflow-hidden rounded-xl border border-border bg-popover shadow-xl sm:left-3 sm:right-auto sm:w-72">
          {mentionMatches.map((m, i) => (
            <button
              key={m.userId}
              onMouseDown={(e) => { e.preventDefault(); pickMention(m); }}
              onMouseEnter={() => setMentionIndex(i)}
              className={cn("flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm sm:py-2", i === mentionIndex ? "bg-secondary" : "hover:bg-secondary/60")}
            >
              <Avatar name={m.name} color={m.avatarColor} size="sm" />
              <div className="min-w-0">
                <p className="truncate font-medium">{m.name}</p>
                {m.title && <p className="truncate text-xs text-muted-foreground">{m.title}</p>}
              </div>
            </button>
          ))}
        </div>
      )}

      <div className="flex items-end gap-1 sm:gap-1.5">
        {/* TROIS FAÇONS DE JOINDRE, sous un seul trombone. Trois boutons alignés auraient tous
            le même poids visuel alors qu'on en utilise un neuf fois sur dix ; et surtout, la
            troisième — « depuis le Drive » — a besoin d'être NOMMÉE pour qu'on comprenne qu'elle
            ne recopie rien. Une icône seule ne dit pas cela. */}
        <div className="relative">
          <button
            onClick={() => setAttachMenu((v) => !v)}
            title="Joindre"
            aria-label="Joindre"
            aria-expanded={attachMenu}
            className="mb-1 rounded-lg p-2 text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            <Paperclip className="h-5 w-5" />
          </button>
          {attachMenu && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setAttachMenu(false)} />
              <div className="absolute bottom-full left-0 z-20 mb-1 w-[min(18rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-border bg-popover p-1 shadow-xl">
                <button
                  onClick={() => { setAttachMenu(false); fileRef.current?.click(); }}
                  className="flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left text-sm hover:bg-secondary"
                >
                  <FileText className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <span>
                    Des fichiers de mon ordinateur
                    <span className="block text-xs text-muted-foreground">
                      Gros fichiers et ZIP compris{limites ? ` (jusqu'à ${formatBytes(limites.maxDriveUploadMb * 1024 * 1024)} par fichier)` : ""} — ou glissez-les ici.
                    </span>
                  </span>
                </button>
                <button
                  onClick={() => { setAttachMenu(false); folderRef.current?.click(); }}
                  className="flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left text-sm hover:bg-secondary"
                >
                  <FolderUp className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <span>
                    Un dossier de mon ordinateur
                    <span className="block text-xs text-muted-foreground">Arborescence exacte, sans archive — comme dans le Drive.</span>
                  </span>
                </button>
                <button
                  onClick={() => { setAttachMenu(false); setDrivePicker(true); }}
                  className="flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left text-sm hover:bg-secondary"
                >
                  <FolderSearch className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                  <span>
                    Depuis le Drive
                    <span className="block text-xs text-muted-foreground">Sans recopier — les destinataires reçoivent un accès en lecture.</span>
                  </span>
                </button>
              </div>
            </>
          )}
        </div>
        <input
          ref={fileRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => { if (e.target.files) fichiersChoisis(e.target.files); e.target.value = ""; }}
        />
        {/* `webkitdirectory` n'existe pas dans les types React : l'attribut est bien standard dans
            tous les navigateurs de bureau, mais la définition TypeScript ne l'a jamais suivi. */}
        <input
          ref={folderRef}
          type="file"
          multiple
          className="hidden"
          {...{ webkitdirectory: "", directory: "" }}
          onChange={(e) => { if (e.target.files) fichiersChoisis(e.target.files); e.target.value = ""; }}
        />

        {drivePicker && (
          <DriveExplorerSheet
            onClose={() => setDrivePicker(false)}
            onPick={(v: DrivePickerValue) => {
              setDrivePicker(false);
              setDriveRefs((list) =>
                list.some((r) => r.id === v.id) || list.length + (lot ? 1 : 0) >= MAX_ATTACHMENTS
                  ? list
                  : [...list, { id: v.id, name: v.name, isFolder: v.isFolder }],
              );
            }}
          />
        )}

        <div className="relative min-w-0 flex-1">
          <textarea
            ref={taRef}
            value={text}
            onChange={onChange}
            onKeyDown={onKeyDown}
            rows={1}
            enterKeyHint="send"
            placeholder="Écrire un message…   (@ pour mentionner, Entrée pour envoyer)"
            className="max-h-40 w-full resize-none rounded-2xl border border-input bg-background px-4 py-2.5 text-base leading-relaxed lg:text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>

        <div className="relative">
          <button
            onClick={() => setShowEmoji((v) => !v)}
            title="Émoji"
            aria-label="Émoji"
            className="mb-1 rounded-lg p-2 text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            <Smile className="h-5 w-5" />
          </button>
          {showEmoji && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setShowEmoji(false)} />
              <div className="absolute bottom-full right-0 z-20 mb-1 w-[min(18rem,calc(100vw-2rem))] rounded-xl border border-border bg-popover p-2 shadow-xl sm:w-64">
                <div className="grid max-h-48 grid-cols-8 gap-0.5 overflow-y-auto">
                  {EMOJI_PALETTE.map((e) => (
                    <button key={e} onClick={() => insertEmoji(e)} className="rounded-md p-1.5 text-lg hover:bg-secondary sm:p-1 sm:text-base">{e}</button>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>

        <button
          onClick={() => void submit()}
          disabled={!canSend}
          title="Envoyer"
          aria-label="Envoyer"
          className={cn(
            "mb-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full shadow-sm transition-colors",
            canSend ? "bg-primary text-primary-foreground hover:bg-primary/90" : "bg-secondary text-muted-foreground",
          )}
        >
          {sending ? <Loader2 className="h-5 w-5 animate-spin" /> : <Send className="h-5 w-5" />}
        </button>
      </div>
    </div>
  );
}
