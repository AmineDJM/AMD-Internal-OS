/**
 * OÙ MÈNE UNE NOTIFICATION Ad & Pro — la fiche de la demande (sponsoring, congrès, événement, « autre ») et,
 * quand la notification parle d'UN poste, ce poste sur la fiche (ancre `#poste-<id>`).
 *
 * La même table vivait recopiée dans le moteur de circuit, les missions, les postes, la prise en
 * charge et le transfert : cinq copies d'une adresse, c'est la garantie qu'une finira par mener à
 * l'ancien écran (§118.5).
 *
 * Et DE QUELLE DEMANDE un poste dépend (`parentDuPoste`) : une adresse aussi, que le référentiel des
 * personnes lit pour relier une fiche 360° au poste — il ne peut pas lire le module Ad & Pro (un
 * référentiel ne lit pas un métier, `src/modules/carte.ts`).
 *
 * Module PUR — aucune importation (les types d'entité sont repris en chaînes).
 */

export type ParentAdPro = "SPONSORING" | "CONGRESS_NATIONAL" | "CONGRESS_INTERNATIONAL" | "EVENT" | "AD_PRO_OTHER";

export const CHEMIN_PARENT_AD_PRO: Record<ParentAdPro, string> = {
  SPONSORING: "/sponsoring",
  CONGRESS_NATIONAL: "/congress-national",
  CONGRESS_INTERNATIONAL: "/congress-international",
  EVENT: "/events",
  // La demande « autre » suit le même circuit depuis le 27/10/2026 (décision #17) : sa fiche est ici.
  AD_PRO_OTHER: "/ad-pro/autres",
};

/** La fiche d'une demande Ad & Pro. */
export function lienDemandeAdPro(type: ParentAdPro, id: string): string {
  return `${CHEMIN_PARENT_AD_PRO[type]}/${id}`;
}

/** L'ancre d'un poste sur la fiche de sa demande (posée par `AdProItemsPanel`). */
export function ancrePoste(itemId: string): string {
  return `poste-${itemId}`;
}

/** UN poste, sur la fiche de sa demande. */
export function lienPosteAdPro(type: ParentAdPro, parentId: string, itemId: string): string {
  return `${lienDemandeAdPro(type, parentId)}#${ancrePoste(itemId)}`;
}

/** Le centre de validation Ad & Pro (les sièges du centre y tranchent les BC et les dépassements). */
export const CHEMIN_CENTRE_AD_PRO = "/centre-ad-pro";

/**
 * Le centre ouvert SUR UNE LIGNE (`?ligne=<id de l'objet>`) : la demande, le contrat, le matériel, le
 * poste (bon de commande) ou la pièce Legal dont parle la notification. L'écran pose `ancreLigneCentre`
 * sur la ligne et la fait venir sous les yeux ; sans identifiant, le centre s'ouvre en tête de file.
 */
export function ancreLigneCentre(entityId: string): string {
  return `ligne-centre-${entityId}`;
}

export function lienLigneCentreAdPro(entityId?: string | null): string {
  return entityId ? `${CHEMIN_CENTRE_AD_PRO}?ligne=${encodeURIComponent(entityId)}` : CHEMIN_CENTRE_AD_PRO;
}

// ── LE PARENT D'UN POSTE — quelle demande le porte (déplacé ici depuis les postes Ad & Pro) ────────

/**
 * Les opérations Ad & Pro qui portent des postes — les quatre du pôle, plus la demande « autre »
 * depuis le 27/10/2026 (elle suit le même circuit : prévalidation, postes, DG sur le total).
 *
 * LA VALEUR D'UN PARENT EST SON `EntityType` (`AD_PRO_OTHER`, pas `OTHER`) : le moteur et la porte du
 * DG comparent et stockent le parent comme un type d'entité (`AdProPorteDg.entityType`).
 */
export type AdProParent = ParentAdPro;

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
