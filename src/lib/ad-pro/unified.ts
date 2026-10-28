/**
 * AD & PRO — UNE SEULE DEMANDE.
 *
 * Sponsoring, prises en charge, événement, matériel promotionnel, consulting, et tout le reste :
 * autant d'écrans, autant de listes, autant de boutons « nouvelle demande ». Pour celui qui
 * demande, ce sont pourtant autant de façons de poser la MÊME question — « je veux engager une
 * dépense de promotion, voici pour qui et pour quoi ». Lui faire choisir d'abord le bon écran,
 * c'est lui demander de connaître notre découpage interne avant de pouvoir formuler son besoin.
 *
 * On unifie donc l'ENTRÉE et la LECTURE, pas le stockage. Chaque nature garde son modèle, ses
 * champs propres et son circuit : un congrès international a des billets et des visas qu'un
 * sponsoring n'a pas, et les fondre dans une table commune reviendrait à perdre ce qui fait leur
 * spécificité — ou à fabriquer une table de cinquante colonnes dont quarante sont vides.
 *
 * Ce que ce module apporte : un vocabulaire commun (l'ÉTAT d'une demande, quelle que soit sa
 * nature) et la liste unifiée. Chaque ligne renvoie vers son écran d'origine, qui reste maître.
 *
 * Module PUR — testé. Le seul import est un import de TYPE (effacé à la compilation).
 */

import type { EntityType } from "@prisma/client";
import type { Module } from "@/lib/rbac";

export type AdProKind =
  | "SPONSORING" | "CONGRESS_INTERNATIONAL" | "CONGRESS_NATIONAL" | "EVENT" | "PROMO_MATERIAL"
  | "CONSULTING" | "OTHER";

/**
 * LA NATURE Ad&Pro → LE TYPE D'ENTITÉ DU REGISTRE COMMUN.
 *
 * Cinq des sept noms coïncident, et c'est précisément ce qui rend la table nécessaire : deux
 * ne coïncident PAS (`CONSULTING` s'appelle `CONSULTING_CONTRACT` dans le registre, `OTHER`
 * s'appelle `AD_PRO_OTHER`), et un appelant qui « devine » en recopiant le nom se trompera sur
 * ces deux-là seulement — c'est-à-dire là où l'erreur ne se voit pas en relisant.
 *
 * `Record<AdProKind, …>` sans valeur optionnelle : une huitième nature ajoutée à `AdProKind`
 * fait échouer le typecheck ICI, au lieu de partager un dossier sous un type d'entité faux.
 * L'import de type est effacé à la compilation — ce module reste PUR.
 */
export const AD_PRO_ENTITY_TYPE: Record<AdProKind, EntityType> = {
  SPONSORING: "SPONSORING",
  CONGRESS_INTERNATIONAL: "CONGRESS_INTERNATIONAL",
  CONGRESS_NATIONAL: "CONGRESS_NATIONAL",
  EVENT: "EVENT",
  PROMO_MATERIAL: "PROMO_MATERIAL",
  CONSULTING: "CONSULTING_CONTRACT",
  OTHER: "AD_PRO_OTHER",
};

/**
 * LES TYPES D'ENTITÉ QUI RATTACHENT UNE PIÈCE À AD & PRO — les sept natures, plus le POSTE d'une
 * opération, qui n'est pas une nature mais en fait partie. Dérivés du registre ci-dessus : une
 * huitième nature entre ici sans que personne y pense (§118.73).
 *
 * Trois lecteurs posaient cette question, et le troisième l'écrivait À LA MAIN : l'action qui
 * clôt une demande du secrétariat ne connaissait que CINQ natures, quand la page de la même
 * demande en lisait huit (§118.150). Sur un achat lié à un POSTE, la page masquait donc les
 * champs d'imputation — « déjà porté par l'opération » — et l'action refusait de terminer faute
 * de département : une impasse, sans une ligne d'erreur ailleurs que dans ce refus.
 */
export const TYPES_ENTITE_AD_PRO: ReadonlySet<string> = new Set<string>([
  ...Object.values(AD_PRO_ENTITY_TYPE),
  "AD_PRO_ITEM",
]);

/**
 * UNE DEMANDE DU SECRÉTARIAT DÉJÀ PORTÉE PAR SA FICHE — ne s'impute pas une seconde fois aux
 * moyens généraux d'un département.
 *
 * La question n'est PAS « est-ce de la promotion ? » mais « qui porte déjà cette dépense ? » : une
 * opération Ad & Pro par son enveloppe, un contrat de consulting par SES ordres de dépense. D'où
 * un contrat passé aux RH (§118.150) qui reste dans la liste — sa rémunération se paie toujours
 * par le contrat, et l'imputer à un département la compterait deux fois, exactement comme avant
 * le transfert. C'est la page ET l'action qui lisent cette fonction : deux lectures divergeraient,
 * et la divergence a déjà coûté une impasse.
 */
export function dejaPorteParSaFiche(linkedEntityType: string | null | undefined): boolean {
  return linkedEntityType != null && TYPES_ENTITE_AD_PRO.has(linkedEntityType);
}

export interface KindSpec {
  kind: AdProKind;
  label: string;
  /** Ce que la personne veut faire, dit dans ses mots — pas dans les nôtres. */
  hint: string;
  icon: string;
  /** Écran d'origine, qui reste maître du circuit et des champs propres. */
  href: string;
  /**
   * Lien direct vers le formulaire de cette nature, SUR SON ÉCRAN.
   *
   * Ce n'est plus le chemin d'Ad & Pro — « Nouvelle demande » y ouvre le formulaire sans quitter
   * l'écran. Il reste utile pour pointer quelqu'un droit sur le formulaire d'un module (un
   * message, un favori, un rappel). Le paramètre est retiré de l'URL à l'ouverture, pour qu'un
   * rafraîchissement ne rouvre pas le formulaire sans fin.
   */
  createHref: string;
  /**
   * Module RBAC qui gouverne cette nature.
   *
   * TYPÉ `Module` et non `string` : c'est ce qui fait de cette liste le registre canonique du
   * pôle Ad & Pro — un nom de module mal orthographié ne compile plus, et le cliquet de
   * permissions (`pole.test.ts`) peut s'y adosser sans redériver la liste ailleurs (§118.5).
   * L'import de TYPE est effacé à la compilation : ce module reste PUR, et `lib/rbac` est au
   * SOCLE, donc un domaine qui le lit ne traverse aucune frontière (`domains.ts`).
   */
  module: Module;
}

export const AD_PRO_KINDS: KindSpec[] = [
  {
    kind: "SPONSORING", label: "Sponsoring", icon: "HandCoins", href: "/sponsoring", module: "SPONSORING", createHref: "/sponsoring?new=1",
    hint: "Soutenir une manifestation, une association, un praticien qui nous sollicite.",
  },
  {
    kind: "CONGRESS_INTERNATIONAL", label: "Prise en charge internationale", icon: "Plane", href: "/congress-international", module: "CONGRESS_INTERNATIONAL", createHref: "/congress-international?new=1",
    hint: "Envoyer un praticien à un congrès à l'étranger — billets, visa, hébergement.",
  },
  {
    kind: "CONGRESS_NATIONAL", label: "Prise en charge nationale", icon: "MapPin", href: "/congress-national", module: "CONGRESS_NATIONAL", createHref: "/congress-national?new=1",
    hint: "Prendre en charge la participation à un congrès en Algérie.",
  },
  {
    kind: "EVENT", label: "Événement", icon: "PartyPopper", href: "/events", module: "EVENTS", createHref: "/events?new=1",
    hint: "Organiser une table ronde, une soirée scientifique, un atelier.",
  },
  {
    kind: "PROMO_MATERIAL", label: "Matériel promotionnel", icon: "Package", href: "/promo-material", module: "PROMO_MATERIAL", createHref: "/promo-material?new=1",
    hint: "Faire produire ou acheter une brochure, un présentoir, un objet : les articles se piochent dans le catalogue, et ce qui est reçu entre au stock.",
  },
  {
    kind: "CONSULTING", label: "Consulting", icon: "Handshake", href: "/consulting", module: "CONSULTING", createHref: "/consulting?new=1",
    hint: "Engager un consultant ou un cabinet : mission, rémunération, durée.",
  },
  {
    // LA CASE QUI MANQUAIT. Sans elle, une dépense de promotion inhabituelle se déclare
    // « en sponsoring » faute de mieux — et l'on perd à la fois la lisibilité du sponsoring et
    // la trace de la dépense.
    kind: "OTHER", label: "Autre", icon: "CircleEllipsis", href: "/ad-pro/autres", module: "AD_PRO_OTHER", createHref: "/ad-pro/autres?new=1",
    hint: "Tout ce qui n'entre dans aucune des natures ci-dessus.",
  },
];

/**
 * L'ÉTAT COMMUN — cinq mots, les mêmes pour toutes les natures.
 *
 * Chaque module a son propre vocabulaire (« CONSIDERED », « BC_FINANCE_REVIEW », « PRELIMINARY_
 * APPROVED »…), et c'est légitime : ce sont des circuits différents. Mais dans une liste unifiée,
 * quinze statuts distincts ne se comparent plus. On les ramène à la seule question que se pose
 * celui qui a demandé : **où en est ma demande ?**
 */
export type AdProState = "DRAFT" | "AWAITING" | "RETURNED" | "APPROVED" | "DONE" | "REFUSED";

export const AD_PRO_STATE: Record<AdProState, { label: string; tone: "neutral" | "warning" | "info" | "success" | "danger" }> = {
  DRAFT: { label: "Brouillon", tone: "neutral" },
  AWAITING: { label: "En attente de décision", tone: "warning" },
  // RENVOYÉE POUR CORRECTION (§118.186) : ni « en attente de décision » — personne ne décide —, ni
  // refusée. Rangée ainsi, elle tomberait dans le défaut « en attente », en tête de la file des
  // validateurs, alors que c'est le DEMANDEUR qui a la main.
  RETURNED: { label: "À corriger", tone: "warning" },
  APPROVED: { label: "Validée", tone: "info" },
  DONE: { label: "Terminée", tone: "success" },
  REFUSED: { label: "Refusée / annulée", tone: "danger" },
};

/** Statuts refusés ou annulés, toutes natures confondues. */
const REFUSED = ["REFUSED", "CANCELLED", "REJECTED"];
/** Statuts qui closent une demande. */
const DONE = ["PAID", "CLOSED", "COMPLETED", "SETTLED", "PAYMENT_DONE", "MATERIAL_DELIVERED", "ARCHIVED", "DONE", "EXPIRED"];
/**
 * Statuts « validée, en cours d'exécution ».
 *
 * `PRE_VALIDATED` y est (§118.151) : la tenue d'un sponsoring est décidée et ses postes
 * s'exécutent — devis, BC, factures — jusqu'à la clôture. Hors de cette liste, il retombait dans
 * « en attente de décision », en tête de liste, alors que plus rien n'attend un arbitre.
 *
 * `PRELIMINARY_APPROVED` en est SORTI, dans le même lot : c'est l'état projeté aux portes du DG et
 * de la Direction des opérations, donc une demande qui ATTEND encore une décision. L'afficher
 * « Validée » faisait lire un accord là où il n'y avait qu'une étape franchie.
 */
const APPROVED = [
  "ACCEPTED", "APPROVED", "VALIDATED", "PRE_VALIDATED", "ORGANIZED", "PREPARATION", "ACTIVE",
  "REGISTRATION_OPEN", "FULL", "AGENCY_CHOSEN", "BC_VALIDATED", "BC_SENT", "PAYMENT_INITIATED",
  "MATERIAL_PRODUCED",
];
/** Statuts de départ, avant toute soumission. */
const DRAFT = ["DRAFT"];

/**
 * L'état commun d'une demande, depuis son statut d'origine.
 *
 * Tout ce qui n'est ni brouillon, ni tranché, ni terminé est « en attente de décision » — et
 * c'est volontairement le défaut : une demande dont on ne sait pas quoi dire attend forcément
 * quelque chose de quelqu'un, et il vaut mieux la montrer que la ranger dans une case rassurante.
 */
export function adProState(status: string): AdProState {
  if (status === "RETURNED") return "RETURNED";
  if (REFUSED.includes(status)) return "REFUSED";
  if (DONE.includes(status)) return "DONE";
  if (APPROVED.includes(status)) return "APPROVED";
  if (DRAFT.includes(status)) return "DRAFT";
  return "AWAITING";
}

/** Une demande Ad & Pro, quelle que soit sa nature — la ligne de la liste unifiée. */
export interface AdProRequest {
  id: string;
  kind: AdProKind;
  reference: string;
  title: string;
  /** Pour qui : praticien, association, agence… */
  beneficiary: string | null;
  amount: number | null;
  /** Statut d'origine, conservé — l'écran de la nature le montre tel quel. */
  status: string;
  state: AdProState;
  requester: string | null;
  createdAt: string;
  href: string;
}

/** Le libellé d'une nature, avec repli : une nature inconnue ne casse pas l'écran. */
export function kindLabel(kind: AdProKind): string {
  return AD_PRO_KINDS.find((k) => k.kind === kind)?.label ?? kind;
}

export function kindSpec(kind: AdProKind): KindSpec | undefined {
  return AD_PRO_KINDS.find((k) => k.kind === kind);
}

/**
 * Les natures que cette personne peut réellement CRÉER.
 *
 * Le droit de créer n'est pas celui de consulter. Proposer « Événement » à quelqu'un qui ne peut
 * que lire les événements, c'est promettre un formulaire qui sera refusé à l'enregistrement — le
 * refus arrive alors après la saisie, au pire moment. On ne propose que ce qui aboutira.
 */
export function creatableKinds(canCreate: (module: string) => boolean): KindSpec[] {
  return AD_PRO_KINDS.filter((k) => canCreate(k.module));
}

/**
 * Le classement de la liste unifiée : ce qui ATTEND une décision d'abord, le reste ensuite, et
 * à état égal la plus récente en tête.
 *
 * Une liste triée uniquement par date enterre les demandes bloquées depuis trois semaines sous
 * celles de ce matin — or ce sont précisément celles-là qu'il faut voir.
 */
const STATE_ORDER: Record<AdProState, number> = { AWAITING: 0, RETURNED: 1, APPROVED: 2, DRAFT: 3, DONE: 4, REFUSED: 5 };

export function sortAdPro(rows: readonly AdProRequest[]): AdProRequest[] {
  return [...rows].sort((a, b) => {
    const d = STATE_ORDER[a.state] - STATE_ORDER[b.state];
    return d !== 0 ? d : b.createdAt.localeCompare(a.createdAt);
  });
}

/** Le décompte par état — les compteurs de tête, qui servent aussi de filtres. */
export function countByState(rows: readonly AdProRequest[]): Record<AdProState, number> {
  const out: Record<AdProState, number> = { DRAFT: 0, AWAITING: 0, RETURNED: 0, APPROVED: 0, DONE: 0, REFUSED: 0 };
  for (const r of rows) out[r.state] += 1;
  return out;
}
