"use client";

/**
 * LA CONVERSATION — la réponse EN COURS : les phases, puis le texte qui s'écrit, puis les blocs de
 * l'espace de travail, frères (et non enfants) de la colonne de prose.
 */
import { Loader2, CheckCircle2 } from "lucide-react";
import type { WorkspaceComposition } from "@/platform/ia/workspace/protocol";
import { WorkspaceBlocks } from "@/platform/ia/ecrans/blocks";
import { phasesOf } from "@/lib/assistant/workspace/turn";
import { cleanReply } from "./modele";
import { LinkifiedText } from "./texte-lie";
import { Avatar } from "./tour-adam";

export function ReponseEnCours({ streaming, canvas }: {
  streaming: { text: string; trace: string[]; workspace: WorkspaceComposition[] } | null;
  canvas: boolean;
}) {
  return (
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
  );
}
