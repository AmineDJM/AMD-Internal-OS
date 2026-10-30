"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AudioLines, Loader2, Mic, MicOff, PhoneOff, X } from "lucide-react";
import { ClientVoixTempsReel, type EtatVoix, type ResultatDelegation } from "@/platform/ia/voix/client-temps-reel";
import { confirmerIntentionAssistantIA } from "@/modules/assistant-ia/actions";
import { CIBLE_LATENCE_VOCALE_MS, mediane } from "@/modules/assistant-ia/partage";
import { ActionConfirmationCard } from "./action-confirmation-card";
import { attendu, sansBloquer } from "@/lib/journal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA CONVERSATION VOCALE DE L'ASSISTANT IA (lot J13, décision 0025) — GPT-Live tient la conversation, l'assistant du fil
 * (mêmes outils, droits et repères que le texte) fait le travail délégué.
 *
 * Ce que l'écran garde, parce qu'une parole ne se reprend pas : les CARTES (une écriture préparée à la voix ne
 * s'exécute que par son bouton, ressaisie comprise pour une carte critique), les VALEURS CONFIDENTIELLES (montrées
 * ici à qui a le droit, jamais lues), et la ligne de ce qui a été dit. La latence (fin de parole → premier son) est
 * affichée et journalisée : la cible est 1,5 s au p50.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

interface Carte { intentId: string; kind: string; title: string; fields?: { label: string; value: string }[]; warnings?: string[]; confirmText?: string; libelleBouton?: string }
type Ligne = { qui: "personne" | "assistant"; texte: string } | { qui: "carte"; carte: Carte } | { qui: "ecran"; texte: string };

const LIBELLE_ETAT: Record<EtatVoix, string> = {
  INACTIF: "Prêt", CONNEXION: "Connexion…", ECOUTE: "À l'écoute", REFLEXION: "Je regarde…", PAROLE: "L'assistant parle",
  FERMETURE: "Fin de la conversation…", ERREUR: "Erreur", TERMINE: "Conversation terminée",
};

/**
 * `conversation` (décision 0027, Adventum IA) : la conversation OUVERTE, où la voix délègue et où la transcription
 * s'écrit — rendue au moment de parler (une « nouvelle conversation » se crée alors). Absente : la conversation courante.
 */
export function BoutonVoixTempsReel({ desactive, conversation, className }: {
  desactive?: boolean;
  conversation?: () => Promise<string | null>;
  className?: string;
}) {
  const [ouvert, setOuvert] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOuvert(true)} disabled={desactive} data-testid="voix-temps-reel"
        aria-label="Conversation vocale avec l'assistant" title="Conversation vocale (gpt-live-1)"
        className={className ?? "flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-slate-600 hover:bg-slate-100 disabled:opacity-40 dark:text-zinc-300 dark:hover:bg-zinc-800"}>
        <AudioLines className="h-5 w-5" />
      </button>
      {/* Un PORTAIL : la barre de saisie a un fond flouté, qui ferait du panneau « fixe » un enfant de la barre. */}
      {ouvert && typeof document !== "undefined" && createPortal(<PanneauVoix onFermer={() => setOuvert(false)} conversation={conversation} />, document.body)}
    </>
  );
}

function PanneauVoix({ onFermer, conversation }: { onFermer: () => void; conversation?: () => Promise<string | null> }) {
  // La conversation, résolue au premier geste puis gardée : délégations et transcription vont au même endroit.
  const cible = useRef<string | null | undefined>(undefined);
  const conversationOuverte = useCallback(async (): Promise<string | null> => {
    if (cible.current === undefined) cible.current = conversation ? await conversation().catch(sansBloquer("voix-temps-reel.conversation", null)) : null;
    return cible.current;
  }, [conversation]);
  const [etat, setEtat] = useState<EtatVoix>("INACTIF");
  const [detail, setDetail] = useState<string | null>(null);
  const [lignes, setLignes] = useState<Ligne[]>([]);
  const [latences, setLatences] = useState<number[]>([]);
  const [muet, setMuet] = useState(false);
  const client = useRef<ClientVoixTempsReel | null>(null);
  const dites = useRef<{ qui: "personne" | "assistant"; texte: string }[]>([]);

  const ajouter = (l: Ligne) => setLignes((xs) => [...xs, l].slice(-60));

  const deleguer = useCallback(async (demande: string): Promise<ResultatDelegation> => {
    const r = await fetch("/api/assistant-ia/voix/delegation", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ demande, conversation: await conversationOuverte() }) });
    if (!r.ok) return { pourVoix: "Le serveur n'a pas répondu : dis-le et propose de réessayer." };
    return (await r.json()) as ResultatDelegation;
  }, [conversationOuverte]);

  const ouvrir = useCallback(async (sdp: string): Promise<{ sdp: string }> => {
    const r = await fetch("/api/assistant-ia/voix/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sdp }) });
    const d = (await r.json().catch(attendu("réponse non JSON : le statut HTTP décide", {}))) as { sdp?: string; error?: string };
    // Pas de modèle de secours (Direction, 30/10) : l'échec se DIT.
    if (!r.ok || !d.sdp) throw new Error(d.error ?? "La conversation vocale est indisponible.");
    return { sdp: d.sdp };
  }, []);

  const terminer = useCallback(async () => {
    const c = client.current;
    client.current = null;
    if (!c) return;
    await c.fermer();
    const corps = JSON.stringify({ secondes: c.secondes, confirme: c.usageConfirme, latences: c.latences, lignes: dites.current, conversation: cible.current ?? null });
    dites.current = [];
    // Le journal part même si l'onglet se ferme.
    if (!navigator.sendBeacon?.("/api/assistant-ia/voix/journal", new Blob([corps], { type: "application/json" }))) {
      void fetch("/api/assistant-ia/voix/journal", { method: "POST", headers: { "content-type": "application/json" }, body: corps, keepalive: true }).catch(sansBloquer("voix-temps-reel.journal"));
    }
  }, []);

  const demarrer = useCallback(async () => {
    setDetail(null);
    const c = new ClientVoixTempsReel({ ouvrir, deleguer }, {
      etat: (e, x) => { setEtat(e); if (x) setDetail(x); },
      ligne: (qui, texte) => { dites.current.push({ qui, texte }); ajouter({ qui, texte }); },
      delegation: (_demande, res) => {
        if (res.carte) ajouter({ qui: "carte", carte: res.carte as Carte });
        if (res.ecran) ajouter({ qui: "ecran", texte: res.ecran });
      },
      latence: (ms) => setLatences((xs) => [...xs, ms]),
    });
    client.current = c;
    await conversationOuverte();
    try { await c.connecter(); } catch { client.current = null; }
  }, [ouvrir, deleguer, conversationOuverte]);

  useEffect(() => () => { void terminer(); }, [terminer]);

  const p50 = mediane(latences);
  const actif = etat === "ECOUTE" || etat === "REFLEXION" || etat === "PAROLE" || etat === "FERMETURE";
  return (
    <div role="dialog" aria-label="Conversation vocale" className="fixed inset-0 z-[60] flex flex-col bg-white dark:bg-zinc-950 sm:inset-auto sm:bottom-24 sm:right-6 sm:h-[34rem] sm:w-[26rem] sm:rounded-2xl sm:border sm:border-slate-200 sm:shadow-2xl dark:sm:border-zinc-800">
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-zinc-800">
        <div>
          <p className="text-sm font-semibold">Conversation vocale</p>
          <p className="text-xs text-slate-500" data-testid="etat-voix">{LIBELLE_ETAT[etat]}{p50 != null ? ` · réponse en ${(p50 / 1000).toFixed(1)} s (médiane)` : ""}</p>
        </div>
        <button type="button" onClick={() => { void terminer(); onFermer(); }} aria-label="Fermer" className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 dark:hover:bg-zinc-800"><X className="h-4 w-4" /></button>
      </div>
      <div className="flex-1 space-y-2 overflow-y-auto px-4 py-3 text-sm">
        <p className="rounded-lg bg-slate-50 p-2.5 text-xs text-slate-600 dark:bg-zinc-900 dark:text-zinc-400">
          L&apos;assistant a vos outils et vos droits. Une action qu&apos;il prépare s&apos;affiche ici en carte : elle ne s&apos;exécute que par son bouton, jamais à la voix. Une valeur confidentielle n&apos;est jamais lue : elle s&apos;affiche ici si vous avez le droit de la voir.
        </p>
        {lignes.map((l, i) => l.qui === "carte" ? (
          <ActionConfirmationCard key={i} intentId={l.carte.intentId} kind={l.carte.kind} title={l.carte.title} fields={l.carte.fields} warnings={l.carte.warnings}
            confirmText={l.carte.confirmText} libelleBouton={l.carte.libelleBouton} onConfirm={(id, t) => confirmerIntentionAssistantIA(id, t)} />
        ) : l.qui === "ecran" ? (
          <pre key={i} className="whitespace-pre-wrap break-words rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">{l.texte.slice(0, 1_500)}</pre>
        ) : (
          <p key={i} className={l.qui === "personne" ? "ml-8 rounded-xl bg-violet-50 px-3 py-2 dark:bg-violet-950/40" : "mr-8 rounded-xl bg-slate-100 px-3 py-2 dark:bg-zinc-900"}>{l.texte}</p>
        ))}
        {detail && <p role="alert" className="text-xs text-red-600">{detail}</p>}
        {p50 != null && p50 > CIBLE_LATENCE_VOCALE_MS && <p className="text-[11px] text-slate-400">Réseau lent : la réponse dépasse 1,5 s.</p>}
      </div>
      <div className="flex items-center justify-center gap-3 border-t border-slate-200 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 dark:border-zinc-800">
        {!actif && etat !== "CONNEXION" ? (
          <button type="button" onClick={() => void demarrer()} className="flex h-14 flex-1 items-center justify-center gap-2 rounded-full bg-[var(--aia-accent,#7c3aed)] text-sm font-medium text-white">
            <Mic className="h-5 w-5" /> Parler à l&apos;assistant
          </button>
        ) : etat === "CONNEXION" ? (
          <span className="flex h-14 flex-1 items-center justify-center gap-2 text-sm text-slate-500"><Loader2 className="h-5 w-5 animate-spin" /> Connexion…</span>
        ) : (
          <>
            <button type="button" onClick={() => { const m = !muet; setMuet(m); client.current?.muet(m); }} aria-pressed={muet} aria-label={muet ? "Réactiver le micro" : "Couper le micro"}
              className="flex h-14 w-14 items-center justify-center rounded-full bg-slate-100 dark:bg-zinc-800">{muet ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}</button>
            <button type="button" onClick={() => void terminer()} aria-label="Raccrocher" className="flex h-14 w-14 items-center justify-center rounded-full bg-red-600 text-white"><PhoneOff className="h-5 w-5" /></button>
          </>
        )}
      </div>
    </div>
  );
}
