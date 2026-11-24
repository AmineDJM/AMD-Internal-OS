/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE RAPPORT DE VISITE SANS RÉSEAU — la file locale, en règles pures (Super Admin, 11/2026).
 *
 * Un délégué rédige son compte rendu dans le parking de l'hôpital, où le réseau ne passe pas. Le
 * rapport ne doit pas se perdre : il est gardé dans le téléphone (rangé PAR PERSONNE, une session
 * partagée ne mélange pas les brouillons de deux délégués) et part tout seul au retour du réseau.
 *
 * LE SERVEUR RESTE LE JUGE. Un brouillon qui arrive après la fenêtre de 48 h est REFUSÉ par l'action,
 * comme n'importe quel rapport : le refus est gardé avec son message, et l'écran le dit — jamais un
 * renvoi en boucle d'un rapport que le serveur a déjà jugé.
 *
 * DEUX SORTES, DEUX PRUDENCES :
 *  · le rapport d'une visite PLANIFIÉE (`rapporterVisite`) se renvoie sans risque — l'action met à jour
 *    la visite, remplace ses liens et ne retire du stock que l'écart (§118.166) ;
 *  · une visite HORS PLAN (`ajouterVisiteImprevue`) CRÉE une visite. Si l'envoi a échoué alors que le
 *    téléphone se disait en ligne, la requête a pu arriver : la renvoyer d'office ferait un doublon. Elle
 *    est mise « à vérifier » — le délégué regarde ses dernières visites, puis renvoie ou retire.
 *
 * Module PUR — aucune importation : l'écran le lit, les tests aussi. Le stockage est dans l'écran.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type SorteBrouillon = "RAPPORT" | "HORS_PLAN";
export type EtatBrouillon = "EN_ATTENTE" | "A_VERIFIER" | "REFUSE";

export interface BrouillonVisite {
  id: string;
  sorte: SorteBrouillon;
  /** La visite planifiée rapportée (RAPPORT), ou null. */
  visitId: string | null;
  doctorId: string | null;
  /** Le nom du praticien, pour le dire sans réseau. */
  praticien: string;
  /** Les champs du formulaire, tels qu'envoyés (le rapport ne porte aucun fichier). */
  champs: [string, string][];
  creeLe: number;
  tentatives: number;
  etat: EtatBrouillon;
  erreur: string | null;
}

/** La clé de base du stockage local — `cleParPersonne` y ajoute la personne. */
export const CLE_BROUILLONS_VISITE = "amd-visites-en-attente";

/** L'issue d'un envoi : le serveur a accepté, a refusé (motif), ou n'a pas répondu (réseau). */
export type IssueEnvoiBrouillon = { kind: "OK" } | { kind: "REFUS"; erreur: string } | { kind: "RESEAU" };

/** Un brouillon neuf, prêt à partir. */
export function nouveauBrouillon(input: {
  id: string; sorte: SorteBrouillon; visitId: string | null; doctorId: string | null; praticien: string;
  champs: [string, string][]; maintenant: number;
}): BrouillonVisite {
  return { ...input, creeLe: input.maintenant, tentatives: 0, etat: "EN_ATTENTE", erreur: null };
}

/**
 * RANGER UN BROUILLON : un seul par visite planifiée — réenregistrer le même rapport hors ligne
 * REMPLACE le précédent (c'est la dernière version qui compte). Une visite hors plan n'a pas d'identité
 * avant d'être créée : chaque enregistrement est un brouillon à lui.
 */
export function rangerBrouillon(liste: readonly BrouillonVisite[], b: BrouillonVisite): BrouillonVisite[] {
  const autres = b.visitId ? liste.filter((x) => x.visitId !== b.visitId) : liste.filter((x) => x.id !== b.id);
  return [...autres, b];
}

/**
 * QUE DEVIENT UN BROUILLON après une tentative. `null` = il part de la file (le serveur l'a pris).
 * `enLigneAvant` : le téléphone se disait-il en ligne au moment d'envoyer ?
 */
export function apresEnvoi(b: BrouillonVisite, issue: IssueEnvoiBrouillon, enLigneAvant: boolean): BrouillonVisite | null {
  if (issue.kind === "OK") return null;
  if (issue.kind === "REFUS") return { ...b, tentatives: b.tentatives + 1, etat: "REFUSE", erreur: issue.erreur };
  // RÉSEAU : sûr de ne pas être parti (hors ligne avant l'envoi), ou rapport rejouable → il attend le retour.
  if (!enLigneAvant || b.sorte === "RAPPORT") return { ...b, tentatives: b.tentatives + 1, etat: "EN_ATTENTE", erreur: null };
  return {
    ...b, tentatives: b.tentatives + 1, etat: "A_VERIFIER",
    erreur: "L'envoi s'est interrompu : la visite a peut-être été enregistrée. Vérifiez « Mes dernières visites » avant de renvoyer.",
  };
}

/** Ce qui part au retour du réseau, le plus ancien d'abord. */
export function aEnvoyer(liste: readonly BrouillonVisite[]): BrouillonVisite[] {
  return liste.filter((b) => b.etat === "EN_ATTENTE").sort((a, b) => a.creeLe - b.creeLe);
}

/** La phrase de l'indicateur — « 1 rapport en attente d'envoi » — ou null quand rien n'attend. */
export function phraseAttente(liste: readonly BrouillonVisite[]): string | null {
  const n = liste.filter((b) => b.etat === "EN_ATTENTE").length;
  if (n === 0) return null;
  return n === 1 ? "1 rapport en attente d'envoi" : `${n} rapports en attente d'envoi`;
}

/** Relit la file stockée ; ce qui ne se relit pas est ignoré plutôt que de casser l'écran. */
export function lireBrouillons(brut: string | null): BrouillonVisite[] {
  if (!brut) return [];
  try {
    const v: unknown = JSON.parse(brut);
    if (!Array.isArray(v)) return [];
    return v.filter((b): b is BrouillonVisite =>
      typeof b === "object" && b !== null
      && typeof (b as BrouillonVisite).id === "string"
      && ((b as BrouillonVisite).sorte === "RAPPORT" || (b as BrouillonVisite).sorte === "HORS_PLAN")
      && Array.isArray((b as BrouillonVisite).champs)
      && ["EN_ATTENTE", "A_VERIFIER", "REFUSE"].includes((b as BrouillonVisite).etat));
  } catch {
    return [];
  }
}

/** Les champs d'un formulaire, réduits à leur texte (aucun fichier dans un rapport de visite). */
export function champsDuFormulaire(entrees: Iterable<[string, unknown]>): [string, string][] {
  const out: [string, string][] = [];
  for (const [k, v] of entrees) if (typeof v === "string") out.push([k, v]);
  return out;
}
