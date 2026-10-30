"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { LuminescentCursor } from "./luminescent-cursor";
import { ChatMessageList, type ChatMessage } from "./chat-message-list";
import { CommandPillBar } from "./command-pill-bar";
import { MemoirePanel } from "./memoire-panel";
import { RoutinesPanel } from "./routines-panel";
import { TravauxPanel } from "./travaux-panel";
import { BoutonJoindre, PiecesEnAttente, type PieceOuvrable } from "./pieces-jointes";
import { ApercuPiece } from "./apercu-piece";
import { Atelier } from "./atelier/atelier";
import { depuisListe } from "./depot-navigateur";
import { texteDemandeModification } from "../domaine/lecture/depot";
import { ZoneDepot } from "./zone-depot";
import { useFil } from "./use-fil";
import { usePieces } from "./use-pieces";
import { useConversations } from "./conversations/use-conversations";
import { ListeConversations } from "./conversations/liste-conversations";
import { PanneauDuDossier } from "./conversations/dossier-panneau";
import "./app/theme.css";
import { EnregistreurVocal } from "./enregistreur-vocal";
import { AlarmClock, Brain, Briefcase, MessagesSquare, MoreHorizontal, Sparkles, Volume2, VolumeX, X } from "lucide-react";
import { listerMesRoutines, listerMesTravaux } from "@/modules/assistant-ia/actions";
import { confirmerActionBeta, envoyerMessageBeta } from "@/app/(app)/assistant/beta/actions";
import type { KpiData } from "./kpi-glass-strip";
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

export function AssistantWorkspace({ userName }: AssistantWorkspaceProps) {
  const bienvenue: ChatMessage = { id: "welcome-1", role: "assistant", content: accueil(userName) };
  const [memoireOuverte, setMemoireOuverte] = useState(false);
  const [routinesOuvertes, setRoutinesOuvertes] = useState(false);
  const [routineInitiale, setRoutineInitiale] = useState<string | null>(null);
  const [nonLus, setNonLus] = useState(0);
  const majNonLus = useCallback((n: number) => setNonLus(n), []);
  // J2 : les TRAVAUX — un plan proposé par l'assistant attend son approbation dans ce panneau.
  const [travauxOuverts, setTravauxOuverts] = useState(false);
  const [travailInitial, setTravailInitial] = useState<string | null>(null);
  const [aApprouver, setAApprouver] = useState(0);
  const majAApprouver = useCallback((n: number) => setAApprouver(n), []);
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("travail");
    if (id) { setTravailInitial(id); setTravauxOuverts(true); }
    const compter = () => void listerMesTravaux().then((r) => { if (r.ok) setAApprouver(r.aApprouver); }).catch(sansBloquer("assistant-workspace.listerMesTravaux"));
    compter();
    // Un plan arrive pendant que la personne écrit (l'assistant l'a proposé au tour d'avant) : le point s'allume.
    const t = setInterval(compter, 20_000);
    return () => clearInterval(t);
  }, []);

  // Une notification de routine mène ici (« ?routine=… ») : le panneau s'ouvre sur son dernier passage.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("routine");
    if (id) { setRoutineInitiale(id); setRoutinesOuvertes(true); }
    void listerMesRoutines().then((r) => { if (r.ok) setNonLus(r.nonLus); }).catch(sansBloquer("assistant-workspace.AssistantWorkspace.listerMesRoutines"));
  }, []);
  const [apercu, setApercu] = useState<PieceOuvrable | null>(null);
  const [brouillon, setBrouillon] = useState<{ texte: string; jeton: number } | null>(null);
  // J3 — L'ATELIER : les documents à côté de la conversation (redimensionnable, plein écran ; panneau plein écran sur mobile).
  const [atelierOuvert, setAtelierOuvert] = useState(false);
  const [atelierPlein, setAtelierPlein] = useState(false);
  const [aOuvrir, setAOuvrir] = useState<{ nodeId: string; jeton: number } | null>(null);
  const [largeurConversation, setLargeurConversation] = useState(42);
  const verre = useRef<HTMLDivElement>(null);
  const afficherAtelier = useCallback(() => setAtelierOuvert(true), []);
  const fermerAtelier = useCallback(() => { setAtelierOuvert(false); setAtelierPlein(false); }, []);
  const ouvrirDansAtelier = useCallback((p: PieceOuvrable) => {
    setApercu(null);
    setAtelierOuvert(true);
    setAOuvrir({ nodeId: p.id, jeton: Date.now() });
  }, []);
  /** La poignée : glisser (pointeur) ou flèches (clavier) — la conversation garde entre 25 % et 75 %. */
  const redimensionner = (e: React.PointerEvent<HTMLDivElement>) => {
    const boite = verre.current?.getBoundingClientRect();
    if (!boite) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const bouge = (ev: PointerEvent) => setLargeurConversation(Math.min(75, Math.max(25, ((ev.clientX - boite.left) / boite.width) * 100)));
    const fin = () => { window.removeEventListener("pointermove", bouge); window.removeEventListener("pointerup", fin); };
    window.addEventListener("pointermove", bouge);
    window.addEventListener("pointerup", fin);
  };

  // ── LES CONVERSATIONS (décision 0027) : la même liste et le même fil que l'app Adventum IA ─────────────────
  // `?c=` ouvre une conversation (lien de notification) ; sans lui, la conversation courante du serveur.
  const [conversation, setConversation] = useState<string | null>(null);
  const [nouvelle, setNouvelle] = useState<{ prive: boolean; dossierId: string | null } | null>(null);
  const [listeOuverte, setListeOuverte] = useState(false);
  const [dossierOuvert, setDossierOuvert] = useState<string | null>(null);
  const [panneauDossier, setPanneauDossier] = useState<"nouveau" | string | null>(null);
  const conversations = useConversations();
  useEffect(() => {
    const c = new URLSearchParams(window.location.search).get("c");
    if (c) setConversation(c);
  }, []);
  const surConversation = useCallback((c: { id: string }) => {
    setConversation((avant) => (avant === c.id ? avant : c.id));
    setNouvelle(null);
  }, []);
  const ouvrirConversation = (id: string) => { setNouvelle(null); setConversation(id); setListeOuverte(false); window.history.replaceState(null, "", `?c=${id}`); };
  const nouvelleConversation = (dossierId: string | null = null) => { setNouvelle({ prive: false, dossierId }); setConversation(null); setListeOuverte(false); window.history.replaceState(null, "", window.location.pathname); };

  const f = useFil({ conversation, nouvelle, onConversation: surConversation, tourLocal: envoyerMessageBeta });
  const { fil, vueExacte, travaille, envoi, erreur, setErreur, reponseVocale } = f;
  const p = usePieces(setErreur);
  const { pieces, televersement, avisDepot, survol } = p;
  const envoiEnCours = televersement;
  const [menuOuvert, setMenuOuvert] = useState(false);

  /**
   * « Demander une modification » (J3) : le document s'ouvre dans l'Atelier, la pièce rejoint le message, la saisie
   * est pré-remplie — l'assistant modifiera EN PLACE, sous les yeux de la personne.
   */
  const demanderModification = (piece: PieceOuvrable) => {
    ouvrirDansAtelier(piece);
    p.joindreDuDrive(piece);
    setBrouillon({ texte: texteDemandeModification(piece.nom), jeton: Date.now() });
  };
  const fermerApercu = useCallback(() => setApercu(null), []);

  const handleSendMessage = async (text: string): Promise<boolean> => {
    if (!text.trim() && !p.piecesRef.current.length) return false;
    setErreur(null);
    const pretes = await p.preparerPieces();
    if (!pretes) return false;
    return f.envoyer(text, pretes);
  };

  const envoyerVocal = async (audio: Blob, dureeS: number) => {
    const pretes = await p.preparerPieces();
    if (!pretes) return;
    await f.envoyerVocal(audio, dureeS, pretes);
  };

  const basculerReponseVocale = async () => {
    setMenuOuvert(false);
    await f.basculerReponseVocale();
  };

  const handleConfirmIntent = async (intentId: string, confirmTyped?: string) => {
    return confirmerActionBeta(intentId, confirmTyped);
  };

  /** « Nouvelle conversation » : l'ancienne reste dans la liste (décision 0027) — rien n'est effacé. */
  const handleReset = async () => {
    setErreur(null);
    if (vueExacte) { f.setLocaux([]); return; }
    nouvelleConversation(dossierOuvert);
  };

  const messages = [bienvenue, ...(vueExacte ? f.locaux : fil)];
  const ouverte = conversations.conversations.find((c) => c.id === conversation) ?? conversations.archivees?.find((c) => c.id === conversation);
  const prive = nouvelle ? nouvelle.prive : !!ouverte?.prive;
  const titreCourant = nouvelle || !ouverte ? "Nouvelle conversation" : ouverte.titre;
  const attente = f.attente;

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
          ref={verre}
          data-glass="true"
          className={`relative mx-auto flex h-full w-full flex-1 flex-row overflow-hidden bg-white/80 backdrop-blur-2xl sm:rounded-3xl sm:border sm:border-white/60 sm:bg-white/75 sm:shadow-2xl dark:bg-zinc-950/75 sm:dark:border-white/10 sm:dark:bg-zinc-950/70 ${atelierOuvert ? "max-w-none" : "max-w-5xl"}`}
        >
          {/* LES CONVERSATIONS (décision 0027) : à gauche sur grand écran, en tiroir sur téléphone — la même liste que l'app. */}
          {!vueExacte && (
            <div className={`adventum-ia ${listeOuverte ? "fixed inset-0 z-50 flex" : "hidden"} ${atelierOuvert ? "" : "lg:static lg:z-auto lg:flex"} lg:w-64 lg:shrink-0 lg:border-r lg:border-[var(--aia-filet)]`}>
              {listeOuverte && <button type="button" aria-label="Fermer la liste" onClick={() => setListeOuverte(false)} className="absolute inset-0 bg-slate-950/40 lg:hidden" />}
              <div className="relative flex h-full w-[82%] max-w-[320px] flex-col lg:w-full lg:max-w-none">
                <ListeConversations
                  etat={conversations} courante={nouvelle ? null : conversation} onOuvrir={ouvrirConversation} onNouvelle={nouvelleConversation}
                  dossierOuvert={dossierOuvert} onDossier={(id) => { setDossierOuvert(id); if (id) setPanneauDossier(id); }}
                  onCreerDossier={() => setPanneauDossier("nouveau")}
                  entete={<div className="flex items-center justify-between px-3 pb-2 pt-3"><span className="text-[13px] font-semibold">Conversations</span>
                    <button type="button" onClick={() => setListeOuverte(false)} aria-label="Fermer la liste" className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-[var(--aia-survol)] lg:hidden"><X className="h-4 w-4" /></button></div>}
                />
              </div>
            </div>
          )}
          <div
            className={`relative flex min-h-0 min-w-0 flex-1 flex-col ${atelierOuvert ? "lg:flex-none lg:basis-[var(--conversation)]" : ""} ${atelierOuvert && atelierPlein ? "lg:hidden" : ""}`}
            style={{ "--conversation": `${largeurConversation}%` } as React.CSSProperties}
          >
          {!vueExacte && (
            <div className="flex items-center gap-2 border-b border-slate-200/70 px-3 py-2 dark:border-zinc-800/70">
              <button type="button" onClick={() => setListeOuverte(true)} aria-label="Mes conversations" title="Mes conversations"
                className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-slate-600 hover:bg-slate-100 dark:text-zinc-300 dark:hover:bg-zinc-800 ${atelierOuvert ? "" : "lg:hidden"}`}>
                <MessagesSquare className="h-4 w-4" />
              </button>
              <span className="min-w-0 flex-1 truncate text-[14px] font-semibold text-slate-800 dark:text-zinc-100" data-testid="titre-conversation">{titreCourant}</span>
              {prive && <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-[11.5px] text-amber-800 dark:bg-amber-950/50 dark:text-amber-300">Conversation privée</span>}
              {nouvelle && (
                <button type="button" aria-pressed={nouvelle.prive} onClick={() => setNouvelle({ ...nouvelle, prive: !nouvelle.prive })}
                  title="Conversation privée : l'assistant n'utilise pas votre mémoire et ne retient rien ; elle est supprimée après 30 jours."
                  className="shrink-0 rounded-lg border border-slate-200 px-2.5 py-1 text-[12.5px] text-slate-600 hover:bg-slate-100 aria-pressed:border-amber-300 aria-pressed:bg-amber-50 aria-pressed:text-amber-800 dark:border-zinc-700 dark:text-zinc-300">
                  {nouvelle.prive ? "Privée ✓" : "Rendre privée"}
                </button>
              )}
            </div>
          )}
          <ChatMessageList
            messages={messages}
            isLoading={attente}
            onConfirmIntent={handleConfirmIntent}
            onOuvrirPiece={setApercu}
          />

          {/* Barre de saisie — au-dessus de la barre système du téléphone (zone sûre). */}
          <div className="px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-1 sm:p-4 sm:pt-0">
            {erreur && <p role="alert" className="mb-1 px-2 text-xs text-red-600 dark:text-red-400">{erreur}</p>}
            <p aria-live="polite" className={avisDepot ? "mb-1 px-2 text-xs text-amber-700 dark:text-amber-400" : "sr-only"} data-testid="avis-depot">{avisDepot}</p>
            <CommandPillBar
              onSendMessage={handleSendMessage}
              onReset={handleReset}
              // On peut écrire pendant que l'assistant travaille : le message rejoint la file.
              isLoading={f.occupeLocal}
              showSuggestions={messages.length <= 1 && !pieces.length}
              canSendEmpty={pieces.length > 0}
              sendBlocked={envoiEnCours}
              brouillon={brouillon}
              above={<PiecesEnAttente pieces={pieces} onRetirer={p.retirer} verrou={televersement} />}
              vocal={vueExacte ? undefined : <EnregistreurVocal onVocal={(a, d) => void envoyerVocal(a, d)} desactive={envoiEnCours} />}
              leading={
                <>
                <BoutonJoindre onFichiers={(liste) => p.joindre(depuisListe(liste))} desactive={f.occupeLocal || televersement} />
                <Outils
                  ouvert={menuOuvert}
                  onBasculer={() => setMenuOuvert((o) => !o)}
                  onMemoire={() => { setMenuOuvert(false); setMemoireOuverte(true); }}
                  onRoutines={() => { setMenuOuvert(false); setRoutinesOuvertes(true); }}
                  onTravaux={() => { setMenuOuvert(false); setTravauxOuverts(true); }}
                  onAtelier={() => { setMenuOuvert(false); setAtelierOuvert((o) => !o); }}
                  atelierOuvert={atelierOuvert}
                  aApprouver={aApprouver}
                  nonLus={nonLus}
                  reponseVocale={reponseVocale}
                  onReponseVocale={() => void basculerReponseVocale()}
                  vueExacte={vueExacte}
                />
                </>
              }
            />
          </div>
          {survol && <ZoneDepot />}
          </div>
          {atelierOuvert && !atelierPlein && (
            <div
              role="separator" aria-orientation="vertical" aria-label="Largeur de la conversation et de l'Atelier" tabIndex={0}
              aria-valuemin={25} aria-valuemax={75} aria-valuenow={Math.round(largeurConversation)}
              onPointerDown={redimensionner}
              onKeyDown={(e) => {
                if (e.key === "ArrowLeft") setLargeurConversation((l) => Math.max(25, l - 5));
                if (e.key === "ArrowRight") setLargeurConversation((l) => Math.min(75, l + 5));
              }}
              className="atelier-poignee hidden w-1.5 shrink-0 bg-slate-200/70 hover:bg-violet-300 lg:block dark:bg-zinc-800 dark:hover:bg-violet-800"
            />
          )}
          <div className={atelierOuvert ? "fixed inset-0 z-40 flex min-h-0 min-w-0 lg:static lg:z-auto lg:flex-1" : "hidden"}>
            <Atelier
              ouvert={atelierOuvert} travaille={travaille || envoi} aOuvrir={aOuvrir} pleinEcran={atelierPlein}
              onAfficher={afficherAtelier} onFermer={fermerAtelier} onPleinEcran={() => setAtelierPlein((p) => !p)}
              onConfirmIntent={handleConfirmIntent}
            />
          </div>
        </div>
      </div>
      <ApercuPiece piece={apercu} onFermer={fermerApercu} onDemanderModification={vueExacte ? undefined : demanderModification} onOuvrirAtelier={vueExacte ? undefined : ouvrirDansAtelier} />
      <MemoirePanel ouvert={memoireOuverte} onFermer={() => setMemoireOuverte(false)} />
      <RoutinesPanel ouvert={routinesOuvertes} onFermer={() => setRoutinesOuvertes(false)} routineInitiale={routineInitiale} onNonLus={majNonLus} />
      <PanneauDuDossier panneau={panneauDossier} etat={conversations} onPanneau={setPanneauDossier} onDossierOuvert={setDossierOuvert} onNouvelleConversation={nouvelleConversation} />
      <TravauxPanel ouvert={travauxOuverts} onFermer={() => setTravauxOuverts(false)} travailInitial={travailInitial} onAApprouver={majAApprouver} />
    </div>
  );
}

/**
 * LES OUTILS DE LA BARRE — mémoire, routines, réponse vocale. Sur ordinateur, trois boutons ; sur
 * téléphone, un seul « ⋯ » qui les déplie : à 375 px, trois boutons de plus ne laissaient que
 * quelques lettres au champ de saisie.
 */
function Outils({ ouvert, onBasculer, onMemoire, onRoutines, onTravaux, onAtelier, atelierOuvert, aApprouver, nonLus, reponseVocale, onReponseVocale, vueExacte }: {
  ouvert: boolean; onBasculer: () => void; onMemoire: () => void; onRoutines: () => void; onTravaux: () => void; onAtelier: () => void; atelierOuvert: boolean; aApprouver: number; nonLus: number;
  reponseVocale: boolean; onReponseVocale: () => void; vueExacte: boolean;
}) {
  const bouton = "relative flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 dark:text-zinc-400 dark:hover:bg-zinc-800";
  const libelleRoutines = nonLus ? `Mes routines (${nonLus} non lu${nonLus > 1 ? "s" : ""})` : "Mes routines";
  const libelleVoix = reponseVocale ? "Réponses vocales activées — désactiver" : "Réponses vocales désactivées — activer";
  const IconeVoix = reponseVocale ? Volume2 : VolumeX;
  const point = nonLus > 0 && <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-violet-600" />;
  const libelleTravaux = aApprouver ? `Mes travaux (${aApprouver} plan${aApprouver > 1 ? "s" : ""} à approuver)` : "Mes travaux";
  const pointTravaux = aApprouver > 0 && <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-amber-500" />;
  return (
    <>
      <div className="hidden sm:contents">
        <button type="button" onClick={onMemoire} aria-label="Ma mémoire" title="Ma mémoire" className={bouton}><Brain className="h-4 w-4" /></button>
        <button type="button" onClick={onRoutines} aria-label={libelleRoutines} title="Mes routines" className={bouton}><AlarmClock className="h-4 w-4" />{point}</button>
        <button type="button" onClick={onTravaux} aria-label={libelleTravaux} title="Mes travaux" className={bouton}><Briefcase className="h-4 w-4" />{pointTravaux}</button>
        {!vueExacte && <button type="button" onClick={onAtelier} aria-pressed={atelierOuvert} aria-label="Atelier — documents" title="Atelier — documents" className={`${bouton} ${atelierOuvert ? "bg-violet-50 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300" : ""}`}><Sparkles className="h-4 w-4" /></button>}
        {!vueExacte && (
          <button type="button" onClick={onReponseVocale} aria-pressed={reponseVocale} aria-label={libelleVoix} title={libelleVoix}
            className={`${bouton} ${reponseVocale ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400" : ""}`}>
            <IconeVoix className="h-4 w-4" />
          </button>
        )}
      </div>
      <div className="relative sm:hidden">
        <button type="button" onClick={onBasculer} aria-expanded={ouvert} aria-label="Plus d'outils" title="Plus d'outils" className={bouton}>
          <MoreHorizontal className="h-4 w-4" />{point || pointTravaux}
        </button>
        {ouvert && (
          <div role="menu" className="absolute bottom-12 left-0 z-40 w-60 rounded-xl border border-slate-200 bg-white p-1 shadow-xl dark:border-zinc-800 dark:bg-zinc-950">
            <button type="button" role="menuitem" onClick={onMemoire} className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm text-slate-700 hover:bg-slate-100 dark:text-zinc-200 dark:hover:bg-zinc-800">
              <Brain className="h-4 w-4" /> Ma mémoire
            </button>
            <button type="button" role="menuitem" onClick={onRoutines} className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm text-slate-700 hover:bg-slate-100 dark:text-zinc-200 dark:hover:bg-zinc-800">
              <AlarmClock className="h-4 w-4" /> {libelleRoutines}
            </button>
            <button type="button" role="menuitem" onClick={onTravaux} className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm text-slate-700 hover:bg-slate-100 dark:text-zinc-200 dark:hover:bg-zinc-800">
              <Briefcase className="h-4 w-4" /> {libelleTravaux}
            </button>
            {!vueExacte && (
              <button type="button" role="menuitem" onClick={onAtelier} className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm text-slate-700 hover:bg-slate-100 dark:text-zinc-200 dark:hover:bg-zinc-800">
                <Sparkles className="h-4 w-4" /> Atelier — documents
              </button>
            )}
            {!vueExacte && (
              <button type="button" role="menuitemcheckbox" aria-checked={reponseVocale} onClick={onReponseVocale} className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm text-slate-700 hover:bg-slate-100 dark:text-zinc-200 dark:hover:bg-zinc-800">
                <IconeVoix className="h-4 w-4" /> Réponses vocales : {reponseVocale ? "activées" : "désactivées"}
              </button>
            )}
          </div>
        )}
      </div>
    </>
  );
}
