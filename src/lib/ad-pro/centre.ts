/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CENTRE DE VALIDATION AD & PRO — le troisième centre, et le seul qui règle son propre seuil.
 *
 * ── CE QUE LA DIRECTION A DEMANDÉ ───────────────────────────────────────────────────────────
 *
 * « Crée un centre de validation Ad&Pro pour le PDG et super admin. On gère depuis là le seuil à
 * partir duquel il faut une validation qui passe par ce centre. Toute demande parmi les demandes
 * Ad&Pro dont le budget total est au-dessus du seuil nécessite de passer par là, comme les
 * autres centres de validations. »
 *
 * ── QUI Y SIÈGE, ET POURQUOI CE N'EST PAS LA « DIRECTION » ──────────────────────────────────
 *
 * Le **Directeur Général** et le **Super Admin**. Le dépôt emploie « PDG » de deux façons
 * contradictoires, et il a fallu mesurer avant de choisir : `rbac.ts` écrit que le Directeur
 * Général « est précisément la personne qu'on appelle « le PDG » », pendant que le commentaire
 * du centre de PAIEMENT appelle PDG le rôle `DIRECTION`. Deux lectures dans le même fichier.
 *
 * Ce qui tranche n'est pas la prose mais le MÉCANISME que la demande décrit : « le seuil à partir
 * duquel il faut une validation qui passe par ce centre » existe déjà — `AppSetting
 * .adProDgThreshold` — et la porte qu'il commande est l'étape `dg`, dont l'acteur est
 * `GENERAL_MANAGER`, créée sur les mots de la Direction elle-même (« la validation du DG à partir
 * de 1 000 000 DZD », §118.138). Le centre est l'ÉCRAN de celui qui tient déjà cette porte.
 *
 * Et `DIRECTION` en est EXCLU pour une raison de circuit, pas de vocabulaire : depuis §118.139,
 * ce rôle s'appelle « Direction des opérations » et il est l'acteur de l'étape `final` de CHAQUE
 * circuit Ad & Pro. L'asseoir aussi à la porte du DG lui ferait valider DEUX FOIS la même
 * demande — un guichet de plus qui ne décide rien de plus.
 *
 * **Le réglage d'une ligne qui retourne cette lecture**, si la Direction visait l'autre : ajouter
 * `|| user.role === "DIRECTION"` ci-dessous, et accorder `AD_PRO_CENTRE` à ce rôle dans
 * `rbac.ts`. Une ambiguïté qu'on tranche se documente avec le geste qui la retourne (§118.138).
 *
 * ── CE CENTRE EST UNE LENTILLE, JAMAIS UNE SECONDE AUTORISATION ─────────────────────────────
 *
 * La tentation était de copier le centre de PAIEMENT : une table d'autorisation centrale posée
 * par-dessus, un statut à elle, un guichet unique. Elle est fausse ici, et mesurablement : la
 * porte du DG EXISTE DÉJÀ dans cinq des sept natures. Une seconde couche par-dessus aurait
 * demandé au Directeur Général de valider DEUX FOIS un sponsoring de 1,2 M — une fois à l'étape
 * `dg`, une fois au centre — et deux vérités sur « le DG a-t-il validé ? » divergent toujours
 * (§118.5). Le précédent juste est l'autre centre : `/centre-de-validations` est une LENTILLE
 * sur `ValidationRequest`, et décider depuis lui appelle la MÊME action que l'écran d'origine.
 *
 * Ce centre fait de même : il LIT la porte là où elle vit, et décider depuis lui appelle l'action
 * du circuit concerné. L'état du circuit EST l'état du centre ; il ne peut pas en dériver.
 *
 * ── TROIS FORMES DE PORTE, UNE SEULE QUESTION ───────────────────────────────────────────────
 *
 * Mesuré nature par nature avant d'écrire une ligne :
 *
 *   • `ETAPE_CIRCUIT` — sponsoring, prises en charge internationale et nationale, événements :
 *     l'étape `dg` d'un `WorkflowInstance` (§118.138). Franchie automatiquement sous le seuil.
 *   • `ETAPE_PROMO` — matériel promotionnel : `REVIEW_DG` de `PROMO_STEPS`, qui n'a pas d'étapes
 *     en base et pose la question directement.
 *   • `VISA_CENTRE` — consulting et « autres demandes » : elles n'avaient **AUCUNE** porte. Un
 *     contrat de consulting de 5 M DZD sortait sans que personne en haut l'ait vu, et un centre
 *     qui les laisserait passer serait une porte ouverte à côté d'une porte gardée (§118.71).
 *     Elles reçoivent un VISA (`AdProGateVisa`), une table unique et non deux jeux de colonnes.
 *
 * `Record<AdProKind, FormePorte>` sans valeur optionnelle : une huitième nature ajoutée à
 * `AD_PRO_KINDS` NE COMPILE PAS tant que personne n'a dit par quelle porte elle passe (§118.130).
 * C'est ce qui empêche « toute demande » de redevenir « presque toutes », en silence.
 *
 * ── CE QU'UNE UNIFICATION COÛTERAIT, écrit pour ne pas être redécouvert ─────────────────────
 *
 * Ramener les sept natures au seul `VISA_CENTRE` donnerait UNE forme au lieu de trois, et c'est
 * tentant. Le prix mesuré : retirer l'étape `dg` de quatre définitions en base, donc DÉPLACER
 * les instances qui s'y trouvent à cet instant (elles seraient orphelines d'un `currentSlug` que
 * plus aucune étape ne porte — le circuit mort de §118.113), perdre le réglage par circuit
 * (`autoSkipMaxAmount` surchargé par le Super Admin), et toucher `parcours.ts`, son tamis, ses
 * bornes et leurs bancs. Une régression déguisée en simplification (§118.86).
 *
 * Module PUR — testé, sans base ni session. Son seul import est le SOCLE.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import { porteDgRequise, motifPorteDg } from "@/lib/seuils/ad-pro";
import { AD_PRO_KINDS, type AdProKind } from "./unified";

export { porteDgRequise, motifPorteDg };

/**
 * SIÈGE AU CENTRE DE VALIDATION AD & PRO — le Directeur Général et le Super Admin.
 *
 * Le module `AD_PRO_CENTRE` s'ouvre par le RBAC, mais le siège est une règle d'ORGANISATION :
 * un administrateur qui s'octroierait le module ne devient pas pour autant l'arbitre des
 * dépenses de promotion de la société. La règle pure a le dernier mot, comme au centre de
 * validations et au centre de paiement.
 *
 * Le rôle PRINCIPAL OU SECONDAIRE (Direction, 27/10 — point 26). Le rôle secondaire est une
 * attribution du Super Admin, nommée sur le compte (`User.secondaryRole`), pas un prêt : un DG
 * qui porte sa casquette en second (son rôle principal étant, par exemple, celui de la Direction
 * Marketing) restait dehors, et les BC nés d'Ad & Pro n'avaient plus personne pour les viser.
 * L'INTÉRIM, lui, ne prête toujours aucun rôle (`hr/stand-in.ts`, §118.185) : ce siège ne se
 * délègue pas.
 */
const ROLES_CENTRE_AD_PRO: readonly string[] = ["SUPER_ADMIN", "GENERAL_MANAGER"];

export function siegeAuCentreAdPro(user: { role: string; secondaryRole?: string | null }): boolean {
  return ROLES_CENTRE_AD_PRO.includes(user.role) || (user.secondaryRole != null && ROLES_CENTRE_AD_PRO.includes(user.secondaryRole));
}

/**
 * LE REFUS, ÉCRIT UNE SEULE FOIS.
 *
 * Écran, action, outil et lecteur disent la même phrase. Trois copies d'un refus finissent par
 * en faire trois refus différents, et deux d'entre eux seront faux le jour où le siège change
 * (§118.5, §104.17). Il NOMME qui siège — un refus qui ne dit pas à qui s'adresser fait chercher.
 */
export const REFUS_CENTRE_AD_PRO =
  "Le centre de validation Ad & Pro est réservé à la Direction Générale et au Super Admin : "
  + "ce sont eux qui arbitrent les demandes au-dessus du seuil et valident tout bon de commande né d'Ad & Pro, "
  + "et qui règlent ce seuil.";

/**
 * LE REFUS D'UN VISA DE BON DE COMMANDE — la même garde, dite pour ce geste-là.
 *
 * Celui qui cliquait « Viser le BC » depuis la fiche d'un sponsoring le faisait jusqu'ici au titre
 * de la Direction (vue globale, ou VALIDATE sur le module). Depuis la décision de la Direction
 * (09/2026, §118.148), le visa appartient au CENTRE : le refus le dit, et nomme qui y siège.
 */
export const REFUS_BC_CENTRE_AD_PRO =
  "Un bon de commande né d'Ad & Pro se valide au centre de validation Ad & Pro : la Direction "
  + "Générale ou le Super Admin (décision de la Direction, 09/2026).";

/** Par quelle porte une nature Ad & Pro passe-t-elle au-dessus du seuil ? */
/**
 * `TOTAL_DG` (Direction, 27/10/2026) : le TOTAL des postes d'une demande dépasse le seuil et attend la
 * validation du DG (`ad-pro/porte-dg.ts`). Comme une étape de circuit, il se décide DEVANT LE DOSSIER.
 */
export type FormePorte = "ETAPE_CIRCUIT" | "ETAPE_PROMO" | "VISA_CENTRE" | "TOTAL_DG";

/**
 * LES BONS DE COMMANDE AU CENTRE (§118.148) — un axe DISTINCT des portes de demande.
 *
 * `FormePorte` dit par quelle porte une DEMANDE franchit le seuil ; un bon de commande, lui, passe
 * au centre selon le SEUIL DES BONS DE COMMANDE (§118.149 — 0 par défaut, donc « tous les BC »,
 * jusqu'à ce que la Direction fixe un montant). Trois formes,
 * parce que le BC d'Ad & Pro existe sous trois formes et qu'on le lit là où il vit :
 *
 *   • `BC_POSTE`  — la demande de BC d'un POSTE (`AdProItem.orderStage = REQUESTED`) : le centre
 *     vise la demande (prestataire, montant accordé, imputation) avant que la pièce n'existe ;
 *   • `BC_LEGAL`  — une pièce BC du registre Legal née d'Ad & Pro (`AdProGateVisa` sur
 *     `LEGAL_DOCUMENT`) : le centre valide le DOCUMENT ;
 *   • `BC_PROMO`  — le BC d'un dossier de matériel promotionnel de l'ANCIEN parcours, qui
 *     attendait la validation des Finances (`status = BC_FINANCE_REVIEW`).
 *
 * Les deux premières se décident DANS le centre — un BC se juge sur sa ligne (prestataire,
 * montant, imputation, message) ; la troisième depuis sa fiche, où vivent ses pièces.
 */
export type FormeBC = "BC_POSTE" | "BC_LEGAL" | "BC_PROMO";

/** Cette forme est-elle celle d'un bon de commande ? */
export function estFormeBC(forme: FormePorte | FormeBC): forme is FormeBC {
  return forme === "BC_POSTE" || forme === "BC_LEGAL" || forme === "BC_PROMO";
}

/**
 * LA PORTE DE CHAQUE NATURE — exhaustif par construction.
 *
 * `Record<AdProKind, …>` : une nature ajoutée au registre canonique sans porte déclarée fait
 * échouer le TYPECHECK ici. C'est la seule chose qui garantit que « toute demande au-dessus du
 * seuil passe par le centre » reste vrai demain (§118.130) — une liste écrite à la main serait
 * fausse au premier ajout, en silence (§118.73).
 */
export const FORME_PORTE: Record<AdProKind, FormePorte> = {
  SPONSORING: "ETAPE_CIRCUIT",
  CONGRESS_INTERNATIONAL: "ETAPE_CIRCUIT",
  CONGRESS_NATIONAL: "ETAPE_CIRCUIT",
  EVENT: "ETAPE_CIRCUIT",
  PROMO_MATERIAL: "ETAPE_PROMO",
  // Ces deux-là n'avaient AUCUNE porte avant ce lot : mesuré sur leurs machines à états
  // (`ConsultingState`, `AdProOtherStatus`), rien n'y consultait le seuil.
  CONSULTING: "VISA_CENTRE",
  OTHER: "VISA_CENTRE",
};

/** Les natures qui passent par le VISA du centre — dérivé, jamais recopié. */
export const NATURES_A_VISA: AdProKind[] = AD_PRO_KINDS
  .map((k) => k.kind)
  .filter((k) => FORME_PORTE[k] === "VISA_CENTRE");

/** L'état d'un visa. `null` en base = la porte n'a jamais été évaluée pour cette demande. */
/**
 * `CHANGES_REQUESTED` (audit 360°, R07/R10) : le centre RENVOIE pour correction au lieu de refuser
 * définitivement. La demande ne passe pas — elle revient au centre quand son demandeur la resoumet.
 */
export type EtatVisa = "PENDING" | "APPROVED" | "REFUSED" | "CHANGES_REQUESTED";

/**
 * LA DEMANDE PEUT-ELLE AVANCER ? — la garde que les deux natures à visa appellent AVANT de
 * trancher.
 *
 * Elle répond sur ce qu'elle LIT, et son défaut est le plus sûr : un visa en attente BLOQUE.
 * Un visa absent (`null`) ne bloque PAS — sinon toutes les demandes déjà en base, créées avant
 * ce lot, se seraient arrêtées net sans que personne ait rien décidé, et la migration aurait
 * gelé le module au déploiement. C'est la porte de CRÉATION qui pose le visa (§118.138 : « par
 * quels chemins peut-on ARRIVER sur une étape conditionnelle ? »).
 */
export function visaAutoriseAAvancer(visa: EtatVisa | null | undefined): boolean {
  // Écrite comme ce qui PASSE, pas comme ce qui bloque : un état ajouté demain arrête la demande
  // par défaut, au lieu de la laisser filer parce que personne n'a pensé à l'exclure.
  return visa == null || visa === "APPROVED";
}

/**
 * CE QUE LE BLOCAGE DIT À CELUI QUI LE RENCONTRE — avec le geste qui le lève.
 *
 * Un refus qui nomme la faute sans nommer le remède fait payer un aller-retour (§118.30). Ici le
 * remède n'est pas un geste du demandeur : c'est une décision qui revient à quelqu'un d'autre, et
 * le dire est la seule chose utile.
 */
export function motifBlocageVisa(visa: EtatVisa | null | undefined): string | null {
  if (visa === "PENDING") {
    return "Cette demande dépasse le seuil Ad & Pro : elle attend l'arbitrage du centre de "
      + "validation (Direction Générale ou Super Admin). Rien à faire de votre côté.";
  }
  if (visa === "CHANGES_REQUESTED") {
    return "Le centre de validation Ad & Pro demande une correction (le motif est sur la fiche) : son demandeur "
      + "la corrige puis la resoumet au centre depuis la fiche — elle ne peut pas avancer d'ici là.";
  }
  if (visa === "REFUSED") {
    return "Le centre de validation Ad & Pro a refusé cette demande : elle ne peut plus avancer, sauf si un siège "
      + "du centre la réexamine. Le motif est consigné sur la fiche.";
  }
  return null;
}

/** Une ligne du centre, toutes natures confondues. */
export interface LigneCentre {
  /**
   * La nature Ad & Pro de la demande. `null` pour un bon de commande du registre Legal dont la
   * fiche d'origine n'est pas une nature (un poste, une demande de pièce) : on ne devine pas.
   */
  kind: AdProKind | null;
  /** Type d'entité du registre commun — ce qui permet d'agir sans deviner la table. */
  entityType: string;
  entityId: string;
  reference: string | null;
  intitule: string;
  demandeur: string | null;
  /** Le budget TOTAL de la demande, celui que le seuil compare. `null` = non renseigné. */
  montant: number | null;
  /**
   * Le seuil en vigueur pour cette ligne (celui du visa s'il en porte un, sinon le réglage).
   * `null` sur un bon de commande : sa porte suit le seuil des BC EN VIGUEUR, relu à chaque
   * aiguillage (§118.149) — rien n'est figé sur la ligne.
   */
  seuil: number | null;
  forme: FormePorte | FormeBC;
  /** Ce que la ligne dit en plus, quand il y a quelque chose à dire (le message d'une demande de BC). */
  detail?: string | null;
  /**
   * Le PRESTATAIRE d'un BC de poste, tel que le centre le lit — renvoyé avec le visa pour que l'action
   * refuse un visa donné sur un prestataire qui a changé pendant la lecture (§118.187).
   */
  prestataire?: string | null;
  /** Depuis quand elle attend — c'est ce qui trie. */
  depuis: string;
  href: string;
}

/**
 * L'ORDRE DU CENTRE — la plus vieille en tête.
 *
 * Pas la plus grosse : un dossier de 8 M vu ce matin n'est pas plus urgent qu'un dossier de 1,1 M
 * qui dort depuis onze jours, et c'est celui qui dort qui bloque quelqu'un. Le montant reste
 * affiché sur chaque ligne — il sert à DÉCIDER, pas à classer.
 */
export function trierCentre(rows: readonly LigneCentre[]): LigneCentre[] {
  return [...rows].sort((a, b) => a.depuis.localeCompare(b.depuis));
}

export interface CompteursCentre {
  /** Tout ce qui attend une décision du centre. */
  enAttente: number;
  /** Qui dort depuis plus de `DORMANTES_JOURS` — le chiffre qu'on regarde en premier. */
  dormantes: number;
  /**
   * Le total engagé par les DEMANDES qui attendent. Les montants inconnus n'y entrent pas (voir
   * plus bas), et les bons de commande non plus : le BC d'un poste est une part d'une enveloppe
   * déjà accordée — l'ajouter au total des demandes compterait deux fois le même argent.
   */
  montantTotal: number;
  /** Combien de lignes n'ont PAS de montant : sans ce compte, le total se lirait comme exhaustif. */
  sansMontant: number;
  /** Les bons de commande qui attendent, comptés à part pour la raison ci-dessus. */
  bonsDeCommande: number;
}

const DORMANTES_JOURS = 7;

/**
 * LES COMPTEURS — et la moitié qui compte est `sansMontant`.
 *
 * Additionner les montants connus et afficher la somme comme « total engagé » serait une coupe
 * silencieuse : le lecteur croit voir l'engagement total, il en voit une partie (§118.60). Le
 * nombre de lignes sans montant voyage donc avec le total, et l'écran le DIT.
 */
export function compteursCentre(rows: readonly LigneCentre[], maintenant: Date): CompteursCentre {
  const jours = (iso: string) =>
    Math.floor((maintenant.getTime() - new Date(iso).getTime()) / 86_400_000);
  const demandes = rows.filter((r) => !estFormeBC(r.forme));
  return {
    enAttente: rows.length,
    dormantes: rows.filter((r) => jours(r.depuis) >= DORMANTES_JOURS).length,
    montantTotal: demandes.reduce((t, r) => t + (r.montant != null && r.montant > 0 ? r.montant : 0), 0),
    sansMontant: demandes.filter((r) => r.montant == null || !(r.montant > 0)).length,
    bonsDeCommande: rows.length - demandes.length,
  };
}
