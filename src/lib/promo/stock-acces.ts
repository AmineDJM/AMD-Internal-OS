/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * QUI PEUT QUOI SUR LE STOCK PROMOTIONNEL — la règle, écrite une fois (§118.164).
 *
 * Les décisions de la Direction (01/10/2026), mot pour mot :
 *   • « Qui gère le magasin central — c'est la directrice marketing. Le super administrateur, il
 *     peut gérer ce qu'il veut, modifier, supprimer. »
 *   • « Le délégué doit confirmer la réception. »
 *   • « Le directeur des opérations, on lui donne la vue globale du stock promotionnel, mais aussi
 *     la gestion du matériel promotionnel de ses équipes — les superviseurs en dessous de lui et
 *     les KAM. »
 *
 * ── LES FAITS, PUIS LA RÈGLE ───────────────────────────────────────────────────────────────
 *
 * Ce module ne lit rien : il reçoit des FAITS (`FaitsStock`) que le chargeur établit une fois par
 * requête (`queries/promo-stock.ts`) — le droit de module, la portée réglée dans la console, la
 * cheffe de la Direction Marketing lue sur l'organigramme, l'équipe sous la personne. L'écran, les
 * actions et le banc lisent tous CETTE règle : un bouton que l'action refuse n'est pas un bouton,
 * et une action qui accepte ce que l'écran cache est une porte (§118.71).
 *
 * ── TROIS GESTES QUI NE SE DÉLÈGUENT PAS ───────────────────────────────────────────────────
 *
 *   • CONFIRMER UNE RÉCEPTION est une ATTESTATION : « je l'ai entre les mains ». Seul celui qui
 *     reçoit la donne — pas même le Super Admin, qui peut en revanche ANNULER le transfert (le
 *     matériel revient alors à celui qui l'avait). Une confirmation donnée à la place de quelqu'un
 *     ferait porter à son nom un stock qu'il n'a peut-être jamais vu (§118.15).
 *   • ENTRER DU STOCK À LA MAIN et POSER L'INVENTAIRE D'OUVERTURE — les seules lignes qui créent
 *     du matériel sans facture ni transfert — étaient réservés au Super Admin (01/10). La Direction
 *     a RENVERSÉ cette règle le 23/11/2026, après l'essai en conditions réelles : « le matériel
 *     promotionnel doit pouvoir être ajouté manuellement par Assia ». Ils sont ouverts à celle qui
 *     tient le magasin (la cheffe de la Direction Marketing), avec le droit « Créer » du module —
 *     et au Super Admin. Personne d'autre : un délégué, ou un membre de la Direction Marketing qui
 *     n'en est pas la cheffe, ne crée pas de stock.
 *   • ANNULER UN MOUVEMENT (le « supprimer », pour le registre) est réservé au Super Admin, et ne
 *     supprime rien : il écrit l'exact inverse, et l'histoire reste entière.
 *
 * Module PUR — aucune base, aucune session. Testé.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface FaitsStock {
  userId: string;
  /** Super Admin en rôle PRINCIPAL — c'est le seul qui « peut gérer ce qu'il veut ». */
  superAdmin: boolean;
  /** Le droit de module `PROMO_STOCK`, tel que la console l'a réglé pour cette personne. */
  module: { voir: boolean; creer: boolean; modifier: boolean; /** Supprimer (réversible) un article — directeur des opérations. */ supprimer?: boolean };
  /** La portée du module vaut TOUT (réglable dans la console) : la vue globale du stock. */
  vueGlobale: boolean;
  /** La cheffe de la Direction Marketing (ou le Super Admin) : elle tient le magasin central. */
  gereLeMagasin: boolean;
  /** Directeur des opérations (`DIRECTION` / `OPERATIONS_DIRECTOR`, principal ou secondaire). */
  directeurDesOperations: boolean;
  /** Les personnes SOUS elle : l'arbre de l'organigramme ET les KAM des gammes qu'elle supervise. */
  equipe: ReadonlySet<string>;
}

/** Le détenteur `null` est le magasin central de la société de l'article. */
type Detenteur = string | null;

/** Le magasin se tient par sa gestionnaire ou le Super Admin — et personne d'autre. */
export function tientLeMagasin(f: FaitsStock): boolean {
  return f.superAdmin || (f.gereLeMagasin && f.module.voir);
}

/** VOIR le stock d'un détenteur. */
export function peutVoirStockDe(f: FaitsStock, detenteur: Detenteur): boolean {
  if (f.superAdmin || f.vueGlobale) return true;
  if (!f.module.voir) return false;
  if (detenteur === null) return f.gereLeMagasin;
  if (detenteur === f.userId) return true;
  return f.equipe.has(detenteur);
}

/** L'onglet « Mon équipe » a-t-il quelque chose à montrer ? */
export function aUneEquipe(f: FaitsStock): boolean {
  return f.module.voir && f.equipe.size > 0;
}

/**
 * FAIRE SORTIR du stock d'un détenteur (transfert, retour, perte) — l'initiative du mouvement.
 *
 * Le détenteur lui-même ; le Super Admin ; le directeur des opérations pour les personnes SOUS
 * lui (« la gestion du matériel de ses équipes ») ; la gestionnaire du magasin pour le magasin.
 * Un superviseur VOIT le stock de ses KAM, il n'en dispose pas : la Direction a donné la gestion
 * des équipes au directeur des opérations, pas à chaque échelon.
 */
export function peutSortirDe(f: FaitsStock, detenteur: Detenteur): boolean {
  if (f.superAdmin) return true;
  if (!f.module.modifier) return false;
  if (detenteur === null) return f.gereLeMagasin;
  if (detenteur === f.userId) return true;
  return f.directeurDesOperations && f.equipe.has(detenteur);
}

/**
 * VERS QUI peut aller ce qui sort. Le détenteur (et le Super Admin) l'envoie où il veut — un
 * collègue, le magasin. Le directeur des opérations qui dispose du stock d'un membre de ses équipes
 * le déplace DANS ses équipes, vers lui-même, ou le rend au magasin : « la gestion du matériel de
 * SES équipes », pas le droit de le faire sortir de son périmètre.
 */
export function peutTransfererVers(f: FaitsStock, deId: Detenteur, versId: Detenteur): boolean {
  if (!peutSortirDe(f, deId)) return false;
  if (f.superAdmin || deId === f.userId || deId === null) return true;
  return versId === null || versId === f.userId || f.equipe.has(versId);
}

/** DOTER une personne depuis le magasin. */
export function peutDoter(f: FaitsStock): boolean {
  return peutSortirDe(f, null);
}

/**
 * CONFIRMER (ou refuser) une réception. Une personne pour elle-même ; un retour au magasin, la
 * gestionnaire du magasin (ou le Super Admin, qui tient le magasin à défaut).
 */
export function peutConfirmerReception(f: FaitsStock, versId: Detenteur): boolean {
  if (versId === null) return tientLeMagasin(f);
  return versId === f.userId && f.module.voir;
}

/** ANNULER un transfert encore en route : celui qui l'a lancé, le Super Admin, et le magasin pour ses dotations. */
export function peutAnnulerTransfert(f: FaitsStock, t: { initiateurId: string; deId: Detenteur }): boolean {
  if (f.superAdmin) return true;
  if (t.initiateurId === f.userId) return true;
  return t.deId === null && tientLeMagasin(f);
}

/** DÉCLARER UNE PERTE (casse, perte, lot périmé détruit). */
export function peutDeclarerPerte(f: FaitsStock, detenteur: Detenteur): boolean {
  return peutSortirDe(f, detenteur);
}

/**
 * CORRIGER UN INVENTAIRE. Au magasin : sa gestionnaire. Chez une personne : le Super Admin
 * seulement à cette étape — un comptage demandé par le directeur des opérations (étape 5) aura sa
 * porte propre ; laisser chacun réécrire son solde à la main ferait du stock une déclaration.
 */
export function peutCorriger(f: FaitsStock, detenteur: Detenteur): boolean {
  if (f.superAdmin) return true;
  return detenteur === null && f.gereLeMagasin && f.module.modifier;
}

/**
 * ENTRER du matériel à la main, POSER l'inventaire d'ouverture : celle qui tient le magasin, avec le
 * droit « Créer » du module, et le Super Admin (Direction, 23/11/2026 — voir l'en-tête).
 */
export function peutEntrerAlaMain(f: FaitsStock): boolean {
  return f.superAdmin || (f.gereLeMagasin && f.module.creer);
}
export function peutPoserOuverture(f: FaitsStock): boolean {
  return f.superAdmin || (f.gereLeMagasin && f.module.creer);
}
/** ANNULER un mouvement : le Super Admin seul. */
export function peutAnnulerMouvement(f: FaitsStock): boolean {
  return f.superAdmin;
}

/** DEMANDER du matériel au magasin. */
export function peutDemander(f: FaitsStock): boolean {
  return f.superAdmin || f.module.creer;
}

/**
 * ANNULER une demande ouverte : son AUTEUR seulement. Le magasin, lui, la REFUSE — avec un motif,
 * parce que le demandeur doit savoir quoi faire ; une annulation sans motif par celui qui la sert
 * effacerait la demande sans un mot (§118.30).
 */
export function peutAnnulerDemande(f: FaitsStock, demandeurId: string): boolean {
  return demandeurId === f.userId && (f.superAdmin || f.module.voir);
}

/** SERVIR ou REFUSER une demande : le magasin. */
export function peutServirDemande(f: FaitsStock): boolean {
  return tientLeMagasin(f) && (f.superAdmin || f.module.modifier);
}

/** La FICHE d'un article de stock, ses lots, ses supports numériques : le magasin. */
export function peutGererArticles(f: FaitsStock): boolean {
  return f.superAdmin || (f.gereLeMagasin && f.module.modifier);
}

/**
 * LES PHRASES DE REFUS — chacune nomme le geste qui la lève ou la personne qui peut le faire.
 * Un refus qui dit « non » sans dire à qui s'adresser renvoie la personne chercher (§118.30).
 */
export const REFUS = {
  module: "Le stock promotionnel ne vous est pas ouvert — un Super Admin l'ouvre dans Administration › Accès (module « Stock promotionnel »).",
  magasin: "Le magasin central est tenu par la directrice de la Direction Marketing (et le Super Admin) : c'est elle qui dote, sert les demandes et corrige l'inventaire du magasin.",
  sortie: "Seul celui qui détient ce matériel le transfère ou le rend — ou le directeur des opérations pour les personnes de ses équipes, ou le Super Admin.",
  confirmation: "Seul celui qui reçoit confirme la réception : c'est lui qui atteste l'avoir entre les mains. Celui qui a lancé le transfert peut l'annuler.",
  superAdmin: "Ce geste crée ou efface du stock sans facture ni transfert : il est réservé au Super Admin.",
  entree: "Entrer du matériel à la main (ou poser l'inventaire d'ouverture) crée du stock sans facture ni transfert : c'est la directrice de la Direction Marketing, qui tient le magasin, qui le fait — ou le Super Admin.",
  correction: "Corriger le solde d'une personne est réservé au Super Admin à cette étape ; la gestionnaire du magasin corrige l'inventaire du magasin.",
  voir: "Ce stock n'est pas dans votre périmètre : vous voyez le vôtre, celui de votre équipe, et le reste si la vue globale vous est ouverte.",
  hors_equipe: "Le directeur des opérations déplace le matériel de ses équipes à l'intérieur de ses équipes, ou le rend au magasin — pas vers une personne hors de son périmètre.",
} as const;
