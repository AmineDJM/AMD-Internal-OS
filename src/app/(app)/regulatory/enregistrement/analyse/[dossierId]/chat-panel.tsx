"use client";

import * as React from "react";
import { Loader2, Send, Paperclip, FileDown, X, MessageSquarePlus } from "lucide-react";
import { askDossierAgentAction, loadDossierChatAction, resetDossierChatAction } from "@/lib/regulatory/intelligence/knowledge/actions";
import type { ThreadMessageView } from "@/lib/regulatory/intelligence/knowledge/dossier-thread";
import { useConfirmer } from "@/components/ui/dialogue";
import { useRetours } from "@/components/ui/retour";
import { actionFailureMessage } from "@/lib/action-outcome";
import { sansBloquer } from "@/lib/journal";

/** Même forme que les messages persistés côté serveur — le fil recharge à l'identique. */
type Msg = ThreadMessageView;

const SUGGESTIONS = [
  "Quelle est la durée de conservation (stabilité) ?",
  "Fais-moi l'état complet du dossier et ses points faibles",
  "Voici une réserve ANPP — propose un projet de réponse",
  "Génère une note de synthèse PDF de ce dossier",
];

/**
 * AGENT DE DOSSIER — « Discuter avec ce dossier », version OUTILLÉE.
 *
 * L'agent DÉCIDE de ses recherches : pièces réelles du dossier, corpus réglementaire opposable
 * (ANPP/ICH/UE), bibliothèque des réserves passées, état de l'analyse — en plusieurs tours si la
 * question l'exige. On peut lui SOUMETTRE des pièces (lettre de réserves, certificat, rapport —
 * les scans sont océrisés) et lui demander des LIVRABLES : il génère des PDF propres,
 * téléchargeables ici même. Chaque fait cité porte sa source ; il n'invente rien.
 *
 * MESSAGERIE : le fil persiste côté serveur — on quitte l'app, on revient, la discussion est là,
 * et l'agent revoit les pièces déjà soumises. L'historique n'est plus transporté par le client.
 */
export function DossierChatPanel({ dossierId, configured, canView }: { dossierId: string; configured: boolean; canView: boolean }) {
  const confirmer = useConfirmer();
  const retours = useRetours();
  const [messages, setMessages] = React.useState<Msg[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [input, setInput] = React.useState("");
  const [attached, setAttached] = React.useState<File[]>([]);
  const [busy, setBusy] = React.useState(false);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);

  // Rechargement du fil persistant au montage — la discussion reprend où elle s'était arrêtée.
  React.useEffect(() => {
    if (!canView) { setLoading(false); return; }
    let alive = true;
    const fd = new FormData();
    fd.set("dossierId", dossierId);
    loadDossierChatAction(fd)
      .then((r) => { if (alive && r.ok) setMessages(r.messages); })
      .catch(sansBloquer("chat-panel.DossierChatPanel.loadDossierChatAction"))
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [dossierId, canView]);

  React.useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy]);

  const addFiles = (files: FileList | null) => {
    if (!files) return;
    const list = Array.from(files).filter((f) => f.size > 0);
    // 3 pièces au plus par message : au-delà, mieux vaut plusieurs échanges ciblés qu'un fourre-tout.
    setAttached((prev) => [...prev, ...list].slice(0, 3));
  };

  async function send(e?: React.FormEvent) {
    e?.preventDefault();
    const q = input.trim();
    if ((!q && attached.length === 0) || busy) return;
    const question = q || "Analyse la ou les pièces jointes et dis-moi ce qu'elles impliquent pour ce dossier.";
    // L'historique n'est PLUS envoyé : le serveur relit le fil persistant (pièces comprises).
    const sending = attached;
    setMessages((m) => [...m, { role: "user", text: question, attachedNames: sending.map((f) => f.name) }]);
    setInput("");
    setAttached([]);
    setBusy(true);
    try {
      const fd = new FormData();
      fd.set("dossierId", dossierId);
      fd.set("question", question);
      for (const f of sending) fd.append("files", f, f.name);
      const r = await askDossierAgentAction(fd);
      setMessages((m) => [...m, r.ok
        ? { role: "assistant", text: r.answer || "(réponse vide)", citations: r.citations, files: r.files }
        : { role: "assistant", text: r.error ?? "Réponse indisponible.", error: true }]);
    } catch {
      // La CONNEXION a lâché — pas forcément l'agent : côté serveur il continue, et sa réponse
      // entre dans le fil persistant. On la RÉCUPÈRE par sondage au lieu d'abandonner.
      setMessages((m) => [...m, { role: "assistant", text: "La connexion a été interrompue — l'agent continue en arrière-plan, sa réponse apparaîtra ici dès qu'elle est prête…", error: true }]);
      // `messages` (fermeture) = le fil AVANT cet envoi : la réponse attendue porte le fil
      // serveur à au moins « avant + question + réponse » — garde contre une vieille réponse.
      void recoverFromThread(messages.length + 2);
    } finally {
      setBusy(false);
    }
  }

  /**
   * REPRISE APRÈS COUPURE : le serveur écrit la réponse dans le fil même si le navigateur a
   * perdu la connexion (les gros tours peuvent durer plusieurs minutes). On resonde le fil
   * toutes les 6 s pendant 6 min ; dès que LA réponse de ce tour (non-erreur, fil suffisamment
   * long) est là, on recharge la discussion — la vérité serveur remplace l'état local.
   */
  async function recoverFromThread(minLen: number) {
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 6000));
      try {
        const fd = new FormData();
        fd.set("dossierId", dossierId);
        const r = await loadDossierChatAction(fd);
        const last = r.ok ? r.messages[r.messages.length - 1] : undefined;
        if (last && last.role === "assistant" && !last.error && r.messages.length >= minLen) {
          setMessages(r.messages);
          return;
        }
      } catch {
        /* toujours coupé — on retentera au prochain tour */
      }
    }
  }

  if (!canView) return null;

  async function resetThread() {
    if (busy || messages.length === 0) return;
    if (!(await confirmer("Commencer une nouvelle discussion ? Le fil actuel sera effacé et l'agent oubliera les pièces soumises."))) return;
    const fd = new FormData();
    fd.set("dossierId", dossierId);
    try {
      const r = await resetDossierChatAction(fd);
      if (r.ok) setMessages([]);
      else retours.erreur(r.error ?? "La discussion n'a pas été effacée.");
    } catch {
      retours.erreur(actionFailureMessage("THROWN"));
    }
  }

  return (
    <div className="flex flex-col overflow-hidden rounded-lg border border-border/60 bg-card">
      {messages.length > 0 && !loading && (
        <div className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-1.5">
          <p className="truncate text-[0.6875rem] text-muted-foreground">Discussion enregistrée — quittez, revenez : elle reprend ici.</p>
          <button type="button" onClick={resetThread} disabled={busy}
            className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1.5 text-[0.6875rem] sm:py-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50">
            <MessageSquarePlus className="h-3.5 w-3.5" /> Nouvelle discussion
          </button>
        </div>
      )}
      <div ref={scrollRef} className="max-h-[26rem] min-h-[8rem] space-y-3 overflow-y-auto p-3">
        {loading && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Reprise de la discussion…
          </div>
        )}
        {!loading && messages.length === 0 && (
          <div className="space-y-2 text-xs text-muted-foreground">
            <p>
              Discutez avec ce dossier : l'agent cherche lui-même dans les <strong>pièces réellement lues</strong>, le{" "}
              <strong>corpus réglementaire</strong> (ANPP · ICH · UE) et les <strong>réserves passées</strong>, et cite ses
              sources. Joignez-lui une <strong>pièce ou une lettre de réserves</strong> (📎 — les scans sont océrisés), ou
              demandez-lui un <strong>PDF propre</strong> (note, projet de réponse). La discussion <strong>reste
              enregistrée</strong> — comme une messagerie, l'agent se souvient des pièces déjà soumises. Il n'invente rien
              et ne conclut jamais à votre place.
            </p>
            <div className="flex flex-wrap gap-1.5">
              {SUGGESTIONS.map((s) => (
                <button key={s} type="button" onClick={() => setInput(s)}
                  className="rounded-full border border-border px-2.5 py-1.5 text-left text-[0.6875rem] transition-colors hover:bg-accent sm:py-1">
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
            <div className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
              m.role === "user" ? "bg-primary text-primary-foreground"
                : m.error ? "border border-destructive/30 bg-destructive/5 text-destructive"
                : "border border-border/60 bg-background"}`}>
              {m.attachedNames && m.attachedNames.length > 0 && (
                <p className="mb-1 flex flex-wrap gap-1">
                  {m.attachedNames.map((n) => (
                    <span key={n} className="inline-flex items-center gap-1 rounded bg-primary-foreground/15 px-1.5 py-0.5 text-[0.6875rem]">
                      <Paperclip className="h-3 w-3" /> {n}
                    </span>
                  ))}
                </p>
              )}
              <p className="whitespace-pre-wrap break-words">{m.text}</p>
              {m.files && m.files.length > 0 && (
                <div className="mt-2 space-y-1 border-t border-border/40 pt-2">
                  {m.files.map((f) => (
                    <a key={f.url} href={f.url} className="inline-flex max-w-full items-center gap-1.5 break-all rounded-md border border-primary/40 bg-primary/5 px-2 py-1 text-xs font-medium text-primary hover:bg-primary/10">
                      <FileDown className="h-3.5 w-3.5" /> {f.name}
                    </a>
                  ))}
                  <p className="text-[0.6875rem] text-muted-foreground">PROJET généré par l'agent — revue humaine requise.</p>
                </div>
              )}
              {m.citations && m.citations.length > 0 && (
                <ul className="mt-2 space-y-1 border-t border-border/40 pt-2">
                  {m.citations.map((c) => (
                    <li key={c.n} className="text-[0.6875rem] text-muted-foreground">
                      <span className="font-medium text-foreground">[{c.n}] {c.filename}</span>
                      {c.ctdSection ? ` · ${c.ctdSection}` : ""}
                      {c.page ? ` · p.${c.page}` : ""}
                      <span className="mt-0.5 block truncate italic opacity-80" title={c.snippet}>« {c.snippet} »</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        ))}

        {busy && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> L'agent cherche (dossier, corpus, réserves)…
          </div>
        )}
      </div>

      {attached.length > 0 && (
        <div className="flex flex-wrap gap-1.5 border-t border-border/60 px-2 pt-2">
          {attached.map((f, i) => (
            <span key={`${f.name}-${i}`} className="inline-flex max-w-full items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs [overflow-wrap:anywhere]">
              <Paperclip className="h-3 w-3" /> {f.name}
              <button type="button" aria-label={`Retirer ${f.name}`} className="-my-1 -mr-1.5 rounded-full p-1.5 sm:m-0 sm:p-0" onClick={() => setAttached((prev) => prev.filter((_, j) => j !== i))}>
                <X className="h-3 w-3 text-muted-foreground hover:text-destructive" />
              </button>
            </span>
          ))}
        </div>
      )}

      <form onSubmit={send} className="flex items-center gap-2 border-t border-border/60 p-2">
        <input ref={fileRef} type="file" multiple hidden accept=".pdf,.docx,.txt,.md,.csv,.xlsx,.xls,.png,.jpg,.jpeg,.tif,.tiff"
          onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
        <button type="button" onClick={() => fileRef.current?.click()} disabled={busy}
          aria-label="Joindre une pièce (PDF, scan, lettre de réserves…)"
          className="inline-flex items-center rounded-md border border-border px-2.5 py-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50">
          <Paperclip className="h-4 w-4" />
        </button>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={configured ? "Discuter avec ce dossier — question, réserve à traiter, PDF à produire…" : "Clé IA requise — les sources restent affichées"}
          aria-label="Question sur le dossier"
          className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
        />
        <button type="submit" disabled={busy || (!input.trim() && attached.length === 0)}
          className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-opacity disabled:opacity-50">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          <span className="hidden sm:inline">Demander</span>
        </button>
      </form>
    </div>
  );
}
