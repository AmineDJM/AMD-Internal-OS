/**
 * QUI TRANCHE CE QUE LE PRIM FAIT VALIDER — le Directeur des Opérations (Direction, 10/2026).
 *
 * « Dans Information médicale, quand le pharmacien responsable d'information médicale demande une
 * validation, elle doit automatiquement aller chez le directeur des opérations. C'est lui qui valide,
 * ou pas. »
 *
 * ── TROIS DEMANDES, UN SEUL DÉCIDEUR ────────────────────────────────────────────────────────
 *
 *   1. la LECTURE « à déclarer au ministère / sans déclaration » (circuit événement) ;
 *   2. le DÉPÔT DES BONS DE VERSEMENT (circuit matériel promotionnel) ;
 *   3. la VALIDATION FINALE du dossier, qui émet l'ordre de dépense.
 *
 * Avant, les deux premières partaient en série chez le N+1 du pharmacien, le référent Direction
 * Marketing du dossier puis le centre (Directeur Général) ; la troisième chez la vue globale
 * (« Direction des opérations » — le SERVICE, rôle `DIRECTION` — et le Super Admin). Elles vont
 * désormais toutes chez la PERSONNE : le Directeur des Opérations (`OPERATIONS_DIRECTOR`, porté en
 * principal ou en secondaire). Deux vocabulaires, jamais confondus (§118.112a) : le métier a dit
 * « le directeur », pas « la direction ».
 *
 * ── PLUSIEURS DIRECTEURS, AUCUN DIRECTEUR ───────────────────────────────────────────────────
 *
 * Plusieurs comptes actifs portent le rôle : tous sont saisis et notifiés, et LE PREMIER QUI TRANCHE
 * tranche pour tous (`OBJET_DECISION_INFO_MED`, lu par `validations/decision.ts`). Une validation
 * qui attendrait l'accord de chacun ferait d'un intérim une double signature.
 *
 * Aucun compte actif : la demande va au Super Admin — souverain, il tranche déjà toute étape de
 * validation (`droitSurLEtape`) — et la confirmation du pharmacien le DIT. Se taire laisserait le
 * pharmacien relancer un directeur qui n'existe pas.
 *
 * Le pharmacien n'est jamais son propre décideur : un PRIM qui porterait aussi le rôle de directeur
 * s'écarte, et ce sont les autres qui tranchent (ou, à défaut, le Super Admin).
 *
 * Module PUR : il décide qui engage la société, il doit se lire sans rien exécuter. Testé.
 */

/** Le rôle qui tranche — la personne « Directeur des Opérations ». */
export const ROLE_DECIDEUR_INFO_MED = "OPERATIONS_DIRECTOR" as const;

/** Son nom, tel que l'écran et les notifications l'écrivent (`ROLE_LABELS.OPERATIONS_DIRECTOR`). */
export const DECIDEUR_INFO_MED_LABEL = "Directeur des Opérations";

/**
 * LA NATURE DES DEMANDES DE VALIDATION NÉES ICI (`ValidationRequest.objectType`). Elle dit au
 * moteur commun que l'accord d'UN seul des validateurs saisis suffit (`validations/decision.ts`).
 */
export const OBJET_DECISION_INFO_MED = "INFO_MED_DIRECTEUR_OPS";

interface Porteur {
  role: string;
  secondaryRole?: string | null;
}

/**
 * PEUT-IL TRANCHER ? — le Directeur des Opérations (principal ou secondaire), et le Super Admin
 * souverain, comme dans tout autre circuit. Ni la Direction des opérations (le service), ni le
 * Directeur Général, ni le pharmacien.
 */
export function estDecideurInfoMed(u: Porteur): boolean {
  return u.role === "SUPER_ADMIN" || u.role === ROLE_DECIDEUR_INFO_MED || u.secondaryRole === ROLE_DECIDEUR_INFO_MED;
}

export interface DecideursInfoMed {
  /** Ceux qu'on saisit, dans l'ordre d'ancienneté. Vide : personne ne peut trancher. */
  validatorIds: string[];
  /** Aucun Directeur des Opérations actif : c'est le Super Admin qui reçoit la demande. */
  repli: boolean;
}

/**
 * QUI SAISIR — les Directeurs des Opérations actifs, à défaut les Super Admins actifs ; jamais le
 * demandeur. Les listes arrivent triées (ancienneté) et sans comptes inactifs : l'appelant les lit.
 */
export function decideursInfoMed(i: { directeurs: readonly string[]; superAdmins: readonly string[]; requesterId: string | null }): DecideursInfoMed {
  const sauf = (ids: readonly string[]) => [...new Set(ids)].filter((id) => id && id !== i.requesterId);
  const directeurs = sauf(i.directeurs);
  if (directeurs.length > 0) return { validatorIds: directeurs, repli: false };
  return { validatorIds: sauf(i.superAdmins), repli: true };
}

/** « chez qui » — le nom de la fonction qui tranche, pour la pastille et la carte d'attente. */
export function chezDecideur(d: Pick<DecideursInfoMed, "repli">): string {
  return d.repli ? "le Super Admin" : `le ${DECIDEUR_INFO_MED_LABEL}`;
}

/** Ce qu'on écrit dans la demande elle-même, pour que le décideur sache pourquoi c'est lui. */
export function noteDecideurs(d: DecideursInfoMed): string {
  return d.repli
    ? `Aucun ${DECIDEUR_INFO_MED_LABEL} actif : la demande est adressée au Super Admin.`
    : d.validatorIds.length > 1
      ? `Adressée aux ${d.validatorIds.length} comptes ${DECIDEUR_INFO_MED_LABEL} actifs — le premier qui tranche décide pour tous.`
      : `Adressée au ${DECIDEUR_INFO_MED_LABEL}.`;
}

/**
 * LA CONFIRMATION DU PHARMACIEN — où est partie sa demande, et le repli s'il y en a un.
 * `phrase` porte le sujet et son participe accordé : « Votre lecture est envoyée », « Le dossier est transmis ».
 */
export function confirmationDemande(d: DecideursInfoMed, phrase: string): string {
  return d.repli
    ? `${phrase} au Super Admin : aucun ${DECIDEUR_INFO_MED_LABEL} n'est actif dans l'ERP.`
    : `${phrase} au ${DECIDEUR_INFO_MED_LABEL}${d.validatorIds.length > 1 ? ` (${d.validatorIds.length} comptes notifiés — le premier qui tranche décide)` : ""}.`;
}

/** Le refus de trancher, quand personne ne peut recevoir la demande. */
export const AUCUN_DECIDEUR = `Aucun ${DECIDEUR_INFO_MED_LABEL} ni Super Admin actif : la demande n'aurait personne à qui aller.`;
