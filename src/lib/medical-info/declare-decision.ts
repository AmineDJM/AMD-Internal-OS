/**
 * « FAUT-IL DÉCLARER CET ÉVÉNEMENT ? » — la seule question du circuit ÉVÉNEMENT.
 *
 * ── CE QUE LE PHARMACIEN FAIT VRAIMENT ──────────────────────────────────────────────────────
 *
 * Une prise en charge de congrès, un sponsoring, un événement n'appellent aucun versement. Ce
 * qu'ils appellent, c'est un JUGEMENT : ce dossier relève-t-il d'une déclaration au ministère de
 * l'Industrie pharmaceutique, ou non ? Le pharmacien responsable (PRIM) sait répondre — mais cette
 * réponse engage la société, et elle ne doit pas rester la sienne seule.
 *
 * Il FORMULE donc son intention — « je déclare » ou « je ne déclare pas » — et la fait valider.
 *
 * ── POURQUOI UNE INTENTION, ET NON UNE QUESTION OUVERTE ─────────────────────────────────────
 *
 * Une demande de validation répond OUI ou NON. Poser « faut-il déclarer ? » aurait donc fait dire
 * « refusé » pour signifier « non, ne déclarez pas » : un refus dans le journal, une notification
 * de refus au PRIM, et un dossier parfaitement conforme marqué comme rejeté. Ce que le validateur
 * approuve ou refuse, c'est la LECTURE du pharmacien — et les deux lectures sont légitimes.
 *
 * ── CE QUE LA DÉCISION OUVRE ────────────────────────────────────────────────────────────────
 *
 *   accordée + DÉCLARER    → le dépôt auprès du ministère s'ouvre ; il se fait, puis on valide
 *   accordée + NE PAS      → rien à déposer : on valide directement, et le motif reste au dossier
 *   refusée                → le validateur a dit pourquoi ; le PRIM reformule et redemande
 *
 * Module PUR : ni base, ni session. Testé.
 */

/** Ce que le pharmacien compte faire, et qu'il soumet. */
export type DeclareIntent = "DECLARE" | "SKIP";

export const DECLARE_INTENT_LABEL: Record<DeclareIntent, string> = {
  DECLARE: "À déclarer au ministère",
  SKIP: "Sans déclaration",
};

export function isDeclareIntent(v: unknown): v is DeclareIntent {
  return v === "DECLARE" || v === "SKIP";
}

export type DeclareStage =
  | "A_DEMANDER"   // le pharmacien n'a pas encore soumis sa lecture
  | "EN_VALIDATION"
  | "A_REVOIR"     // un validateur demande une modification
  | "REFUSEE"      // la lecture du pharmacien est refusée : il en reformule une autre
  | "ACCORDEE";

export interface DeclareInput {
  /** La demande de validation existe-t-elle ? */
  validationId: string | null;
  /** Son état (`ValidationStatus`), ou `null`. */
  validationStatus: string | null;
  /** Ce que le pharmacien a soumis. */
  intent: string | null;
  /**
   * LA REPRISE — et rien d'autre.
   *
   * Les dossiers instruits AVANT que cette marche existe n'ont aucune demande de validation :
   * leur pharmacien avait déjà fait son travail sous les règles d'alors. Les renvoyer à « décision
   * à demander » leur ferait refaire signer une question tranchée il y a des mois, sur des
   * dossiers parfois déjà déposés au ministère.
   *
   * Ce champ est posé UNE FOIS, par la migration, et par personne d'autre : l'application écrit
   * la validation, jamais lui. Deux écritures pour un même état finiraient par diverger.
   */
  grantedAt?: Date | null;
}

export function declareStage(i: DeclareInput): DeclareStage {
  if (!i.validationId) return i.grantedAt ? "ACCORDEE" : "A_DEMANDER";
  switch (i.validationStatus) {
    // ANNULÉE (une resoumission a clos la précédente, ou le demandeur l'a retirée) : il n'y a plus
    // de demande — l'état par défaut la lisait « en validation », et le dossier y restait à vie
    // (audit 360°, I9). Une demande SUPPRIMÉE arrive ici sans identifiant : le chargeur ne transmet
    // que l'identifiant d'une validation qui existe encore (`circuitStateOf`).
    case "CANCELLED": return i.grantedAt ? "ACCORDEE" : "A_DEMANDER";
    case "REJECTED": return "REFUSEE";
    case "CHANGES_REQUESTED": return "A_REVOIR";
    case "APPROVED": return "ACCORDEE";
    default: return "EN_VALIDATION";
  }
}

/**
 * Le pharmacien peut-il (re)soumettre sa lecture ?
 *
 * Un REFUS rouvre la porte : le validateur a dit ce qu'il attendait, et reformuler avec cela est
 * exactement ce qu'on veut. Une demande À REVOIR aussi (audit 360°, I9) : la règle d'avant disait
 * « elle se corrige dans son propre circuit » — or une demande de validation n'a AUCUN geste de
 * reprise côté demandeur (le retrait est refusé dès qu'un validateur s'est prononcé), et le message
 * promettait « reprenez-la là-bas ». Le dossier mourait au premier « Modification ». La resoumission
 * se fait donc ICI, et elle CLÔT la demande précédente : jamais deux demandes vivantes pour une
 * seule question — c'était la vraie raison de la règle, et elle reste tenue.
 */
export function canRequestDecision(i: DeclareInput): boolean {
  const s = declareStage(i);
  return s === "A_DEMANDER" || s === "REFUSEE" || s === "A_REVOIR";
}

/**
 * LE DÉPÔT AU MINISTÈRE EST-IL OUVERT ?
 *
 * Seulement quand la lecture « à déclarer » a été accordée. Ouvrir le dépôt avant, c'est laisser
 * déposer une déclaration que personne n'a validée ; l'ouvrir sur une lecture « sans déclaration »
 * n'aurait aucun sens — il n'y a rien à déposer.
 */
export function canFileWithAuthorities(i: DeclareInput): boolean {
  return declareStage(i) === "ACCORDEE" && i.intent === "DECLARE";
}

/**
 * LE DOSSIER PEUT-IL ÊTRE VALIDÉ PAR LE PHARMACIEN ?
 *
 * Deux chemins, et le second compte autant que le premier :
 *   • lecture « à déclarer » accordée ET le dépôt effectué (une référence au ministère existe) ;
 *   • lecture « sans déclaration » accordée — il n'y a rien à déposer, on valide.
 *
 * Valider sans décision reviendrait à trancher tout seul la question qu'on vient d'ouvrir.
 */
export function canValidateEvent(i: DeclareInput, filed: { authorityRef: string | null }): boolean {
  if (declareStage(i) !== "ACCORDEE") return false;
  if (i.intent === "SKIP") return true;
  return Boolean(filed.authorityRef && filed.authorityRef.trim());
}

const LIBELLES: Record<DeclareStage, string> = {
  A_DEMANDER: "Décision à demander",
  EN_VALIDATION: "Décision en validation",
  A_REVOIR: "Décision à revoir",
  REFUSEE: "Lecture refusée — à reformuler",
  ACCORDEE: "Décision accordée",
};

export function declareStageLabel(s: DeclareStage): string {
  return LIBELLES[s];
}

/**
 * CE QUE L'ÉCRAN DIT — l'état, et surtout QUI DOIT AGIR. « En attente » sans nom fait relancer la
 * mauvaise personne, ou personne.
 */
export function declareMessage(i: DeclareInput, filed: { authorityRef: string | null }): string {
  switch (declareStage(i)) {
    case "A_DEMANDER":
      return "Ce dossier n'appelle aucun bon de versement. Dites si vous comptez le déclarer au ministère de l'Industrie pharmaceutique — ou non — et faites valider cette lecture : c'est elle qui ouvre la suite.";
    case "EN_VALIDATION":
      return "Votre lecture est en validation chez le Directeur des Opérations (à défaut, le Super Admin). Rien à faire de votre côté tant qu'il n'a pas tranché.";
    case "A_REVOIR":
      return "Le validateur demande une modification : lisez son commentaire dans la demande de validation, corrigez votre lecture et soumettez-la de nouveau ici — la demande précédente sera close.";
    case "REFUSEE":
      return "Votre lecture a été refusée. Lisez le motif, puis soumettez celle que le validateur attend.";
    case "ACCORDEE":
      if (i.intent === "SKIP") {
        return "Décision accordée : ce dossier ne se déclare pas. Vous pouvez le valider — la trace de cette décision reste au dossier.";
      }
      return filed.authorityRef && filed.authorityRef.trim()
        ? "Le dépôt au ministère est enregistré. Vous pouvez valider le dossier."
        : "Décision accordée : ce dossier se déclare. Faites le nécessaire auprès du ministère de l'Industrie pharmaceutique, enregistrez la référence de dépôt, puis validez.";
  }
}
