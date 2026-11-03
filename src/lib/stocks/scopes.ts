/**
 * QUI VOIT QUEL STOCK — et pourquoi le terrain ne voit que les hôpitaux.
 *
 * ── LE DÉFAUT QU'ON CORRIGE ─────────────────────────────────────────────────────────────────
 *
 * L'écran des stocks montrait ses trois onglets à quiconque entrait dans le module : **stock
 * PCH** (la centrale d'achat de l'État), **stock hôpitaux**, **stock annexes PCH**. Un délégué
 * médical — un KAM — y voyait donc la position de la centrale et de ses annexes, qui ne relèvent
 * pas de son métier : lui relève les stocks des hôpitaux qu'il VISITE. Et le bouton « Demander un
 * état de stock », qui envoie une réquisition à quelqu'un, lui était ouvert dès qu'il détenait le
 * droit de suppression sur le module.
 *
 * ── LA RÈGLE, ET POURQUOI ELLE N'EST PAS UNE LISTE DE RÔLES ─────────────────────────────────
 *
 * PCH et ses ANNEXES sont la chaîne d'approvisionnement : elles appartiennent au module `PCH`
 * (marchés, appels d'offres, livraisons). Qui n'a pas accès à ce module n'a rien à faire dans ces
 * deux onglets — c'est vrai du KAM, et ce sera vrai du prochain rôle terrain qu'on créera sans y
 * penser. Écrire « sauf MEDICAL_DELEGATE » aurait tenu jusqu'à la première nomination.
 *
 * Les HÔPITAUX, eux, restent ouverts à tout le module : c'est le relevé de terrain, et c'est
 * précisément ce qu'on attend d'un délégué.
 *
 * ── CE QUE ÇA IMPLIQUE CÔTÉ SERVEUR ─────────────────────────────────────────────────────────
 *
 * Masquer un onglet ne suffit pas : les relevés partent dans la charge utile de la page. La même
 * règle FILTRE donc les données avant l'envoi (`keepVisibleSnapshots`). Un onglet caché dont les
 * chiffres voyagent quand même n'est pas une restriction, c'est une décoration.
 *
 * Module PUR : ni base, ni session. Testé.
 */

import { regleDemandeEtatStock } from "@/lib/rbac/roles";

export type StockScope = "PCH" | "HOSPITAL" | "ANNEX";

/** Ce que sait faire la personne, réduit à ce qui compte ici. */
export interface StockViewer {
  /** A-t-elle accès au module PCH — la chaîne d'approvisionnement ? */
  canSeeSupplyChain: boolean;
  /** Vue globale (Super Admin, Direction) : elle voit tout, partout. */
  hasGlobalView?: boolean;
}

const seesSupplyChain = (v: StockViewer): boolean => v.hasGlobalView === true || v.canSeeSupplyChain;

/**
 * LES ONGLETS AUXQUELS CETTE PERSONNE A DROIT, dans l'ordre d'affichage.
 *
 * Jamais vide : quiconque entre dans le module relève au moins les hôpitaux — sans quoi l'écran
 * s'ouvrirait sur rien, et l'on chercherait la panne.
 */
export function visibleStockScopes(viewer: StockViewer): StockScope[] {
  return seesSupplyChain(viewer) ? ["PCH", "HOSPITAL", "ANNEX"] : ["HOSPITAL"];
}

export function canSeeStockScope(viewer: StockViewer, scope: StockScope): boolean {
  return visibleStockScopes(viewer).includes(scope);
}

/**
 * DEMANDER UN ÉTAT DE STOCK À QUELQU'UN — une réquisition, pas une lecture.
 *
 * On demande à une personne nommée d'aller compter et de répondre pour une date donnée. C'est un
 * geste de pilotage de la chaîne : il appartient à qui la tient, jamais à qui y contribue. Le
 * droit de SUPPRESSION sur le module ne suffit donc plus à l'ouvrir — il pouvait être accordé
 * pour de tout autres raisons.
 */
// QUI LANCE UNE DEMANDE D'ÉTAT DE STOCK FORMELLE (Direction, 03/11/2026, décision 0061) : la règle vit au socle des droits
// (`lib/rbac/roles.ts`, `regleDemandeEtatStock`) — un module la lit sans dépendre des stocks ; ici, son nom historique.
export { REFUS_DEMANDE_STOCK } from "@/lib/rbac/roles";
export const canRequestStockState = (viewer: StockViewer & { isSuperAdmin?: boolean; roles?: readonly (string | null | undefined)[] }): boolean =>
  regleDemandeEtatStock(viewer);

export interface ScopedSnapshot {
  scope: string;
}

/**
 * LE FILTRE DES DONNÉES — la même règle, appliquée AVANT l'envoi.
 *
 * Un relevé dont le `scope` n'est pas reconnu est ÉCARTÉ pour qui n'a pas la chaîne
 * d'approvisionnement : le doute referme, il n'ouvre pas.
 */
export function keepVisibleSnapshots<T extends ScopedSnapshot>(viewer: StockViewer, rows: readonly T[]): T[] {
  if (seesSupplyChain(viewer)) return [...rows];
  return rows.filter((r) => r.scope === "HOSPITAL");
}

export const STOCK_SCOPE_LABEL: Record<StockScope, string> = {
  PCH: "Stock PCH",
  HOSPITAL: "Stock hôpitaux",
  ANNEX: "Stock annexes PCH",
};
