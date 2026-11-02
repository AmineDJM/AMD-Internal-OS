/**
 * Registre des suppressions — la COMPOSITION de `DELETE_REGISTRY` (les morceaux par famille, dans
 * l'ordre d'origine) et ses lectures : genres, délégué Prisma, refus d'un lot, aperçu d'une suppression.
 * Réexporté par la porte `lib/admin-delete-registry`.
 */

import { prisma } from "@/lib/prisma";
import { inventorier } from "@/lib/suppression/lot";
import { resumeDesLiens } from "@/lib/suppression/branches";
import type { DeletableKind, KindSpec } from "./types";
import { REGISTRE_REGULATORY_RH_ADMINISTRATION } from "./regulatory-rh-administration";
import { REGISTRE_TERRAIN_VENTES_BD_SUPPORT } from "./terrain-ventes-bd-support";
import { REGISTRE_FINANCE } from "./finance";
import { REGISTRE_PROMOTION_AD_PRO } from "./promotion-ad-pro";
import { REGISTRE_MARCHES_VALIDATIONS_LEGAL } from "./marches-validations-legal";
import { REGISTRE_MESSAGERIE_DRIVE } from "./messagerie-drive";

export const DELETE_REGISTRY: Record<DeletableKind, KindSpec> = {
  ...REGISTRE_REGULATORY_RH_ADMINISTRATION,
  ...REGISTRE_TERRAIN_VENTES_BD_SUPPORT,
  ...REGISTRE_FINANCE,
  ...REGISTRE_PROMOTION_AD_PRO,
  ...REGISTRE_MARCHES_VALIDATIONS_LEGAL,
  ...REGISTRE_MESSAGERIE_DRIVE,
};

/** Les kinds dans l'ordre du registre — pour les énumérations (schéma d'outil, messages). */
export const DELETABLE_KINDS = Object.keys(DELETE_REGISTRY) as DeletableKind[];

export function isDeletableKind(v: string): v is DeletableKind {
  return Object.prototype.hasOwnProperty.call(DELETE_REGISTRY, v);
}

/** Délégué Prisma générique (snapshot / restauration / recherche) pour un kind du registre. */
export function deleteDelegateOf(spec: KindSpec) {
  return (prisma as unknown as Record<string, {
    findUnique: (a: { where: { id: string } }) => Promise<Record<string, unknown> | null>;
    findMany: (a: { where: Record<string, unknown>; select: { id: true }; take: number }) => Promise<{ id: string }[]>;
    create: (a: { data: Record<string, unknown> }) => Promise<unknown>;
  }>)[spec.model];
}

/** Le nom du MODÈLE Prisma d'une entrée du registre — son délégué, première lettre capitale. */
export function modeleDuRegistre(spec: KindSpec): string {
  return spec.model.charAt(0).toUpperCase() + spec.model.slice(1);
}

/**
 * LE REFUS D'UN LOT — ce qui a quitté l'ERP, nommé. Pas de faux remède : quand un règlement est
 * parti ou qu'une pièce est signée, la demande EST la justification de ce fait, elle reste.
 */
export function refusDuLot(bloquants: readonly string[]): string {
  return `Suppression refusée : ${bloquants.join(" ; ")}. Cet élément justifie ces faits — le supprimer les laisserait sans cause, il reste donc au registre. (Un courrier inscrit se retire d'abord depuis le registre des courriers, si c'est bien voulu.)`;
}

/** Ce qu'une suppression emportera, et ce qui l'interdit — lu AVANT de confirmer (§118.53). */
export interface ApercuSuppression {
  nom: string | null;
  /** « 2 postes », « 1 déclaration d'information médicale »… Vide : l'élément part seul. */
  emporte: string[];
  /**
   * CE QUI RESTE mais PERD SON LIEN avec lui — « 3 dossiers réglementaires » perdent leur projet.
   * Ces lignes ne partent pas : leur lien est vidé, noté, et rétabli à la restauration. Le taire
   * laisserait croire qu'un projet supprimé ne touche à rien, alors que trois dossiers perdent leur
   * classement au même clic (§118.53, §118.163).
   */
  detache: string[];
  refus: string | null;
  /** Vrai : ce qui part avec l'élément REVIENT avec lui à la restauration. */
  lot: boolean;
}

/**
 * L'APERÇU — le MÊME inventaire que la suppression, lu sans rien écrire. L'écran (bouton rouge)
 * et Adam (carte de confirmation) le lisent tous deux : deux rédactions de « ce qui part avec »
 * finiraient par dire deux choses différentes (§118.5).
 */
export async function apercuSuppression(kind: DeletableKind, id: string): Promise<ApercuSuppression> {
  const spec = DELETE_REGISTRY[kind];
  const refusPropre = spec.refuse ? await spec.refuse(id) : null;
  const nom = await spec.describe(id);
  if (!spec.lot || nom === null) return { nom, emporte: [], detache: [], refus: refusPropre, lot: Boolean(spec.lot) };
  const inv = await inventorier(modeleDuRegistre(spec), id);
  if (!inv) return { nom: null, emporte: [], detache: [], refus: refusPropre, lot: true };
  return {
    nom,
    emporte: inv.resume,
    detache: resumeDesLiens(inv.liensExternes),
    refus: refusPropre ?? (inv.bloquants.length ? refusDuLot(inv.bloquants) : null),
    lot: true,
  };
}
