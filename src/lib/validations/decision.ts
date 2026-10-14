/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA DÉCISION D'UNE ÉTAPE ET LA REPRISE D'UNE DEMANDE RENVOYÉE — règles PURES (audit 360°, R08).
 *
 * « Modification demandée » CLÔTURAIT la demande de validation : le demandeur ne pouvait que la
 * laisser là et en écrire une autre, sans que rien relie la seconde à la première ni au motif qui
 * l'avait fait renvoyer. La règle commune des circuits est désormais tenue ici aussi : à chaque
 * étape, VALIDER, RENVOYER POUR CORRECTION (motif exigé) ou REFUSER (motif exigé) ; une demande
 * renvoyée se corrige et se RESOUMET sur elle-même, et le circuit reprend à l'étape qui l'a renvoyée.
 *
 * Ces fonctions ne lisent rien : l'action les appelle SOUS LE VERROU de la demande, sur des étapes
 * RELUES après l'écriture — c'est ce qui fait qu'en mode parallèle, deux validateurs qui approuvent
 * à la même seconde ne laissent plus une demande en attente pour toujours (chacun voyait l'autre
 * encore « en attente », aucun ne finalisait, et plus personne ne pouvait trancher).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type DecisionEtape = "APPROVED" | "REJECTED" | "CHANGES_REQUESTED";
export type StatutDemande = "PENDING" | "APPROVED" | "REJECTED" | "CHANGES_REQUESTED";

export interface EtapeVue {
  id: string;
  order: number;
  status: string;
}

export interface DemandeVue {
  mode: "SEQUENTIAL" | "PARALLEL" | string;
  currentOrder: number;
  steps: EtapeVue[];
}

/** Refuser ou renvoyer sans dire pourquoi laisse le demandeur deviner ce qu'il doit corriger. */
export function motifExige(decision: DecisionEtape): boolean {
  return decision !== "APPROVED";
}

export const MOTIF_EXIGE =
  "Indiquez le motif : sans lui, le demandeur ne sait pas quoi corriger — et l'historique ne dira pas pourquoi la demande a été arrêtée.";

/**
 * CE QUE DEVIENT LA DEMANDE quand l'étape `stepId` vient d'être tranchée — lu sur les étapes RELUES,
 * où cette étape porte déjà sa décision.
 *
 * Un refus ou un renvoi s'appliquent à toute la demande. Un accord la fait avancer : en parallèle,
 * elle n'est validée que quand TOUTES les étapes le sont ; en séquentiel, elle passe à l'étape
 * suivante encore en attente, et n'est validée qu'au bout du circuit.
 */
export function issueDeLaDecision(
  demande: DemandeVue,
  stepId: string,
  decision: DecisionEtape,
): { status: StatutDemande; currentOrder: number; suivanteId: string | null } {
  if (decision === "REJECTED") return { status: "REJECTED", currentOrder: demande.currentOrder, suivanteId: null };
  if (decision === "CHANGES_REQUESTED") return { status: "CHANGES_REQUESTED", currentOrder: demande.currentOrder, suivanteId: null };
  if (demande.mode === "PARALLEL") {
    const toutes = demande.steps.every((e) => (e.id === stepId ? true : e.status === "APPROVED"));
    return { status: toutes ? "APPROVED" : "PENDING", currentOrder: demande.currentOrder, suivanteId: null };
  }
  const suivante = demande.steps.find((e) => e.order === demande.currentOrder + 1 && e.status === "PENDING");
  return suivante
    ? { status: "PENDING", currentOrder: demande.currentOrder + 1, suivanteId: suivante.id }
    : { status: "APPROVED", currentOrder: demande.currentOrder, suivanteId: null };
}

/**
 * LES ÉCRANS DE L'OBJET D'ORIGINE À RAFRAÎCHIR APRÈS CHAQUE DÉCISION — finalisante OU NON (Direction, 06/10).
 *
 * La fiche de la demande au secrétariat n'était rafraîchie que quand le circuit se CLÔTURAIT : le premier
 * accord d'un circuit à deux n'y changeait rien, alors que cette fiche montre désormais ce que chaque
 * validateur a dit. On rafraîchit la fiche de l'objet lié (demande au secrétariat) et le lien interne
 * porté par la validation (`link`, chemin seul — jamais une adresse externe, jamais une requête).
 */
export function cheminsDeLObjetLie(v: { entityType: string | null; entityId: string | null; link: string | null }): string[] {
  const chemins = new Set<string>();
  if (v.entityType === "ADMIN_REQUEST" && v.entityId) chemins.add(`/demandes/${v.entityId}`);
  const lien = v.link?.trim() ?? "";
  if (lien.startsWith("/") && !lien.startsWith("//")) {
    const chemin = lien.split(/[?#]/)[0];
    if (chemin.length > 1) chemins.add(chemin);
  }
  return [...chemins];
}

/**
 * LA REPRISE D'UNE DEMANDE RENVOYÉE — quelles étapes rouvrir, et où reprend le circuit.
 *
 * Le circuit reprend À L'ÉTAPE QUI A RENVOYÉ : la personne qui a demandé la correction juge la
 * correction, et un accord déjà donné avant elle reste acquis. Sauf quand le MONTANT monte : un
 * accord ne couvre pas plus que ce qu'il a vu (la règle du visa d'un BC, §118.187), et toutes les
 * étapes déjà validées repartent alors avec la nouvelle version. Une baisse, elle, ne rouvre rien.
 */
export function repriseApresCorrection(
  demande: DemandeVue,
  montantAvant: number | null,
  montantApres: number | null,
): { aRouvrir: string[]; currentOrder: number; montantReleve: boolean } {
  const montantReleve = montantAvant != null && montantApres != null && montantApres > montantAvant;
  const aRouvrir = demande.steps
    .filter((e) => e.status === "CHANGES_REQUESTED" || (montantReleve && e.status === "APPROVED"))
    .map((e) => e.id);
  const enAttenteApres = demande.steps.filter((e) => aRouvrir.includes(e.id) || e.status === "PENDING");
  const currentOrder = demande.mode === "SEQUENTIAL" && enAttenteApres.length > 0
    ? Math.min(...enAttenteApres.map((e) => e.order))
    : demande.currentOrder;
  return { aRouvrir, currentOrder, montantReleve };
}

/**
 * UNE DEMANDE SE CORRIGE-T-ELLE SUR ELLE-MÊME ? — oui quand rien d'autre ne la porte.
 *
 * Une demande déposée depuis l'écran des validations n'a pas d'objet d'origine : elle EST l'objet,
 * et sa correction (le texte, le montant, les pièces) se fait sur elle. Une demande née d'un autre
 * circuit — un bon de commande, une pièce du secrétariat, une déclaration d'information médicale —
 * se corrige LÀ-BAS, et c'est ce circuit qui la renvoie (souvent par une demande neuve qui clôt la
 * précédente, audit 360° I9). La resoumettre ici contournerait la correction que ce circuit exige :
 * un BC « à revoir » se lève en MODIFIANT le BC, pas en appuyant sur un bouton.
 */
export function resoumissionSurPlace(demande: { entityType: string | null; documentId?: string | null; objectType?: string | null }): boolean {
  // LA PRÉ-VALIDATION D'UN BC (Demandes de validations, 10/2026) vise une pièce Legal mais n'est pas née d'un autre
  // circuit : c'est le demandeur qui l'a ouverte ici, et c'est ici qu'il la corrige et la resoumet. La valeur est
  // écrite en clair (module au socle, sans import) : c'est `OBJET_PREVALIDATION_BC`.
  if (demande.objectType === "PREVALIDATION_BC") return true;
  return !demande.entityType && !demande.documentId;
}

/**
 * L'INSTANT DE LA DERNIÈRE RESOUMISSION, lu dans les traces du journal (lot E2 — 07-05).
 *
 * La resoumission (`resoumettreValidation`) est le SEUL écrivain qui trace le champ « version » d'une
 * demande de validation, avec la version atteinte. On ne retient que la trace de la version COURANTE :
 * si elle manque (une écriture de journal perdue), une trace plus ancienne daterait la reprise d'une
 * correction précédente — une ancienneté fausse, dans le sens qui accuse. On rend alors `null`.
 */
export function instantDeReprise(
  traces: readonly { newValue: string | null; createdAt: Date }[],
  version: number,
): Date | null {
  if (version <= 1) return null;
  let t: Date | null = null;
  for (const tr of traces) {
    if (tr.newValue !== String(version)) continue;
    if (!t || tr.createdAt > t) t = tr.createdAt;
  }
  return t;
}

/**
 * DEPUIS QUAND CETTE ÉTAPE EST À SON TOUR (lot E2 — audit 360°, 07-05) — l'instant où la décision est
 * devenue possible, pas celui où la demande a été déposée.
 *
 *   · En PARALLÈLE, chaque étape est à son tour dès le dépôt.
 *   · En SÉQUENTIEL, l'étape du rang N l'est quand le rang précédent a décidé : on prend la plus
 *     récente décision des rangs inférieurs. Dater l'étape 3 du dépôt ferait porter au troisième
 *     validateur les jours que les deux premiers ont pris.
 *   · Une demande RESOUMISE (version > 1) repart à la resoumission : les accords d'avant le renvoi
 *     datent d'avant la correction. Sans instant de reprise connu, on ne date pas (§118.16).
 */
export function depuisEtapeValidation(e: {
  mode: "SEQUENTIAL" | "PARALLEL" | string;
  ordre: number;
  creeLe: Date;
  version: number;
  etapes: readonly { ordre: number; decideeLe: Date | null }[];
  reprise: Date | null;
}): Date | null {
  if (e.version > 1 && e.reprise === null) return null;
  let t = e.creeLe.getTime();
  if (e.reprise) t = Math.max(t, e.reprise.getTime());
  if (e.mode === "SEQUENTIAL") {
    for (const s of e.etapes) {
      if (s.ordre < e.ordre && s.decideeLe) t = Math.max(t, s.decideeLe.getTime());
    }
  }
  return new Date(t);
}
