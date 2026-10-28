"use client";

import * as React from "react";
import { ArrowLeft, Hash, Users, Info, Pin, ChevronDown, ChevronUp, X, Phone, Video, Loader2 } from "lucide-react";
import { startCall } from "@/lib/actions/meeting-actions";
import { Avatar } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import { useRetours } from "@/components/ui/retour";
import { actionFailureMessage } from "@/lib/action-outcome";
import type { ConversationDetailDTO, ConvMemberDTO, MessageDTO } from "@/lib/queries/messaging";
import { CHAT_STATUS_LABEL, CHAT_STATUSES, peutGererLaConversation, type ChatStatus } from "@/lib/messaging-ui";
import { MessageItem } from "./message-item";
import { Composer, type SendPayload } from "./composer";
import { PresenceDot, dayLabel, sameDay, presenceLine } from "./format";

interface Props {
  detail: ConversationDetailDTO;
  selfId: string;
  /** Rôle à vue globale de l'ERP : modération transverse, hors appartenance. */
  vueGlobale: boolean;
  typingUserIds: string[];
  replyTo: MessageDTO | null;
  setReplyTo: (m: MessageDTO | null) => void;
  onSend: (payload: SendPayload) => Promise<boolean>;
  onReact: (id: string, emoji: string) => void;
  onTogglePin: (id: string) => void;
  onBookmark: (id: string) => void;
  onDelete: (id: string) => void;
  onSaveEdit: (id: string, body: string) => Promise<boolean>;
  onToggleInfo: () => void;
  onBack: () => void;
}

export function MessageThread({
  detail, selfId, vueGlobale, typingUserIds, replyTo, setReplyTo, onSend,
  onReact, onTogglePin, onBookmark, onDelete, onSaveEdit, onToggleInfo, onBack,
}: Props) {
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const stick = React.useRef(true);
  const [showPinned, setShowPinned] = React.useState(false);
  const memberNames = React.useMemo(() => detail.members.map((m) => m.name), [detail.members]);
  const gere = peutGererLaConversation(detail.myRole);

  const lastId = detail.messages[detail.messages.length - 1]?.id;

  const scrollToBottom = (behavior: ScrollBehavior = "auto") => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior });
  };

  // Reste collé en bas quand on y est déjà ; saute en bas au changement de conversation.
  React.useEffect(() => { stick.current = true; scrollToBottom("auto"); }, [detail.id]);
  React.useEffect(() => { if (stick.current) scrollToBottom("auto"); }, [lastId, typingUserIds.length]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };

  const jumpToParent = (id: string) => {
    const el = document.getElementById(`msg-${id}`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("ring-2", "ring-warning", "rounded-xl");
      setTimeout(() => el.classList.remove("ring-2", "ring-warning", "rounded-xl"), 1500);
    }
  };

  const onlineCount = detail.members.filter((m) => m.presence === "online" && m.userId !== selfId).length;
  const typingNames = typingUserIds
    .map((id) => detail.members.find((m) => m.userId === id)?.name?.split(" ")[0])
    .filter(Boolean) as string[];

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col bg-background">
      {/* En-tête */}
      <div className="flex h-16 shrink-0 items-center gap-1.5 border-b border-border bg-card px-1.5 sm:gap-3 sm:px-3 lg:px-4">
        <button onClick={onBack} aria-label="Retour" className="shrink-0 rounded-lg p-2 text-muted-foreground hover:bg-secondary md:hidden"><ArrowLeft className="h-5 w-5" /></button>
        <button onClick={onToggleInfo} className="flex min-w-0 flex-1 items-center gap-2.5 text-left sm:gap-3">
          {detail.type === "DIRECT" ? (
            <span className="relative shrink-0">
              <Avatar name={detail.avatarName} color={detail.avatarColor} />
              <PresenceDot presence={detail.presence} className="absolute -bottom-0.5 -right-0.5 h-3 w-3" />
            </span>
          ) : (
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-white" style={{ backgroundColor: detail.avatarColor ?? (detail.type === "CHANNEL" ? "#0f766e" : "#7c3aed") }}>
              {detail.type === "CHANNEL" ? <Hash className="h-4 w-4" /> : <Users className="h-4 w-4" />}
            </span>
          )}
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{detail.title}</p>
            <p className="truncate text-xs text-muted-foreground">
              {typingNames.length > 0 ? (
                <span className="text-primary">{typingNames.join(", ")} {typingNames.length > 1 ? "écrivent" : "écrit"}…</span>
              ) : detail.type === "DIRECT" ? (
                // Statut Teams : message perso > statut manuel > présence auto (« vu à… »).
                detail.otherStatusMessage
                  ? detail.otherStatusMessage
                  : detail.otherChatStatus && (CHAT_STATUSES as string[]).includes(detail.otherChatStatus)
                    ? CHAT_STATUS_LABEL[detail.otherChatStatus as ChatStatus]
                    : presenceLine(detail.presence, detail.otherLastSeenAt)
              ) : (
                `${detail.memberCount} membres${onlineCount > 0 ? ` · ${onlineCount} en ligne` : ""}`
              )}
            </p>
          </div>
        </button>
        <CallButtons conversationId={detail.id} />
        <button onClick={onToggleInfo} className="shrink-0 rounded-lg p-2 text-muted-foreground hover:bg-secondary" title="Détails" aria-label="Détails"><Info className="h-5 w-5" /></button>
      </div>

      {/* Bandeau messages épinglés */}
      {detail.pinnedMessages.length > 0 && (
        <div className="shrink-0 border-b border-border bg-accent/40">
          <button onClick={() => setShowPinned((v) => !v)} className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-xs text-accent-foreground sm:py-1.5">
            <Pin className="h-3.5 w-3.5" />
            <span className="font-medium">{detail.pinnedMessages.length} message{detail.pinnedMessages.length > 1 ? "s" : ""} épinglé{detail.pinnedMessages.length > 1 ? "s" : ""}</span>
            {showPinned ? <ChevronUp className="ml-auto h-3.5 w-3.5" /> : <ChevronDown className="ml-auto h-3.5 w-3.5" />}
          </button>
          {showPinned && (
            <div className="max-h-40 space-y-1 overflow-y-auto px-3 pb-2">
              {detail.pinnedMessages.map((m) => (
                <div key={m.id} className="flex items-center gap-2 rounded-lg bg-card px-2.5 py-1.5 text-xs">
                  <button onClick={() => jumpToParent(m.id)} className="line-clamp-2 min-w-0 flex-1 text-left [overflow-wrap:anywhere]">
                    <span className="font-medium text-foreground">{m.senderName} : </span>
                    <span className="text-muted-foreground">{m.body || "Pièce jointe"}</span>
                  </button>
                  <button onClick={() => onTogglePin(m.id)} title="Désépingler" aria-label="Désépingler" className="-my-1 shrink-0 rounded p-2 text-muted-foreground hover:bg-secondary sm:my-0 sm:p-0.5"><X className="h-3.5 w-3.5" /></button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Messages */}
      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-3">
        {detail.messages.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
            <span className="text-3xl">👋</span>
            <p className="px-6 [overflow-wrap:anywhere]">Démarrez la conversation avec <span className="font-medium text-foreground">{detail.title}</span>.</p>
          </div>
        )}
        {detail.messages.map((m, i) => {
          const prev = detail.messages[i - 1];
          const daySep = !prev || !sameDay(prev.createdAt, m.createdAt);
          const gap = prev ? new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() : Infinity;
          const showHeader = daySep || !prev || prev.senderId !== m.senderId || prev.kind === "SYSTEM" || gap > 5 * 60 * 1000;
          return (
            <React.Fragment key={m.id}>
              {daySep && m.kind !== "SYSTEM" && (
                <div className="my-3 flex items-center gap-3 px-4">
                  <span className="h-px flex-1 bg-border" />
                  <span className="rounded-full bg-secondary px-3 py-0.5 text-[0.6875rem] font-medium text-muted-foreground">{dayLabel(m.createdAt)}</span>
                  <span className="h-px flex-1 bg-border" />
                </div>
              )}
              <MessageItem
                m={m}
                selfId={selfId}
                showHeader={showHeader}
                memberNames={memberNames}
                vueGlobale={vueGlobale}
                gereLaConversation={gere}
                onReact={onReact}
                onReply={setReplyTo}
                onTogglePin={onTogglePin}
                onBookmark={onBookmark}
                onDelete={onDelete}
                onSaveEdit={onSaveEdit}
                onJumpToParent={jumpToParent}
              />
            </React.Fragment>
          );
        })}
        {typingNames.length > 0 && (
          <div className="flex items-center gap-2 px-4 py-1.5 text-xs text-muted-foreground">
            <span className="flex gap-0.5">
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.3s]" />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.15s]" />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground" />
            </span>
            {typingNames.join(", ")} {typingNames.length > 1 ? "écrivent" : "écrit"}…
          </div>
        )}
      </div>

      <Composer
        conversationId={detail.id}
        members={detail.members as ConvMemberDTO[]}
        selfId={selfId}
        replyTo={replyTo}
        onCancelReply={() => setReplyTo(null)}
        onSend={onSend}
      />
    </div>
  );
}

/** Lance un appel audio/vidéo (Jitsi) depuis la conversation et ouvre la salle. */
function CallButtons({ conversationId }: { conversationId: string }) {
  const [busy, setBusy] = React.useState<"audio" | "video" | null>(null);
  const retours = useRetours();

  async function call(video: boolean) {
    setBusy(video ? "video" : "audio");
    const fd = new FormData();
    fd.set("conversationId", conversationId);
    fd.set("withVideo", video ? "true" : "false");
    try {
      const r = await startCall(fd);
      if (r.ok && r.id) window.open(`/meetings/${r.id}`, "_blank", "noopener");
      else if (!r.ok) retours.erreur(r.error ?? "L'appel n'a pas été lancé.");
    } catch {
      retours.erreur(actionFailureMessage("THROWN"));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <button onClick={() => call(false)} disabled={busy !== null} title="Appel audio" aria-label="Appel audio"
        className="rounded-lg p-2 text-muted-foreground hover:bg-secondary disabled:opacity-60">
        {busy === "audio" ? <Loader2 className="h-5 w-5 animate-spin" /> : <Phone className="h-5 w-5" />}
      </button>
      <button onClick={() => call(true)} disabled={busy !== null} title="Appel vidéo" aria-label="Appel vidéo"
        className="rounded-lg p-2 text-muted-foreground hover:bg-secondary disabled:opacity-60">
        {busy === "video" ? <Loader2 className="h-5 w-5 animate-spin" /> : <Video className="h-5 w-5" />}
      </button>
    </div>
  );
}
