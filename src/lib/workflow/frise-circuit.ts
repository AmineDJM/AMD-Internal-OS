import type { WorkflowView, WorkflowEventView, WorkflowStepView } from "@/lib/queries/workflow";
import { SCOPE_LABELS } from "@/lib/workflow/types";
import { ROLE_LABELS } from "@/lib/labels";
import { formatDate } from "@/lib/utils";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA FRISE D'UN CIRCUIT — la demande déposée, puis les étapes de SON parcours, chacune avec « date · personne » quand
 * elle est faite, ou qui la tient sinon.
 *
 * Module PUR (imports de types et de libellés seulement) : le panneau du circuit (`WorkflowPanel`, composant client) la
 * dessine, et la fiche d'une demande Ad & Pro (page serveur) la résume en une barre de cinq étapes au plus
 * (`ad-pro/domaine/barre-etapes`). Une seule lecture du circuit, deux rendus — jamais deux copies (§118.5).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Une case de la frise horizontale de « La demande ». */
export interface EtapeDeFrise {
  cle: string;
  titre: string;
  /** Sous le titre : « date · personne » pour une étape faite, qui la tient sinon. */
  detail?: string | null;
  etat: "done" | "current" | "todo" | "rejected";
}

function rolesText(roles: string[]): string {
  return roles.map((r) => ROLE_LABELS[r] ?? r).join(", ");
}

/** QUI tient une étape, en un mot. */
export function acteurDe(s: Pick<WorkflowStepView, "actorScope" | "actorRoles">): string {
  return s.actorScope === "ROLE" ? rolesText(s.actorRoles) || "—" : SCOPE_LABELS[s.actorScope];
}

/** « Yacine Habes » → « Y. Habes » : la frise n'a la place que d'un nom court. */
function nomCourt(nom: string | null): string | null {
  if (!nom) return null;
  const p = nom.trim().split(/\s+/);
  return p.length > 1 ? `${p[0]![0]}. ${p.slice(1).join(" ")}` : nom;
}

const jourCourt = (iso: string) => formatDate(iso, { day: "numeric", month: "short" });

/** Les gestes qui FONT une étape (et non un commentaire en passant). */
const GESTES_D_ETAPE = new Set(["APPROVE", "REJECT", "OPINION_AGAINST", "SKIP", "AUTO_SKIP", "AUTO_APPROVE_REQUESTER"]);

/**
 * LA FRISE : « Demande » (l'événement de création), les étapes du parcours, puis ce que la page ajoute (`suite` — le
 * sponsoring : postes, validation finale ; la déclaration).
 */
export function friseDuCircuit(
  view: Pick<WorkflowView, "events" | "steps" | "assigneeName">,
  suite: EtapeDeFrise[] = [],
): EtapeDeFrise[] {
  const creation = view.events.find((e) => e.action === "CREATE");
  const quand = (e: WorkflowEventView | undefined) => (e ? [jourCourt(e.createdAt), nomCourt(e.actorName)].filter(Boolean).join(" · ") : null);
  return [
    ...(creation ? [{ cle: "__demande__", titre: "Demande", detail: quand(creation), etat: "done" as const }] : []),
    ...view.steps.map((s): EtapeDeFrise => {
      const fait = [...view.events].reverse().find((e) => e.stepTitle === s.title && GESTES_D_ETAPE.has(e.action));
      const detail = s.state === "done" || s.state === "rejected" ? quand(fait)
        : s.state === "current" ? (view.assigneeName ?? acteurDe(s))
          : acteurDe(s);
      return { cle: s.slug, titre: s.title, detail, etat: s.state };
    }),
    ...suite,
  ];
}

/**
 * LE CIRCUIT TEL QUE LA BARRE D'UNE FICHE LE RÉSUME (`ad-pro/domaine/barre-etapes`) : son statut, sa frise sans suite, et
 * si la personne qui regarde y a un geste maintenant — décider l'étape, resoumettre une demande renvoyée, faire appel.
 */
export function circuitPourLaBarre(
  view: Pick<WorkflowView, "status" | "events" | "steps" | "assigneeName" | "action" | "peutResoumettre" | "peutFaireAppel"> | null,
): { statut: string; frise: EtapeDeFrise[]; aVous: boolean } | null {
  if (!view) return null;
  return { statut: view.status, frise: friseDuCircuit(view), aVous: Boolean(view.action) || view.peutResoumettre || view.peutFaireAppel };
}
