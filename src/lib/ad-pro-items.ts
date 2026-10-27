import type { AdProItemKind, AdProItemStatus, AdProItemBudgetKind, AdProItemOrderStage } from "@prisma/client";
import { refusFichesPersonnes } from "@/lib/ad-pro/hebergements";

/**
 * POSTES D'UNE OPÉRATION AD & PRO — la ventilation de l'enveloppe.
 *
 * Sert le **sponsoring** et les **prises en charge nationales** : la question posée est la même (de quoi
 * est fait le montant, et à qui va l'argent), la réponse doit donc l'être aussi. Deux
 * implémentations parallèles finiraient par diverger sur un détail qui compte — un garde-fou
 * financier corrigé d'un côté et pas de l'autre.
 *
 * Ce fichier ne contient QUE des fonctions pures : il est importé par des composants client
 * (l'écran de ventilation) autant que par le serveur. Rien qui lise un fichier ou la base —
 * sans quoi la compilation de production échouerait sur un `fs` introuvable.
 */

/**
 * Les opérations Ad & Pro qui portent des postes — les quatre du pôle, plus la demande « autre »
 * depuis le 27/10/2026 (elle suit le même circuit : prévalidation, postes, DG sur le total).
 *
 * LA VALEUR D'UN PARENT EST SON `EntityType` (`AD_PRO_OTHER`, pas `OTHER`) : le moteur et la porte du
 * DG comparent et stockent le parent comme un type d'entité (`AdProPorteDg.entityType`).
 */
export type AdProParent = "SPONSORING" | "CONGRESS_NATIONAL" | "CONGRESS_INTERNATIONAL" | "EVENT" | "AD_PRO_OTHER";

export const AD_PRO_PARENTS: AdProParent[] = ["SPONSORING", "CONGRESS_NATIONAL", "CONGRESS_INTERNATIONAL", "EVENT", "AD_PRO_OTHER"];

/**
 * LA COLONNE DE CHAQUE PARENT, et l'ENTITÉ qu'elle désigne.
 *
 * `AdProItem` porte CINQ clés étrangères nullables, dont exactement une est renseignée
 * (contrainte `AdProItem_one_parent`). Quatre désignent une opération du pôle ; la cinquième,
 * `trainingId`, est une colonne DORMANTE — recensé, elle n'a AUCUN lecteur dans le dépôt, les
 * postes d'une formation n'existant pas encore.
 */
export const PARENT_COLONNE: Record<AdProParent, "sponsoringId" | "congressNationalId" | "congressInternationalId" | "eventId" | "otherRequestId"> = {
  SPONSORING: "sponsoringId",
  CONGRESS_NATIONAL: "congressNationalId",
  CONGRESS_INTERNATIONAL: "congressInternationalId",
  EVENT: "eventId",
  AD_PRO_OTHER: "otherRequestId",
};

/** Le type d'entité de chaque parent — c'est LUI qui porte les droits, jamais le poste. */
export const PARENT_ENTITE: Record<AdProParent, "SPONSORING" | "CONGRESS_NATIONAL" | "CONGRESS_INTERNATIONAL" | "EVENT" | "AD_PRO_OTHER"> = {
  SPONSORING: "SPONSORING",
  CONGRESS_NATIONAL: "CONGRESS_NATIONAL",
  CONGRESS_INTERNATIONAL: "CONGRESS_INTERNATIONAL",
  EVENT: "EVENT",
  AD_PRO_OTHER: "AD_PRO_OTHER",
};

/** Les cinq clés étrangères d'un poste, telles qu'elles sortent de la base. */
export interface ColonnesParent {
  sponsoringId?: string | null;
  congressNationalId?: string | null;
  congressInternationalId?: string | null;
  eventId?: string | null;
  otherRequestId?: string | null;
  trainingId?: string | null;
}

/**
 * DE QUI CE POSTE DÉPEND-IL ? — la question que l'accès doit poser, et la seule.
 *
 * Un poste n'a pas de droits à lui : il n'existe que porté par une opération, et c'est cette
 * opération qui dit qui peut la voir, y joindre une pièce, la commenter. Le rattacher à un
 * MODULE écrit à la main serait une devinette — mesuré, c'en était une : `ENTITY_MODULE`
 * annonçait `SPONSORING` pour TOUS les postes, or le délégué médical et le manager promotion
 * médicale — les deux auteurs typiques d'un événement ou d'un congrès national — n'ont PAS ce
 * module. Ils ne pouvaient donc rien joindre au poste de LEUR propre demande.
 *
 * On rend `null` sur tout ce qui ne se lit pas à coup sûr : aucun parent (donnée impossible que
 * la contrainte interdit), plusieurs parents (idem), ou le parent DORMANT `trainingId`, dont
 * aucune entité du registre ne porte les droits. Rendre un parent plausible ferait juger l'accès
 * d'un poste sur une opération qui n'est pas la sienne (§104.7).
 */
export function parentDuPoste(c: ColonnesParent): { parent: AdProParent; id: string } | null {
  const trouves = AD_PRO_PARENTS
    .map((p) => ({ parent: p, id: c[PARENT_COLONNE[p]] ?? null }))
    .filter((x): x is { parent: AdProParent; id: string } => Boolean(x.id));
  if (trouves.length !== 1) return null;
  // Un poste rattaché À LA FOIS à une opération et à une formation n'est pas « une opération
  // avec un détail en plus » : c'est une donnée qu'on ne sait pas lire.
  if (c.trainingId) return null;
  return trouves[0];
}

/** Libellés métier. `PROMO_MATERIAL` est distingué : il renvoie vers un autre circuit. */
export const ITEM_KIND_LABELS: Record<AdProItemKind, string> = {
  STAND: "Stand",
  SYMPOSIUM: "Symposium",
  PROMO_MATERIAL: "Matériel promotionnel",
  // LE SPONSORING, DIRECT OU INDIRECT (§118.151) — la nature que la Direction fait préciser à la
  // création, et que le poste créé avec la demande porte. Direct : l'argent va à l'association.
  // Indirect : la société prend en charge des prestations ou des médecins.
  ASSOCIATION_SUPPORT: "Sponsoring direct (association)",
  INDIRECT_SUPPORT: "Sponsoring indirect (prise en charge)",
  SERVICE: "Prestation",
  // L'IMPRIMERIE (§118.175) : l'impression payée à un imprimeur — l'une des natures d'un
  // sponsoring indirect. Le matériel promotionnel, lui, a son propre circuit (visa, BAT).
  PRINTING: "Imprimerie",
  CONSULTING: "Consulting",
  CATERING: "Traiteur",
  DINNER: "Prise en charge des dîners",
  VENUE: "Location de salle",
  ACCOMMODATION: "Prise en charge de l'hôtellerie",
  TICKETING: "Prise en charge de la billetterie",
  // « Déplacement / hébergement » jusqu'ici : l'hôtellerie ayant sa propre nature, ce libellé
  // annonçait une chose que la nature d'à côté fait désormais — une prose qui contredit le code
  // est pire que pas de prose (§118.112b).
  TRAVEL: "Déplacement",
  // LE MATÉRIEL DU STOCK (§118.167) — pris au magasin central, réservé à l'accord, confirmé après.
  STOCK_MATERIAL: "Matériel du stock",
  OTHER: "Autre",
};

/**
 * ORDRE D'AFFICHAGE — ce qui coûte le plus cher et se décide en premier, en tête.
 *
 * CETTE LISTE EST ÉCRITE À LA MAIN, et c'est pour cela qu'un cliquet la garde
 * (`ad-pro-items.test.ts`) : `ITEM_KIND_LABELS` est un `Record<AdProItemKind, …>`, donc une
 * nature ajoutée à l'énumération sans libellé NE COMPILE PAS. L'ordre, lui, est un simple
 * tableau : une nature ajoutée sans y figurer compile parfaitement et devient INVISIBLE dans le
 * menu de saisie, en silence. Le test exige donc que les deux portent exactement le même
 * ensemble (§118.130).
 */
export const ITEM_KINDS: AdProItemKind[] = [
  "STAND", "SYMPOSIUM", "PROMO_MATERIAL", "PRINTING", "ASSOCIATION_SUPPORT", "INDIRECT_SUPPORT", "VENUE", "CATERING", "DINNER",
  "ACCOMMODATION", "TICKETING", "CONSULTING", "SERVICE", "TRAVEL", "STOCK_MATERIAL", "OTHER",
];

export const ITEM_STATUS_LABELS: Record<AdProItemStatus, { label: string; tone: "neutral" | "info" | "warning" | "success" | "danger" }> = {
  DRAFT: { label: "Brouillon", tone: "neutral" },
  PENDING: { label: "En attente de la Direction", tone: "info" },
  REVISION: { label: "Budget à revoir", tone: "warning" },
  APPROVED: { label: "Accordé", tone: "success" },
  REJECTED: { label: "Refusé", tone: "danger" },
};

export const ITEM_BUDGET_KIND_LABELS: Record<AdProItemBudgetKind, string> = {
  INCLUDED: "Inclus dans le budget accordé",
  ADDITIONAL: "Budget supplémentaire",
};

export const ITEM_ORDER_STAGE_LABELS: Record<AdProItemOrderStage, { label: string; tone: "neutral" | "info" | "warning" | "success" | "danger" }> = {
  NONE: { label: "Aucun bon de commande", tone: "neutral" },
  // `DIRECTION_OK` garde son nom de colonne ; depuis §118.148 c'est le CENTRE qui le pose.
  REQUESTED: { label: "BC demandé — au centre de validation Ad & Pro", tone: "info" },
  DIRECTION_OK: { label: "BC validé par le centre — en attente des Finances", tone: "warning" },
  ISSUED: { label: "Bon de commande émis", tone: "success" },
  REFUSED: { label: "BC refusé par le centre", tone: "danger" },
};

/**
 * Un poste passé aux Finances SOUS le seuil des bons de commande (§118.149) porte le même
 * `DIRECTION_OK` qu'un poste visé — mais aucun centre ne l'a vu, et le badge ne doit pas le dire.
 */
export const LIBELLE_BC_SOUS_LE_SEUIL = "BC sous le seuil — en attente des Finances";

export interface ItemAmounts {
  amountEstimated?: number | null;
  amountGranted?: number | null;
  addedAfterDecision?: boolean;
  /** Un poste REFUSÉ ne pèse plus rien ; un poste supplémentaire ne pèse pas sur l'enveloppe. */
  status?: AdProItemStatus;
  budgetKind?: AdProItemBudgetKind;
}

export interface Breakdown {
  /** Ce que la Direction a accordé. `null` tant qu'elle n'a pas tranché. */
  envelopeDzd: number | null;
  /** Somme des estimations du demandeur — sert avant décision. */
  estimatedDzd: number;
  /** Somme des montants affectés aux postes. */
  allocatedDzd: number;
  /** Reste à affecter (0 si l'enveloppe est entièrement ventilée ou dépassée). */
  unallocatedDzd: number;
  /** Ce qui dépasse l'enveloppe accordée. C'est CE chiffre qu'il faut montrer, pas cacher. */
  overrunDzd: number;
  /** La ventilation tombe juste : ni reste, ni dépassement. */
  balanced: boolean;
  /** Au moins un poste a été ajouté après la décision — explique un éventuel dépassement. */
  hasLateAdditions: boolean;
  itemCount: number;
  /**
   * Postes demandés EN PLUS de l'enveloppe (rallonge). Comptés à part : les mêler au reste
   * ferait passer une rallonge assumée pour un dépassement subi — deux situations qui
   * n'appellent pas la même décision.
   */
  additionalDzd: number;
  /** Postes encore soumis à la Direction (ni accordés ni refusés) — l'argent n'est pas arbitré. */
  pendingDzd: number;
  /** Total engagé si tout était accordé : enveloppe ventilée + rallonges demandées. */
  totalRequestedDzd: number;
}

const sum = (xs: (number | null | undefined)[]): number =>
  xs.reduce<number>((a, x) => a + (typeof x === "number" && Number.isFinite(x) ? x : 0), 0);

/** Arrondi au centime — les décimaux flottants ne doivent pas faire apparaître un écart fantôme. */
const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * L'état de la ventilation, tel qu'il sera affiché.
 *
 * La règle métier retenue : la Direction accorde **un montant global**, les postes se le
 * répartissent. Mais un poste peut être ajouté **après** la décision (on découvre qu'il faut un
 * stand) — c'est autorisé et simplement tracé. La ventilation peut donc légitimement dépasser
 * l'enveloppe : on ne bloque pas, on **affiche le dépassement**. Un dépassement caché est un
 * dépassement qu'on découvre à la facture.
 *
 * Fonction PURE — testée.
 */
export function breakdown(items: ItemAmounts[], amountGranted: number | null | undefined): Breakdown {
  const envelopeDzd = typeof amountGranted === "number" && Number.isFinite(amountGranted) ? amountGranted : null;

  // Un poste REFUSÉ ne pèse plus sur rien : le garder dans les totaux ferait porter à l'opération
  // le poids d'une dépense que la Direction a précisément écartée.
  const live = items.filter((i) => i.status !== "REJECTED");
  const additional = live.filter((i) => i.budgetKind === "ADDITIONAL");
  const included = live.filter((i) => i.budgetKind !== "ADDITIONAL");

  const estimatedDzd = round2(sum(live.map((i) => i.amountEstimated)));
  // La ventilation de l'ENVELOPPE ne compte que les postes qui s'y imputent : un poste
  // « supplémentaire » est une RALLONGE demandée, pas une part du montant déjà accordé.
  const allocatedDzd = round2(sum(included.map((i) => i.amountGranted)));
  const additionalDzd = round2(sum(additional.map((i) => i.amountGranted ?? i.amountEstimated)));
  const pendingDzd = round2(sum(live.filter((i) => i.status === "PENDING" || i.status === "REVISION").map((i) => i.amountGranted ?? i.amountEstimated)));

  const diff = envelopeDzd == null ? 0 : round2(envelopeDzd - allocatedDzd);
  const unallocatedDzd = diff > 0 ? diff : 0;
  const overrunDzd = diff < 0 ? -diff : 0;

  return {
    envelopeDzd,
    estimatedDzd,
    allocatedDzd,
    unallocatedDzd,
    overrunDzd,
    // Sans enveloppe, rien n'est « équilibré » : il n'y a pas encore de cible.
    balanced: envelopeDzd != null && unallocatedDzd === 0 && overrunDzd === 0 && live.length > 0,
    hasLateAdditions: live.some((i) => i.addedAfterDecision === true),
    itemCount: live.length,
    additionalDzd,
    pendingDzd,
    totalRequestedDzd: round2(allocatedDzd + additionalDzd),
  };
}

// ───────────────────────────── Cycle de validation d'un poste ─────────────────────────────

/**
 * Un poste peut-il PARTIR EN VALIDATION ? On ne soumet ni un poste vide de chiffre (la Direction
 * déciderait sur rien), ni un poste déjà tranché. Un poste en RÉVISION se resoumet — c'est tout
 * l'intérêt de l'aller-retour. Fonction PURE — testée.
 */
export function canSubmitItem(item: {
  status: AdProItemStatus;
  amountEstimated?: number | null;
  amountGranted?: number | null;
  /** La nature : un poste « Matériel du stock » n'engage pas d'argent (§118.167). */
  kind?: AdProItemKind;
  /** Combien d'articles du stock il liste — c'est eux, pas un montant, qui se décident. */
  lignesStock?: number;
  /**
   * Combien de FICHES PERSONNES le poste porte — voyageurs d'une billetterie, fiches hôtellerie
   * d'une hôtellerie (Direction, 06/10). `undefined` = non compté par l'appelant : pas de refus.
   */
  fichesPersonnes?: number;
  /** Le poste vit dans un sponsoring INDIRECT : les fiches par personne y sont facultatives. */
  priseEnChargeIndirecte?: boolean;
}): { ok: boolean; reason?: string } {
  if (item.status === "PENDING") return { ok: false, reason: "Ce poste est déjà en attente de la Direction." };
  if (item.status === "APPROVED") return { ok: false, reason: "Ce poste est déjà accordé." };
  if (item.kind === "STOCK_MATERIAL") {
    return (item.lignesStock ?? 0) > 0
      ? { ok: true }
      : { ok: false, reason: "Ajoutez au moins un article du stock (et sa quantité) avant de soumettre ce poste." };
  }
  // UN SPONSORING INDIRECT SE RÉPARTIT D'ABORD PAR NATURE (§118.175) : « 1 000 000 DZD répartis en
  // 400 000 d'imprimerie et 600 000 d'hôtellerie ». L'imprimeur et l'hôtel sont deux fournisseurs,
  // deux BC, deux paiements — un poste « sponsoring indirect » d'un seul tenant ne pourrait en payer
  // qu'un. Le refus NOMME le geste qui le lève, parce qu'un refus sans remède fait chercher.
  if (item.kind === "INDIRECT_SUPPORT") {
    return { ok: false, reason: REFUS_INDIRECT_NON_REPARTI };
  }
  const amount = item.amountGranted ?? item.amountEstimated;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
    return { ok: false, reason: "Chiffrez le poste (montant estimé) avant de le soumettre." };
  }
  // UNE FICHE PAR PERSONNE (Direction, 06/10) : une billetterie sans voyageur, une hôtellerie sans
  // fiche hôtellerie ne se soumettent pas — sauf en sponsoring indirect, où elles restent facultatives.
  if (item.kind) {
    const fiches = refusFichesPersonnes({ kind: item.kind, fichesPersonnes: item.fichesPersonnes, priseEnChargeIndirecte: item.priseEnChargeIndirecte });
    if (fiches) return { ok: false, reason: fiches };
  }
  return { ok: true };
}

/** La phrase du refus — lue par l'action, l'écran et leurs bancs : une seule rédaction. */
export const REFUS_INDIRECT_NON_REPARTI =
  "Répartissez d'abord ce sponsoring indirect par nature (« Répartir par nature » : imprimerie, hôtellerie, billetterie…) — "
  + "chaque nature devient un poste qui se valide, se commande et se paie à part.";

/**
 * Une demande d'ÉMISSION DE BON DE COMMANDE ne se fait que sur un poste ACCORDÉ, CHIFFRÉ, dont
 * le budget a été choisi, et une seule fois — sauf refus, qui rouvre le droit de redemander.
 * Fonction PURE — testée.
 */
export function canRequestPurchaseOrder(item: {
  status: AdProItemStatus;
  amountGranted?: number | null;
  budgetCategoryId?: string | null;
  orderStage: AdProItemOrderStage;
}): { ok: boolean; reason?: string } {
  if (item.status !== "APPROVED") return { ok: false, reason: "Le poste doit d'abord être accordé par la Direction." };
  const amount = item.amountGranted;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
    return { ok: false, reason: "Affectez d'abord un montant à ce poste." };
  }
  if (!item.budgetCategoryId) return { ok: false, reason: "Choisissez d'abord le budget (enveloppe) qui portera ce poste." };
  if (item.orderStage === "REQUESTED" || item.orderStage === "DIRECTION_OK") {
    return { ok: false, reason: "Une demande d'émission est déjà en cours." };
  }
  if (item.orderStage === "ISSUED") return { ok: false, reason: "Le bon de commande de ce poste a déjà été émis." };
  return { ok: true };
}

/**
 * CE QUI EST ANNONCÉ MAIS QUE PERSONNE N'A CHIFFRÉ.
 *
 * Un congrès déclare `hasBooth` / `hasSymposium` : on sait donc qu'il y aura un stand ou un
 * symposium. Ces intentions n'ont jamais porté d'argent — on annonçait un stand et le budget
 * n'en disait pas un mot. Le rapprochement est le seul endroit où l'écart devient visible avant
 * la facture.
 *
 * Ce n'est pas un blocage : un stand peut être offert par l'organisateur. C'est une question
 * posée à la bonne personne au bon moment. Fonction PURE — testée.
 */
export interface PlannedGaps {
  boothUnbudgeted: boolean;
  symposiumUnbudgeted: boolean;
  any: boolean;
}

export function plannedGaps(
  items: { kind: AdProItemKind }[],
  plan: { hasBooth?: boolean | null; hasSymposium?: boolean | null },
): PlannedGaps {
  const has = (k: AdProItemKind) => items.some((i) => i.kind === k);
  const boothUnbudgeted = plan.hasBooth === true && !has("STAND");
  const symposiumUnbudgeted = plan.hasSymposium === true && !has("SYMPOSIUM");
  return { boothUnbudgeted, symposiumUnbudgeted, any: boothUnbudgeted || symposiumUnbudgeted };
}

/**
 * Un poste peut-il émettre son ordre de dépense ?
 *
 * Trois conditions, et elles sont toutes des garde-fous financiers : le sponsoring doit être
 * **accordé** (on ne paie pas ce qui n'est pas décidé), le poste doit porter un **montant**
 * (on ne paie pas un chiffre vide), et il ne doit pas **déjà** avoir sa pièce (on ne paie pas
 * deux fois). Fonction PURE — testée.
 */
export function canEmitOrder(
  item: { amountGranted?: number | null; expenseOrderId?: string | null; status?: AdProItemStatus },
  sponsoringDecided: boolean,
): { ok: boolean; reason?: string } {
  if (item.expenseOrderId) return { ok: false, reason: "Un ordre de dépense a déjà été émis pour ce poste." };
  if (!sponsoringDecided) return { ok: false, reason: "L'opération n'a pas encore été accordée." };
  // Depuis que chaque poste se valide à part, un poste refusé ou encore en attente ne se paie
  // pas — même si l'opération, elle, est accordée.
  if (item.status && item.status !== "APPROVED") {
    return { ok: false, reason: "Ce poste n'a pas été accordé par la Direction." };
  }
  const amount = item.amountGranted;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
    return { ok: false, reason: "Affectez d'abord un montant à ce poste." };
  }
  return { ok: true };
}

/**
 * RETIRER UN POSTE — trois situations, trois réponses différentes.
 *
 * Refuser purement et simplement dès qu'un ordre de dépense existait créait une impasse : un
 * poste émis par erreur (mauvais fournisseur, doublon) restait à l'écran pour toujours. Mais
 * l'effacer en silence laisserait une pièce comptable pointant vers rien.
 *
 *   • aucun ordre parti → on retire, sans cérémonie ;
 *   • un ordre émis, non réglé → seule la DIRECTION retire, et l'ordre est ANNULÉ avec ;
 *   • un ordre RÉGLÉ → jamais : le poste justifie un paiement réellement sorti.
 *
 * Fonction PURE — testée, et partagée par le bouton et l'action serveur pour que l'écran ne
 * propose jamais ce que le serveur refusera.
 */
export function canRemoveItem(
  item: { expenseOrderId?: string | null; expenseOrderStatus?: string | null },
  viewer: { canAllocate: boolean },
): { ok: boolean; reason?: string } {
  if (!item.expenseOrderId) return { ok: true };
  if (item.expenseOrderStatus === "PAID") {
    return { ok: false, reason: "L'ordre de dépense est déjà réglé : le poste justifie un paiement, il ne peut plus être retiré." };
  }
  if (!viewer.canAllocate) {
    return { ok: false, reason: "Un ordre de dépense a été émis : seule la Direction peut retirer ce poste (l'ordre sera annulé)." };
  }
  return { ok: true };
}

/**
 * La NATURE DE BUDGET (inclus / rallonge) est-elle encore modifiable ?
 *
 * C'est ce sur quoi la Direction s'est prononcée : la changer après coup réécrirait sa
 * décision. Tout le reste du poste — libellé, fournisseur, précisions, estimation — se corrige
 * à tout moment, parce que ces champs DÉCRIVENT la dépense sans l'engager.
 */
export function budgetKindLocked(item: { status: AdProItemStatus }): boolean {
  return item.status === "APPROVED" || item.status === "REJECTED";
}
