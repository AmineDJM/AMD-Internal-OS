"use client";

import * as React from "react";
import { ChiefHeader } from "./chief-header";
import { ChiefHome } from "./chief-home";
import type { TourRelu } from "@/lib/assistant/workspace/turn";
import { AssistantChat } from "@/components/chief/assistant-chat";

/**
 * LA COQUE CLIENTE — elle décide de ce qui occupe l'écran, et de rien d'autre.
 *
 * POURQUOI LE MOTEUR DE CONVERSATION N'EST PAS RÉÉCRIT. `AssistantChat` porte la mémoire, les
 * cartes d'action, l'approbation canonique, la politique d'envoi, la dictée, l'appel vocal, les
 * pièces jointes et les sources. La mission le dit elle-même : ceci est « a new presentation /
 * interaction layer over canonical systems », pas une réimplémentation de la logique métier.
 * Le refaire à neuf pour changer une apparence, ce serait risquer la seule chose qui marche —
 * l'exécution — au bénéfice de la seule chose qui se corrige facilement : le style.
 *
 * TROIS PROPS lui ont été AJOUTÉES, toutes optionnelles, aucune ne change son comportement
 * par défaut (la page Assistant de l'ERP est intacte) :
 *
 *   • `emptyState`   — l'écran d'accueil est fourni par l'hôte. L'ancien empilait un avatar en
 *     dégradé, un paragraphe explicatif et une grille de cartes de suggestion : exactement la
 *     « card soup » que la mission rejette.
 *   • `historyMode`  — `drawer` au lieu de `rail`. Une liste de conversations affichée en
 *     permanence prend 256 px de large pour une chose qu'on ouvre trois fois par jour (§45).
 *   • `surface`      — `flush` : ici la conversation EST la page, il n'y a rien autour dont il
 *     faille la distinguer par une bordure et des coins arrondis.
 */

export interface ChiefWorkspaceProps {
  userName: string;
  configured: boolean;
  /** La phrase du refus, composée côté serveur (§118.128). */
  messageIaNonConfiguree?: string;
  voiceConfigured: boolean;
  realtimeVoice: boolean;
  memoryEnabled: boolean;
  initialPrompt: string | null;
  initialThreadId: string | null;
  /** Les derniers tours, rendus par le serveur — voir `assistant-chat.tsx`. */
  initialMessages: TourRelu[] | null;
  initialCallRef: string | null;
  settingsHref: string | null;
  /** Ce qui attend une décision — calculé côté serveur, affiché seulement s'il y en a. */
  attention: { count: number; label: string; prompt: string }[];
  /** La boîte de décision (§21) : compte des cartes à trancher et sa porte. */
  inbox?: { count: number; href: string } | null;
  /** Adam voit-il des données à jour ? Le point de l'en-tête, et rien de plus bavard. */
  freshness: { label: string; tone: "ok" | "warn" | "off" };
  /** Les modules où cette personne peut aller — la porte de sortie du bureau (voir l'en-tête). */
}

export function ChiefWorkspace({
  userName,
  configured,
  messageIaNonConfiguree,
  voiceConfigured,
  realtimeVoice,
  memoryEnabled,
  initialPrompt,
  initialThreadId,
  initialMessages,
  initialCallRef,
  settingsHref,
  attention,
  inbox = null,
  freshness,
}: ChiefWorkspaceProps) {
  // La graine de saisie : une amorce cliquée PRÉ-REMPLIT le composeur, elle n'envoie rien.
  // Envoyer « Prépare un mail à » tout seul produirait une question en retour — un tour perdu.
  const [seed, setSeed] = React.useState<string | null>(initialPrompt);

  // L'HISTORIQUE EST PILOTÉ ICI, pas dans la conversation. C'est ce qui permet de n'avoir
  // QU'UNE barre d'en-tête : le bouton vit dans l'en-tête d'Adam, le tiroir dans la
  // conversation. Empilées, les deux barres coûtaient 110 px sur un téléphone de 390 px —
  // avant le premier mot.
  const [historyOpen, setHistoryOpen] = React.useState(false);

  const pick = React.useCallback((prompt: string) => setSeed(prompt), []);
  const openHistory = React.useCallback(() => setHistoryOpen(true), []);

  const emptyState = React.useMemo(
    () => <ChiefHome userName={userName} onPick={pick} attention={attention} inbox={inbox} />,
    [userName, pick, attention, inbox],
  );

  return (
    <>
      <ChiefHeader
        freshness={freshness}
        voiceAvailable={realtimeVoice}
        settingsHref={settingsHref}
        onOpenHistory={memoryEnabled ? openHistory : undefined}
      />

      {/* UNE SEULE COLONNE. Le panneau contextuel de droite n'existe pas encore comme surface
          autonome ; le réserver vide en permanence prendrait 340 px pour ne rien montrer, ce que
          §13 interdit explicitement. La conversation prend donc toute la largeur utile, bornée
          par la mesure de LECTURE définie dans le système visuel. */}
      <div className="flex min-h-0 flex-1 flex-col">
        <AssistantChat
          userName={userName}
          configured={configured}
          messageIaNonConfiguree={messageIaNonConfiguree}
          voiceConfigured={voiceConfigured}
          realtimeVoice={realtimeVoice}
          memoryEnabled={memoryEnabled}
          executive
          initialPrompt={seed}
          initialThreadId={initialThreadId}
          initialMessages={initialMessages}
          initialCallRef={initialCallRef}
          emptyState={emptyState}
          historyMode="drawer"
          surface="flush"
          canvas
          historyOpen={historyOpen}
          onHistoryOpenChange={setHistoryOpen}
        />
      </div>
    </>
  );
}
