"use client";

import { useState, type ReactNode } from "react";
import { ChevronDown, Check, Loader2 } from "lucide-react";
import { WorkspaceOneBlock } from "@/platform/ia/ecrans/blocks";
import { VISIBLE_BEFORE_FOLD, type TurnSlot, type TurnWorkspace } from "@/lib/assistant/workspace/turn";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'ESPACE DE TRAVAIL D'UN TOUR (§13–§22) — l'objet d'abord, le geste dessous, la prose ensuite.
 *
 * ── L'ORDRE DE LA PAGE, ET POURQUOI IL EST CELUI-LÀ ──────────────────────────────────────
 *
 *   1. LES PHASES — trois mots qui disent « j'ai compris, je travaille, c'est prêt ». Elles
 *      disparaissent dès que le tour est fini : une frise d'étapes accomplies n'aide personne.
 *   2. L'OBJET DE TÊTE — le message prêt, le dossier bloqué, la file de décisions. En entier.
 *   3. SES GESTES, juste dessous. C'est la correction la plus importante du chantier : le bouton
 *      qui envoie un message vit sous le message, pas trois blocs plus bas.
 *   4. LE RESTE, replié au-delà de trois objets (§16).
 *   5. LA SYNTHÈSE d'Adam, en petit, à la fin. §13 : « puis seulement une petite synthèse ».
 *
 * ── CE QUE CE COMPOSANT NE FAIT PAS ──────────────────────────────────────────────────────
 *
 * Il ne décide rien. Le rangement, la pondération et le rattachement des gestes vivent dans
 * `lib/assistant/workspace/turn.ts`, qui est PUR et testé sans navigateur. Ici, on place. C'est
 * ce qui permet de prouver « l'objet passe avant la prose » par un test unitaire plutôt que par
 * une capture d'écran qu'il faudrait relire à chaque changement.
 *
 * ── §15 : NI CHATBOT, NI SECOND ERP ──────────────────────────────────────────────────────
 *
 * La conversation reste la colonne vertébrale — cet espace vit DANS le fil, pas à côté. Mais son
 * contenu est transactionnel : on lit, on décide, on agit sans ouvrir cinq modules.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface TurnWorkspaceProps {
  turn: TurnWorkspace;
  /** Rend les gestes d'un bloc. Injecté : ce composant ne connaît pas les cartes d'action. */
  renderProposals?: (indexes: number[]) => ReactNode;
  /** Le bandeau de confirmation groupée (§10). Injecté pour la même raison. */
  renderBundle?: () => ReactNode;
  /** La synthèse, rendue par l'appelant (liens cliquables, nettoyage du texte…). */
  renderSynthesis?: (text: string) => ReactNode;
}

export function TurnWorkspaceView({ turn, renderProposals, renderBundle, renderSynthesis }: TurnWorkspaceProps) {
  const [unfolded, setUnfolded] = useState(false);

  const visible = unfolded ? turn.rest : turn.rest.slice(0, VISIBLE_BEFORE_FOLD - 1);
  const hidden = turn.rest.length - visible.length;

  return (
    <div className="chief-turn-workspace" data-testid="turn-workspace">
      {/* ── 1. LES PHASES. Des états métier, jamais « calling tool #7 ». ─────────────── */}
      {turn.phases.length > 0 && (
        <ol className="chief-phases" data-testid="turn-phases">
          {turn.phases.map((p, i) => (
            <li key={`${p.label}-${i}`} className="chief-phase" data-state={p.state}>
              {p.state === "running"
                ? <Loader2 className="chief-phase-icon chief-phase-spin" aria-hidden />
                : <Check className="chief-phase-icon" aria-hidden />}
              <span>{p.label}</span>
            </li>
          ))}
        </ol>
      )}

      {/* ── 2 & 3. L'OBJET, PUIS SES GESTES. Le cœur de la refonte. ──────────────────── */}
      {turn.lead && (
        <SlotView slot={turn.lead} lead renderProposals={renderProposals} />
      )}

      {/* ── LE LOT. §10 : une mission cohérente = une confirmation. Le bandeau se place
             APRÈS l'objet de tête, là où le regard arrive une fois la chose comprise. ── */}
      {turn.singleConfirmation && renderBundle?.()}

      {/* ── 4. LE RESTE, avec repli. ─────────────────────────────────────────────────── */}
      {visible.map((s, i) => (
        <SlotView key={`slot-${i}`} slot={s} renderProposals={renderProposals} />
      ))}

      {hidden > 0 && !unfolded && (
        <button type="button" className="chief-unfold" onClick={() => setUnfolded(true)} data-testid="turn-unfold">
          <ChevronDown className="h-3.5 w-3.5" aria-hidden />
          Voir {hidden} élément{hidden > 1 ? "s" : ""} de plus
        </button>
      )}

      {/* ── 5. LA SYNTHÈSE, EN DERNIER ET EN PETIT. ──────────────────────────────────── */}
      {turn.synthesis && (
        <p className="chief-synthesis" data-testid="turn-synthesis">
          {renderSynthesis ? renderSynthesis(turn.synthesis) : turn.synthesis}
        </p>
      )}
    </div>
  );
}

/**
 * UN OBJET ET SES GESTES, indissociables.
 *
 * L'enveloppe `chief-slot` existe pour que le lien visuel soit STRUCTUREL et non typographique :
 * les gestes sont DANS le même cadre que l'objet, ce qui reste vrai quelle que soit la largeur
 * d'écran. Une simple proximité verticale se défait dès qu'un bloc s'allonge.
 */
function SlotView({
  slot, lead = false, renderProposals,
}: { slot: TurnSlot; lead?: boolean; renderProposals?: (i: number[]) => ReactNode }) {
  const actions = slot.proposals.length ? renderProposals?.(slot.proposals) : null;
  return (
    <div className={lead ? "chief-slot chief-slot-lead" : "chief-slot"} data-testid={lead ? "turn-lead" : "turn-slot"}>
      <WorkspaceOneBlock b={slot.block} />
      {actions ? <div className="chief-slot-actions" data-testid="slot-actions">{actions}</div> : null}
    </div>
  );
}
