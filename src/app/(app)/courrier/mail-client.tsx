"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Inbox, Send as SendIcon, RefreshCw, Loader2, Paperclip, PenSquare, X,
  ChevronLeft, AlertCircle, Trash2, Mail as MailIcon, Reply, ReplyAll, Forward, Maximize2, Minimize2,
  FolderKanban, Check, ExternalLink, Search, PenLine,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Textarea, Label, Select } from "@/components/ui/input";
import { Sheet } from "@/components/ui/sheet";
import { Avatar } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import { sendMailAction, disconnectMailbox, updateMailSignature } from "@/lib/actions/mail-actions";
import { listLinkableDossiers, linkEmailToDossier } from "@/lib/actions/dossier-actions";
import { sansBloquer } from "@/lib/journal";

interface Folder { path: string; name: string; role: string; unseen: number; total: number }
interface Envelope { uid: number; subject: string; from: string; fromAddr: string; date: string | null; seen: boolean }
interface AttMeta { index: number; filename: string; contentType: string; size: number }
interface MsgDetail { uid: number; subject: string; from: string; fromAddr: string; to: string; cc: string; date: string | null; html: string | null; text: string | null; attachments: AttMeta[] }
export interface Contact { name: string; address: string; source?: string }

const fmtDate = (s: string | null) => (s ? new Date(s).toLocaleString("fr-FR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "");
const fmtSize = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} Mo` : `${Math.max(1, Math.ceil(n / 1024))} Ko`);
const folderIcon = (role: string) => (role === "Sent" ? SendIcon : role === "Trash" ? Trash2 : Inbox);
const folderLabel = (f: Folder) => ({ Sent: "Envoyés", Trash: "Corbeille", Drafts: "Brouillons", Junk: "Indésirables", Archive: "Archives" }[f.role] || (f.path === "INBOX" ? "Réception" : f.name));

const replySubject = (s: string) => (/^re\s*:/i.test(s) ? s : `Re: ${s}`);
const quoteBody = (m: MsgDetail) => `\n\n--- Le ${fmtDate(m.date)}, ${m.from} a écrit ---\n${(m.text || "").slice(0, 4000)}`;
const forwardBody = (m: MsgDetail) =>
  `\n\n--- Message transféré ---\nDe : ${m.from} <${m.fromAddr}>\nDate : ${fmtDate(m.date)}\nÀ : ${m.to}${m.cc ? `\nCc : ${m.cc}` : ""}\nObjet : ${m.subject}\n\n${(m.text || "").slice(0, 6000)}`;

export function MailClient({ email, signature: initialSignature }: { email: string; signature: string }) {
  const router = useRouter();
  const [signature, setSignature] = React.useState(initialSignature);
  const [sigOpen, setSigOpen] = React.useState(false);
  const [folders, setFolders] = React.useState<Folder[]>([]);
  const [mailbox, setMailbox] = React.useState("INBOX");
  const [messages, setMessages] = React.useState<Envelope[]>([]);
  const [sel, setSel] = React.useState<MsgDetail | null>(null);
  const [loadingList, setLoadingList] = React.useState(true);
  const [loadingMsg, setLoadingMsg] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [compose, setCompose] = React.useState<null | { to: string; cc: string; subject: string; body: string }>(null);
  const [fullscreen, setFullscreen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [activeSearch, setActiveSearch] = React.useState("");
  const [unreadOnly, setUnreadOnly] = React.useState(false);
  const [accent, setAccent] = React.useState<"pink" | "blue">("pink");
  // « stale » = boîte affichée depuis le cache (Infomaniak momentanément saturé). On ne
  // montre pas d'erreur rouge : la boîte reste consultable et une nouvelle tentative se planifie.
  const [stale, setStale] = React.useState<number | null>(null);
  const retryTimer = React.useRef<number | null>(null);

  // Plein écran : verrouille le défilement de la page derrière + sortie au clavier (Échap).
  React.useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !compose && !sel) toggleFullscreen(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullscreen, compose, sel]);

  // Accent Infomaniak (rose par défaut / bleu, comme dans Infomaniak Mail) mémorisé par navigateur.
  React.useEffect(() => {
    const saved = typeof window !== "undefined" ? localStorage.getItem("ik-mail-accent") : null;
    if (saved === "blue" || saved === "pink") setAccent(saved);
  }, []);
  const chooseAccent = (a: "pink" | "blue") => { setAccent(a); try { localStorage.setItem("ik-mail-accent", a); } catch { /* ignore */ } };

  // « Très grand écran » : superpose l'interface du Courrier (masque la barre + le menu
  // de l'application) ET passe le navigateur en plein écran natif (masque onglets / URL)
  // pour ne voir QUE l'e-mail. Échap ou sortie navigateur reviennent à la vue normale.
  function toggleFullscreen() {
    const next = !fullscreen;
    setFullscreen(next);
    try {
      if (next) { const p = document.documentElement.requestFullscreen?.(); if (p) p.catch(sansBloquer("mail-client.toggleFullscreen")); }
      else if (document.fullscreenElement) { const p = document.exitFullscreen?.(); if (p) p.catch(sansBloquer("mail-client.toggleFullscreen")); }
    } catch { /* API plein écran indisponible : la superposition suffit */ }
  }
  React.useEffect(() => {
    const onFs = () => { if (!document.fullscreenElement) setFullscreen(false); };
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  const loadList = React.useCallback(async (mb: string, withFolders = false, search = "") => {
    setLoadingList(true); setErr(null); setSel(null);
    if (retryTimer.current) { clearTimeout(retryTimer.current); retryTimer.current = null; }
    try {
      const sp = search.trim() ? `&search=${encodeURIComponent(search.trim())}` : "";
      const res = await fetch(`/api/mail/messages?mailbox=${encodeURIComponent(mb)}&limit=300${withFolders ? "&folders=1" : ""}${sp}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) { setErr(data.error ?? "Connexion à la boîte impossible."); setMessages([]); setStale(null); }
      else {
        setMessages(data.messages ?? []);
        if (data.mailboxes) setFolders(data.mailboxes);
        if (data.stale) {
          // Infomaniak saturé : on affiche le cache et on retente automatiquement (le disjoncteur se referme seul).
          setStale(data.syncedAt ?? Date.now());
          retryTimer.current = window.setTimeout(() => loadList(mb, false, search), 20000);
        } else {
          setStale(null);
        }
      }
    } catch { setErr("Connexion à la boîte impossible."); setStale(null); }
    finally { setLoadingList(false); }
  }, []);

  React.useEffect(() => { loadList("INBOX", true); }, [loadList]);

  // Nettoyage du minuteur de nouvelle tentative (mode « cache ») à la sortie.
  React.useEffect(() => () => { if (retryTimer.current) clearTimeout(retryTimer.current); }, []);

  const runSearch = () => { setActiveSearch(query); loadList(mailbox, false, query); };
  const clearSearch = () => { setQuery(""); setActiveSearch(""); loadList(mailbox); };
  const shownMessages = unreadOnly ? messages.filter((m) => !m.seen) : messages;

  // Construit les destinataires d'un « Répondre à tous » (sans se ré-adresser à soi-même).
  const buildReplyAll = (m: MsgDetail) => {
    const self = email.toLowerCase();
    const split = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
    const toSet = new Set<string>();
    [m.fromAddr, ...split(m.to)].forEach((a) => { if (a && a.toLowerCase() !== self) toSet.add(a); });
    const ccList = split(m.cc).filter((a) => a.toLowerCase() !== self && !toSet.has(a));
    return { to: [...toSet].join(", "), cc: ccList.join(", ") };
  };

  const openMessage = async (uid: number) => {
    setLoadingMsg(true); setErr(null);
    try {
      const res = await fetch(`/api/mail/message?mailbox=${encodeURIComponent(mailbox)}&uid=${uid}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) setErr(data.error ?? "Lecture impossible.");
      else { setSel(data.message); setMessages((m) => m.map((x) => (x.uid === uid ? { ...x, seen: true } : x))); }
    } catch { setErr("Lecture impossible."); }
    finally { setLoadingMsg(false); }
  };

  const selectFolder = (mb: string) => { setMailbox(mb); setQuery(""); setActiveSearch(""); setUnreadOnly(false); loadList(mb); };

  // Signature insérée en haut du corps (au-dessus d'une éventuelle citation), curseur au début.
  const sigTop = signature.trim() ? `\n\n${signature.trimEnd()}` : "";

  return (
    <div data-accent={accent} className={cn("ik-mail flex overflow-hidden", fullscreen ? "fixed inset-0 z-[90] bg-background" : "surface min-h-0 flex-1")}>
      {/* Dossiers */}
      <aside className="hidden w-56 shrink-0 flex-col border-r border-border bg-gradient-to-b from-secondary/40 to-secondary/10 p-3 md:flex">
        <button
          onClick={() => setCompose({ to: "", cc: "", subject: "", body: sigTop })}
          className="mb-3 flex w-full items-center justify-center gap-2 rounded-full bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground shadow-md shadow-primary/25 transition hover:bg-primary/90 hover:shadow-lg active:scale-[0.98]"
        >
          <PenSquare className="h-4 w-4" /> Nouveau message
        </button>
        <nav className="min-h-0 flex-1 space-y-1 overflow-y-auto">
          {folders.length === 0 && loadingList ? (
            <p className="px-2 py-1 text-xs text-muted-foreground">Chargement…</p>
          ) : folders.map((f) => {
            const Icon = folderIcon(f.role);
            const active = f.path === mailbox;
            return (
              <button key={f.path} onClick={() => selectFolder(f.path)} className={cn("flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-sm transition-colors", active ? "bg-card font-semibold text-primary shadow-sm ring-1 ring-primary/10" : "text-foreground hover:bg-card/60")}>
                <Icon className={cn("h-4 w-4 shrink-0", active ? "text-primary" : "text-muted-foreground")} /><span className="flex-1 truncate text-left">{folderLabel(f)}</span>
                {f.unseen > 0 && <span className="rounded-full bg-primary px-1.5 text-[0.6875rem] font-semibold text-primary-foreground">{f.unseen}</span>}
              </button>
            );
          })}
        </nav>
        <div className="mt-2 flex items-center gap-2 px-2.5 py-1.5">
          <span className="text-[0.6875rem] text-muted-foreground">Couleur</span>
          <button type="button" onClick={() => chooseAccent("pink")} aria-label="Accent rose Infomaniak" title="Rose Infomaniak" className={cn("h-5 w-5 rounded-full ring-offset-2 ring-offset-secondary transition", accent === "pink" && "ring-2 ring-foreground")} style={{ backgroundColor: "#BC0055" }} />
          <button type="button" onClick={() => chooseAccent("blue")} aria-label="Accent bleu Infomaniak" title="Bleu Infomaniak" className={cn("h-5 w-5 rounded-full ring-offset-2 ring-offset-secondary transition", accent === "blue" && "ring-2 ring-foreground")} style={{ backgroundColor: "#0098FF" }} />
        </div>
        <button onClick={() => setSigOpen(true)} className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground">
          <PenLine className="h-3.5 w-3.5" /> Signature{signature.trim() ? "" : " (aucune)"}
        </button>
        <button onClick={async () => { if (confirm("Déconnecter cette boîte mail ?")) { await disconnectMailbox(); router.refresh(); } }} className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-secondary hover:text-destructive">
          <X className="h-3.5 w-3.5" /> Déconnecter la boîte
        </button>
      </aside>

      <SignatureSheet open={sigOpen} onClose={() => setSigOpen(false)} initial={signature} onSaved={setSignature} />

      {/* Liste des messages */}
      {/* Au téléphone, un seul panneau à la fois : la liste, OU le message, OU le composeur. */}
      <div className={cn("flex min-h-0 w-full flex-col border-r border-border md:w-80", (sel || compose) && "hidden md:flex")}>
        <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
          <p className="min-w-0 truncate text-sm font-semibold">{folders.find((f) => f.path === mailbox) ? folderLabel(folders.find((f) => f.path === mailbox)!) : mailbox}</p>
          <div className="flex shrink-0 items-center gap-0.5">
            <button onClick={() => loadList(mailbox, false, activeSearch)} className="rounded-lg p-2 text-muted-foreground hover:bg-secondary md:p-1.5" title="Actualiser" aria-label="Actualiser"><RefreshCw className={cn("h-4 w-4", loadingList && "animate-spin")} /></button>
            <button onClick={toggleFullscreen} className={cn("rounded-lg p-2 hover:bg-secondary md:p-1.5", fullscreen ? "text-primary" : "text-muted-foreground")} title={fullscreen ? "Quitter le grand écran (Échap)" : "Grand écran — n'afficher que l'e-mail"} aria-label={fullscreen ? "Quitter le grand écran" : "Grand écran"}>
              {fullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
            </button>
          </div>
        </div>
        {/* LE PANNEAU DES DOSSIERS EST MASQUÉ AU TÉLÉPHONE : ses deux gestes essentiels — changer de
            dossier, écrire un message — reviennent ici, sinon ils n'existaient qu'au bureau. */}
        <div className="flex items-center gap-2 border-b border-border px-3 py-2 md:hidden">
          <Select value={mailbox} onChange={(e) => selectFolder(e.target.value)} aria-label="Dossier" className="h-10 min-w-0 flex-1">
            {folders.length === 0 && <option value={mailbox}>{mailbox}</option>}
            {folders.map((f) => <option key={f.path} value={f.path}>{folderLabel(f)}{f.unseen > 0 ? ` (${f.unseen})` : ""}</option>)}
          </Select>
          <Button size="sm" className="h-10 shrink-0" onClick={() => setCompose({ to: "", cc: "", subject: "", body: sigTop })}>
            <PenSquare className="h-4 w-4" /> Écrire
          </Button>
        </div>
        {/* Recherche + filtres */}
        <div className="space-y-2 border-b border-border px-3 py-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") runSearch(); }}
              placeholder="Rechercher (expéditeur, objet, contenu…)"
              type="search" enterKeyHint="search"
              className="w-full rounded-lg border border-input bg-background py-2 pl-8 pr-9 text-base outline-none focus:ring-2 focus:ring-primary/30 md:py-1.5 md:pr-8 md:text-sm"
            />
            {(query || activeSearch) && (
              <button onClick={clearSearch} className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-2 text-muted-foreground hover:bg-secondary md:right-2 md:p-0.5" title="Effacer" aria-label="Effacer la recherche"><X className="h-3.5 w-3.5" /></button>
            )}
          </div>
          <div className="flex min-w-0 items-center gap-1.5">
            <button onClick={() => setUnreadOnly(false)} className={cn("min-h-8 rounded-full border px-3 py-1 text-xs font-medium md:min-h-0 md:px-2.5 md:py-0.5", !unreadOnly ? "border-primary bg-primary text-primary-foreground" : "border-border text-muted-foreground hover:bg-secondary")}>Tous</button>
            <button onClick={() => setUnreadOnly(true)} className={cn("min-h-8 rounded-full border px-3 py-1 text-xs font-medium md:min-h-0 md:px-2.5 md:py-0.5", unreadOnly ? "border-primary bg-primary text-primary-foreground" : "border-border text-muted-foreground hover:bg-secondary")}>Non lus</button>
            {activeSearch && <span className="ml-auto truncate text-[0.6875rem] text-muted-foreground">Recherche : « {activeSearch} »</span>}
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {stale && !err && (
            <div className="m-3 flex items-start gap-2 rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>Serveur Infomaniak momentanément saturé — affichage de la dernière synchronisation ({new Date(stale).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}). Nouvelle tentative automatique…</span>
            </div>
          )}
          {err && !loadingList && <div className="m-3 flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> {err}</div>}
          {loadingList ? (
            <div className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Chargement…</div>
          ) : shownMessages.length === 0 && !err ? (
            <p className="p-8 text-center text-sm text-muted-foreground">{activeSearch ? "Aucun résultat." : unreadOnly ? "Aucun message non lu." : "Aucun message."}</p>
          ) : shownMessages.map((m) => (
            <button key={m.uid} onClick={() => openMessage(m.uid)} className={cn("flex w-full items-start gap-3 border-b border-border/60 px-3 py-2.5 text-left transition-colors hover:bg-accent/40", sel?.uid === m.uid ? "bg-accent/60" : !m.seen && "bg-primary/[0.03]")}>
              <Avatar name={m.from || m.fromAddr || "?"} size="sm" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span className={cn("truncate text-sm", !m.seen ? "font-semibold text-foreground" : "text-foreground/90")}>{m.from || m.fromAddr || "—"}</span>
                  <span className="shrink-0 text-[0.6875rem] text-muted-foreground">{fmtDate(m.date)}</span>
                </div>
                <span className={cn("block truncate text-sm", !m.seen ? "font-medium text-foreground" : "text-muted-foreground")}>{m.subject || "(sans objet)"}</span>
              </div>
              {!m.seen && <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary" />}
            </button>
          ))}
        </div>
      </div>

      {/* Lecteur / composeur — au téléphone, seulement quand il y a quelque chose à lire ou à écrire. */}
      <div className={cn("min-h-0 min-w-0 flex-1 flex-col", sel || compose ? "flex" : "hidden md:flex")}>
        {compose ? (
          <Composer email={email} initial={compose} onClose={() => setCompose(null)} />
        ) : sel ? (
          <Reader
            msg={sel}
            mailbox={mailbox}
            loading={loadingMsg}
            onBack={() => setSel(null)}
            onReply={() => setCompose({ to: sel.fromAddr, cc: "", subject: replySubject(sel.subject), body: sigTop + quoteBody(sel) })}
            onReplyAll={() => { const r = buildReplyAll(sel); setCompose({ to: r.to, cc: r.cc, subject: replySubject(sel.subject), body: sigTop + quoteBody(sel) }); }}
            onForward={() => setCompose({ to: "", cc: "", subject: `Tr: ${sel.subject}`, body: sigTop + forwardBody(sel) })}
          />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-muted-foreground">
            <MailIcon className="h-10 w-10 opacity-30" />
            <p className="text-sm">Sélectionnez un message{loadingMsg ? "…" : ""}</p>
          </div>
        )}
      </div>
    </div>
  );
}

function Reader({ msg, mailbox, loading, onBack, onReply, onReplyAll, onForward }: { msg: MsgDetail; mailbox: string; loading: boolean; onBack: () => void; onReply: () => void; onReplyAll: () => void; onForward: () => void }) {
  const [preview, setPreview] = React.useState<AttMeta | null>(null);
  const hasMultiple = Boolean(msg.cc) || msg.to.split(",").filter((s) => s.trim()).length > 1;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-gradient-to-r from-accent/30 to-transparent px-3 py-3 md:px-4">
        <button onClick={onBack} aria-label="Retour à la liste" className="rounded-lg p-2 text-muted-foreground hover:bg-secondary md:hidden"><ChevronLeft className="h-5 w-5" /></button>
        <Avatar name={msg.from || msg.fromAddr || "?"} size="md" />
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold">{msg.subject || "(sans objet)"}</p>
          <p className="truncate text-xs text-muted-foreground">{msg.from} &lt;{msg.fromAddr}&gt; · {fmtDate(msg.date)}</p>
          <p className="truncate text-xs text-muted-foreground">À : {msg.to || "—"}{msg.cc ? ` · Cc : ${msg.cc}` : ""}</p>
        </div>
        <LinkToDossier msg={msg} />
        <Button size="sm" variant="outline" onClick={onReply}><Reply className="h-4 w-4" /> Répondre</Button>
        {hasMultiple && <Button size="sm" variant="outline" onClick={onReplyAll}><ReplyAll className="h-4 w-4" /> <span className="hidden sm:inline">Répondre à tous</span></Button>}
        <Button size="sm" variant="outline" onClick={onForward}><Forward className="h-4 w-4" /> <span className="hidden sm:inline">Transférer</span></Button>
      </div>
      {msg.attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 border-b border-border px-4 py-2">
          {msg.attachments.map((a) => (
            <button key={a.index} type="button" onClick={() => setPreview(a)} title="Aperçu" className="inline-flex min-h-9 max-w-full items-center gap-1.5 rounded-lg border border-border bg-secondary/40 px-2.5 py-1 text-xs hover:bg-secondary md:min-h-0">
              <Paperclip className="h-3.5 w-3.5 shrink-0" /> <span className="min-w-0 truncate">{a.filename}</span>
            </button>
          ))}
        </div>
      )}
      {preview && <AttachmentPreview mailbox={mailbox} uid={msg.uid} att={preview} onClose={() => setPreview(null)} />}
      <div className="min-h-0 flex-1 overflow-auto bg-muted/10 p-3">
        {loading ? (
          <div className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Chargement…</div>
        ) : msg.html ? (
          <iframe title="message" sandbox="" className="h-full min-h-[60vh] w-full rounded-lg border border-border bg-white" srcDoc={msg.html} />
        ) : (
          <pre className="whitespace-pre-wrap rounded-lg border border-border bg-white p-4 text-sm text-neutral-900">{msg.text || "(message vide)"}</pre>
        )}
      </div>
    </div>
  );
}

/** Aperçu in-app d'une pièce jointe (PDF / image / texte) avant téléchargement. */
function AttachmentPreview({ mailbox, uid, att, onClose }: { mailbox: string; uid: number; att: AttMeta; onClose: () => void }) {
  const base = `/api/mail/attachment?mailbox=${encodeURIComponent(mailbox)}&uid=${uid}&index=${att.index}`;
  const inlineUrl = `${base}&inline=1`;
  const lower = att.filename.toLowerCase();
  const isImg = att.contentType.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp|svg)$/.test(lower);
  const isPdf = att.contentType === "application/pdf" || lower.endsWith(".pdf");
  const isText = att.contentType.startsWith("text/") || /\.(txt|csv|log|md)$/.test(lower);
  const canPreview = isImg || isPdf || isText;
  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-black/70 p-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))] sm:p-6" onClick={onClose}>
      <div className="mx-auto flex h-full w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b border-border px-3 py-2.5 sm:px-4">
          <Paperclip className="h-4 w-4 shrink-0 text-muted-foreground" />
          <p className="min-w-0 flex-1 truncate text-sm font-medium">{att.filename}</p>
          <a href={base} aria-label="Télécharger" className="inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-secondary sm:min-h-0"><ExternalLink className="h-3.5 w-3.5" /> <span className="hidden sm:inline">Télécharger</span></a>
          <button onClick={onClose} aria-label="Fermer l'aperçu" className="shrink-0 rounded-lg p-2 text-muted-foreground hover:bg-secondary sm:p-1.5"><X className="h-4 w-4" /></button>
        </div>
        <div className="min-h-0 flex-1 bg-muted/20">
          {isImg ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={inlineUrl} alt={att.filename} className="mx-auto max-h-full max-w-full object-contain" />
          ) : isPdf || isText ? (
            <iframe title={att.filename} src={inlineUrl} sandbox="" className="h-full min-h-[60vh] w-full bg-white" />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center text-sm text-muted-foreground">
              <Paperclip className="h-8 w-8" />
              <p>Aperçu non disponible pour ce type de fichier.</p>
              <a href={base} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 font-medium text-foreground hover:bg-secondary"><ExternalLink className="h-4 w-4" /> Télécharger</a>
            </div>
          )}
        </div>
        {canPreview && <p className="border-t border-border px-4 py-1.5 text-center text-[0.6875rem] text-muted-foreground">Aperçu — utilisez « Télécharger » pour enregistrer le fichier.</p>}
      </div>
    </div>
  );
}

function stripHtml(html: string): string {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Rattache l'e-mail affiché à un dossier de suivi (existant ou nouveau). */
function LinkToDossier({ msg }: { msg: MsgDetail }) {
  const [open, setOpen] = React.useState(false);
  const [dossiers, setDossiers] = React.useState<{ id: string; reference: string; title: string }[] | null>(null);
  const [target, setTarget] = React.useState(""); // id d'un dossier, ou "" = nouveau
  const [newTitle, setNewTitle] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [done, setDone] = React.useState<null | { id: string; reference: string }>(null);
  const [err, setErr] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (open && dossiers === null) {
      listLinkableDossiers().then((d) => { setDossiers(d); setTarget(d[0]?.id ?? ""); }).catch(() => setDossiers([]));
    }
  }, [open, dossiers]);
  // Repart à zéro quand on change de message.
  React.useEffect(() => { setOpen(false); setDone(null); setErr(null); setNewTitle(""); }, [msg.uid]);

  async function submit() {
    setBusy(true); setErr(null);
    const body = msg.text || (msg.html ? stripHtml(msg.html) : "");
    const r = await linkEmailToDossier({
      dossierId: target || null,
      newTitle: target ? null : (newTitle || msg.subject),
      from: msg.from || msg.fromAddr, subject: msg.subject, date: msg.date, body,
    });
    setBusy(false);
    if (r.ok) setDone({ id: r.dossierId!, reference: r.reference ?? "" });
    else setErr(r.error ?? "Échec du rattachement.");
  }

  return (
    <div className="relative">
      <Button size="sm" variant="outline" onClick={() => setOpen((v) => !v)}><FolderKanban className="h-4 w-4" /> <span className="hidden sm:inline">Lier à un dossier</span></Button>
      {open && (
        <div className="absolute right-0 top-full z-20 mt-1 w-72 max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-card p-3 shadow-xl">
          {done ? (
            <div className="space-y-2 text-sm">
              <p className="flex items-center gap-1.5 font-medium text-success"><Check className="h-4 w-4" /> E-mail lié{done.reference ? ` à ${done.reference}` : ""}.</p>
              <a href={`/dossiers/${done.id}`} className="inline-flex items-center gap-1 text-primary hover:underline"><ExternalLink className="h-3.5 w-3.5" /> Ouvrir le dossier</a>
            </div>
          ) : dossiers === null ? (
            <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Chargement…</div>
          ) : (
            <div className="space-y-2">
              <Label>Dossier</Label>
              <Select value={target} onChange={(e) => setTarget(e.target.value)}>
                {dossiers.map((d) => <option key={d.id} value={d.id}>{d.reference} — {d.title}</option>)}
                <option value="">➕ Nouveau dossier…</option>
              </Select>
              {target === "" && (
                <Input value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder={msg.subject || "Intitulé du dossier"} />
              )}
              {err && <p className="text-xs text-destructive">{err}</p>}
              <div className="flex justify-end gap-2 pt-1">
                <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Annuler</Button>
                <Button size="sm" onClick={submit} disabled={busy}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FolderKanban className="h-4 w-4" />} Lier</Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Édite la signature e-mail (ajoutée en bas des nouveaux messages, réponses et transferts). */
function SignatureSheet({ open, onClose, initial, onSaved }: { open: boolean; onClose: () => void; initial: string; onSaved: (s: string) => void }) {
  const [text, setText] = React.useState(initial);
  const [saving, setSaving] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  // Repart de la valeur enregistrée à chaque ouverture.
  React.useEffect(() => { if (open) { setText(initial); setErr(null); } }, [open, initial]);

  async function save() {
    setSaving(true); setErr(null);
    const fd = new FormData(); fd.set("signature", text);
    const r = await updateMailSignature(fd);
    setSaving(false);
    if (r.ok) { onSaved(text.trimEnd()); onClose(); }
    else setErr(r.error ?? "Enregistrement impossible.");
  }

  return (
    <Sheet open={open} onClose={() => !saving && onClose()} title="Signature e-mail" width="md">
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">Elle est insérée automatiquement au bas de vos nouveaux messages, réponses et transferts. Laissez vide pour ne pas en ajouter.</p>
        <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={8}
          placeholder={"Cordialement,\nPrénom NOM\nAdventum Pharma\n+213 …"} />
        {text.trim() && (
          <div className="rounded-lg border border-border bg-secondary/30 p-3">
            <p className="mb-1 text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground">Aperçu</p>
            <pre className="whitespace-pre-wrap text-sm">{text.trimEnd()}</pre>
          </div>
        )}
        {err && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose} disabled={saving}>Annuler</Button>
          <Button type="button" onClick={save} disabled={saving}>{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Enregistrer</Button>
        </div>
      </div>
    </Sheet>
  );
}

function Composer({ email, initial, onClose }: { email: string; initial: { to: string; cc: string; subject: string; body: string }; onClose: () => void }) {
  const [saving, setSaving] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [sent, setSent] = React.useState(false);
  const [contacts, setContacts] = React.useState<Contact[]>([]);
  const [showCc, setShowCc] = React.useState(Boolean(initial.cc));
  const [files, setFiles] = React.useState<File[]>([]);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const addFiles = (list: FileList | null) => { if (list) setFiles((cur) => [...cur, ...Array.from(list)]); if (fileRef.current) fileRef.current.value = ""; };
  const removeFile = (i: number) => setFiles((cur) => cur.filter((_, idx) => idx !== i));
  // Verrou synchrone : empêche tout double-envoi (double-clic / double soumission)
  // même avant que l'état `saving` ne soit re-rendu.
  const inFlight = React.useRef(false);

  async function send(fd: FormData) {
    if (inFlight.current) return;
    inFlight.current = true;
    setSaving(true); setErr(null);
    try {
      files.forEach((f) => fd.append("attachments", f));
      const r = await sendMailAction(fd);
      if (r.ok) setSent(true);
      else setErr(r.error ?? "Envoi impossible.");
    } finally {
      setSaving(false);
      inFlight.current = false;
    }
  }

  // Carnet d'adresses (collègues + correspondants récents) chargé une fois.
  React.useEffect(() => {
    let alive = true;
    fetch("/api/mail/contacts", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { contacts: [] }))
      .then((d) => { if (alive) setContacts(d.contacts ?? []); })
      .catch(sansBloquer("mail-client.Composer.fetch"));
    return () => { alive = false; };
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between border-b border-border px-3 py-2.5 md:px-4">
        <p className="font-semibold">Nouveau message</p>
        <button onClick={onClose} aria-label="Fermer le message" className="rounded-lg p-2 text-muted-foreground hover:bg-secondary md:p-1.5"><X className="h-4 w-4" /></button>
      </div>
      {sent ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-success">
          <SendIcon className="h-10 w-10" /><p className="font-medium">Message envoyé !</p>
          <Button size="sm" variant="outline" onClick={onClose}>Fermer</Button>
        </div>
      ) : (
        <form action={send} className="flex min-h-0 flex-1 flex-col gap-2 p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] md:p-4">
          <p className="text-xs text-muted-foreground">De : {email}</p>
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <Label>À</Label>
              {!showCc && <button type="button" onClick={() => setShowCc(true)} className="text-xs text-primary hover:underline">+ Cc</button>}
            </div>
            <AddressInput name="to" defaultValue={initial.to} contacts={contacts} required placeholder="Commencez à taper un nom ou une adresse…" />
          </div>
          {showCc && <div className="space-y-1"><Label>Cc</Label><AddressInput name="cc" defaultValue={initial.cc} contacts={contacts} placeholder="cc@exemple.com" /></div>}
          <div className="space-y-1"><Label>Objet</Label><Input name="subject" defaultValue={initial.subject} /></div>
          <div className="flex min-h-0 flex-1 flex-col space-y-1"><Label>Message</Label><Textarea name="body" defaultValue={initial.body} className="min-h-0 flex-1 resize-none" /></div>
          {files.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {files.map((f, i) => (
                <span key={`${f.name}-${i}`} className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-secondary/40 px-2 py-1 text-xs">
                  <Paperclip className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="max-w-[12rem] truncate">{f.name}</span>
                  <span className="text-muted-foreground">{fmtSize(f.size)}</span>
                  <button type="button" onClick={() => removeFile(i)} className="rounded p-1.5 text-muted-foreground hover:bg-secondary hover:text-destructive md:p-0.5" aria-label="Retirer la pièce jointe"><X className="h-3 w-3" /></button>
                </span>
              ))}
            </div>
          )}
          <input ref={fileRef} type="file" multiple className="hidden" onChange={(e) => addFiles(e.target.files)} />
          {err && <div className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> {err}</div>}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <button type="button" onClick={() => fileRef.current?.click()} className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-sm font-medium hover:bg-secondary md:min-h-0"><Paperclip className="h-4 w-4" /> Joindre</button>
            <div className="flex gap-2"><Button type="button" variant="ghost" onClick={onClose}>Annuler</Button><Button type="submit" disabled={saving}>{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <SendIcon className="h-4 w-4" />} Envoyer</Button></div>
          </div>
        </form>
      )}
    </div>
  );
}

/** Champ d'adresse avec autocomplétion (collègues + correspondants récents). Gère
 *  plusieurs destinataires séparés par des virgules : seul le dernier est complété. */
function AddressInput({ name, defaultValue, contacts, required, placeholder }: { name: string; defaultValue?: string; contacts: Contact[]; required?: boolean; placeholder?: string }) {
  const [value, setValue] = React.useState(defaultValue ?? "");
  const [open, setOpen] = React.useState(false);
  const [hi, setHi] = React.useState(0);

  const token = (value.split(",").pop() ?? "").trim().toLowerCase();
  const chosen = new Set(value.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
  const suggestions = token.length >= 1
    ? contacts.filter((c) => !chosen.has(c.address) && (c.address.includes(token) || c.name.toLowerCase().includes(token))).slice(0, 8)
    : [];

  const pick = (addr: string) => {
    const parts = value.split(",");
    parts[parts.length - 1] = ` ${addr}`;
    setValue(parts.join(",").replace(/^\s+/, "") + ", ");
    setOpen(false); setHi(0);
  };

  return (
    <div className="relative">
      <Input
        name={name} required={required} autoComplete="off" value={value} placeholder={placeholder}
        onChange={(e) => { setValue(e.target.value); setOpen(true); setHi(0); }}
        onFocus={() => setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (!open || suggestions.length === 0) return;
          if (e.key === "ArrowDown") { e.preventDefault(); setHi((h) => Math.min(h + 1, suggestions.length - 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
          else if (e.key === "Enter" || e.key === "Tab") {
            if (e.key === "Enter") e.preventDefault();
            pick(suggestions[hi].address);
          } else if (e.key === "Escape") setOpen(false);
        }}
      />
      {open && suggestions.length > 0 && (
        <ul className="absolute z-20 mt-1 max-h-56 w-full overflow-auto rounded-lg border border-border bg-background py-1 shadow-lg">
          {suggestions.map((c, i) => (
            <li key={c.address}>
              <button type="button" onMouseDown={(e) => { e.preventDefault(); pick(c.address); }}
                className={cn("flex w-full flex-col px-3 py-1.5 text-left hover:bg-secondary", i === hi && "bg-secondary")}>
                <span className="truncate text-sm font-medium">{c.name || c.address}</span>
                {c.name && <span className="truncate text-xs text-muted-foreground">{c.address}{c.source === "interne" ? " · collègue" : ""}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
