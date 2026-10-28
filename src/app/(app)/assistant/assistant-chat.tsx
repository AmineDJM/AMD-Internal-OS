"use client";

import * as React from "react";
import Link from "next/link";
import { Sparkles, Send, Loader2, Bot, CheckCircle2, KeyRound, Search, ArrowRight, X, Wand2, Paperclip, FolderOpen, FileText, Mic, Square, History, Plus, Trash2, Lock, Phone, Link2 } from "lucide-react";
import { useCall } from "@/components/layout/call-provider";
import type { VoiceToolUi } from "./realtime-voice";
import { Button } from "@/components/ui/button";
import { assistantChat, assistantDirectIntent, executeAssistantAction, executeAssistantBundle, cancelAssistantAction, listAssistantFiles, myAssistantThreads, myAssistantThread, deleteMyAssistantThread, forgetMyAssistantMemory } from "@/lib/actions/assistant-actions";
// HYGIÈNE D'AFFICHAGE — le dernier filtre avant l'écran. Il existe parce que des marqueurs
// internes et des sorties d'outils BRUTES ont été rendus au PDG en production, dont un
// vidage de 27 résultats contenant six lignes de salaires, en réponse à « Bonsoir, ça va ? ».
import { decideDisplay } from "@/lib/assistant/voice/transcript-hygiene";
import type { ProposedAction, AssistantActionPayload, ChatTurn, AssistantResult, AssistantStreamEvent } from "@/lib/assistant";
import type { WorkspaceActionIntent, WorkspaceComposition } from "@/lib/assistant/workspace/protocol";
import { WorkspaceBlocks, WorkspaceAskProvider } from "@/components/chief/workspace/blocks";
import { TurnWorkspaceView } from "@/components/chief/workspace/turn-workspace";
import { composeTurn, elaguerFil, isWorkspaceTurn, lireWorkspaceRange, phasesOf } from "@/lib/assistant/workspace/turn";
import type { TourRelu } from "@/lib/assistant/workspace/turn";
import type { AssistantAttachment, AssistantFileOption } from "@/lib/assistant-attachments";
import type { ThreadSummary } from "@/lib/assistant-memory";
import { useScrollLock } from "@/lib/use-scroll-lock";
import { useConfirmer } from "@/components/ui/dialogue";
import { useRetours } from "@/components/ui/retour";
import { actionFailureMessage } from "@/lib/action-outcome";
import { sansBloquer } from "@/lib/journal";
import { ActionCard } from "./assistant-chat/carte-action";

/** Pièce jointe en attente d'envoi : fichier local (upload) ou fichier du Drive (référence). */
type PendingAttach =
  | { id: string; kind: "upload"; name: string; file: File }
  | { id: string; kind: "drive"; name: string; nodeId: string };

/** Lit un fichier local en base64 (sans le préfixe data:) pour l'envoyer à l'action serveur. */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const res = String(reader.result ?? "");
      const comma = res.indexOf(",");
      resolve(comma >= 0 ? res.slice(comma + 1) : res);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export type ActionState = "pending" | "running" | "done" | "cancelled" | "error";

/**
 * UN TOUR RANGÉ REDEVIENT UN TOUR À L'ÉCRAN — la même traduction aux DEUX endroits qui
 * rouvrent une conversation : le premier rendu (fourni par le serveur) et l'ouverture d'un
 * autre fil depuis l'historique. Deux traductions finiraient par diverger, et l'on retrouverait
 * son écran ou son texte seul selon le chemin emprunté pour y revenir.
 */
function repriseDuTour(m: TourRelu): Msg {
  const ws = lireWorkspaceRange(m.workspace);
  return { id: nextId(), role: m.role, content: m.content, ...(ws ? { workspace: ws } : {}) };
}

interface Msg {
  id: number;
  role: "user" | "assistant";
  content: string;
  /** L'heure du tour, quand elle est connue. Un fil restauré n'en a pas — on n'en invente pas. */
  at?: number;
  attachmentNames?: string[];
  trace?: string[];
  /** Les actions proposées dans CE tour (souvent une, parfois plusieurs — « crée les trois tâches »). */
  proposals?: ProposedAction[];
  /** État / résultat / lien PAR action, alignés sur `proposals`. */
  actionStates?: ActionState[];
  actionResults?: (string | undefined)[];
  actionLinks?: (string | undefined)[];
  /**
   * L'ESPACE DE TRAVAIL de ce tour — des blocs TYPÉS bâtis par le serveur à partir d'une
   * source canonique. Ils restent attachés au message : remonter dans la conversation
   * redonne le tableau, il ne se volatilise pas au tour suivant.
   */
  workspace?: WorkspaceComposition[];
}

const SUGGESTIONS = [
  "Où en suis-je ? Résume mon espace de travail.",
  "Crée une tâche : préparer le dossier AMM pour vendredi.",
  "Demande à l'assistante de direction un billet Alger → Paris du 12 au 14 mars.",
  "Quels sont mes médecins à fort potentiel ?",
];

type StreamEvent = AssistantStreamEvent;

let counter = 1;
const nextId = () => counter++;

/** Nettoie un éventuel Markdown résiduel (l'assistant doit répondre en texte simple). */
export function cleanReply(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")        // **gras**
    .replace(/__(.+?)__/g, "$1")              // __gras__
    .replace(/`{1,3}([^`]+)`{1,3}/g, "$1")    // `code`
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")        // # titres
    .replace(/^(\s*)[*]\s+/gm, "$1- ")          // puces * → -
    .trim();
}

/** Les chemins internes de l'ERP écrits DANS le texte d'une réponse — rendus cliquables. */
const INTERNAL_PATH_RE =
  /(\/(?:api\/drive|drive|regulatory|legal|rh|events|sponsoring|validations|centre-de-paiement|calendar|chief-of-staff|workspace|courriers|stocks|finances|messages|meetings)\/[A-Za-z0-9_\-/.?=&%]+)/g;

/**
 * Un lien écrit en clair (« Lien : /drive/xxx ») n'est un lien que s'il se CLIQUE.
 * Les chemins `/api/drive/…/raw` deviennent de vrais téléchargements ; les autres, des
 * navigations internes. La ponctuation finale (.,;:)»…) reste du texte.
 */
export function LinkifiedText({ text }: { text: string }) {
  const parts = text.split(INTERNAL_PATH_RE);
  if (parts.length === 1) return <>{text}</>;
  return (
    <>
      {parts.map((part, i) => {
        if (i % 2 === 0) return <React.Fragment key={i}>{part}</React.Fragment>;
        const clean = part.replace(/[).,;:!?»…]+$/, "");
        const trail = part.slice(clean.length);
        const isDownload = /^\/api\/drive\/[^/]+\/raw/.test(clean);
        return (
          <React.Fragment key={i}>
            {isDownload ? (
              <a href={clean} download className="font-medium text-primary underline underline-offset-2 [overflow-wrap:anywhere] hover:opacity-80">
                {clean}
              </a>
            ) : (
              <Link href={clean} className="font-medium text-primary underline underline-offset-2 [overflow-wrap:anywhere] hover:opacity-80">
                {clean}
              </Link>
            )}
            {trail}
          </React.Fragment>
        );
      })}
    </>
  );
}

export function AssistantChat({
  userName, configured, messageIaNonConfiguree = "IA non configurée.", voiceConfigured = false, realtimeVoice = false, memoryEnabled = false,
  executive = false, initialPrompt = null, initialThreadId = null, initialMessages = null, initialCallRef = null,
  emptyState = null, historyMode = "rail", surface = "card", canvas = false,
  historyOpen, onHistoryOpenChange,
}: {
  userName: string; configured: boolean;
  /**
   * LA PHRASE DU REFUS, COMPOSÉE PAR LE SERVEUR (§118.128) — pas le nom de la clé.
   *
   * Le nom se lit dans le registre des modèles, donc côté serveur : un composant client qui
   * importerait `lib/ai.ts` tirerait la passerelle dans le navigateur. La première version
   * recevait le NOM et composait la phrase ici, en important le module pur du socle ; le cliquet
   * de frontière a compté 429 pour un plafond de 428, et le remède n'est jamais de relever le
   * plafond (§118.72, §118.114). Recevoir la phrase FINIE est plus petit encore : cet écran
   * n'importe alors plus rien, et la phrase vit toujours à UN seul endroit.
   */
  messageIaNonConfiguree?: string;
  /** Dictée disponible (transcription simple, texte éditable avant envoi). */
  voiceConfigured?: boolean;
  /** APPEL temps réel (speech-to-speech) disponible — siège exécutif + clé Realtime. */
  realtimeVoice?: boolean;
  memoryEnabled?: boolean;
  /** Mode Chief of Staff : panneau CONTEXTE (sources, actions) sur grand écran. */
  executive?: boolean;
  /** Entrée contextuelle (?q=…) : la question est pré-remplie, prête à partir. */
  initialPrompt?: string | null;
  /** LE FIL PRINCIPAL : la conversation continue qui s'ouvre d'office (Chief of Staff). */
  initialThreadId?: string | null;
  /**
   * LES DERNIERS TOURS, RENDUS PAR LE SERVEUR — ce qui supprime l'écran vide au retour.
   *
   * Avant : la page peignait l'état d'accueil, puis un `useEffect` allait chercher l'historique,
   * puis les messages apparaissaient. Trois états visibles pour rouvrir une conversation qui
   * était déjà en base. Fournis ici, les tours sont dans le PREMIER rendu ; le chargement
   * client ne sert plus qu'à ouvrir un AUTRE fil depuis l'historique.
   */
  initialMessages?: TourRelu[] | null;
  /** APPEL DEPUIS UNE FICHE (?call=1&ref=…) : l'appel démarre avec ce dossier en contexte. */
  initialCallRef?: string | null;
  /**
   * L'ÉCRAN VIDE, remplacé par l'hôte. Le bureau d'Adam y met sa salutation et ses quatre
   * amorces ; la page Assistant de l'ERP garde le sien. Rien n'est supprimé : c'est l'hôte qui
   * choisit ce qu'on voit avant le premier message.
   */
  emptyState?: React.ReactNode;
  /**
   * OÙ VIT L'HISTORIQUE. `rail` = colonne permanente de 256 px (la page Assistant historique).
   * `drawer` = derrière un bouton, comme dans le bureau d'Adam : une liste de conversations
   * affichée en continu prend un cinquième de la largeur pour une chose qu'on ouvre trois fois
   * par jour.
   */
  historyMode?: "rail" | "drawer";
  /**
   * `card` = la conversation est une carte posée dans une page. `flush` = elle EST la page —
   * pas de bordure ni de coins arrondis, parce qu'il n'y a rien autour dont il faille la
   * distinguer.
   */
  surface?: "card" | "flush";
  /**
   * LE FIL COMME CANVAS (bureau d'Adam).
   *
   * `false` — la page Assistant de l'ERP : bulles classiques, elle ne change pas d'un pixel.
   * `true`  — la conversation d'Adam : le tour utilisateur devient une pastille claire, et la
   * réponse d'Adam n'a plus de bulle du tout. Le texte s'écrit à même la page, sous son nom et
   * son heure, et les objets métier viennent juste dessous. Une bulle grise autour d'une
   * réponse qui contient déjà une carte encadre un cadre : deux boîtes pour une idée.
   */
  canvas?: boolean;
  /**
   * L'HISTORIQUE, PILOTÉ PAR L'HÔTE (optionnel). Sans ces deux props, la conversation garde son
   * propre état — la page Assistant de l'ERP ne change pas. Avec elles, le bureau d'Adam peut
   * mettre le bouton dans SON en-tête, et n'avoir qu'UNE barre au lieu de deux : sur un
   * téléphone de 390 px, deux barres empilées, c'est 110 px de chrome avant le premier mot.
   */
  historyOpen?: boolean;
  onHistoryOpenChange?: (open: boolean) => void;
}) {
  const confirmer = useConfirmer();
  const retours = useRetours();
  const [messages, setMessages] = React.useState<Msg[]>(() => (initialMessages ?? []).map(repriseDuTour));
  const [input, setInput] = React.useState("");
  const [sending, setSending] = React.useState(false);
  /** Les SOURCES consultées pendant la conversation (liens internes), les plus récentes d'abord. */
  const [sources, setSources] = React.useState<{ label: string; href: string; detail?: string }[]>([]);
  const [attachments, setAttachments] = React.useState<PendingAttach[]>([]);
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [dragOver, setDragOver] = React.useState(false);
  /** Réponse EN COURS d'écriture (texte partiel + étapes de lecture déjà annoncées). */
  const [streaming, setStreaming] = React.useState<{ text: string; trace: string[]; workspace: WorkspaceComposition[] } | null>(null);
  const abortRef = React.useRef<AbortController | null>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const taRef = React.useRef<HTMLTextAreaElement>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);

  // ── Mémoire personnelle : fil courant + historique de MES conversations.
  //    Le serveur ne renvoie jamais que les fils du demandeur (cf. assistant-memory.ts).
  // LE FIL EST OUVERT DÈS LE PREMIER RENDU quand le serveur a fourni ses tours : pas d'écran
  // d'accueil qui clignote, pas de « Ouverture… », pas d'aller-retour pour relire ce qui était
  // déjà en base.
  const [threadId, setThreadId] = React.useState<string | null>(
    initialMessages && initialMessages.length ? initialThreadId : null,
  );
  const [threads, setThreads] = React.useState<ThreadSummary[]>([]);
  const [histOpenLocal, setHistOpenLocal] = React.useState(false);
  const histOpen = historyOpen ?? histOpenLocal;
  const setHistOpen = React.useCallback((v: boolean) => {
    if (onHistoryOpenChange) onHistoryOpenChange(v);
    else setHistOpenLocal(v);
  }, [onHistoryOpenChange]);
  const [loadingThread, setLoadingThread] = React.useState(false);
  useScrollLock(histOpen); // sinon la conversation défile derrière le tiroir d'historique

  const refreshThreads = React.useCallback(async () => {
    if (!memoryEnabled) return;
    setThreads(await myAssistantThreads());
  }, [memoryEnabled]);

  React.useEffect(() => { void refreshThreads(); }, [refreshThreads]);

  // Entrée contextuelle (« Demander au Chief of Staff » depuis une fiche) : la question arrive
  // PRÉ-REMPLIE, jamais envoyée toute seule — on relit avant d'envoyer, même une question.
  React.useEffect(() => {
    if (initialPrompt && initialPrompt.trim()) {
      setInput(initialPrompt.trim());
      taRef.current?.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPrompt]);

  React.useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, sending, streaming?.text]);

  const newConversation = () => {
    setThreadId(null); setMessages([]); setInput(""); setAttachments([]); setHistOpen(false);
    taRef.current?.focus();
  };

  const openThread = async (id: string) => {
    setHistOpen(false);
    if (id === threadId) return;
    setLoadingThread(true);
    try {
      const stored = await myAssistantThread(id);
      if (!stored) { await refreshThreads(); return; } // fil disparu (ou jamais le mien)
      setThreadId(id);
      // CE QU'ADAM AVAIT CONSTRUIT revient avec le tour (`repriseDuTour`).
      setMessages(stored.map(repriseDuTour));
    } finally {
      setLoadingThread(false);
    }
  };

  // LE FIL PRINCIPAL s'ouvre d'office : la conversation avec le Chief of Staff CONTINUE dans le
  // temps au lieu de repartir de zéro. Seuls les derniers échanges sont rechargés (plafond côté
  // serveur) — le passé lointain se retrouve par recall_conversation.
  React.useEffect(() => {
    // SI LE SERVEUR A DÉJÀ RENDU LES TOURS, il n'y a rien à aller chercher : refaire l'appel
    // remplacerait l'écran par le même écran, une seconde plus tard. On ne charge que lorsque
    // la page n'a pas pu fournir l'historique (ancienne page, ou fil vide).
    if (initialMessages && initialMessages.length) return;
    if (initialThreadId && memoryEnabled) void openThread(initialThreadId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialThreadId, memoryEnabled]);

  const removeThread = async (id: string) => {
    try {
      const r = await deleteMyAssistantThread(id);
      if (r.ok) {
        if (id === threadId) { setThreadId(null); setMessages([]); }
        await refreshThreads();
      }
    } catch {
      retours.erreur(actionFailureMessage("THROWN"));
    }
  };

  const forgetAll = async () => {
    if (!(await confirmer("Effacer TOUTE la mémoire de votre assistant (conversations et souvenirs) ? Cette action est définitive."))) return;
    try {
      const r = await forgetMyAssistantMemory();
      if (r.ok) { setThreadId(null); setMessages([]); await refreshThreads(); }
    } catch {
      retours.erreur(actionFailureMessage("THROWN"));
    }
  };

  const addFiles = (files: FileList | File[]) => {
    const list = Array.from(files);
    if (list.length === 0) return;
    setAttachments((prev) => [
      ...prev,
      ...list.map((file) => ({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, kind: "upload" as const, name: file.name, file })),
    ].slice(0, 6));
  };
  const addDriveFile = (f: AssistantFileOption) => {
    setAttachments((prev) => (prev.some((a) => a.kind === "drive" && a.nodeId === f.id) ? prev : [...prev, { id: f.id, kind: "drive" as const, name: f.name, nodeId: f.id }].slice(0, 6)));
  };
  const removeAttachment = (id: string) => setAttachments((prev) => prev.filter((a) => a.id !== id));

  // ── Dictée vocale : on parle, Whisper transcrit, le texte arrive dans la zone de saisie
  //    (ÉDITABLE) — l'utilisateur relit/corrige avant d'envoyer. L'audio n'est pas conservé.
  const [recording, setRecording] = React.useState(false);
  const [transcribing, setTranscribing] = React.useState(false);
  const [voiceMsg, setVoiceMsg] = React.useState<string | null>(null);
  const mr = React.useRef<MediaRecorder | null>(null);
  const chunks = React.useRef<Blob[]>([]);

  const startRec = async () => {
    setVoiceMsg(null);
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setVoiceMsg("Le micro nécessite une connexion sécurisée (HTTPS). Vous pouvez aussi écrire votre message.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      chunks.current = [];
      rec.ondataavailable = (e) => { if (e.data.size) chunks.current.push(e.data); };
      rec.onstop = async () => { stream.getTracks().forEach((t) => t.stop()); await transcribe(new Blob(chunks.current, { type: rec.mimeType || "audio/webm" })); };
      rec.start(); mr.current = rec; setRecording(true);
    } catch {
      setVoiceMsg("Micro inaccessible — autorisez-le dans le navigateur, ou écrivez votre message.");
    }
  };
  const stopRec = () => { mr.current?.stop(); setRecording(false); };

  const transcribe = async (blob: Blob) => {
    setTranscribing(true); setVoiceMsg(null);
    try {
      const f = new FormData(); f.set("file", blob, "audio.webm");
      const res = await fetch("/api/assistant/transcribe", { method: "POST", body: f });
      const data = await res.json();
      if (data.transcript) {
        setInput((prev) => (prev.trim() ? `${prev.trim()} ${data.transcript}` : data.transcript));
        taRef.current?.focus();
      } else setVoiceMsg(data.error ?? "Transcription indisponible — vous pouvez écrire à la main.");
    } catch {
      setVoiceMsg("Envoi de l'audio impossible.");
    } finally {
      setTranscribing(false);
    }
  };

  // ── APPEL VOCAL : le pont avec l'APPEL GLOBAL (CallProvider, monté au layout — l'appel
  //    survit à la navigation ERP). Pendant un appel, le texte tapé entre DANS la session
  //    (réponse parlée) ; les tours vocaux et les cartes d'outils reviennent s'afficher ICI —
  //    voix et texte sont deux modalités de la même conversation.
  const call = useCall();
  const onVoiceTurn = React.useCallback((userText: string, assistantText: string) => {
    setMessages((m) => [
      ...m,
      { id: nextId(), role: "user", content: userText },
      { id: nextId(), role: "assistant", at: Date.now(), content: assistantText },
    ]);
    void refreshThreads();
  }, [refreshThreads]);
  const onVoiceToolUi = React.useCallback((ui: VoiceToolUi) => {
    if (ui.sources?.length) {
      setSources((prev) => {
        const merged = [...prev];
        for (const s of ui.sources ?? []) if (!merged.some((x) => x.href === s.href)) merged.unshift(s);
        return merged.slice(0, 30);
      });
    }
    const proposals = (ui.proposals ?? null) as ProposedAction[] | null;
    // Le COMPAGNON VISUEL : les actions à confirmer et les analyses détaillées s'affichent
    // dans le fil pendant que la voix résume — la carte de confirmation reste LA porte.
    if (proposals?.length) {
      setMessages((m) => [...m, {
        id: nextId(), role: "assistant", at: Date.now(),
        content: ui.reply || (proposals.length === 1 ? "Action proposée — à confirmer ci-dessous." : `${proposals.length} actions proposées — à confirmer ci-dessous.`),
        trace: ui.trace,
        proposals,
        actionStates: proposals.map(() => "pending" as ActionState),
        actionResults: proposals.map(() => undefined),
        actionLinks: proposals.map(() => undefined),
      }]);
    } else if (ui.reply && ui.reply.length > 400) {
      // Une analyse déléguée détaillée mérite l'écran ; la voix n'en dit que la synthèse.
      setMessages((m) => [...m, { id: nextId(), role: "assistant", at: Date.now(), content: ui.reply as string, trace: ui.trace }]);
    }
  }, []);

  // Le chat se BRANCHE sur l'appel global tant qu'il est monté (les tours et cartes arrivés
  // pendant une navigation ailleurs sont bufferisés par le provider et rattrapés ici).
  const setBridge = call.setBridge;
  React.useEffect(() => {
    setBridge({ onTurn: onVoiceTurn, onToolUi: onVoiceToolUi, onThreadId: (tid) => setThreadId(tid) });
    return () => setBridge(null);
  }, [setBridge, onVoiceTurn, onVoiceToolUi]);

  // APPEL DEPUIS UNE FICHE : ?call=1&ref=… — l'appel démarre AVEC le dossier en contexte
  // (« Où ça bloque ? » se comprend tout seul). Un seul démarrage, jamais en boucle.
  const callStartedRef = React.useRef(false);
  React.useEffect(() => {
    if (initialCallRef === null || callStartedRef.current || !realtimeVoice) return;
    callStartedRef.current = true;
    call.start({
      threadId,
      screenContext: initialCallRef
        ? `L'utilisateur appelle DEPUIS la fiche « ${initialCallRef} » — « ça », « ce dossier » s'y réfèrent sauf indication contraire.`
        : null,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialCallRef, realtimeVoice]);

  /** Envoie un tour et REND la réponse finale — la voix en a besoin pour parler. */
  const send = async (text: string): Promise<string | null> => {
    const content = text.trim();
    const pending = attachments;
    if ((!content && pending.length === 0) || sending || !configured) return null;

    // Pendant un APPEL : le message tapé entre dans la session vocale (sans pièces jointes —
    // elles passent par le circuit texte habituel). La réponse arrive parlée ET transcrite.
    if (call.active && pending.length === 0 && content && call.sendText(content)) {
      setInput("");
      return null;
    }
    const userMsg: Msg = { id: nextId(), role: "user", content: content || "(pièces jointes)", at: Date.now(), attachmentNames: pending.map((a) => a.name) };
    const next = [...messages, userMsg];
    setMessages(next);
    setInput("");
    setAttachments([]);
    setSending(true);

    const history: ChatTurn[] = next
      .filter((m) => m.content.trim().length > 0)
      .map((m) => ({ role: m.role, content: m.content }));

    try {
      // Les pièces jointes passent par l'action serveur (elles doivent être résolues et
      // extraites avant l'appel au modèle) ; une conversation SANS pièce jointe passe par le
      // FLUX, pour que la réponse s'écrive au lieu de tomber d'un bloc.
      if (pending.length > 0) {
        const payload: AssistantAttachment[] = await Promise.all(
          pending.map(async (a) =>
            a.kind === "upload"
              ? ({ kind: "upload", name: a.name, dataB64: await fileToBase64(a.file) } as AssistantAttachment)
              : ({ kind: "drive", nodeId: a.nodeId, name: a.name } as AssistantAttachment),
          ),
        );
        const res = await assistantChat(history, payload, threadId);
        return appendResult(res);
      }
      return await streamAnswer(history);
    } catch {
      setMessages((m) => [...m, { id: nextId(), role: "assistant", at: Date.now(), content: "Appel à l'assistant impossible." }]);
      return null;
    } finally {
      setSending(false);
      setStreaming(null);
      if (!call.active) taRef.current?.focus();
    }
  };
  /** Ajoute le résultat d'un tour non diffusé (pièces jointes) à la conversation. */
  const appendResult = (res: AssistantResult, workspace: WorkspaceComposition[] = []): string | null => {
    if (!res.configured) {
      // LE MÊME FAIT, LA MÊME PHRASE. Elle disait « IA non configurée. » tout court pendant que la
      // bannière, deux cents lignes plus bas, nommait le geste : deux vérités sur le même refus, et
      // c'est la version muette qui tombait dans la conversation (§118.5, §118.30).
      setMessages((m) => [...m, { id: nextId(), role: "assistant", at: Date.now(), content: messageIaNonConfiguree }]);
      return null;
    }
    if (res.ok) {
      const proposals = res.proposals ?? (res.proposal ? [res.proposal] : []);
      setMessages((m) => [...m, {
        id: nextId(), role: "assistant", content: res.reply, trace: res.trace,
        workspace: workspace.length ? workspace : undefined,
        proposals: proposals.length ? proposals : undefined,
        actionStates: proposals.length ? proposals.map(() => "pending" as ActionState) : undefined,
        actionResults: proposals.length ? proposals.map(() => undefined) : undefined,
        actionLinks: proposals.length ? proposals.map(() => undefined) : undefined,
      }]);
      // LE TOUR NOMME LES CARTES QU'IL REND CADUQUES : on les éteint AVANT de rendre la main,
      // pour qu'aucune frappe rapide ne tombe sur un bouton que le serveur refuse déjà.
      if (res.perimees?.length) eteindrePerimees(res.perimees);
      if (res.threadId) { setThreadId(res.threadId); void refreshThreads(); }
      return res.reply || null;
    }
    setMessages((m) => [...m, { id: nextId(), role: "assistant", at: Date.now(), content: res.error ?? "Une erreur est survenue." }]);
    return null;
  };

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   * LE GESTE DÉTERMINISTE — un clic, une lecture, ZÉRO appel au modèle (§23).
   *
   * Le bouton porte l'intention exacte que le serveur a écrite en le dessinant. Il n'y a donc
   * rien à comprendre : on appelle la lecture, on affiche l'objet. Pas de flux, pas de
   * rédaction — et pas de commentaire inventé sous la carte, puisque personne ne l'a rédigé.
   *
   * EN CAS D'ÉCHEC, ON RETOMBE SUR LA CONVERSATION. Un geste refusé (droit manquant, capacité
   * retirée du registre) ne doit pas laisser un bouton mort : la phrase repart par la porte
   * normale, qui sait quoi faire d'une demande en français.
   * ═══════════════════════════════════════════════════════════════════════════════════════
   */
  const runDirect = async (phrase: string, intent: WorkspaceActionIntent): Promise<void> => {
    if (sending) return;
    const userMsg: Msg = { id: nextId(), role: "user", content: phrase, at: Date.now() };
    setMessages((m) => [...m, userMsg]);
    setSending(true);
    try {
      const data = await assistantDirectIntent(intent.capability, intent.args);
      if (!data.ok) throw new Error("geste refusé");
      setMessages((m) => [...m, {
        id: nextId(), role: "assistant", at: Date.now(),
        content: data.reply,
        trace: data.label ? [data.label] : undefined,
        workspace: data.composition ? [data.composition] : undefined,
      }]);
    } catch {
      // Le repli EST la conversation : elle a toujours su répondre à une phrase.
      setSending(false);
      void send(phrase);
      return;
    } finally {
      setSending(false);
    }
  };

  /**
   * Tour de conversation EN FLUX (Server-Sent Events). On affiche, dans l'ordre où ils
   * arrivent : les étapes de lecture, puis le texte mot à mot. La réponse n'apparaît plus
   * d'un bloc après un long silence.
   */
  const streamAnswer = async (history: ChatTurn[]): Promise<string | null> => {
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setStreaming({ text: "", trace: [], workspace: [] });
    // Accumulé LOCALEMENT au tour : c'est ce qui sera attaché au message final. L'état React
    // sert l'aperçu pendant la diffusion ; cette liste-ci survit à la fin du flux.
    const composed: WorkspaceComposition[] = [];

    const res = await fetch("/api/assistant/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ history, threadId }),
      signal: ctrl.signal,
    });
    if (!res.ok || !res.body) {
      setMessages((m) => [...m, { id: nextId(), role: "assistant", at: Date.now(), content: "L'assistant est momentanément indisponible." }]);
      return null;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let finished = false;
    let reply: string | null = null;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, sep).trim();
        buffer = buffer.slice(sep + 2);
        if (!raw.startsWith("data:")) continue;
        let evt: StreamEvent;
        try { evt = JSON.parse(raw.slice(5).trim()) as StreamEvent; } catch { continue; }

        if (evt.type === "delta") {
          setStreaming((s) => ({ text: (s?.text ?? "") + evt.text, trace: s?.trace ?? [], workspace: s?.workspace ?? [] }));
        } else if (evt.type === "trace") {
          setStreaming((s) => ({ text: s?.text ?? "", trace: s?.trace.includes(evt.label) ? s.trace : [...(s?.trace ?? []), evt.label], workspace: s?.workspace ?? [] }));
        } else if (evt.type === "source") {
          // Le panneau CONTEXTE se remplit au moment même où l'assistant consulte.
          setSources((prev) => (prev.some((s) => s.href === evt.href) ? prev : [{ label: evt.label, href: evt.href, detail: evt.detail }, ...prev].slice(0, 30)));
        } else if (evt.type === "workspace") {
          // La donnée est là AVANT la phrase : on l'affiche tout de suite, elle n'attend pas
          // qu'Adam ait fini de la commenter.
          composed.push(evt.composition);
          setStreaming((s) => ({ text: s?.text ?? "", trace: s?.trace ?? [], workspace: [...(s?.workspace ?? []), evt.composition] }));
        } else if (evt.type === "reset") {
          // Le texte affiché n'était qu'un préambule à un appel d'outil. Les blocs déjà rendus
          // viennent de la base, eux : ils restent.
          setStreaming((s) => ({ text: "", trace: s?.trace ?? [], workspace: s?.workspace ?? [] }));
        } else if (evt.type === "done") {
          finished = true;
          reply = appendResult(evt.result, composed);
        }
      }
    }
    if (!finished) {
      // Flux interrompu : on conserve ce qui a été écrit plutôt que de tout perdre.
      setStreaming((s) => {
        if (s?.text) setMessages((m) => [...m, {
          id: nextId(), role: "assistant", content: s.text, trace: s.trace,
          workspace: s.workspace.length ? s.workspace : undefined,
        }]);
        return null;
      });
    }
    return reply;
  };

  /** Interrompt la génération en cours (le texte déjà écrit est conservé). */
  const stopStreaming = () => {
    abortRef.current?.abort();
    abortRef.current = null;
  };

  /** Met à jour l'état d'UNE action (par son index) dans le message qui la porte. */
  const patchAction = (msgId: number, index: number, patch: { state: ActionState; result?: string; link?: string }) => {
    setMessages((m) => m.map((x) => {
      if (x.id !== msgId || !x.actionStates) return x;
      const actionStates = [...x.actionStates];
      const actionResults = [...(x.actionResults ?? [])];
      const actionLinks = [...(x.actionLinks ?? [])];
      actionStates[index] = patch.state;
      actionResults[index] = patch.result;
      actionLinks[index] = patch.link;
      return { ...x, actionStates, actionResults, actionLinks };
    }));
  };

  const confirm = async (msgId: number, index: number, payload: AssistantActionPayload, intentId?: string, confirmTyped?: string): Promise<boolean> => {
    patchAction(msgId, index, { state: "running" });
    try {
      // L'INTENT accompagne la confirmation : l'exécution est idempotente côté serveur (un
      // double-clic ou une reconnexion renvoie le reçu d'origine, jamais un second envoi).
      // La valeur RESSAISIE (action CRITIQUE) part avec : c'est le SERVEUR qui la vérifie.
      const r = await executeAssistantAction(payload, intentId, confirmTyped);
      patchAction(msgId, index, { state: r.ok ? "done" : "error", result: r.ok ? r.message : r.error, link: r.link });
      return r.ok;
    } catch {
      patchAction(msgId, index, { state: "error", result: "Exécution impossible." });
      return false;
    }
  };

  /** Un lot à la fois par message : un double-clic ne lance pas deux exécutions. */
  const confirmingAllRef = React.useRef<Set<number>>(new Set());
  /**
   * TOUT CONFIRMER — UN SEUL APPEL SERVEUR.
   *
   * Cette fonction bouclait ici, dans le navigateur : un aller-retour par action. Un onglet
   * fermé, un réseau qui coupe ou un téléphone qui se verrouille au milieu laissait la moitié
   * du lot partie, sans que personne ne sache laquelle. L'enchaînement est passé côté serveur ;
   * la page n'a plus qu'à afficher le compte rendu.
   *
   * Les actions CRITIQUES ne s'enchaînent toujours pas — mais c'est désormais le SERVEUR qui le
   * refuse et le DIT, au lieu d'un `continue` silencieux ici. Une carte qu'on saute sans le dire
   * laisse croire qu'elle est partie.
   */
  const confirmAll = async (msg: Msg) => {
    if (!msg.proposals || !msg.actionStates) return;
    if (confirmingAllRef.current.has(msg.id)) return; // double-clic = un seul lot
    confirmingAllRef.current.add(msg.id);

    // L'ordre des cartes fait foi : c'est celui que le modèle a proposé, donc celui qui porte
    // le chaînage entre étapes.
    const picked = msg.proposals
      .map((p, i) => ({ p, i }))
      .filter(({ i }) => msg.actionStates![i] === "pending")
      .filter(({ p }) => Boolean(p.intentId));
    if (!picked.length) { confirmingAllRef.current.delete(msg.id); return; }

    for (const { i } of picked) patchAction(msg.id, i, { state: "running" });

    try {
      const res = await executeAssistantBundle(picked.map(({ p }) => p.intentId!));
      const byIntent = new Map(res.outcomes.map((o) => [o.intentId, o]));
      for (const { p, i } of picked) {
        const o = byIntent.get(p.intentId!);
        if (!o) { patchAction(msg.id, i, { state: "error", result: "Résultat manquant — vérifiez l'état de cette action." }); continue; }
        if (o.status === "executed" || o.status === "already") {
          patchAction(msg.id, i, { state: "done", result: o.message ?? "Fait.", link: o.link });
        } else if (o.status === "refused" || o.status === "skipped") {
          // Elle n'est pas partie : elle redevient confirmable, avec la raison affichée.
          patchAction(msg.id, i, { state: "pending", result: o.error });
        } else {
          patchAction(msg.id, i, { state: "error", result: o.error ?? "L'action n'a pas pu être exécutée." });
        }
      }
    } catch {
      for (const { i } of picked) {
        patchAction(msg.id, i, { state: "error", result: "Le lot n'a pas pu être mené à son terme — vérifiez l'état de chaque action." });
      }
    } finally {
      confirmingAllRef.current.delete(msg.id);
    }
  };

  /**
   * LES CARTES QUE LE SERVEUR VIENT DE RETIRER S'ÉTEIGNENT ICI.
   *
   * Mesuré au banc live : le PDG propose une tâche pour Raihana, puis dit « non, finalement
   * Amel ». Le serveur annule la première (`CANCELLED` ; `executeIntentGuarded` la refuse), mais
   * l'écran continuait de PEINDRE son bouton. Aucune écriture fausse — le serveur tenait — mais
   * une interface qui offre un geste voué au refus, et l'ancienne carte restait la plus haute.
   *
   * On ne DEVINE rien côté client : on éteint exactement les identifiants que le tour a nommés
   * (`perimees`). C'est le serveur qui décide ce qui est caduc ; l'écran ne fait que suivre.
   */
  const eteindrePerimees = (ids: string[]) => {
    if (!ids.length) return;
    const morts = new Set(ids);
    setMessages((m) => m.map((x) => {
      if (!x.proposals?.length || !x.actionStates) return x;
      const actionStates = [...x.actionStates];
      let touche = false;
      x.proposals.forEach((a, i) => {
        if (a.intentId && morts.has(a.intentId) && actionStates[i] !== "done") {
          actionStates[i] = "cancelled";
          touche = true;
        }
      });
      return touche ? { ...x, actionStates } : x;
    }));
  };

  const cancel = (msgId: number, index: number, intentId?: string) => {
    patchAction(msgId, index, { state: "cancelled" });
    // L'état CANONIQUE serveur suit : « annulée — jamais exécutée » restera vrai partout.
    if (intentId) void cancelAssistantAction(intentId).catch(sansBloquer("assistant-chat.cancel.cancelAssistantAction"));
  };

  /**
   * LE MÊME OBJET NE S'EMPILE PAS — il change (§21, §22).
   *
   * Un brouillon d'e-mail devient un envoi, une mission devient une mission exécutée. Sans cet
   * élagage, chaque état poserait une carte de plus et le fil finirait avec trois versions du
   * même message dont on ne saurait plus laquelle fait foi.
   *
   * L'élagage se fait à l'AFFICHAGE, pas dans `messages` : l'historique reste intact, ce qui
   * importe pour la mémoire du fil et pour tout relire si besoin. Ce qu'on retire de l'écran,
   * on ne l'efface pas de la conversation.
   */
  const messagesElagues = React.useMemo(() => {
    const fil = elaguerFil(messages.map((m) => m.workspace ?? []));
    return messages.map((m, i) => (m.workspace ? { ...m, workspace: fil[i] } : m));
  }, [messages]);

  // Le panneau de droite a-t-il une raison d'exister à cet instant ?
  const showContextPanel = sources.length > 0
    || messages.some((m) => (m.proposals ?? []).length > 0);

  const rail = memoryEnabled ? (
    <ThreadRail
      threads={threads} current={threadId}
      onNew={newConversation} onOpen={openThread} onDelete={removeThread} onForget={forgetAll}
    />
  ) : null;

  return (
    // LES GESTES DE L'ESPACE DE TRAVAIL entrent par la MÊME porte que le clavier. Un bouton
    // « Approuver » posé sur une ligne de la file écrit la phrase exacte dans la conversation :
    // la mutation repasse donc par la proposition, la carte de confirmation et l'action
    // canonique — aucune seconde porte n'est ouverte pour aller plus vite.
    <WorkspaceAskProvider ask={(phrase, intent) => {
      if (intent) { void runDirect(phrase, intent); return; }
      void send(phrase);
    }}>
    <div className="flex min-h-0 flex-1 gap-0 lg:gap-4">
      {memoryEnabled && historyMode === "rail" && <div className="hidden w-64 shrink-0 lg:block">{rail}</div>}
      {memoryEnabled && histOpen && (
        <div className={`fixed inset-0 z-50 flex ${historyMode === "rail" ? "lg:hidden" : ""}`} role="dialog" aria-modal="true">
          <button type="button" aria-label="Fermer l'historique" className="absolute inset-0 bg-black/40" onClick={() => setHistOpen(false)} />
          <div className="relative z-10 h-full w-72 max-w-[85vw] p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-[max(0.5rem,env(safe-area-inset-top))]">{rail}</div>
        </div>
      )}

    <div className={surface === "flush" ? "flex min-h-0 flex-1 flex-col overflow-hidden" : "flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border bg-card"}>
      {memoryEnabled && surface !== "flush" && (
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <button type="button" onClick={() => setHistOpen(true)} className={`flex min-h-9 shrink-0 items-center gap-1.5 rounded-lg px-2 py-1 text-sm text-muted-foreground sm:min-h-0 transition hover:bg-secondary hover:text-foreground ${historyMode === "rail" ? "lg:hidden" : ""}`}>
            <History className="h-4 w-4" /> Historique
          </button>
          <span className="min-w-0 flex-1 truncate text-sm font-medium">
            {loadingThread ? "Ouverture…" : threads.find((t) => t.id === threadId)?.title ?? "Nouvelle conversation"}
          </span>
          <button type="button" onClick={newConversation} title="Nouvelle conversation"
            className="flex min-h-9 min-w-9 shrink-0 items-center justify-center gap-1.5 rounded-lg px-2 py-1 text-sm text-muted-foreground transition hover:bg-secondary hover:text-foreground sm:min-h-0 sm:min-w-0">
            <Plus className="h-4 w-4" /> <span className="hidden sm:inline">Nouvelle</span>
          </button>
        </div>
      )}
      {!configured && (
        <div className="flex items-start gap-2 border-b border-border bg-warning/10 px-4 py-2.5 text-sm text-warning">
          <KeyRound className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="min-w-0 [overflow-wrap:anywhere]">{messageIaNonConfiguree}</span>
        </div>
      )}

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-4 sm:px-6 sm:py-6">
        {/* LE FLUX PORTE LE PLAN DE TRAVAIL, pas la colonne de lecture (globals.css) : c'est
            chaque CONTENU qui déclare sa mesure — `chat-measure` pour la prose, toute la
            largeur pour l'espace de travail d'un tour. Une borne unique écrasait la donnée. */}
        <div className="chat-surface space-y-6">
        {messages.length === 0 && emptyState ? (
          <div className="chat-measure">{emptyState}</div>
        ) : messages.length === 0 ? (
          <div className="mx-auto max-w-xl py-8 text-center">
            <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-primary to-purple-500 text-primary-foreground shadow-lg">
              <Sparkles className="h-6 w-6" />
            </div>
            <h2 className="text-lg font-semibold">Bonjour {userName.split(" ")[0]} 👋</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Posez une question sur votre travail, ou demandez-moi de préparer une action.
              Je m'appuie sur vos données (selon vos droits) et chaque action vous est soumise pour confirmation.
            </p>
            <div className="mt-5 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => send(s)}
                  disabled={!configured}
                  className="group flex items-center gap-2 rounded-xl border border-border bg-card px-3 py-2.5 text-left text-sm transition hover:border-primary/50 hover:bg-secondary/50 disabled:opacity-50"
                >
                  <Wand2 className="h-4 w-4 shrink-0 text-primary" />
                  <span className="min-w-0 flex-1">{s}</span>
                  <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100" />
                </button>
              ))}
            </div>
          </div>
        ) : (
          messagesElagues.map((m) => (
            <MessageBubble key={m.id} msg={m} onConfirm={confirm} onCancel={cancel} onConfirmAll={confirmAll} canvas={canvas} />
          ))
        )}
        {/* Réponse EN COURS : on montre ce que l'assistant fait, puis ce qu'il écrit — jamais
            un long silence suivi d'un pavé. */}
        {sending && (
          <div className="flex gap-3">
            <Avatar />
            <div className="min-w-0 flex-1 space-y-1.5">
              {/* Les PHASES et le TEXTE se lisent ; les BLOCS s'examinent. Deux mesures, et
                  c'est pour cela que l'espace de travail est HORS de ce conteneur. */}
              <div className="chat-measure space-y-1.5">
              {/* §18 — LA LATENCE PERÇUE. Des ÉTATS MÉTIER pendant que la mission tourne
                  (« Préparation du message »), jamais la liste des outils appelés. La dernière
                  phase reste marquée EN COURS tant que le tour n'est pas rendu : c'est ce qui
                  distingue « ça avance » de « ça a fini ». */}
              {streaming && streaming.trace.length > 0 && (
                <ol className="chief-phases" data-testid="streaming-phases">
                  {phasesOf(streaming.trace, false).map((ph, i) => (
                    <li key={`${ph.label}-${i}`} className="chief-phase" data-state={ph.state}>
                      {ph.state === "running"
                        ? <Loader2 className="chief-phase-icon chief-phase-spin" aria-hidden />
                        : <CheckCircle2 className="chief-phase-icon" aria-hidden />}
                      <span>{ph.label}</span>
                    </li>
                  ))}
                </ol>
              )}
              {streaming?.text ? (
                <p className={`whitespace-pre-wrap leading-relaxed [overflow-wrap:anywhere] ${canvas ? "chief-turn-text" : "text-[0.9375rem]"}`}>
                  <LinkifiedText text={cleanReply(streaming.text)} />
                  <span className="ml-0.5 inline-block h-4 w-[2px] animate-pulse bg-foreground align-middle" aria-hidden />
                </p>
              ) : streaming?.workspace.length ? (
                // La donnée est déjà à l'écran : annoncer « l'assistant réfléchit » par-dessus
                // un tableau rempli serait faux. On laisse lire.
                null
              ) : (
                <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> L&apos;assistant réfléchit…
                </p>
              )}
              </div>
              {streaming?.workspace.map((c, i) => <WorkspaceBlocks key={`${c.source}-${i}`} composition={c} />)}
            </div>
          </div>
        )}
        </div>
      </div>

      <div className="relative border-t border-border bg-card p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:p-4">
        <div className="chat-measure">
        {pickerOpen && <DriveFilePicker onPick={addDriveFile} onClose={() => setPickerOpen(false)} />}

        {/* Pièces jointes en attente */}
        {attachments.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {attachments.map((a) => (
              <span key={a.id} className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-lg border border-border bg-secondary/60 py-0.5 pl-2 pr-0.5 text-xs sm:py-1 sm:pr-2">
                <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 max-w-[180px] truncate">{a.name}</span>
                {a.kind === "drive" && <span className="shrink-0 text-[0.6875rem] text-muted-foreground">Drive</span>}
                <button type="button" onClick={() => removeAttachment(a.id)} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:text-destructive sm:h-auto sm:w-auto"><X className="h-3.5 w-3.5 sm:h-3 sm:w-3" /></button>
              </span>
            ))}
          </div>
        )}

        {(recording || transcribing || voiceMsg) && (
          <div className="mb-2 space-y-1">
            {recording && <p className="flex items-center gap-2 text-xs text-destructive"><span className="h-2 w-2 animate-pulse rounded-full bg-destructive" /> Enregistrement… parlez, puis cliquez sur le carré pour transcrire.</p>}
            {transcribing && <p className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Transcription en cours…</p>}
            {voiceMsg && <p className="rounded-lg bg-accent/60 px-3 py-1.5 text-xs text-accent-foreground [overflow-wrap:anywhere]">{voiceMsg}</p>}
          </div>
        )}

        {/* Au téléphone, les boutons-outils passent sur une seconde ligne : en ligne avec le
            champ, ils ne lui laissaient qu'environ 80 px sur un écran de 360 px. */}
        <form
          onSubmit={(e) => { e.preventDefault(); send(input); }}
          onDragOver={(e) => { if (configured) { e.preventDefault(); setDragOver(true); } }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); if (configured && e.dataTransfer.files?.length) addFiles(e.dataTransfer.files); }}
          className={`flex flex-wrap items-end gap-2 rounded-xl sm:flex-nowrap ${dragOver ? "ring-2 ring-primary/50" : ""}`}
        >
          <input ref={fileRef} type="file" multiple className="hidden" onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ""; }} />
          <div className="order-last -ml-1 flex w-full items-center gap-1 sm:order-none sm:ml-0 sm:w-auto">
            {/* LE TÉLÉPHONE — « Appeler My Chief of Staff » (conversation temps réel). Distinct
                de la dictée (icône micro) : appeler ≠ dicter. */}
            {realtimeVoice && (
              <button type="button"
                title={call.active ? "Reprendre l'appel en cours" : "Appeler My Chief of Staff — conversation vocale temps réel"}
                onClick={() => (call.active ? call.setMinimized(false) : call.start({ threadId }))}
                disabled={!configured}
                className={`flex h-10 w-10 items-center justify-center rounded-xl sm:h-[2.75rem] sm:w-9 transition disabled:opacity-50 ${call.active ? "bg-primary/15 text-primary" : "text-muted-foreground hover:bg-secondary hover:text-foreground"}`}>
                <Phone className="h-4 w-4" />
              </button>
            )}
            {voiceConfigured && (recording ? (
              <button type="button" title="Arrêter et transcrire" onClick={stopRec}
                className="flex h-10 w-10 items-center justify-center rounded-xl sm:h-[2.75rem] sm:w-9 text-destructive transition hover:bg-destructive/10">
                <Square className="h-4 w-4" />
              </button>
            ) : (
              <button type="button" title="Dicter — la voix est transcrite en texte, éditable avant l'envoi" onClick={startRec} disabled={!configured || sending || transcribing}
                className="flex h-10 w-10 items-center justify-center rounded-xl sm:h-[2.75rem] sm:w-9 text-muted-foreground transition hover:bg-secondary hover:text-foreground disabled:opacity-50">
                {transcribing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mic className="h-4 w-4" />}
              </button>
            ))}
            <button type="button" title="Joindre un fichier (glisser-déposer possible)" onClick={() => fileRef.current?.click()} disabled={!configured || sending}
              className="flex h-10 w-10 items-center justify-center rounded-xl sm:h-[2.75rem] sm:w-9 text-muted-foreground transition hover:bg-secondary hover:text-foreground disabled:opacity-50">
              <Paperclip className="h-4 w-4" />
            </button>
            <button type="button" title="Choisir un fichier de mon Drive (sans le re-téléverser)" onClick={() => setPickerOpen((o) => !o)} disabled={!configured || sending}
              className={`flex h-10 w-10 items-center justify-center rounded-xl sm:h-[2.75rem] sm:w-9 transition hover:bg-secondary disabled:opacity-50 ${pickerOpen ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"}`}>
              <FolderOpen className="h-4 w-4" />
            </button>
          </div>
          <textarea
            ref={taRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(input); } }}
            placeholder={
              configured
                ? dragOver
                  ? "Déposez vos fichiers ici…"
                  // Le bureau d'Adam s'adresse à quelqu'un qui DEMANDE ou qui ORDONNE. « Écrivez
                  // votre demande » décrit le champ ; l'invite, elle, décrit ce qu'on peut y faire.
                  : canvas
                    ? "Pose-moi une question ou donne-moi une instruction…"
                    : "Écrivez votre demande, ou glissez un fichier…  (Entrée pour envoyer)"
                : "Assistant indisponible — clé IA manquante."
            }
            disabled={!configured || sending}
            rows={1}
            enterKeyHint="send"
            className="max-h-[min(10rem,30dvh)] min-h-[2.75rem] min-w-0 flex-1 resize-none rounded-xl border border-border bg-background px-3.5 py-2.5 text-base outline-none lg:text-sm transition placeholder:text-muted-foreground focus:border-primary/60 focus:ring-2 focus:ring-primary/20 disabled:opacity-60"
          />
          {sending ? (
            <Button type="button" size="lg" variant="outline" onClick={stopStreaming} className="h-[2.75rem] shrink-0 px-4" title="Arrêter la génération">
              <Square className="h-4 w-4" />
            </Button>
          ) : (
            <Button type="submit" size="lg" disabled={!configured || (!input.trim() && attachments.length === 0)} className="h-[2.75rem] shrink-0 px-4">
              <Send className="h-4 w-4" />
            </Button>
          )}
        </form>
        <p className="mt-2 text-center text-[0.6875rem] text-muted-foreground">
          L&apos;assistant peut se tromper. Chaque action qu&apos;il propose vous est soumise avant d&apos;être exécutée.
        </p>
        </div>
      </div>
    </div>

    {/* PANNEAU CONTEXTE (Chief of Staff, grand écran) : les sources consultées et les actions
        du fil — chaque dossier lu devient un lien, sans refaire la recherche. */}
    {/* LE PANNEAU CONTEXTUEL EST CONTEXTUEL — il n'apparaît que s'il a quelque chose à
        montrer. Il était PERMANENT : 288 px réservés en continu pour afficher, la plupart du
        temps, deux phrases expliquant que rien n'est encore consulté. §13 : « If nothing
        meaningful: DO NOT render empty space. » */}
    {executive && showContextPanel && <ExecutivePanel sources={sources} messages={messages} showShortcuts={historyMode === "rail"} />}
    </div>
    </WorkspaceAskProvider>
  );
}

/** Le volet CONTEXTE du Chief of Staff : sources consultées + actions proposées du fil. */
function ExecutivePanel({ sources, messages, showShortcuts = true }: {
  sources: { label: string; href: string; detail?: string }[];
  messages: Msg[];
  /**
   * LES RACCOURCIS VERS LES MODULES DE L'ERP. Ils ont leur place sur la page Assistant, qui vit
   * DANS l'ERP. Ils n'en ont aucune dans le bureau d'Adam : y remettre cinq liens de modules,
   * c'est réintroduire par la fenêtre le menu qu'on a sorti par la porte.
   */
  showShortcuts?: boolean;
}) {
  const actions = messages
    .flatMap((m) => (m.proposals ?? []).map((p, i) => ({ id: `${m.id}-${i}`, title: p.title, state: m.actionStates?.[i] ?? "pending" })))
    .slice(-6)
    .reverse();
  return (
    <aside className="hidden w-72 shrink-0 xl:block">
      <div className="flex h-full flex-col gap-3 overflow-y-auto rounded-2xl border border-border bg-card p-3">
        <div>
          <p className="flex items-center gap-1.5 px-1 text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground">
            <Link2 className="h-3 w-3" /> Sources consultées
          </p>
          {sources.length === 0 ? (
            <p className="px-1 py-2 text-xs leading-relaxed text-muted-foreground">
              Les dossiers, documents et fiches que l&apos;assistant consulte apparaîtront ici, en liens cliquables.
            </p>
          ) : (
            <div className="mt-1 space-y-0.5">
              {sources.map((s) => (
                <Link key={s.href + s.label} href={s.href}
                  className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs transition hover:bg-secondary">
                  <ArrowRight className="h-3 w-3 shrink-0 text-primary" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate" title={s.label}>{s.label}</span>
                    {/* D'OÙ ET DE QUAND (F8) : famille, date propre, fraîcheur, confiance — la provenance se lit sans la demander. */}
                    {s.detail && <span className="block truncate text-[0.6875rem] text-muted-foreground" title={s.detail} data-testid="source-detail">{s.detail}</span>}
                  </span>
                </Link>
              ))}
            </div>
          )}
        </div>

        {actions.length > 0 && (
          <div>
            <p className="flex items-center gap-1.5 px-1 text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground">
              <Sparkles className="h-3 w-3" /> Actions du fil
            </p>
            <div className="mt-1 space-y-1">
              {actions.map((a) => (
                <div key={a.id} className="rounded-lg border border-border/60 px-2 py-1.5 text-xs">
                  <p className="truncate font-medium" title={a.title}>{a.title}</p>
                  <p className="mt-0.5 text-muted-foreground">
                    {a.state === "done" ? "✔ Exécutée" : a.state === "cancelled" ? "Annulée"
                      : a.state === "error" ? "En échec" : a.state === "running" ? "En cours…" : "À confirmer"}
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}

        {showShortcuts && (
        <div className="mt-auto border-t border-border pt-2">
          <p className="px-1 text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground">Raccourcis</p>
          <div className="mt-1 space-y-0.5">
            {[
              { href: "/centre-de-paiement", label: "Centre de paiement" },
              { href: "/validations", label: "Demandes de validations" },
              { href: "/legal", label: "Legal" },
              { href: "/rh", label: "Ressources humaines" },
              { href: "/calendar", label: "Calendrier" },
            ].map((l) => (
              <Link key={l.href} href={l.href} className="block rounded-lg px-2 py-1.5 text-xs text-muted-foreground transition hover:bg-secondary hover:text-foreground">
                {l.label}
              </Link>
            ))}
          </div>
        </div>
        )}
      </div>
    </aside>
  );
}

/**
 * Historique de MES conversations. Le serveur ne renvoie jamais les fils d'autrui : cette
 * liste est, par construction, strictement personnelle (cf. `src/lib/assistant-memory.ts`).
 */
/** Regroupe les conversations par ancienneté — c'est ainsi qu'on les retrouve. */
function groupThreads(threads: ThreadSummary[]): { label: string; items: ThreadSummary[] }[] {
  const now = Date.now();
  const day = 86_400_000;
  const buckets: { label: string; max: number; items: ThreadSummary[] }[] = [
    { label: "Aujourd'hui", max: day, items: [] },
    { label: "7 derniers jours", max: 7 * day, items: [] },
    { label: "30 derniers jours", max: 30 * day, items: [] },
    { label: "Plus ancien", max: Infinity, items: [] },
  ];
  for (const t of threads) {
    const age = now - new Date(t.updatedAt).getTime();
    (buckets.find((b) => age < b.max) ?? buckets[buckets.length - 1]).items.push(t);
  }
  return buckets.filter((b) => b.items.length > 0).map(({ label, items }) => ({ label, items }));
}

/**
 * Historique de MES conversations. Le serveur ne renvoie jamais les fils d'autrui : cette
 * liste est, par construction, strictement personnelle (cf. `src/lib/assistant-memory.ts`).
 *
 * Regroupées par ancienneté (aujourd'hui, 7 jours, 30 jours, plus ancien) : au bout de
 * quelques semaines, une liste à plat ne se relit plus.
 */
function ThreadRail({
  threads, current, onNew, onOpen, onDelete, onForget,
}: {
  threads: ThreadSummary[];
  current: string | null;
  onNew: () => void;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  onForget: () => void;
}) {
  const groups = groupThreads(threads);
  return (
    <div className="flex h-full flex-col overflow-hidden rounded-2xl border border-border bg-card">
      <div className="p-2">
        <button
          type="button" onClick={onNew}
          className="flex w-full items-center gap-2 rounded-xl border border-border px-3 py-2.5 text-sm font-medium transition hover:bg-secondary"
        >
          <Plus className="h-4 w-4" /> Nouvelle conversation
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {threads.length === 0 ? (
          <p className="px-2 py-3 text-xs leading-relaxed text-muted-foreground">
            Vos échanges seront conservés ici pour que l&apos;assistant se souvienne de votre contexte.
          </p>
        ) : (
          groups.map((g) => (
            <div key={g.label} className="mb-2">
              <p className="px-2 py-1 text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground">{g.label}</p>
              <div className="space-y-0.5">
                {g.items.map((t) => (
                  <div key={t.id}
                    className={`group flex items-center gap-1 rounded-lg px-2 py-0.5 text-sm transition sm:py-2 ${t.id === current ? "bg-secondary font-medium text-foreground" : "hover:bg-secondary/60"}`}>
                    <button type="button" onClick={() => onOpen(t.id)} className="min-w-0 flex-1 truncate py-2 text-left sm:py-0" title={t.title}>
                      {t.title}
                    </button>
                    {/* Au doigt, la corbeille reste visible : un bouton qui n'apparaît qu'au survol n'existe pas. */}
                    <button type="button" onClick={() => onDelete(t.id)} title="Supprimer cette conversation"
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded text-muted-foreground transition hover:text-destructive sm:h-auto sm:w-auto sm:p-1 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:focus:opacity-100 [@media(hover:hover)]:group-hover:opacity-100">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
      </div>

      <div className="border-t border-border px-3 py-2.5">
        <p className="flex items-start gap-1.5 text-[0.6875rem] leading-snug text-muted-foreground">
          <Lock className="mt-0.5 h-3 w-3 shrink-0" />
          Mémoire strictement personnelle : personne d&apos;autre — pas même un administrateur — n&apos;y a accès.
        </p>
        {threads.length > 0 && (
          <button type="button" onClick={onForget} className="mt-1 py-1.5 text-[0.6875rem] sm:mt-1.5 sm:py-0 text-muted-foreground underline-offset-2 transition hover:text-destructive hover:underline">
            Tout effacer
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UN TOUR D'ADAM — l'objet d'abord, son geste dessous, la synthèse ensuite.
 *
 * Ce composant remplace l'empilement historique (pastilles d'outils → prose → blocs → cartes de
 * confirmation détachées) par le rangement décidé dans `lib/assistant/workspace/turn.ts`. Il ne
 * décide rien lui-même : il place ce que le rangement a trié, et il INJECTE les cartes d'action
 * là où elles appartiennent — sous l'objet qu'elles engagent.
 *
 * Le repli sur une bulle de texte reste possible, et c'est voulu : « Il est 15 h » n'est pas un
 * espace de travail, et l'encadrer comme tel ferait chercher un bouton qui n'existe pas.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
function AdamTurn({
  msg, text, onConfirm, onCancel, onConfirmAll, bubble = false,
}: {
  msg: Msg;
  text: string;
  onConfirm: (id: number, index: number, payload: AssistantActionPayload, intentId?: string, confirmTyped?: string) => void;
  onCancel: (id: number, index: number, intentId?: string) => void;
  onConfirmAll: (msg: Msg) => void;
  bubble?: boolean;
}) {
  const proposals = msg.proposals ?? [];
  const states = msg.actionStates ?? [];

  const turn = composeTurn({
    compositions: msg.workspace ?? null,
    proposals: proposals.map((p, i) => ({
      kind: p.payload.kind,
      title: p.title,
      state: (states[i] ?? "pending") as "pending" | "done" | "failed" | "cancelled",
      level: p.level,
    })),
    trace: msg.trace ?? null,
    reply: text,
  });

  const cards = (indexes: number[]) =>
    indexes.map((i) => {
      const p = proposals[i];
      if (!p) return null;
      return (
        <ActionCard
          key={i}
          proposal={p}
          state={states[i] ?? "pending"}
          result={msg.actionResults?.[i]}
          link={msg.actionLinks?.[i]}
          onConfirm={(confirmTyped) => onConfirm(msg.id, i, p.payload, p.intentId, confirmTyped)}
          onCancel={() => onCancel(msg.id, i, p.intentId)}
        />
      );
    });

  // ── LE REPLI VERBAL. Aucun objet à montrer : on rend la phrase, et les éventuelles cartes.
  if (!isWorkspaceTurn(turn)) {
    return (
      <div className="chat-measure space-y-2">
        {text ? (
          bubble ? (
            <div className="min-w-0 whitespace-pre-wrap rounded-2xl rounded-tl-sm bg-secondary px-3.5 py-2.5 text-sm leading-relaxed [overflow-wrap:anywhere] sm:px-4">
              <LinkifiedText text={text} />
            </div>
          ) : (
            <p className="chief-turn-text whitespace-pre-wrap [overflow-wrap:anywhere]"><LinkifiedText text={text} /></p>
          )
        ) : null}
        {cards(proposals.map((_, i) => i))}
      </div>
    );
  }

  return (
    <TurnWorkspaceView
      turn={turn}
      renderProposals={cards}
      renderSynthesis={(t) => <LinkifiedText text={t} />}
      renderBundle={() => (
        // §10 — UNE MISSION COHÉRENTE, UNE CONFIRMATION. Le bandeau se place APRÈS l'objet de
        // tête : on comprend d'abord CE QU'ON confirme, on confirme ensuite.
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-primary/30 bg-accent/30 px-3 py-2 text-sm" data-testid="turn-bundle">
          <Sparkles className="h-4 w-4 shrink-0 text-primary" />
          <span className="min-w-0 flex-1 basis-40">
            {turn.pending} actions préparées — elles forment une seule mission.
          </span>
          <Button size="sm" className="w-full sm:w-auto" onClick={() => onConfirmAll(msg)}>
            <CheckCircle2 className="h-4 w-4" /> Tout confirmer
          </Button>
        </div>
      )}
    />
  );
}

function Avatar() {
  return (
    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-primary to-purple-500 text-primary-foreground">
      <Bot className="h-4 w-4" />
    </div>
  );
}

/** Sélecteur de fichiers du Drive personnel : on référence un fichier existant (aucun
 *  re-téléversement) — recherche par nom, chargée à la demande. */
function DriveFilePicker({ onPick, onClose }: { onPick: (f: AssistantFileOption) => void; onClose: () => void }) {
  const [q, setQ] = React.useState("");
  const [files, setFiles] = React.useState<AssistantFileOption[]>([]);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    let alive = true;
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const res = await listAssistantFiles(q);
        if (alive) { setFiles(res); setLoading(false); }
      } catch {
        if (alive) { setFiles([]); setLoading(false); }
      }
    }, q ? 250 : 0);
    return () => { alive = false; clearTimeout(t); };
  }, [q]);

  return (
    <div className="absolute bottom-full left-3 right-3 z-20 mb-2 overflow-hidden rounded-xl border border-border bg-card shadow-lg">
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 sm:py-2">
        <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate text-sm font-medium">Mes fichiers du Drive</span>
        <button type="button" onClick={onClose} className="-mr-2 ml-auto flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:text-foreground sm:mr-0 sm:h-auto sm:w-auto"><X className="h-4 w-4" /></button>
      </div>
      <div className="p-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} autoFocus placeholder="Rechercher un fichier…" className="w-full rounded-lg border border-border bg-background py-2 pl-8 pr-3 text-base outline-none focus:border-primary/60 sm:py-1.5 lg:text-sm" />
        </div>
      </div>
      {/* Bornée aussi par la hauteur visible : clavier ouvert, il ne reste parfois qu'un tiers d'écran. */}
      <div className="max-h-[min(13rem,35dvh)] overflow-y-auto overscroll-contain px-2 pb-2">
        {loading ? (
          <p className="px-2 py-3 text-sm text-muted-foreground"><Loader2 className="mr-1 inline h-4 w-4 animate-spin" /> Chargement…</p>
        ) : files.length === 0 ? (
          <p className="px-2 py-3 text-sm text-muted-foreground">Aucun fichier{q ? " pour cette recherche" : ""}.</p>
        ) : (
          files.map((f) => (
            <button key={f.id} type="button" onClick={() => { onPick(f); onClose(); }} className="flex w-full items-center gap-2 rounded-lg px-2 py-2.5 text-left text-sm hover:bg-secondary sm:py-1.5">
              <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{f.name}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{Math.max(1, Math.round(f.size / 1024))} Ko</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

/** « 09:16 » — discret, et seulement quand l'heure est connue. */
function turnTime(at?: number): string | null {
  if (!at) return null;
  try {
    return new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" }).format(new Date(at));
  } catch {
    return null;
  }
}

function MessageBubble({
  msg, onConfirm, onCancel, onConfirmAll, canvas = false,
}: {
  msg: Msg;
  onConfirm: (id: number, index: number, payload: AssistantActionPayload, intentId?: string, confirmTyped?: string) => void;
  onCancel: (id: number, index: number, intentId?: string) => void;
  onConfirmAll: (msg: Msg) => void;
  canvas?: boolean;
}) {
  // LE DERNIER FILTRE AVANT L'ÉCRAN. Calculé une fois, pour les deux rôles : un tour dont le
  // contenu est un marqueur interne ou une sortie d'outil brute n'affiche PAS de bulle vide —
  // il ne s'affiche pas du tout.
  const display = decideDisplay(msg.content);
  const userDisplay = display;
  const assistantDisplay = display;

  if (msg.role === "user") {
    return (
      <div className="chat-measure flex flex-col items-end gap-1">
        {msg.attachmentNames && msg.attachmentNames.length > 0 && (
          <div className="flex max-w-[85%] flex-wrap justify-end gap-1 sm:max-w-[80%]">
            {msg.attachmentNames.map((n, i) => (
              <span key={i} className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-lg bg-primary/10 px-2 py-0.5 text-xs text-primary">
                <FileText className="h-3 w-3 shrink-0" /> <span className="min-w-0 max-w-[160px] truncate">{n}</span>
              </span>
            ))}
          </div>
        )}
        {userDisplay.show && (
          canvas ? (
            // LA PASTILLE, PAS LE PAVÉ. Un aplat de couleur pleine sur 80 % de la largeur crie
            // plus fort que la réponse qui suit — or c'est la réponse qui porte l'information.
            <div className="flex max-w-[85%] items-baseline gap-2.5 sm:max-w-[70%]">
              <div className="chief-user-turn min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">{userDisplay.text}</div>
              {turnTime(msg.at) ? <span className="chief-turn-time shrink-0">{turnTime(msg.at)}</span> : null}
            </div>
          ) : (
            <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-tr-sm bg-primary px-3.5 py-2.5 text-sm text-primary-foreground shadow-sm [overflow-wrap:anywhere] sm:max-w-[80%] sm:px-4">
              {userDisplay.text}
            </div>
          )
        )}
      </div>
    );
  }

  if (canvas) {
    // LE CANVAS. Pas de bulle : le nom, l'heure, puis le texte à même la page — et les objets
    // métier dessous, pleine largeur. Encadrer une réponse qui contient déjà une carte revient
    // à dessiner deux boîtes pour une seule idée.
    return (
      <div className="flex gap-3">
        <Avatar />
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex items-baseline gap-2">
            <span className="chief-turn-author">Adam</span>
            {turnTime(msg.at) ? <span className="chief-turn-time">{turnTime(msg.at)}</span> : null}
          </div>
          <AdamTurn
            msg={msg}
            text={assistantDisplay.show ? cleanReply(assistantDisplay.text) : ""}
            onConfirm={onConfirm}
            onCancel={onCancel}
            onConfirmAll={onConfirmAll}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-2.5">
      <Avatar />
      <div className="min-w-0 flex-1 space-y-2">
        {/* L'ESPACE DE TRAVAIL DE CE TOUR. Il reste attaché au message : remonter dans la
            conversation redonne l'objet au lieu d'un texte qui y fait référence. */}
        <AdamTurn
          msg={msg}
          text={assistantDisplay.show ? cleanReply(assistantDisplay.text) : ""}
          onConfirm={onConfirm}
          onCancel={onCancel}
          onConfirmAll={onConfirmAll}
          bubble
        />

      </div>
    </div>
  );
}
