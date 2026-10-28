"use client";

/**
 * LA CONVERSATION — le composant `AssistantChat` : le fil, l'envoi (flux ou pièces jointes), le
 * geste déterministe, les confirmations d'actions, l'historique et le composeur.
 */
import * as React from "react";
import { Send, Loader2, KeyRound, X, Paperclip, FolderOpen, FileText, Mic, Square, History, Plus, Phone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { assistantChat, assistantDirectIntent, executeAssistantAction, executeAssistantBundle, cancelAssistantAction, myAssistantThreads, myAssistantThread, deleteMyAssistantThread, forgetMyAssistantMemory } from "@/lib/actions/assistant-actions";
import type { AssistantActionPayload, ChatTurn, AssistantResult } from "@/lib/assistant";
import type { WorkspaceActionIntent, WorkspaceComposition } from "@/lib/assistant/workspace/protocol";
import { WorkspaceAskProvider } from "@/components/chief/workspace/blocks";
import { elaguerFil, type TourRelu } from "@/lib/assistant/workspace/turn";
import type { AssistantAttachment, AssistantFileOption } from "@/lib/assistant-attachments";
import type { ThreadSummary } from "@/lib/assistant-memory";
import { useScrollLock } from "@/lib/use-scroll-lock";
import { sansBloquer } from "@/lib/journal";
import { type Msg, repriseDuTour, type PendingAttach, nextId, type ActionState, fileToBase64, type StreamEvent } from "./modele";
import { ExecutivePanel } from "./panneau-contexte";
import { ThreadRail } from "./historique";
import { DriveFilePicker } from "./drive-picker";
import { MessageBubble } from "./bulle";
import { useDictee } from "./dictee";
import { usePontAppel } from "./pont-appel";
import { AccueilVide } from "./accueil";
import { ReponseEnCours } from "./reponse-en-cours";

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
    const r = await deleteMyAssistantThread(id);
    if (r.ok) {
      if (id === threadId) { setThreadId(null); setMessages([]); }
      await refreshThreads();
    }
  };

  const forgetAll = async () => {
    if (!window.confirm("Effacer TOUTE la mémoire de votre assistant (conversations et souvenirs) ? Cette action est définitive.")) return;
    const r = await forgetMyAssistantMemory();
    if (r.ok) { setThreadId(null); setMessages([]); await refreshThreads(); }
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

  // ── Dictée vocale : voir `dictee.ts` (le texte transcrit arrive, éditable, dans la saisie).
  const { recording, transcribing, voiceMsg, startRec, stopRec } = useDictee(setInput, taRef);

  // ── APPEL VOCAL : le pont avec l'APPEL GLOBAL — voir `pont-appel.ts`.
  const call = usePontAppel({ setMessages, setSources, setThreadId, refreshThreads, threadId, initialCallRef, realtimeVoice });

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
          <AccueilVide userName={userName} configured={configured} send={send} />
        ) : (
          messagesElagues.map((m) => (
            <MessageBubble key={m.id} msg={m} onConfirm={confirm} onCancel={cancel} onConfirmAll={confirmAll} canvas={canvas} />
          ))
        )}
        {/* Réponse EN COURS : on montre ce que l'assistant fait, puis ce qu'il écrit — jamais
            un long silence suivi d'un pavé. */}
        {sending && (
          <ReponseEnCours streaming={streaming} canvas={canvas} />
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
