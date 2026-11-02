/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * CE QUE LA FICHE PERSONNE MONTRE À QUI — la règle, pure (lot V2-B, fiche 360° `/personnes/[id]`).
 *
 * La fiche ne crée AUCUN droit : chaque ligne qu'elle réunit (le praticien, le salarié, la prise en charge,
 * le voyage…) s'y montre si, et seulement si, l'écran d'où elle vient l'aurait montrée à la même personne
 * (`fiche.ts` pose ces portes, ligne par ligne). Ce module en tire le reste :
 *
 *   • la fiche s'ouvre si au moins une ligne est visible — un délégué ne découvre pas une Personne qu'il
 *     ne voit nulle part ailleurs ;
 *   • un RÔLE ne se montre que si une ligne visible le porte : apprendre qu'un praticien est aussi
 *     « candidat » à un poste chez nous serait une fuite du recrutement ;
 *   • la DATE DE NAISSANCE vient du dossier RH : elle ne se montre qu'à qui ouvre ce dossier par la porte
 *     des RH (pas par l'annuaire interne, qui ne la montre pas).
 *
 * Aucune donnée sensible (NIN, IBAN, salaire) n'est même chargée par la fiche : elles relèvent du coffre.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import type { RolePersonne } from "@prisma/client";
import { roleApporte, type LigneSource } from "./sources";

export interface Regard {
  /** Les lignes de cette Personne visibles par la porte de leur écran. */
  lignesVues: readonly Pick<LigneSource, "source" | "racine">[];
  /** Le dossier salarié est vu par la porte des RH (et pas seulement par l'annuaire interne). */
  salarieVuParLesRh: boolean;
  /** Le Super Admin, qui conduit la refonte : il voit la Personne même sans ligne (orpheline, fusionnée). */
  conduitLaRefonte: boolean;
}

export const ficheOuverte = (r: Regard): boolean => r.conduitLaRefonte || r.lignesVues.length > 0;

/**
 * Les rôles qu'une ligne VISIBLE apporte (`roleApporte` : la même règle que la reprise). Le Super Admin les voit
 * tous, y compris ceux posés à la main.
 */
export function rolesVisibles(roles: readonly RolePersonne[], r: Regard): RolePersonne[] {
  if (r.conduitLaRefonte) return [...new Set(roles)];
  const justifies = new Set(r.lignesVues.map((l) => roleApporte(l)).filter((x): x is RolePersonne => !!x));
  return [...new Set(roles)].filter((x) => justifies.has(x));
}

export const naissanceVisible = (r: Regard): boolean => r.conduitLaRefonte || r.salarieVuParLesRh;
