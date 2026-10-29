"use client";

/**
 * LA CONVERSATION — la bulle d'un message (personne ou assistant) et son heure.
 */
import { FileText } from "lucide-react";
// HYGIÈNE D'AFFICHAGE — le dernier filtre avant l'écran. Il existe parce que des marqueurs
// internes et des sorties d'outils BRUTES ont été rendus au PDG en production, dont un
// vidage de 27 résultats contenant six lignes de salaires, en réponse à « Bonsoir, ça va ? ».
import { decideDisplay } from "@/lib/assistant/voice/transcript-hygiene";
import type { AssistantActionPayload } from "@/lib/assistant";
import { type Msg, cleanReply } from "./modele";
import { Avatar, AdamTurn } from "./tour-adam";

/** « 09:16 » — discret, et seulement quand l'heure est connue. */
function turnTime(at?: number): string | null {
  if (!at) return null;
  try {
    return new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" }).format(new Date(at));
  } catch {
    return null;
  }
}

export function MessageBubble({
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
