/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * CE QUI PEUT ÊTRE DÉFAIT, ET CE QUI NE LE PEUT PAS (mandat 6 §48) — pur, sans base ni droits.
 *
 * ── LA PHRASE QUI ORGANISE TOUT LE MODULE ───────────────────────────────────────────────
 *
 * « Annule ce qu'Adam a modifié sur ce dossier hier » est une demande RAISONNABLE à laquelle
 * la seule réponse honnête est souvent PARTIELLE. Le champ « statut » revient à sa valeur ;
 * l'e-mail parti chez le partenaire, non. Un système qui répondrait « c'est annulé » aurait
 * menti sur la moitié de la phrase, et le mensonge ne se verrait qu'au moment où le partenaire
 * répond à un message censé ne pas exister.
 *
 * D'où la règle : **on ne dit jamais « annulé » pour un lot. On dit ce qui l'est, ce qui ne
 * peut pas l'être, et ce qu'on peut faire À LA PLACE.** Les trois listes sortent ensemble.
 *
 * ── POURQUOI QUATRE RÉPONSES ET PAS DEUX ────────────────────────────────────────────────
 *
 * « Réversible / irréversible » perd l'essentiel. Entre les deux vivent deux cas nombreux :
 *
 *   · LA COMPENSATION. Le geste ne se retire pas, mais un geste INVERSE existe et fait le
 *     travail : un e-mail de rectification, un avoir sur une facture, une tâche annulée avec
 *     sa raison. Ce n'est pas la même chose qu'annuler — la trace des deux gestes reste — et
 *     c'est très souvent ce que la personne veut vraiment.
 *   · LA DÉLÉGATION. Un autre module SAIT DÉJÀ défaire cela, mieux que nous : Live Office
 *     annule une retouche de document en REJOUANT les opérations non annulées (§104.3), et
 *     Teach Adam désactive une règle par version (§31). Réimplémenter ici serait le début
 *     d'un second mécanisme d'annulation, qui divergerait du premier au premier correctif.
 *
 * ── CE QUE CE MODULE N'A PAS LE DROIT DE FAIRE ──────────────────────────────────────────
 *
 * Décider. Il CLASSE. L'application appartient au pont, sous les droits de la personne, par
 * les mêmes chemins d'écriture que l'écran — une annulation n'est pas une porte dérobée, et
 * une annulation est elle-même un changement, journalisé comme tel. On ne réécrit pas
 * l'histoire : on écrit une ligne de plus.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Ce qu'un geste passé a fait — la matière du classement. */
export const NATURES_GESTE = [
  /** Un champ d'un enregistrement a changé : `AuditLog` porte l'ancienne valeur. */
  "CHAMP_MODIFIE",
  /** Un enregistrement est né. */
  "ENREGISTREMENT_CREE",
  /** Un enregistrement a disparu. */
  "ENREGISTREMENT_SUPPRIME",
  /** Un message est parti chez quelqu'un — e-mail, notification, push. */
  "MESSAGE_ENVOYE",
  /** Un document Office a été retouché. */
  "DOCUMENT_MODIFIE",
  /** Un fichier a bougé, été renommé ou rangé. */
  "FICHIER_DEPLACE",
  /** Une règle Teach Adam a été posée ou changée. */
  "REGLE_ENSEIGNEE",
  /** De l'argent est parti, ou un ordre a été transmis à la banque. */
  "PAIEMENT_EXECUTE",
  /** Une signature électronique a été demandée à un tiers. */
  "SIGNATURE_DEMANDEE",
  /** Un dossier a été déposé à une autorité. */
  "DEPOT_AUTORITE",
] as const;
export type NatureGeste = (typeof NATURES_GESTE)[number];

export const REVERSIBILITES = [
  /** On réécrit l'ancienne valeur — à condition que personne ne l'ait touchée depuis. */
  "REVERSIBLE",
  /** Un autre module sait le défaire : on l'appelle, on ne le refait pas. */
  "DELEGUEE",
  /** Le geste reste, un geste INVERSE le corrige : rectificatif, avoir, annulation motivée. */
  "PAR_COMPENSATION",
  /** Rien ne le défait ni ne le compense utilement. Le dire est la seule conduite juste. */
  "IRREVERSIBLE",
] as const;
export type Reversibilite = (typeof REVERSIBILITES)[number];

export interface Verdict {
  reversibilite: Reversibilite;
  /** POURQUOI — la phrase à montrer, pas un code. */
  raison: string;
  /** Quand ce n'est pas réversible : ce qu'on peut faire à la place, en français. */
  compensation: string | null;
  /** Quand c'est délégué : le module qui sait faire, pour que personne ne le réécrive ici. */
  delegueA: string | null;
}

/**
 * LA TABLE, ET LE FAIT QU'ELLE SOIT UNE TABLE.
 *
 * Chaque ligne est une décision qu'on peut lire, contester et changer sans toucher au code
 * qui l'applique. Un `switch` de deux cents lignes dirait la même chose et cacherait la
 * doctrine dans du contrôle de flux.
 */
const TABLE: Readonly<Record<NatureGeste, Verdict>> = {
  CHAMP_MODIFIE: {
    reversibilite: "REVERSIBLE",
    raison: "l'ancienne valeur est dans le journal d'audit — la réécrire suffit",
    compensation: null,
    delegueA: null,
  },
  ENREGISTREMENT_CREE: {
    reversibilite: "PAR_COMPENSATION",
    raison: "supprimer un enregistrement effacerait aussi ce qui s'y est accroché depuis (pièces, liens, commentaires)",
    compensation: "le passer à ANNULÉ avec sa raison — la trace reste, l'effet cesse",
    delegueA: null,
  },
  ENREGISTREMENT_SUPPRIME: {
    reversibilite: "PAR_COMPENSATION",
    raison: "un enregistrement recréé porterait un nouvel identifiant : les liens vers l'ancien resteraient cassés",
    compensation: "recréer avec les valeurs journalisées, puis rattacher à la main ce qui pointait vers l'ancien",
    delegueA: null,
  },
  MESSAGE_ENVOYE: {
    reversibilite: "IRREVERSIBLE",
    raison: "le message est chez son destinataire ; rien ici ne peut l'y reprendre, et il a pu être lu",
    compensation: "envoyer un rectificatif au MÊME destinataire, en disant ce qui était faux",
    delegueA: null,
  },
  DOCUMENT_MODIFIE: {
    reversibilite: "DELEGUEE",
    raison: "l'état d'un document est un REJEU des opérations non annulées, pas un instantané",
    compensation: null,
    delegueA: "Live Office (§104.3) — marquer l'opération annulée et rejouer",
  },
  FICHIER_DEPLACE: {
    reversibilite: "REVERSIBLE",
    raison: "l'ancien emplacement est journalisé — le fichier y retourne",
    compensation: null,
    delegueA: null,
  },
  REGLE_ENSEIGNEE: {
    reversibilite: "DELEGUEE",
    raison: "les règles sont versionnées : on désactive la version, on n'efface pas l'apprentissage",
    compensation: null,
    delegueA: "Teach Adam (§31) — désactiver la version, la précédente reprend",
  },
  PAIEMENT_EXECUTE: {
    reversibilite: "IRREVERSIBLE",
    raison: "l'ordre est parti à la banque : ce système ne peut ni le rappeler ni savoir s'il a été honoré",
    compensation: "enregistrer une opération inverse et prévenir la banque par le canal habituel — ce n'est PAS une annulation",
    delegueA: null,
  },
  SIGNATURE_DEMANDEE: {
    reversibilite: "PAR_COMPENSATION",
    raison: "la demande est chez le signataire ; elle a pu être ouverte, voire signée",
    compensation: "révoquer la demande chez le prestataire et prévenir le signataire",
    delegueA: null,
  },
  DEPOT_AUTORITE: {
    reversibilite: "IRREVERSIBLE",
    raison: "un dossier déposé appartient à l'autorité — son retrait est une démarche, pas un clic",
    compensation: "préparer un courrier de retrait ou de correction, à envoyer par la voie officielle",
    delegueA: null,
  },
};

export function classerGeste(nature: NatureGeste): Verdict {
  return TABLE[nature];
}

/**
 * DE L'ACTION À SA NATURE.
 *
 * Le journal ne porte pas la nature : il porte un `action` (CREATE / UPDATE / DELETE), un
 * `module` et un `summary`. La signature la plus PRÉCISE gagne, et l'ordre est le classement :
 * un paiement exécuté est un UPDATE du champ `status`, et le ranger en CHAMP_MODIFIE le
 * rendrait « réversible » — c'est-à-dire qu'Adam proposerait de dé-payer un fournisseur.
 */
const SIGNATURES: readonly { nature: NatureGeste; re: RegExp }[] = [
  { nature: "PAIEMENT_EXECUTE", re: /\b(virement (?:[ée]mis|ex[ée]cut)|paiement (?:ex[ée]cut|[ée]mis|envoy)|ordre de paiement|remise en banque|PAID|EXECUTED)\b/i },
  { nature: "DEPOT_AUTORITE", re: /\b(d[ée]p[oô]t (?:ANPP|autorit|dossier)|soumis(?:sion)? (?:[àa] l'|au )?(?:ANPP|autorit)|SUBMITTED)\b/i },
  { nature: "SIGNATURE_DEMANDEE", re: /\b(signature (?:[ée]lectronique|demand|envoy)|DocuSign|parapheur|[àa] signer)\b/i },
  { nature: "MESSAGE_ENVOYE", re: /\b(e-?mail (?:envoy|parti)|message envoy|notification envoy|relance envoy|courriel|push envoy)\b/i },
  { nature: "REGLE_ENSEIGNEE", re: /\b(r[èe]gle|playbook|pr[ée]f[ée]rence|Teach Adam|politique enseign)\b/i },
  { nature: "DOCUMENT_MODIFIE", re: /\b(document (?:modifi|retouch)|\.docx|\.xlsx|\.pptx|paragraphe|diapositive|feuille de calcul)\b/i },
  { nature: "FICHIER_DEPLACE", re: /\b(d[ée]plac|renomm|rang[ée]|class[ée] dans|archiv[ée])\b/i },
];

/**
 * Rend la nature d'un geste à partir de ce que le journal en dit. `action` tranche en dernier :
 * une signature textuelle précise l'emporte TOUJOURS sur le verbe générique.
 */
export function natureDe(input: { action: string; module?: string | null; resume?: string | null; champ?: string | null }): NatureGeste {
  const texte = [input.module ?? "", input.resume ?? "", input.champ ?? ""].join(" ");
  for (const s of SIGNATURES) if (s.re.test(texte)) return s.nature;
  const a = input.action.toUpperCase();
  if (a === "CREATE") return "ENREGISTREMENT_CREE";
  if (a === "DELETE") return "ENREGISTREMENT_SUPPRIME";
  return "CHAMP_MODIFIE";
}

// K10 (décision 0038) : les annulations DÉCLARÉES des actions que l'ERP a rendues réversibles — le port du registre.
export { annulationDeclaree } from "@/lib/effets/declarations";
