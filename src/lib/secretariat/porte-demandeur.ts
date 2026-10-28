import type { AdminRequestStatus, EntityType } from "@prisma/client";
import { estDemandeBcAEtablir } from "@/modules/ad-pro/partage";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UNE DEMANDE AU SECRÉTARIAT NE SE FIGE PAS À LA TRENTE ET UNIÈME MINUTE (§118.187 — audit 360°, R08).
 *
 * Mesuré par l'audit : passé trente minutes, ou dès que l'assistante avait commencé, le demandeur
 * ne pouvait plus ni corriger une référence, ni annuler une demande devenue sans objet — et une
 * demande de devis ouverte pour un poste interdisait d'en ouvrir une autre. Le seul geste restant
 * était le commentaire, qui ne prévenait personne quand la demande n'avait pas de responsable (R09).
 * Une demande figée ne protège rien : elle pousse à en ouvrir une seconde à côté, et l'assistante
 * traite les deux.
 *
 * La règle, en deux modes, et c'est la distinction qui compte :
 *
 *   • DISCRET — la demande est neuve, personne ne l'a commencée, elle a moins de trente minutes :
 *     le demandeur la corrige ou la retire sans déranger personne, comme avant (personne n'a encore
 *     rien fait sur ce qu'il change) ;
 *   • PRÉVENU — au-delà, tant qu'elle n'est ni TERMINÉE ni ANNULÉE : il la corrige ou l'annule
 *     encore, mais l'assistante l'apprend (le responsable désigné, sinon le rôle) et la discussion
 *     garde la trace de ce qui a changé. Une annulation n'efface plus la demande : elle la CLÔT,
 *     avec son motif, parce que quelqu'un a peut-être déjà travaillé dessus.
 *
 * Ce qui reste fermé, chacun avec son remède : une demande TERMINÉE (on en ouvre une nouvelle, en
 * citant sa référence) ; une modification pendant qu'une VALIDATION est en cours (le validateur ne
 * doit pas voir changer sous ses yeux ce qu'il tranche) ; une modification quand un PAIEMENT est déjà
 * émis (corriger la demande ne corrigerait pas ce paiement — on l'annule, ou l'on écrit à l'assistante).
 *
 * Module PUR : l'action, l'écran et leurs bancs en ont besoin sans avoir le droit de se parler. Le
 * temps est un paramètre OBLIGATOIRE — un défaut à `Date.now()` rendrait chaque appelant juste ou
 * faux selon l'heure, et un banc ne pourrait plus nommer la minute qui fait basculer (§118.127b).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** La fenêtre pendant laquelle le demandeur agit sans prévenir personne. */
export const FENETRE_DISCRETE_MS = 30 * 60 * 1000;

export interface DemandeVueParSonDemandeur {
  requesterId: string | null;
  status: AdminRequestStatus;
  createdAt: Date;
  processingStartedAt: Date | null;
}

export type PorteDuDemandeur =
  | { ok: true; discret: boolean }
  | { ok: false; raison: string };

/** Le mode discret : neuve, jamais commencée, et dans la fenêtre. */
export function estDiscrete(req: DemandeVueParSonDemandeur, maintenant: number): boolean {
  return req.status === "NEW" && !req.processingStartedAt && maintenant - req.createdAt.getTime() <= FENETRE_DISCRETE_MS;
}

export function porteDuDemandeur(req: DemandeVueParSonDemandeur, userId: string, maintenant: number): PorteDuDemandeur {
  if (req.requesterId !== userId) {
    return { ok: false, raison: "Seule la personne qui a fait la demande la modifie ou l'annule — écrivez-lui dans la discussion." };
  }
  if (req.status === "DONE") {
    return {
      ok: false,
      raison: "Cette demande est terminée : elle ne se modifie plus. Ouvrez une nouvelle demande en citant sa référence, ou écrivez à l'assistante dans la discussion.",
    };
  }
  if (req.status === "CANCELLED") return { ok: false, raison: "Cette demande est déjà annulée." };
  return { ok: true, discret: estDiscrete(req, maintenant) };
}

/**
 * UNE DEMANDE « BC À ÉTABLIR » SUIT LE POSTE QUI L'A OUVERTE. Elle est le travail de l'assistante pour la
 * demande de bon de commande d'un poste Ad & Pro : la corriger ou l'annuler ICI laisserait le poste dire
 * « BC demandé » à une assistante qui n'a plus rien à faire — ou faire lire à l'assistante un message que
 * le poste ne porte plus. Elle se corrige et se retire depuis le poste, qui la met à jour ou la ferme avec.
 */
export function suitLaDemandeDeBcDuPoste(req: { linkedEntityType: EntityType | null; type: string; title: string }): boolean {
  return req.linkedEntityType === "AD_PRO_ITEM" && estDemandeBcAEtablir(req);
}

export function refusDemandeDeBcDuPoste(geste: "corriger" | "annuler"): string {
  return geste === "corriger"
    ? "Cette demande suit la demande de bon de commande d'un poste Ad & Pro : corrigez-la depuis le poste (« Modifier la demande de BC »), elle se mettra à jour avec."
    : "Cette demande suit la demande de bon de commande d'un poste Ad & Pro : retirez-la depuis le poste (« Annuler la demande de BC »), elle se fermera avec.";
}

/** Ce qui interdit de MODIFIER (l'annulation, elle, reste ouverte : c'est un geste qui réduit). */
export function refusDeModification(etat: { validationEnCours: boolean; paiementEmis: boolean }): string | null {
  if (etat.validationEnCours) {
    return "Une validation est en cours sur cette demande : ce que le validateur tranche ne change pas sous ses yeux. Écrivez votre correction dans la discussion, ou attendez sa décision.";
  }
  if (etat.paiementEmis) {
    return "Un paiement est déjà émis pour cette demande : la modifier ne changerait pas ce paiement. Écrivez à l'assistante dans la discussion, ou annulez la demande.";
  }
  return null;
}

export interface ContenuDemande {
  title: string;
  description: string | null;
  priority: string;
  /** `AAAA-MM-JJ`, ou `null`. */
  deadline: string | null;
  fields: Record<string, string>;
}

/**
 * Ce qui a changé, dans les mots de l'écran — pour la discussion et pour l'assistante. Un champ
 * dont le libellé n'est pas connu se nomme par sa clé plutôt que de disparaître : taire un
 * changement ferait croire qu'il n'a pas eu lieu.
 */
export function changementsDeLaDemande(avant: ContenuDemande, apres: ContenuDemande, libelles: Record<string, string>): string[] {
  const n = (s: string | null | undefined) => (s ?? "").trim();
  const out: string[] = [];
  if (n(avant.title) !== n(apres.title)) out.push("l'objet");
  if (n(avant.description) !== n(apres.description)) out.push("la description");
  if (n(avant.priority) !== n(apres.priority)) out.push("la priorité");
  if (n(avant.deadline) !== n(apres.deadline)) out.push("l'échéance");
  const cles = [...new Set([...Object.keys(avant.fields), ...Object.keys(apres.fields)])].sort();
  for (const k of cles) {
    if (n(avant.fields[k]) !== n(apres.fields[k])) out.push(`« ${libelles[k] ?? k} »`);
  }
  return out;
}
