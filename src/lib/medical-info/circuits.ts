/**
 * DEUX CIRCUITS DANS L'INFORMATION MÉDICALE — et ils ne se ressemblent pas.
 *
 * ── CE QU'ON CORRIGE ────────────────────────────────────────────────────────────────────────
 *
 * Le module traitait tout de la même façon : quoi qu'il arrive au pharmacien responsable (PRIM),
 * il fallait un BON DE VERSEMENT — demande, validation, quittance payée, quittance remise — avant
 * de pouvoir déclarer quoi que ce soit aux autorités. Or cette taxe ne concerne QUE le matériel
 * promotionnel. Une prise en charge de congrès, un sponsoring, un événement n'appellent aucun
 * versement : ils appellent une question, et une seule — **faut-il le déclarer ?**
 *
 * Le coût de la confusion était réel : chaque dossier d'événement passait par la porte de sortie
 * « ce dossier n'appelle aucun versement », motif à l'appui. Un contournement obligatoire n'est
 * plus une porte de sortie, c'est le chemin normal mal nommé — et l'on finit par ne plus lire les
 * motifs, qui sont pourtant là pour signaler l'exception.
 *
 * ── LES DEUX CIRCUITS ───────────────────────────────────────────────────────────────────────
 *
 * **ÉVÉNEMENT** (prise en charge nationale, internationale, événement, sponsoring) :
 *
 *     le PRIM demande la validation de ce qu'il compte faire — déclarer, ou ne pas déclarer
 *       → accordée
 *       → il réclame les pièces qui lui manquent (facultatif)
 *       → il fait le nécessaire auprès du ministère de l'Industrie pharmaceutique
 *       → il valide l'événement
 *
 * **MATÉRIEL PROMOTIONNEL** (la catégorie, ou un poste de matériel dans un événement) :
 *
 *     le PRIM réclame les pièces qui lui manquent (facultatif)
 *       → il SÉPARE le dossier en matériels — un bon de versement par matériel
 *       → il demande UNE validation pour le dépôt de ces bons
 *       → accordée, il demande le paiement de CHAQUE bon séparément
 *       → chaque quittance réglée lui est remise
 *
 * ── POURQUOI LA NATURE DÉCIDE, ET NON UNE CASE ──────────────────────────────────────────────
 *
 * Le circuit se DÉDUIT de ce qu'on déclare. Une case à cocher aurait laissé deux dossiers
 * identiques suivre deux chemins différents parce que quelqu'un a coché de travers, et rien à
 * l'écran ne l'aurait dit. Ici, un sponsoring ne peut PAS se retrouver dans le circuit du
 * versement : il n'y a pas de geste pour l'y mettre.
 *
 * Module PUR : ni base, ni session. Testé.
 */

export type MedicalCircuit = "EVENT" | "PROMO";

/** Ce qui relève du circuit ÉVÉNEMENT — la question « faut-il déclarer ? », sans versement. */
export const EVENT_SOURCES: readonly string[] = [
  "SPONSORING", "CONGRESS_NATIONAL", "CONGRESS_INTERNATIONAL", "EVENT",
];

/** Ce qui relève du circuit MATÉRIEL PROMOTIONNEL — les bons de versement, un par matériel. */
export const PROMO_SOURCES: readonly string[] = ["PROMO_MATERIAL"];

/**
 * LE CIRCUIT D'UN DOSSIER, déduit de sa nature.
 *
 * Défaut ÉVÉNEMENT : une nature inconnue — un type ajouté demain, un dossier repris d'un import —
 * ne doit pas se retrouver à réclamer une taxe qu'elle ne doit peut-être pas. Le circuit
 * événement demande une décision à un humain ; le circuit promotionnel engage de l'argent. En cas
 * de doute, on va vers celui qui demande, pas vers celui qui dépense.
 */
export function circuitOf(sourceType: string): MedicalCircuit {
  return PROMO_SOURCES.includes(sourceType) ? "PROMO" : "EVENT";
}

/** Ce dossier passe-t-il par des bons de versement ? Le matériel promotionnel, et lui seul. */
export function usesPaymentSlips(sourceType: string): boolean {
  return circuitOf(sourceType) === "PROMO";
}

/** Ce dossier passe-t-il par la question « faut-il le déclarer ? » ? Les événements. */
export function usesDeclareDecision(sourceType: string): boolean {
  return circuitOf(sourceType) === "EVENT";
}

export const CIRCUIT_LABEL: Record<MedicalCircuit, string> = {
  EVENT: "Événements & prises en charge",
  PROMO: "Matériel promotionnel",
};

/** Ce que le circuit exige, dit en une phrase — sur l'onglet comme sur la fiche. */
export const CIRCUIT_HINT: Record<MedicalCircuit, string> = {
  EVENT:
    "Prises en charge nationales et internationales, événements, sponsorings. Pas de bon de versement : "
    + "le pharmacien fait valider par le Directeur des Opérations s'il y a lieu de déclarer, puis fait le nécessaire auprès du ministère "
    + "de l'Industrie pharmaceutique.",
  PROMO:
    "Le dossier se sépare en matériels, un bon de versement par matériel. Une validation du Directeur des Opérations couvre le dépôt "
    + "des bons ; le paiement de chacun se demande ensuite séparément.",
};

/** Range une liste de dossiers dans ses deux familles, en préservant l'ordre reçu. */
export function splitByCircuit<T extends { sourceType: string; declarationKind?: string | null }>(
  rows: readonly T[],
): Record<MedicalCircuit, T[]> {
  const out: Record<MedicalCircuit, T[]> = { EVENT: [], PROMO: [] };
  for (const r of rows) out[circuitOfDeclaration(r)].push(r);
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// CE QUE LE PRIM CRÉE LUI-MÊME
// ═══════════════════════════════════════════════════════════════════════════════════════════

/**
 * LE PRIM N'ATTEND PAS TOUJOURS QU'UN DOSSIER LUI ARRIVE.
 *
 * Une obligation réglementaire se découvre aussi de son côté : un support à faire viser, une
 * déclaration au ministère qu'aucun événement n'a déclenchée, un versement à faire. Il n'avait
 * pour cela aucun geste — le module ne se remplissait que par la validation d'un autre — et ce
 * qui n'entre pas dans l'ERP se traite dans un carnet.
 *
 * Il choisit donc CE QU'IL OUVRE, et ce choix décide du circuit : un visa publicitaire relève du
 * matériel promotionnel, une déclaration au ministère de l'événement.
 *
 * ── DEUX NATURES, PLUS TROIS ────────────────────────────────────────────────────────────────
 *
 * « Bon de versement » en était une troisième, et c'était une confusion de niveau : le bon de
 * versement n'est pas ce qu'on OUVRE, c'est une ÉTAPE du circuit du matériel — un bon par
 * support, validés ensemble, payés séparément. Le proposer à l'ouverture faisait choisir entre
 * un dossier et l'une de ses pièces, et les deux natures ouvraient de toute façon exactement le
 * même circuit. Ce qu'on ouvre est donc : une déclaration au ministère, ou une demande de visa.
 *
 * La nature reste RECONNUE en lecture — voir `DECLARATION_KINDS` — parce qu'un dossier
 * historique doit continuer de se lire et de suivre SON circuit. Ce qui disparaît, c'est la
 * possibilité d'en ouvrir un nouveau : `OPENABLE_DECLARATION_KINDS`.
 */
export type DeclarationKind = "MIP" | "AD_VISA" | "PAYMENT_SLIP";

export const DECLARATION_KIND_LABEL: Record<DeclarationKind, string> = {
  MIP: "Déclaration au ministère (MIP)",
  AD_VISA: "Demande de visa publicitaire",
  PAYMENT_SLIP: "Bon de versement",
};

export const DECLARATION_KIND_HINT: Record<DeclarationKind, string> = {
  MIP: "Une obligation à déclarer au ministère de l'Industrie pharmaceutique. Vous ferez valider s'il y a lieu de déclarer, puis vous déposerez.",
  AD_VISA: "Un support promotionnel à faire viser. Le dossier suit le circuit du matériel : matériels, bons de versement, paiements.",
  PAYMENT_SLIP: "Un versement à faire. Le dossier suit le circuit du matériel : un bon par matériel, validés ensemble, payés séparément.",
};

/**
 * TOUTES les natures RECONNUES — lecture, libellés, circuit.
 *
 * `PAYMENT_SLIP` y reste bien qu'on ne puisse plus en ouvrir : la retirer d'ici ferait retomber
 * un dossier historique sur le circuit par défaut (ÉVÉNEMENT), c'est-à-dire lui faire perdre ses
 * bons de versement en cours de route. Une nature qu'on cesse de proposer ne cesse pas d'exister.
 */
export const DECLARATION_KINDS: readonly DeclarationKind[] = ["MIP", "AD_VISA", "PAYMENT_SLIP"];

/**
 * CE QUE LE PRIM PEUT OUVRIR AUJOURD'HUI — et c'est cette liste que l'écran propose ET que le
 * serveur exige. Deux listes séparées auraient laissé le formulaire proposer ce que l'action
 * refuse, ou l'inverse.
 */
export const OPENABLE_DECLARATION_KINDS: readonly DeclarationKind[] = ["MIP", "AD_VISA"];

export function isDeclarationKind(v: unknown): v is DeclarationKind {
  return typeof v === "string" && (DECLARATION_KINDS as readonly string[]).includes(v);
}

/** Peut-on OUVRIR un dossier de cette nature ? Le bon de versement, non — c'est une étape. */
export function isOpenableDeclarationKind(v: unknown): v is DeclarationKind {
  return typeof v === "string" && (OPENABLE_DECLARATION_KINDS as readonly string[]).includes(v);
}

/**
 * LE CIRCUIT D'UN DOSSIER QUE LE PRIM OUVRE LUI-MÊME.
 *
 * C'est la nature choisie qui décide — pas une seconde case. Déclarer au ministère est le circuit
 * événement ; un visa ou un versement, celui du matériel promotionnel.
 */
export function circuitOfKind(kind: DeclarationKind): MedicalCircuit {
  return kind === "MIP" ? "EVENT" : "PROMO";
}

/**
 * LE CIRCUIT D'UN DOSSIER, QUELLE QUE SOIT SON ORIGINE — la seule fonction que l'écran appelle.
 *
 * PRÉCÉDENCE : la nature CHOISIE l'emporte sur le type de source. Un dossier ouvert par le PRIM
 * n'a pas d'événement derrière lui : sa source dit « déclaration d'information médicale », ce qui
 * ne décrit rien du chemin à suivre. Ce qu'il a choisi, si.
 *
 * Pour tout le reste — les dossiers qui arrivent d'un événement ou du matériel promotionnel — la
 * source décide, et il n'existe aucun geste pour la contredire.
 */
export function circuitOfDeclaration(d: { sourceType: string; declarationKind?: string | null }): MedicalCircuit {
  if (isDeclarationKind(d.declarationKind)) return circuitOfKind(d.declarationKind);
  return circuitOf(d.sourceType);
}

/**
 * L'ORDRE DE DÉPENSE GLOBAL À LA VALIDATION FINALE — seulement là où rien d'autre ne porte la dépense.
 *
 * La validation finale émettait un ordre du « montant » de la déclaration, quelle qu'en soit
 * l'origine. Or :
 *   · un dossier OUVERT PAR LE PRIM (MIP, visa publicitaire) n'a ni événement ni pièce derrière lui :
 *     son « montant » est une saisie libre, et un ordre bâti dessus serait de l'argent sans justificatif ;
 *   · une NATURE choisie (MIP, visa) et le CIRCUIT MATÉRIEL ont leurs propres paiements — les bons de
 *     versement, la facture du matériel déjà réglée par le dossier promotionnel : un ordre de plus
 *     paierait la même dépense deux fois ;
 *   · un ordre DÉJÀ ÉMIS (la déclaration née sans pharmacien, après que l'ordre est parti) ne se
 *     double pas.
 * Restent les dossiers d'ÉVÉNEMENT venus d'Ad & Pro (sponsoring, prises en charge, événements), dont
 * la demande source est la pièce — et encore, pas quand leurs postes portent la dépense (§118.151,
 * vérifié par l'action). Module PUR, testé.
 */
export function ordreGlobalALaValidation(d: { sourceType: string; declarationKind?: string | null; expenseOrderId?: string | null }): boolean {
  if (d.expenseOrderId) return false;
  if (d.declarationKind) return false;
  if (d.sourceType === "MEDICAL_INFO_DECLARATION" || d.sourceType === "LEGAL_DOCUMENT") return false;
  return circuitOfDeclaration(d) === "EVENT";
}
