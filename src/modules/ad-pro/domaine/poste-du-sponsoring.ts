import type { AdProItemKind, SponsoringNature } from "@prisma/client";
import { ITEM_KIND_LABELS } from "./postes";
import { noteDuPosteDeNaissance } from "./edition";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE POSTE D'UN SPONSORING — module PUR, lu par la création (la nature admise), par la naissance du poste à la
 * prévalidation (`infra/postes/naissance-sponsoring.ts`) et par leurs bancs.
 *
 * « Ce sponsoring s'ajoute automatiquement dans un poste, car dans les postes on voit tous les postes relatifs à cette
 * demande ; on précisera si c'est un sponsoring direct (à l'association) ou indirect (prise en charge de prestations / de
 * médecins) » (Direction, 09/2026 — §118.151).
 *
 * LE POSTE NAÎT À LA PRÉVALIDATION (recette 24/11/2026). Né avec la demande, il se montrait à tous en « Brouillon », avec
 * « Soumettre pour validation », avant que quiconque ait prévalidé. Il naît désormais quand la chaîne est complète — N+1,
 * Directeur des opérations, Direction Marketing —, EN ATTENTE de la Direction Marketing, qui le lit, l'ajuste et l'accorde.
 * Tout ce qu'il porte se lit sur la demande : la nature, l'institution, les deux montants.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/**
 * LA NATURE D'UN SPONSORING DÉCIDE SON POSTE. La table est FERMÉE et exhaustive (`Record<SponsoringNature, …>`) : une
 * troisième nature ajoutée au schéma ne compile pas tant que personne n'a dit quel poste elle ouvre.
 */
export const POSTE_DE_LA_NATURE: Record<SponsoringNature, AdProItemKind> = {
  DIRECT: "ASSOCIATION_SUPPORT",
  INDIRECT: "INDIRECT_SUPPORT",
};

/** Ce que la demande dit de son poste — lu sur `SponsoringRequest`, les montants déjà en nombres. */
export interface DemandeDuPoste {
  nature: SponsoringNature;
  institution: string;
  /** Le sponsoring demandé par le médecin. */
  amountRequested: number | null;
  /** Le sponsoring suggéré par le délégué. */
  amountProposed: number | null;
}

/**
 * LE POSTE TEL QU'IL NAÎT. Chiffré à ce que SUGGÈRE LE DÉLÉGUÉ — une recommandation : c'est la Direction Marketing qui
 * accordera ; la demande du médecin est dite dans ses précisions, pour que l'écart se lise sans ouvrir la demande. Un
 * sponsoring direct se verse à l'association : elle est le bénéficiaire. Un indirect paie des prestataires que personne
 * ne connaît encore : le bénéficiaire reste vide plutôt que deviné.
 */
export function posteDuSponsoring(d: DemandeDuPoste, dzd: (n: number) => string): {
  kind: AdProItemKind; label: string; notes: string | null; supplier: string | null; amountEstimated: number | null;
} {
  const kind = POSTE_DE_LA_NATURE[d.nature];
  return {
    kind,
    label: `${ITEM_KIND_LABELS[kind]} — ${d.institution}`,
    // Une demande d'avant les deux montants obligatoires n'a pas de quoi écrire la phrase : rien plutôt qu'un « 0 DZD ».
    notes: d.amountRequested != null && d.amountProposed != null ? noteDuPosteDeNaissance(d.amountRequested, d.amountProposed, dzd) : null,
    supplier: d.nature === "DIRECT" ? d.institution : null,
    amountEstimated: d.amountProposed,
  };
}
