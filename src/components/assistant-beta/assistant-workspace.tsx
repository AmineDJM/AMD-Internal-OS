"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { LuminescentCursor } from "./luminescent-cursor";
import { ChatMessageList, type ChatMessage } from "./chat-message-list";
import { CommandPillBar } from "./command-pill-bar";
import { MemoirePanel } from "./memoire-panel";
import { RoutinesPanel } from "./routines-panel";
import { BoutonJoindre, PiecesEnAttente, type PieceJointe, type PieceOuvrable } from "./pieces-jointes";
import { ApercuPiece } from "./apercu-piece";
import { deposeDesFichiers, depuisListe, lireDepot, nommerCollage, televerser } from "./depot-navigateur";
import {
  avertissementPiece, miniaturePossible, OCTETS_MAX_DEPOT, phraseRefus, PIECES_PAR_ENVOI_MAX, planifierDepot, retirerPieces, texteDemandeModification,
  type Parcours,
} from "@/lib/agent/lecture/depot";
import { EnregistreurVocal } from "./enregistreur-vocal";
import { AlarmClock, Brain, FolderUp, MoreHorizontal, Volume2, VolumeX } from "lucide-react";
import { envoyerAuFil, listerMesRoutines, reglerMaReponseVocale, repartirDeZero } from "@/lib/actions/assistant-ia-actions";
import type { AudioDuTour, LecturePiece, VocalDuTour } from "@/lib/agent/lecture/regles";
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
  vocal?: VocalDuTour | null;
  lecture?: LecturePiece[] | null;
  audio?: AudioDuTour | null;
  piecesRendues?: { id: string; nom: string }[] | null;
  createdAt: string;
}

function versMessage(t: TourDuFil): ChatMessage {
  if (t.role === "user") {
    return {
      id: t.id, role: "user", content: t.contenu, pieces: t.pieces ?? undefined, createdAt: t.createdAt,
      vocal: t.vocal ?? null, lectures: t.lecture ?? null,
      etat: t.etat === "EN_ATTENTE" ? "attente" : undefined,
    };
  }
  const redaction = t.etat === "EN_COURS";
  return {
    id: t.id, role: "assistant", content: t.contenu, createdAt: t.createdAt,
    blocs: t.blocs ?? undefined, intent: t.intent ?? null, memoireProposee: t.memoireProposee ?? null, audio: t.audio ?? null,
    piecesRendues: t.piecesRendues ?? null,
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
  // Les pièces du message en préparation, lues par l'envoi (l'état React n'est pas encore à jour dans un même geste).
  const piecesRef = useRef<PieceJointe[]>([]);
  useEffect(() => { piecesRef.current = pieces; }, [pieces]);
  const [televersement, setTeleversement] = useState(false);
  const envoiEnCours = televersement;
  // Ce que le dernier dépôt n'a pas pu joindre (aria-live) — et l'aperçu ouvert.
  const [avisDepot, setAvisDepot] = useState<string | null>(null);
  const [apercu, setApercu] = useState<PieceOuvrable | null>(null);
  const [brouillon, setBrouillon] = useState<{ texte: string; jeton: number } | null>(null);
  const [survol, setSurvol] = useState(false);

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
  // L'option « réponse vocale » vit sur le fil (serveur) : elle suit la personne d'un appareil à l'autre.
  const [reponseVocale, setReponseVocale] = useState(false);
  const [menuOuvert, setMenuOuvert] = useState(false);

  const lire = useCallback(async (): Promise<boolean> => {
    try {
      const r = await fetch("/api/assistant-ia/fil", { cache: "no-store" });
      if (!r.ok) return false;
      const d = (await r.json()) as { tours: TourDuFil[]; enCours: boolean; vueExacte: boolean; reponseVocale?: boolean };
      setVueExacte(d.vueExacte);
      setReponseVocale(d.reponseVocale === true);
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

  /**
   * JOINDRE (décision 0015) : chaque fichier déposé, collé ou choisi devient une PUCE — rien n'est
   * téléversé avant l'envoi. Les bornes (nombre, taille, doublons) et les fichiers système écartés
   * sont dits en clair.
   */
  const joindre = useCallback((parcours: Parcours<File>) => {
    const dejaLa = piecesRef.current.map((p) => ({ chemin: p.nom, taille: p.taille ?? 0 }));
    const { acceptes, refus } = planifierDepot(dejaLa, parcours.trouves.map((t) => ({ ...t, taille: t.fichier.size })));
    const neuves: PieceJointe[] = acceptes.map((a) => ({
      cle: `${Date.now()}-${Math.random().toString(36).slice(2)}`, nom: a.chemin, taille: a.fichier.size, type: a.fichier.type,
      fichier: a.fichier, etat: "attente", avertissement: avertissementPiece(a.chemin),
      miniature: miniaturePossible(a.fichier.name, a.fichier.type) ? URL.createObjectURL(a.fichier) : undefined,
    }));
    if (neuves.length) {
      piecesRef.current = [...piecesRef.current, ...neuves];
      setPieces(piecesRef.current);
    }
    setAvisDepot(phraseRefus(refus, parcours.ignores, parcours.tronque));
  }, []);

  /** Retirer des puces : rien n'a été téléversé, rien ne reste dans le Drive ; la miniature est libérée. */
  const retirer = useCallback((cles: string[]) => {
    const { restantes, retirees } = retirerPieces(piecesRef.current, cles);
    for (const p of retirees) if (p.miniature) URL.revokeObjectURL(p.miniature);
    piecesRef.current = restantes;
    setPieces(restantes);
    setAvisDepot(retirees.length ? `${retirees.length} pièce${retirees.length > 1 ? "s" : ""} retirée${retirees.length > 1 ? "s" : ""}.` : null);
  }, []);

  const majPiece = (cle: string, maj: Partial<PieceJointe>) => {
    piecesRef.current = piecesRef.current.map((p) => (p.cle === cle ? { ...p, ...maj } : p));
    setPieces(piecesRef.current);
  };

  /**
   * À L'ENVOI SEULEMENT : chaque fichier part dans le Drive (progression sur sa puce). Un échec arrête
   * l'envoi — le message ne part pas avec une pièce manquante ; la puce dit pourquoi, on la retire ou
   * l'on réessaie. Rend les pièces prêtes, ou `null`.
   */
  const preparerPieces = async (): Promise<{ id: string; nom: string }[] | null> => {
    setTeleversement(true);
    try {
      for (const p of [...piecesRef.current]) {
        if (p.id || !p.fichier) continue;
        majPiece(p.cle, { etat: "envoi", progression: 0, erreur: undefined });
        const r = await televerser(p.fichier, (part) => majPiece(p.cle, { progression: part }));
        if ("erreur" in r) {
          majPiece(p.cle, { etat: "erreur", erreur: r.erreur });
          setErreur(`« ${p.nom} » n'a pas pu être joint : ${r.erreur} Le message n'est pas parti — retirez la pièce ou réessayez.`);
          return null;
        }
        majPiece(p.cle, { etat: "prete", id: r.id, fichier: undefined, progression: 1 });
      }
      const pretes = piecesRef.current.filter((p): p is PieceJointe & { id: string } => !!p.id).map((p) => ({ id: p.id, nom: p.nom }));
      for (const p of piecesRef.current) if (p.miniature) URL.revokeObjectURL(p.miniature);
      piecesRef.current = [];
      setPieces([]);
      setAvisDepot(null);
      return pretes;
    } finally {
      setTeleversement(false);
    }
  };

  // ── LE GLISSER-DÉPOSER, SUR TOUTE LA CONVERSATION ──────────────────────────────────────────────
  // Dès que des FICHIERS survolent la fenêtre, la zone de dépôt apparaît ; un texte glissé ne la montre pas.
  const profondeur = useRef(0);
  useEffect(() => {
    const entre = (e: DragEvent) => {
      if (!deposeDesFichiers(e.dataTransfer)) return;
      e.preventDefault();
      profondeur.current++;
      setSurvol(true);
    };
    const passe = (e: DragEvent) => {
      if (!deposeDesFichiers(e.dataTransfer)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const sort = (e: DragEvent) => {
      if (!deposeDesFichiers(e.dataTransfer)) return;
      profondeur.current = Math.max(0, profondeur.current - 1);
      if (!profondeur.current) setSurvol(false);
    };
    const depose = (e: DragEvent) => {
      if (!deposeDesFichiers(e.dataTransfer) || !e.dataTransfer) return;
      // Jamais la page qui s'en va vers le fichier : le dépôt est pour la conversation.
      e.preventDefault();
      profondeur.current = 0;
      setSurvol(false);
      const dt = e.dataTransfer;
      void (async () => {
        try { joindre(await lireDepot(dt)); } catch { setAvisDepot("Le dépôt n'a pas pu être lu. Réessayez avec le trombone."); }
      })();
    };
    const quitte = () => { profondeur.current = 0; setSurvol(false); };
    window.addEventListener("dragenter", entre);
    window.addEventListener("dragover", passe);
    window.addEventListener("dragleave", sort);
    window.addEventListener("drop", depose);
    window.addEventListener("dragend", quitte);
    return () => {
      window.removeEventListener("dragenter", entre);
      window.removeEventListener("dragover", passe);
      window.removeEventListener("dragleave", sort);
      window.removeEventListener("drop", depose);
      window.removeEventListener("dragend", quitte);
    };
  }, [joindre]);

  // COLLER (Ctrl+V) une image ou un fichier : il devient une puce ; un texte collé reste du texte.
  useEffect(() => {
    const colle = (e: ClipboardEvent) => {
      const f = Array.from(e.clipboardData?.files ?? []);
      if (!f.length) return;
      e.preventDefault();
      joindre(depuisListe(f.map(nommerCollage)));
    };
    document.addEventListener("paste", colle);
    return () => document.removeEventListener("paste", colle);
  }, [joindre]);

  /** « Demander une modification » : la pièce rejoint le message, la saisie est pré-remplie. */
  const demanderModification = (p: PieceOuvrable) => {
    setApercu(null);
    if (!piecesRef.current.some((x) => x.id === p.id)) {
      piecesRef.current = [...piecesRef.current, { cle: `drive-${p.id}`, nom: p.nom, id: p.id, etat: "prete" }];
      setPieces(piecesRef.current);
    }
    setBrouillon({ texte: texteDemandeModification(p.nom), jeton: Date.now() });
  };
  const fermerApercu = useCallback(() => setApercu(null), []);

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
  const handleSendMessage = async (text: string): Promise<boolean> => {
    if (!text.trim() && !piecesRef.current.length) return false;
    setErreur(null);
    const pretes = await preparerPieces();
    if (!pretes) return false;
    if (vueExacte) { await envoyerLocal(text, pretes); return true; }
    // Affiché tout de suite, remplacé par le tour du serveur à la lecture suivante.
    const provisoire: ChatMessage = { id: `prov-${Date.now()}`, role: "user", content: text, pieces: pretes, etat: "attente", createdAt: new Date().toISOString() };
    setFil((prev) => [...prev, provisoire]);
    setTravaille(true);
    setEnvoi(true);
    try {
      const r = await envoyerAuFil(text, JSON.stringify(pretes));
      if (!r.ok) {
        setFil((prev) => prev.filter((m) => m.id !== provisoire.id));
        if (r.vueExacte) { setVueExacte(true); await envoyerLocal(text, pretes); return true; }
        setErreur(r.erreur);
        return false;
      }
      return true;
    } catch {
      setFil((prev) => prev.filter((m) => m.id !== provisoire.id));
      setErreur("La connexion a été interrompue : le message n'est pas parti. Réessayez.");
      return false;
    } finally {
      setEnvoi(false);
      window.dispatchEvent(new Event("assistant-fil:relancer"));
    }
  };

  /**
   * UN VOCAL PART COMME UN MESSAGE : affiché tout de suite (lisible depuis l'enregistrement local), puis
   * déposé dans le Drive et le fil (`/api/assistant-ia/vocal`) avec les pièces prêtes ; la
   * transcription et la réponse arrivent par la lecture du fil.
   */
  const envoyerVocal = async (audio: Blob, dureeS: number) => {
    if (vueExacte) { setErreur("Les messages vocaux sont indisponibles en « Vue exacte »."); return; }
    setErreur(null);
    const pretes = await preparerPieces();
    if (!pretes) return;
    const local = URL.createObjectURL(audio);
    const provisoire: ChatMessage = {
      id: `prov-vocal-${Date.now()}`, role: "user", content: "", pieces: pretes, etat: "attente", createdAt: new Date().toISOString(),
      vocal: { id: null, local, dureeS, etat: "TRANSCRIPTION" },
    };
    setFil((prev) => [...prev, provisoire]);
    setTravaille(true);
    setEnvoi(true);
    try {
      const ext = audio.type.includes("mp4") ? "m4a" : audio.type.includes("ogg") ? "ogg" : "webm";
      const fd = new FormData();
      fd.set("audio", new File([audio], `vocal.${ext}`, { type: audio.type || "audio/webm" }));
      fd.set("dureeS", String(dureeS));
      fd.set("pieces", JSON.stringify(pretes));
      const r = await fetch("/api/assistant-ia/vocal", { method: "POST", body: fd });
      const j = (await r.json().catch(sansBloquer("assistant-workspace.envoyerVocal.json", {}))) as { ok?: boolean; error?: string };
      if (!r.ok || !j.ok) {
        setFil((prev) => prev.filter((m) => m.id !== provisoire.id));
        setErreur(j.error ?? "Le vocal n'est pas parti. Réessayez.");
      }
    } catch {
      setFil((prev) => prev.filter((m) => m.id !== provisoire.id));
      setErreur("La connexion a été interrompue : le vocal n'est pas parti. Réessayez.");
    } finally {
      setEnvoi(false);
      window.dispatchEvent(new Event("assistant-fil:relancer"));
    }
  };

  const basculerReponseVocale = async () => {
    const voulu = !reponseVocale;
    setReponseVocale(voulu);
    setMenuOuvert(false);
    const r = await reglerMaReponseVocale(voulu).catch(sansBloquer("assistant-workspace.reponseVocale", null));
    if (!r || !r.ok) { setReponseVocale(!voulu); setErreur(r && !r.ok ? r.erreur : "Réglage non enregistré. Réessayez."); }
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
              isLoading={vueExacte && localEnCours}
              showSuggestions={messages.length <= 1 && !pieces.length}
              canSendEmpty={pieces.length > 0}
              sendBlocked={envoiEnCours}
              brouillon={brouillon}
              above={<PiecesEnAttente pieces={pieces} onRetirer={retirer} verrou={televersement} />}
              vocal={vueExacte ? undefined : <EnregistreurVocal onVocal={(a, d) => void envoyerVocal(a, d)} desactive={envoiEnCours} />}
              leading={
                <>
                <BoutonJoindre onFichiers={(f) => joindre(depuisListe(f))} desactive={(vueExacte && localEnCours) || televersement} />
                <Outils
                  ouvert={menuOuvert}
                  onBasculer={() => setMenuOuvert((o) => !o)}
                  onMemoire={() => { setMenuOuvert(false); setMemoireOuverte(true); }}
                  onRoutines={() => { setMenuOuvert(false); setRoutinesOuvertes(true); }}
                  nonLus={nonLus}
                  reponseVocale={reponseVocale}
                  onReponseVocale={() => void basculerReponseVocale()}
                  vueExacte={vueExacte}
                />
                </>
              }
            />
          </div>
          {survol && (
            <div
              data-testid="zone-depot"
              className="pointer-events-none absolute inset-2 z-30 flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-violet-500 bg-violet-50/90 text-center text-violet-900 backdrop-blur-sm sm:inset-3 dark:border-violet-400 dark:bg-violet-950/80 dark:text-violet-100"
            >
              <FolderUp className="h-8 w-8" aria-hidden />
              <p className="text-base font-semibold">Déposez vos fichiers ou dossiers</p>
              <p className="max-w-sm px-4 text-xs opacity-80">
                {PIECES_PAR_ENVOI_MAX} pièces au plus par message, {Math.round(OCTETS_MAX_DEPOT / 1048576)} Mo chacune. Rien n&apos;est envoyé avant que vous appuyiez sur Entrée.
              </p>
            </div>
          )}
        </div>
      </div>
      <ApercuPiece piece={apercu} onFermer={fermerApercu} onDemanderModification={vueExacte ? undefined : demanderModification} />
      <MemoirePanel ouvert={memoireOuverte} onFermer={() => setMemoireOuverte(false)} />
      <RoutinesPanel ouvert={routinesOuvertes} onFermer={() => setRoutinesOuvertes(false)} routineInitiale={routineInitiale} onNonLus={majNonLus} />
    </div>
  );
}

/**
 * LES OUTILS DE LA BARRE — mémoire, routines, réponse vocale. Sur ordinateur, trois boutons ; sur
 * téléphone, un seul « ⋯ » qui les déplie : à 375 px, trois boutons de plus ne laissaient que
 * quelques lettres au champ de saisie.
 */
function Outils({ ouvert, onBasculer, onMemoire, onRoutines, nonLus, reponseVocale, onReponseVocale, vueExacte }: {
  ouvert: boolean; onBasculer: () => void; onMemoire: () => void; onRoutines: () => void; nonLus: number;
  reponseVocale: boolean; onReponseVocale: () => void; vueExacte: boolean;
}) {
  const bouton = "relative flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 dark:text-zinc-400 dark:hover:bg-zinc-800";
  const libelleRoutines = nonLus ? `Mes routines (${nonLus} non lu${nonLus > 1 ? "s" : ""})` : "Mes routines";
  const libelleVoix = reponseVocale ? "Réponses vocales activées — désactiver" : "Réponses vocales désactivées — activer";
  const IconeVoix = reponseVocale ? Volume2 : VolumeX;
  const point = nonLus > 0 && <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-violet-600" />;
  return (
    <>
      <div className="hidden sm:contents">
        <button type="button" onClick={onMemoire} aria-label="Ma mémoire" title="Ma mémoire" className={bouton}><Brain className="h-4 w-4" /></button>
        <button type="button" onClick={onRoutines} aria-label={libelleRoutines} title="Mes routines" className={bouton}><AlarmClock className="h-4 w-4" />{point}</button>
        {!vueExacte && (
          <button type="button" onClick={onReponseVocale} aria-pressed={reponseVocale} aria-label={libelleVoix} title={libelleVoix}
            className={`${bouton} ${reponseVocale ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400" : ""}`}>
            <IconeVoix className="h-4 w-4" />
          </button>
        )}
      </div>
      <div className="relative sm:hidden">
        <button type="button" onClick={onBasculer} aria-expanded={ouvert} aria-label="Plus d'outils" title="Plus d'outils" className={bouton}>
          <MoreHorizontal className="h-4 w-4" />{point}
        </button>
        {ouvert && (
          <div role="menu" className="absolute bottom-12 left-0 z-40 w-60 rounded-xl border border-slate-200 bg-white p-1 shadow-xl dark:border-zinc-800 dark:bg-zinc-950">
            <button type="button" role="menuitem" onClick={onMemoire} className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm text-slate-700 hover:bg-slate-100 dark:text-zinc-200 dark:hover:bg-zinc-800">
              <Brain className="h-4 w-4" /> Ma mémoire
            </button>
            <button type="button" role="menuitem" onClick={onRoutines} className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm text-slate-700 hover:bg-slate-100 dark:text-zinc-200 dark:hover:bg-zinc-800">
              <AlarmClock className="h-4 w-4" /> {libelleRoutines}
            </button>
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
