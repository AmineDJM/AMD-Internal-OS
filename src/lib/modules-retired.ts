/**
 * LES MODULES RETIRÉS DU SERVICE — la liste, et pourquoi elle vit seule dans son fichier.
 *
 * ── CE QUE « RETIRÉ » VEUT DIRE ─────────────────────────────────────────────────────────────
 *
 * Ni menu, ni adresse, ni action serveur, ni outil d'assistant — pour TOUT LE MONDE, Super Admin
 * compris. Ce n'est pas un droit (« cette personne n'y a pas accès ») ni un masquage (« éteint le
 * temps d'une refonte, le Super Admin le voit encore ») : c'est une décision de produit. Ces
 * écrans ne servent à personne dans cette entreprise.
 *
 * ── POURQUOI LE CODE ET NON UN RÉGLAGE ──────────────────────────────────────────────────────
 *
 * Un réglage se rallume « pour voir », et l'on se retrouve avec trois modules à maintenir pour un
 * usage qui n'existe pas. Écrit ici, le retrait se relit, se discute, et se défait en supprimant
 * une ligne — sans qu'aucune donnée ne soit perdue.
 *
 * ── POURQUOI UN FICHIER À PART ──────────────────────────────────────────────────────────────
 *
 * Parce que le retrait doit être connu de `rbac.ts` (pour vider l'accès à la racine) ET de
 * `modules-visibility.ts` (qui, lui, importe `rbac.ts`). Une constante posée dans l'un des deux
 * créerait un cycle d'imports. Ce fichier n'importe RIEN : c'est ce qui le rend citable de
 * partout, y compris d'un composant client.
 *
 * ── OÙ LE RETRAIT PREND EFFET ───────────────────────────────────────────────────────────────
 *
 *   • `rbac.ts` (`getAccess`) — le module n'entre PAS dans l'accès effectif. `userCan` répond
 *     donc non partout : écrans, actions serveur, routes d'API et outils d'Adam d'un seul coup.
 *     C'est la garde qui compte : les autres ne font que rendre l'interface cohérente ;
 *   • `modules-visibility.ts` — hors du menu et injoignable par son adresse ;
 *   • `navigation.ts` — les alias de recherche partent avec les écrans.
 *
 * Les DONNÉES restent en base, intactes.
 */

/**
 * Retirés le 2026-09 sur décision métier :
 *   • `SALES` — « Ventes » : le suivi commercial se fait dans Force de vente (SFE) ;
 *   • `LOGISTICS` — « Commandes & logistique » : jamais entré dans les usages ;
 *   • `BUSINESS_DEVELOPMENT` — « Market Intelligence ».
 *
 * ⚠️ `PCH` (Marchés PCH) et `PRODUCT_EXPLORER` (Explorateur produits) RESTENT en service : ce
 * sont des modules voisins, séparés de Market Intelligence précisément pour survivre à ce genre
 * de décision. Ne pas les ajouter ici par association d'idées.
 *
 * Retiré le 25/11/2026 (Super Admin, après la mise en production) :
 *   • `FINANCES_DOUBLONS` — « Doublons de factures » : l'écran du recensement est supprimé ; son adresse mène à la
 *     Comptabilité. La DÉTECTION reste en service — elle ne lit pas cette clé : « doublon possible » au centre de
 *     paiement, « ressemble à » dans la Comptabilité (`recenserDoublonsFactures`). Les accès posés en base restent,
 *     ignorés : la console ne propose plus la clé, et aucun écran ne s'ouvre par elle.
 */
export const RETIRED_MODULE_KEYS: readonly string[] = ["SALES", "LOGISTICS", "BUSINESS_DEVELOPMENT", "FINANCES_DOUBLONS"];

/**
 * CE QUI SURVIT À UN RETRAIT — un MODULE à part, jamais une exception de chemin.
 *
 * Une décision de produit se RÉVISE PAR MORCEAUX : le dirigeant a redemandé « BD › Projets » — le
 * registre des projets par lesquels on classe les dossiers réglementaires — sans redemander
 * Market Intelligence. Rouvrir `BUSINESS_DEVELOPMENT` lui rendrait onze écrans qu'il a décidé
 * d'éteindre, deux actions de Market Intelligence et l'accès générique d'Adam au module entier :
 * l'empreinte réelle dépasserait la demande (§118.16).
 *
 * Projets a d'abord survécu par une exception : un chemin « maintenu », affiché pour tout le
 * monde, dont une porte DÉDUITE de Regulatory décidait l'ouverture. Elle avait raison de ne pas
 * rouvrir le module retiré — et le défaut d'une porte déduite : aucune case de la console ne la
 * réglait. « Donne au Super Admin la permission de gérer l'accès au module » : Projets est donc
 * devenu son propre module, `BD_PROJECTS` (§118.163), réglé comme tous les autres. Le retrait
 * de `BUSINESS_DEVELOPMENT`, lui, reste entier.
 */
/** Ce module a-t-il été retiré du service ? */
export function isRetiredModule(module: string): boolean {
  return RETIRED_MODULE_KEYS.includes(module);
}
