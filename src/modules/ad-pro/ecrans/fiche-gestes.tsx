import * as React from "react";
import type { EntityType } from "@prisma/client";
import { ancrePoste } from "@/lib/chemins/ad-pro";
import { WorkflowPanel, type EtapeDeFrise, type StatutDeLaDemande } from "@/components/workflow/workflow-panel";
import type { GesteAVous } from "./fiche";
import { BoutonVersAncre } from "./lien-vers-poste";
import type { ContexteDesPostes, ItemRow } from "./items-panel";
import { userCan, type SessionUser } from "@/lib/rbac";
import { siegeAuCentreAdPro } from "../domaine/centre";
import { porteSignalSeule, posteQuiVousAttend, type DroitsDesPostes } from "./postes/resume-poste";

/** La vue du circuit, telle que le panneau la reçoit. */
type VueDuCircuit = React.ComponentProps<typeof WorkflowPanel>["view"];

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES GESTES QUE LA CARTE « À VOUS » D'UNE FICHE AD & PRO PORTE (maquette validée, 24/11/2026) — chacun est le composant
 * qui le portait déjà, avec la même action : le panneau du circuit (en n'en montrant que les gestes), la carte du poste
 * (on y mène), la porte du DG (on y mène). La page ajoute ceux qui lui sont propres (clôture, appel, déclaration, soumission).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const minuscule = (s: string) => (s ? s[0]!.toLocaleLowerCase("fr") + s.slice(1) : s);

/** LE CIRCUIT : décider l'étape, corriger et resoumettre une demande renvoyée, faire appel d'un refus. */
export function gesteDuCircuit(entityType: EntityType, entityId: string, view: VueDuCircuit | null, rendu: {
  suite?: EtapeDeFrise[];
  statut?: StatutDeLaDemande | null;
  /** Les gestes propres à la page, rangés avec ceux de l'étape (la relance d'un événement refusé). */
  gestes?: React.ReactNode;
} = {}): GesteAVous | null {
  if (!view || !(view.action || view.peutResoumettre || view.peutFaireAppel)) return null;
  const titre = view.action
    ? `décider — étape « ${view.action.title} »`
    : view.peutResoumettre ? "corriger et resoumettre la demande" : "faire appel de la décision";
  return {
    cle: "circuit", titre,
    contenu: <WorkflowPanel entityType={entityType} entityId={entityId} view={view} compact partie="gestes" suite={rendu.suite} statut={rendu.statut} gestes={rendu.gestes} />,
  };
}

/** UN POSTE ATTEND LA PERSONNE QUI REGARDE : la carte le nomme et y mène ; le geste reste sur la carte du poste. */
function gesteDuPoste(poste: { id: string; titre: string; geste: string } | null): GesteAVous | null {
  if (!poste) return null;
  return {
    cle: `poste:${poste.id}`, titre: `${minuscule(poste.geste)} — poste « ${poste.titre} »`,
    contenu: <BoutonVersAncre ancre={ancrePoste(poste.id)}>Ouvrir le poste</BoutonVersAncre>,
  };
}

/** LA PORTE DU DG SUR LE TOTAL : à qui statue, quand elle attend sa décision (la carte au-dessus des postes porte le geste). */
function gesteDeLaPorteDg(items: ItemRow[], porte: ContexteDesPostes["porteDg"]): GesteAVous | null {
  if (!porte?.peutStatuer || porte.etat === "VALIDEE" || porte.etat === "NON_REQUISE" || porteSignalSeule(items)) return null;
  return {
    cle: "porte-dg", titre: "valider le total de la demande", phrase: porte.phrase,
    contenu: <BoutonVersAncre ancre="porte-dg">Voir le total à valider</BoutonVersAncre>,
  };
}

/**
 * LES DROITS SUR LES POSTES DE LA FICHE — ceux que le panneau des postes reçoit (`AdProItemsPanel`), dits une fois : viser un
 * BC (le centre Ad & Pro), émettre ou annuler un ordre (les Finances) se lisent ici ; décrire et arbitrer, la page les dit.
 */
export function droitsDesPostes(user: SessionUser, d: Omit<DroitsDesPostes, "canViserBC" | "canIssueOrder" | "fige"> & { fige?: boolean }): DroitsDesPostes {
  return {
    ...d, fige: d.fige ?? false,
    canViserBC: siegeAuCentreAdPro(user),
    canIssueOrder: userCan(user, "FINANCES", "UPDATE") || userCan(user, "FINANCES", "VALIDATE"),
  };
}

/** Ce que les postes demandent à la personne qui regarde : un poste à faire avancer, le total à valider (le DG). */
export function gestesDesPostes(items: ItemRow[], droits: DroitsDesPostes): { posteAVous: boolean; gestes: GesteAVous[] } {
  const poste = posteQuiVousAttend(items, droits);
  return {
    posteAVous: poste !== null,
    gestes: [gesteDuPoste(poste), gesteDeLaPorteDg(items, droits.contexte.porteDg)].filter((g): g is GesteAVous => g !== null),
  };
}

/** LA DÉCLARATION, QUAND C'EST LE TOUR DE LA PERSONNE QUI REGARDE — le panneau de l'étape (`contenu`) vient de la page. */
export function gesteDeLaDeclaration(
  etape: { titre: string; phrase: string; aVous: boolean } | null,
  contenu: React.ReactNode,
): GesteAVous | null {
  if (!etape?.aVous) return null;
  return { cle: "declaration", titre: etape.titre.toLocaleLowerCase("fr"), phrase: etape.phrase, contenu };
}
