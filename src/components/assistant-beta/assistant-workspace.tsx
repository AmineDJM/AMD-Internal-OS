"use client";

import React, { useCallback, useEffect, useState } from "react";
import Image from "next/image";
import { LuminescentCursor } from "./luminescent-cursor";
import { ChatMessageList, type ChatMessage } from "./chat-message-list";
import { CommandPillBar } from "./command-pill-bar";
import { MemoirePanel } from "./memoire-panel";
import { RoutinesPanel } from "./routines-panel";
import { BoutonJoindre, PiecesEnAttente, televerser, type PieceJointe } from "./pieces-jointes";
import { AlarmClock, Brain } from "lucide-react";
import { envoyerAuFil, listerMesRoutines, repartirDeZero } from "@/lib/actions/assistant-ia-actions";
import { envoyerMessageBeta, confirmerActionBeta } from "@/app/(app)/assistant/beta/actions";
import type { KpiData } from "./kpi-glass-strip";
import { useConfirmer } from "@/components/ui/dialogue";
import { actionFailureMessage } from "@/lib/action-outcome";
import { sansBloquer } from "@/lib/journal";

export interface AssistantWorkspaceProps {
  initialKpiData?: KpiData;
  userName?: string;
  userRole?: string;
}

/** L'accueil, au prénom de la personne : l'assistant travaille pour ELLE, avec SES droits. */
function accueil(userName?: string): string {
  const prenom = (userName ?? "").trim().split(/\s+/)[0];
  return `Bonjour${prenom ? ` ${prenom}` : ""} 👋\n\nJe suis votre assistant interne. Je lis ce que vos accès vous permettent de voir, et je prépare vos demandes (sponsoring, prise en charge, événement, matériel promotionnel…), tâches et messages — rien ne part sans votre confirmation.\n\nNotre conversation est gardée : vous pouvez quitter cet écran pendant que je travaille, je vous préviens quand c'est prêt. Vous pouvez aussi m'écrire plusieurs messages d'affilée — je les traite dans l'ordre, sans en perdre aucun.\n\nComment puis-je vous aider ?`;
}

/** Un tour du fil tel que le serveur le rend (`/api/assistant-ia/fil`). */
interface TourDuFil {
  id: string;
  role: "user" | "assistant";
  contenu: string;
  etat: "EN_ATTENTE" | "EN_COURS" | "TRAITE" | "TERMINE" | "ECHEC";
  pieces?: { id: string; nom: string }[] | null;
  blocs?: ChatMessage["blocs"] | null;
  intent?: ChatMessage["intent"] | null;
  memoireProposee?: ChatMessage["memoireProposee"] | null;
  outils?: string[];
  etapes?: string[];
  createdAt: string;
}

function versMessage(t: TourDuFil): ChatMessage {
  if (t.role === "user") {
    return {
      id: t.id, role: "user", content: t.contenu, pieces: t.pieces ?? undefined, createdAt: t.createdAt,
      etat: t.etat === "EN_ATTENTE" ? "attente" : undefined,
    };
  }
  const redaction = t.etat === "EN_COURS";
  return {
    id: t.id, role: "assistant", content: t.contenu, createdAt: t.createdAt,
    blocs: t.blocs ?? undefined, intent: t.intent ?? null, memoireProposee: t.memoireProposee ?? null,
    outilsAppeles: redaction ? t.etapes ?? [] : (t.outils?.length ? t.outils : t.etapes ?? []),
    etat: redaction ? "redaction" : t.etat === "ECHEC" ? "echec" : undefined,
  };
}

export function AssistantWorkspace({ userName }: AssistantWorkspaceProps) {
  const bienvenue: ChatMessage = { id: "welcome-1", role: "assistant", content: accueil(userName) };
  const confirmer = useConfirmer();
  const [memoireOuverte, setMemoireOuverte] = useState(false);
  const [routinesOuvertes, setRoutinesOuvertes] = useState(false);
  const [routineInitiale, setRoutineInitiale] = useState<string | null>(null);
  const [nonLus, setNonLus] = useState(0);
  const majNonLus = useCallback((n: number) => setNonLus(n), []);

  // Une notification de routine mène ici (« ?routine=… ») : le panneau s'ouvre sur son dernier passage.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("routine");
    if (id) { setRoutineInitiale(id); setRoutinesOuvertes(true); }
    void listerMesRoutines().then((r) => { if (r.ok) setNonLus(r.nonLus); }).catch(sansBloquer("assistant-workspace.AssistantWorkspace.listerMesRoutines"));
  }, []);
  const [pieces, setPieces] = useState<PieceJointe[]>([]);
  const envoiEnCours = pieces.some((p) => p.etat === "envoi");

  // ── LE FIL GARDÉ (27/10) : la conversation vit sur le serveur, pas dans l'onglet ──────────────
  // À l'ouverture : le fil tel qu'il est (même si l'on était parti pendant une réponse). Tant
  // qu'un tour s'écrit, une lecture par seconde ; sinon une toutes les 15 s (la présence).
  const [fil, setFil] = useState<ChatMessage[]>([]);
  const [travaille, setTravaille] = useState(false);
  const [vueExacte, setVueExacte] = useState(false);
  // En « Vue exacte » : rien n'est écrit dans le fil de la personne regardée — conversation de l'onglet.
  const [locaux, setLocaux] = useState<ChatMessage[]>([]);
  const [localEnCours, setLocalEnCours] = useState(false);
  const [envoi, setEnvoi] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);

  const lire = useCallback(async (): Promise<boolean> => {
    try {
      const r = await fetch("/api/assistant-ia/fil", { cache: "no-store" });
      if (!r.ok) return false;
      const d = (await r.json()) as { tours: TourDuFil[]; enCours: boolean; vueExacte: boolean };
      setVueExacte(d.vueExacte);
      setFil(d.tours.map(versMessage));
      setTravaille(d.enCours);
      return d.enCours;
    } catch {
      return false;
    }
  }, []);
  useEffect(() => {
    let arret = false;
    let minuteur: ReturnType<typeof setTimeout> | undefined;
    const boucle = async () => {
      clearTimeout(minuteur);
      const enCours = await lire();
      if (!arret) minuteur = setTimeout(boucle, enCours ? 900 : 15_000);
    };
    void boucle();
    const relancer = () => void boucle();
    const auRetour = () => { if (document.visibilityState === "visible") void boucle(); };
    window.addEventListener("assistant-fil:relancer", relancer);
    document.addEventListener("visibilitychange", auRetour);
    return () => {
      arret = true;
      clearTimeout(minuteur);
      window.removeEventListener("assistant-fil:relancer", relancer);
      document.removeEventListener("visibilitychange", auRetour);
    };
  }, [lire]);

  /** Chaque fichier part dans le Drive de la personne ; seul son identifiant revient. */
  const joindre = (fichiers: File[]) => {
    for (const f of fichiers) {
      const cle = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      setPieces((prev) => [...prev, { cle, nom: f.name, etat: "envoi" }]);
      void televerser(f).then((r) => setPieces((prev) => prev.map((p) => (p.cle !== cle ? p
        : "id" in r ? { ...p, id: r.id, etat: "prete" } : { ...p, etat: "erreur", erreur: r.erreur }))));
    }
  };

  /** Vue exacte seulement : le tour joué dans la requête, comme avant, sans rien garder. */
  const envoyerLocal = async (text: string, pretes: { id: string; nom: string }[]) => {
    const userMsg: ChatMessage = { id: `usr-${Date.now()}`, role: "user", content: text, pieces: pretes, createdAt: new Date().toISOString() };
    const historique = locaux.map((m) => ({ role: m.role, content: m.content }));
    setLocaux((prev) => [...prev, userMsg]);
    setLocalEnCours(true);
    try {
      const res = await envoyerMessageBeta(text, undefined, historique, pretes);
      setLocaux((prev) => [...prev, res.ok
        ? { id: res.messageId, role: "assistant", content: res.content, blocs: res.blocs, memoireProposee: res.memoireProposee ?? null, outilsAppeles: res.outilsAppeles, intent: res.intent || null, createdAt: new Date().toISOString() }
        : { id: `err-${Date.now()}`, role: "assistant", content: res.error || "Une erreur est survenue lors du traitement.", etat: "echec" }]);
    } catch {
      setLocaux((prev) => [...prev, { id: `err-${Date.now()}`, role: "assistant", content: "La connexion a été interrompue. Réessayez dans un instant.", etat: "echec" }]);
    } finally {
      setLocalEnCours(false);
    }
  };

  /** ENVOYER ne bloque jamais : le message rejoint la file, l'assistant le traite après les précédents. */
  const handleSendMessage = async (text: string) => {
    const pretes = pieces.filter((p): p is PieceJointe & { id: string } => p.etat === "prete" && !!p.id).map((p) => ({ id: p.id, nom: p.nom }));
    if (!text.trim() && !pretes.length) return;
    setPieces([]);
    setErreur(null);
    if (vueExacte) return envoyerLocal(text, pretes);
    // Affiché tout de suite, remplacé par le tour du serveur à la lecture suivante.
    const provisoire: ChatMessage = { id: `prov-${Date.now()}`, role: "user", content: text, pieces: pretes, etat: "attente", createdAt: new Date().toISOString() };
    setFil((prev) => [...prev, provisoire]);
    setTravaille(true);
    setEnvoi(true);
    try {
      const r = await envoyerAuFil(text, JSON.stringify(pretes));
      if (!r.ok) {
        setFil((prev) => prev.filter((m) => m.id !== provisoire.id));
        if (r.vueExacte) { setVueExacte(true); return envoyerLocal(text, pretes); }
        setErreur(r.erreur);
      }
    } catch {
      setFil((prev) => prev.filter((m) => m.id !== provisoire.id));
      setErreur("La connexion a été interrompue : le message n'est pas parti. Réessayez.");
    } finally {
      setEnvoi(false);
      window.dispatchEvent(new Event("assistant-fil:relancer"));
    }
  };

  const handleConfirmIntent = async (intentId: string, confirmTyped?: string) => {
    return confirmerActionBeta(intentId, confirmTyped);
  };

  const handleReset = async () => {
    setErreur(null);
    if (vueExacte) { setLocaux([]); return; }
    if (!(await confirmer("Repartir d'une nouvelle conversation ? L'assistant ne tiendra plus compte des échanges précédents."))) return;
    try {
      const r = await repartirDeZero();
      if (!r.ok) setErreur(r.erreur);
    } catch {
      setErreur(actionFailureMessage("THROWN"));
    }
    window.dispatchEvent(new Event("assistant-fil:relancer"));
  };

  const messages = [bienvenue, ...(vueExacte ? locaux : fil)];
  const redige = fil.some((m) => m.etat === "redaction");
  // L'indicateur « Consultation en cours » ne double pas une réponse qui s'écrit déjà sous les yeux.
  const attente = vueExacte ? localEnCours : (travaille || envoi) && !redige;

  return (
    <div className="relative h-full w-full flex-1 overflow-hidden bg-slate-900 select-text flex flex-col">
      {/* 1. Curseur luminescent avec spring physics */}
      <LuminescentCursor />

      {/* 2. Arrière-plan animé Makoto Shinkai haute résolution avec flou accentué de 20% */}
      <div className="absolute inset-0 pointer-events-none z-0 overflow-hidden">
        <Image
          src="/images/assistant-bg-shinkai.jpg"
          alt="Peaceful Anime Mountain Lake Background"
          fill
          priority
          sizes="100vw"
          className="object-cover object-center scale-110 filter blur-[10px] transition-transform duration-1000"
        />
        {/* Voile atmosphérique équilibré pour une lisibilité parfaite des cartes de verre */}
        <div className="absolute inset-0 bg-slate-950/25 backdrop-blur-[2px] dark:bg-black/40" />
        <div className="absolute inset-0 bg-gradient-to-t from-slate-950/40 via-transparent to-slate-950/20" />
      </div>

      {/* 3. Conteneur principal — plein écran sur téléphone (chaque pixel compte), verre dépoli au-delà. */}
      <div className="relative z-10 flex h-full w-full flex-1 flex-col overflow-hidden sm:p-4 lg:p-6">
        <div
          data-glass="true"
          className="relative mx-auto flex h-full w-full max-w-5xl flex-1 flex-col overflow-hidden bg-white/80 backdrop-blur-2xl sm:rounded-3xl sm:border sm:border-white/60 sm:bg-white/75 sm:shadow-2xl dark:bg-zinc-950/75 sm:dark:border-white/10 sm:dark:bg-zinc-950/70"
        >
          <ChatMessageList
            messages={messages}
            isLoading={attente}
            onConfirmIntent={handleConfirmIntent}
          />

          {/* Barre de saisie — au-dessus de la barre système du téléphone (zone sûre). */}
          <div className="px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-1 sm:p-4 sm:pt-0">
            {erreur && <p role="alert" className="mb-1 px-2 text-xs text-red-600 dark:text-red-400">{erreur}</p>}
            <CommandPillBar
              onSendMessage={handleSendMessage}
              onReset={handleReset}
              // On peut écrire pendant que l'assistant travaille : le message rejoint la file.
              isLoading={vueExacte && localEnCours}
              showSuggestions={messages.length <= 1 && !pieces.length}
              canSendEmpty={pieces.some((p) => p.etat === "prete")}
              sendBlocked={envoiEnCours}
              above={<PiecesEnAttente pieces={pieces} onRetirer={(cle) => setPieces((prev) => prev.filter((p) => p.cle !== cle))} />}
              leading={
                <>
                <BoutonJoindre onFichiers={joindre} desactive={vueExacte && localEnCours} />
                <button
                  type="button"
                  onClick={() => setMemoireOuverte(true)}
                  aria-label="Ma mémoire"
                  title="Ma mémoire"
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
                >
                  <Brain className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => setRoutinesOuvertes(true)}
                  aria-label={nonLus ? `Mes routines (${nonLus} non lu${nonLus > 1 ? "s" : ""})` : "Mes routines"}
                  title="Mes routines"
                  className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
                >
                  <AlarmClock className="h-4 w-4" />
                  {nonLus > 0 && <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-violet-600" />}
                </button>
                </>
              }
            />
          </div>
        </div>
      </div>
      <MemoirePanel ouvert={memoireOuverte} onFermer={() => setMemoireOuverte(false)} />
      <RoutinesPanel ouvert={routinesOuvertes} onFermer={() => setRoutinesOuvertes(false)} routineInitiale={routineInitiale} onNonLus={majNonLus} />
    </div>
  );
}
