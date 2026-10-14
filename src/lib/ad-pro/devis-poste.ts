import { totauxTaxes, lignesDuBonDeCommande, ecartDeRetranscription, formatDzd, type DevisLu, type Totaux } from "@/lib/promo-material/devis";
import type { EtapeBC } from "@/lib/bons-de-commande/regle";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES LIGNES D'UN DEVIS DE POSTE, ET LE BON DE COMMANDE QU'ELLES FONT GÉNÉRER (§118.206).
 *
 * « Quand un devis ou une pro forma est validé entièrement, dans la case Bon de commande, on peut
 * soit GÉNÉRER avec un petit CTA, soit UPLOADER. Il se peut qu'il y ait eu plusieurs devis, et
 * différentes références dans chaque devis qui soient validées : alors ça peut demander de générer
 * UN BC PAR DEVIS (incluant UNIQUEMENT les références validées). S'il oublie une référence, il peut
 * juste la cocher dans le devis et RÉGÉNÉRER le BC. » (Direction, 05/10.)
 *
 * Ce module est PUR (aucune base) : il dit ce qui se VALIDE, ce qu'un BC PORTE, et ce qu'il y a à
 * FAIRE entre les lignes validées d'un devis et le bon de commande qui en découle. L'écran et les
 * actions lisent la MÊME décision — deux lectures de « ce BC est-il à jour ? » finiraient par répondre
 * autrement, et la carte offrirait un geste que l'action refuse (§118.5, §118.83).
 *
 * ── LES TROIS RÈGLES QUI LE TIENNENT ────────────────────────────────────────────────────────
 *
 * 1. UNE LIGNE LUE EST UNE PROPOSITION. Elle ne se valide que complète — une quantité et un prix
 *    lisibles — et par une personne. Un chiffre illisible n'est jamais deviné (§118.16).
 * 2. UNE LIGNE NE SE COMMANDE QU'UNE FOIS : elle est validée pour UN poste, jamais deux. Un devis
 *    qui couvre trois postes ne fait pas payer trois fois la même ligne.
 * 3. UN BC SIGNÉ NE SE RÉÉCRIT PAS. Tant que le BC n'est ni signé ni facturé, régénérer le RÉVISE
 *    (même numéro, version suivante) ; après, il engage la société et le refus nomme le geste.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface LigneDevisPoste {
  id: string;
  position: number;
  reference: string;
  unit: string | null;
  /** `null` : illisible — la ligne attend d'être complétée. */
  quantity: number | null;
  unitPrice: number | null;
  /** Le rang de la ligne lue dont elle vient ; `null` : saisie à la main. */
  lue: number | null;
  aVerifier: string | null;
  validatedItemId: string | null;
  bcId: string | null;
}

export interface EnteteDevisPoste {
  /**
   * En POUR CENT (19), TEL QU'IMPRIMÉ. `null` : le devis n'indique aucune TVA — elle n'est JAMAIS devinée, et
   * « s'il n'y a pas de TVA renseignée, il n'y a pas de TVA » (Direction, 06/10) : comptée 0, le bon de commande
   * se génère sans TVA, et les montants sont ceux du papier.
   */
  tvaRate: number | null;
  extraTaxLabel: string | null;
  /** En POUR CENT. */
  extraTaxRate: number | null;
  announcedTotal: number | null;
}

/** Le BC actif d'un devis pour un poste — ce que la décision lit de lui. */
export interface BcActifDuDevis {
  id: string;
  reference: string | null;
  etape: EtapeBC | null;
  /** Signé par les Finances : il engage la société. */
  signe: boolean;
  /** Le nom de la facture qui en découle (non annulée), ou `null`. */
  facture: string | null;
}

const cents = (x: number): number => Math.round(x * 100);

const nomBc = (b: Pick<BcActifDuDevis, "reference">): string => b.reference?.trim() || "du devis";

/** Une quantité ou un prix lisibles : un nombre fini. */
const lisible = (n: number | null): n is number => typeof n === "number" && Number.isFinite(n);

/**
 * UNE LIGNE SE VALIDE-T-ELLE ? — `null` si oui, sinon ce qui manque. Complète : une désignation, une
 * quantité strictement positive, un prix unitaire positif ou nul. Un chiffre illisible reste à
 * saisir depuis le papier : deviner ferait commander un prix que personne n'a lu.
 */
export function refusValidationLigne(l: Pick<LigneDevisPoste, "reference" | "quantity" | "unitPrice">): string | null {
  const nom = l.reference.trim() ? `« ${l.reference.trim().slice(0, 60)} »` : "une ligne sans désignation";
  if (!l.reference.trim()) return "Une ligne sans désignation ne se valide pas : renseignez la référence ou la désignation.";
  if (!lisible(l.quantity) || !(l.quantity > 0)) return `${nom} : la quantité est illisible ou nulle — saisissez-la depuis le devis avant de valider la ligne.`;
  if (!lisible(l.unitPrice) || l.unitPrice < 0) return `${nom} : le prix unitaire est illisible — saisissez-le depuis le devis avant de valider la ligne.`;
  return null;
}

/** Les lignes validées POUR CE POSTE, dans l'ordre du devis — et seulement celles qui sont complètes. */
export function lignesValidees(lignes: readonly LigneDevisPoste[], itemId: string): LigneDevisPoste[] {
  return lignes
    .filter((l) => l.validatedItemId === itemId && refusValidationLigne(l) === null)
    .sort((a, b) => a.position - b.position);
}

/** Le devis tel que le calcul des montants du matériel promotionnel le lit — la MÊME arithmétique (§118.5). */
export function devisPourCalcul(
  entete: EnteteDevisPoste, lignes: readonly LigneDevisPoste[], retenue: (l: LigneDevisPoste) => boolean,
): DevisLu {
  return {
    id: "devis-de-poste", supplierId: null, supplierName: "", reference: null,
    // TVA non indiquée → 0 pour le CALCUL (aucune taxe n'est ajoutée) ; l'absence se DIT ailleurs (`tvaRate === null`).
    tvaRate: entete.tvaRate ?? 0, extraTaxLabel: entete.extraTaxLabel, extraTaxRate: entete.extraTaxRate,
    announcedTotal: entete.announcedTotal, documentId: null,
    lines: lignes.map((l) => ({
      id: l.id, position: l.position, reference: l.reference, unit: l.unit,
      quantity: lisible(l.quantity) ? l.quantity : 0, unitPrice: lisible(l.unitPrice) ? l.unitPrice : 0,
      selected: retenue(l),
    })),
  };
}

/** Les totaux (HT, TVA, taxe, TTC) des lignes validées pour ce poste dans ce devis. */
export function totauxValides(entete: EnteteDevisPoste, lignes: readonly LigneDevisPoste[], itemId: string): Totaux {
  const gardees = lignesValidees(lignes, itemId);
  return totauxTaxes({ ...entete, tvaRate: entete.tvaRate ?? 0 }, gardees.map((l) => ({ quantity: l.quantity as number, unitPrice: l.unitPrice as number })));
}

/** Les totaux du devis ENTIER tel que lu — pour le comparer au total imprimé. */
export function totauxDuDevisLu(entete: EnteteDevisPoste, lignes: readonly LigneDevisPoste[]): Totaux {
  const completes = lignes.filter((l) => lisible(l.quantity) && lisible(l.unitPrice));
  return totauxTaxes({ ...entete, tvaRate: entete.tvaRate ?? 0 }, completes.map((l) => ({ quantity: l.quantity as number, unitPrice: l.unitPrice as number })));
}

/**
 * LE CONTRÔLE DES LIGNES CONTRE LE TOTAL IMPRIMÉ (§118.59) — `null` quand rien ne dit le contraire, ou
 * quand on ne sait pas : sans total imprimé ou avec une ligne illisible, on ne déclare pas d'écart sur
 * ce qu'on n'a pas lu. Tolérance d'un dinar, comme la retranscription du matériel promotionnel.
 */
export function ecartAvecLeTotalImprime(entete: EnteteDevisPoste, lignes: readonly LigneDevisPoste[]): { annonce: number; calcule: number; ecart: number } | null {
  if (entete.announcedTotal == null) return null;
  if (lignes.some((l) => !lisible(l.quantity) || !lisible(l.unitPrice))) return null;
  return ecartDeRetranscription(devisPourCalcul(entete, lignes, () => true));
}

/** Les lignes que le BC portera, dans la forme de la fabrique — les validées, rien d'autre. */
export function lignesDuBon(entete: EnteteDevisPoste, lignes: readonly LigneDevisPoste[], itemId: string) {
  const gardees = new Set(lignesValidees(lignes, itemId).map((l) => l.id));
  return lignesDuBonDeCommande(devisPourCalcul(entete, lignes, (l) => gardees.has(l.id)));
}

// ───────────────────────── Ce qu'il y a à faire entre les lignes et le BC ─────────────────────────

/**
 * L'ÉTAT D'UN DEVIS VIS-À-VIS DE SON BON DE COMMANDE, POUR UN POSTE.
 *
 *   • AUCUNE_LIGNE — aucune ligne validée pour ce poste, et pas de BC : rien à faire ;
 *   • A_GENERER — des lignes validées, pas de BC actif : le BC est à générer ;
 *   • A_JOUR — le BC porte EXACTEMENT les lignes validées ;
 *   • A_REGENERER — des lignes ont été ajoutées ou retirées depuis : régénérer RÉVISE le même BC ;
 *   • FIGE — il faudrait régénérer, mais le BC est signé ou facturé : le refus nomme le geste ;
 *   • A_ANNULER — plus aucune ligne n'est validée alors qu'un BC existe : on l'annule, on ne le vide pas.
 *   • MIS_A_PART — des lignes validées, pas de BC, mais le devis ne compte pas : c'est la COPIE d'une pièce déjà
 *     comptée, ou une proposition d'un voyageur qui n'est pas la retenue (`devisMisAPart`). Rien à générer pour lui.
 */
export type EtatBcDuDevis = "AUCUNE_LIGNE" | "A_GENERER" | "A_JOUR" | "A_REGENERER" | "FIGE" | "A_ANNULER" | "MIS_A_PART";

export interface DecisionBcDuDevis {
  etat: EtatBcDuDevis;
  /** Les lignes validées qui ne sont pas encore sur le BC (ou toutes, sans BC). */
  ajoutees: string[];
  /** Les lignes que le BC porte et qui ne sont plus validées pour ce poste. */
  retirees: string[];
  /** Pourquoi on ne peut pas (FIGE, A_ANNULER) — avec le geste qui reste. */
  refus: string | null;
}

/**
 * LE REFUS D'UN BC FIGÉ — il nomme le BC, ce qui le fige, et le geste qui reste (§118.30). Une seule
 * phrase pour la génération, la validation d'une ligne et la carte (§118.5).
 */
export function refusBcFige(bc: BcActifDuDevis): string {
  if (bc.facture) {
    return `Une facture (${bc.facture}) découle déjà du bon de commande ${nomBc(bc)} : il ne se réécrit plus. Annulez d'abord la facture dans Legal si l'erreur est bien là.`;
  }
  return `Le bon de commande ${nomBc(bc)} est signé par les Finances : il engage la société, il ne se réécrit plus d'ici. `
    + "Voyez avec les Finances pour le remplacer — ou joignez un bon de commande existant.";
}

export function decisionBcDuDevis(
  lignes: readonly LigneDevisPoste[], itemId: string, bc: BcActifDuDevis | null,
): DecisionBcDuDevis {
  const validees = lignesValidees(lignes, itemId).map((l) => l.id);
  if (!bc) {
    return validees.length > 0
      ? { etat: "A_GENERER", ajoutees: validees, retirees: [], refus: null }
      : { etat: "AUCUNE_LIGNE", ajoutees: [], retirees: [], refus: null };
  }
  const couvertes = lignes.filter((l) => l.bcId === bc.id).map((l) => l.id);
  const ajoutees = validees.filter((id) => !couvertes.includes(id));
  const retirees = couvertes.filter((id) => !validees.includes(id));
  if (ajoutees.length === 0 && retirees.length === 0) return { etat: "A_JOUR", ajoutees, retirees, refus: null };
  if (bc.signe || bc.facture) return { etat: "FIGE", ajoutees, retirees, refus: refusBcFige(bc) };
  if (validees.length === 0) {
    return {
      etat: "A_ANNULER", ajoutees, retirees,
      refus: `Plus aucune ligne n'est validée pour le bon de commande ${nomBc(bc)} : annulez-le (« Annuler la demande de BC ») plutôt que de le vider.`,
    };
  }
  return { etat: "A_REGENERER", ajoutees, retirees, refus: null };
}

/**
 * CE QUI GÈLE LA VALIDATION D'UNE LIGNE — tant qu'un BC signé ou facturé porte ce devis pour ce poste,
 * l'ensemble de ses lignes validées ne bouge plus : ajouter une ligne que le BC ne porte pas serait la
 * laisser validée pour toujours sans qu'aucun BC puisse la commander (une impasse, §118.63).
 */
export function refusChangementDeValidation(bc: BcActifDuDevis | null): string | null {
  if (!bc || !(bc.signe || bc.facture)) return null;
  return `${refusBcFige(bc)} Les lignes validées de ce devis ne changent plus tant qu'il tient.`;
}

/** Une ligne peut-elle être modifiée ou le devis relu ? Pas tant qu'un BC actif en tient une. */
export function refusEditionDesLignes(lignes: readonly LigneDevisPoste[], bcActifs: readonly Pick<BcActifDuDevis, "id" | "reference">[]): string | null {
  const actifs = new Set(bcActifs.map((b) => b.id));
  const portees = lignes.filter((l) => l.bcId && actifs.has(l.bcId));
  if (portees.length === 0) return null;
  const noms = [...new Set(bcActifs.filter((b) => portees.some((l) => l.bcId === b.id)).map((b) => nomBc(b)))].join(", ");
  return `Ce devis porte déjà un bon de commande (${noms}) : ses lignes ne se corrigent plus d'ici — annulez le bon de commande (« Annuler la demande de BC ») pour retranscrire le devis, ou régénérez le BC après avoir coché une ligne oubliée.`;
}

// ───────────────────────── Plusieurs BC pour un poste ─────────────────────────

/**
 * L'ÉTAPE D'ENSEMBLE DES BC D'UN POSTE — la moins avancée. Un poste qui porte deux BC n'est « signé »
 * que quand les DEUX le sont : la facture se dépose après la signature de ce qui a été commandé, pas
 * après le premier (§118.204). Un BC d'avant le circuit (`HORS_CIRCUIT`) est le moins avancé : on ne
 * présume ni qu'il est validé ni qu'il est signé.
 */
const RANG_ETAPE: Record<EtapeBC, number> = {
  HORS_CIRCUIT: 0, REFUSE: 1, SANS_PORTE: 2, A_REVOIR: 3, A_VALIDER: 4, A_CORRIGER: 5, A_SIGNER: 6, SIGNE: 7,
};

export function etapeDEnsemble(etapes: readonly (EtapeBC | null)[]): EtapeBC | null {
  if (etapes.length === 0) return null;
  let pire: EtapeBC = "SIGNE";
  for (const e of etapes) {
    const etape = e ?? "HORS_CIRCUIT";
    if (RANG_ETAPE[etape] < RANG_ETAPE[pire]) pire = etape;
  }
  return pire;
}

// ───────────────────────── Le montant ─────────────────────────

/**
 * LES BC D'UN POSTE ONT-ILS LE DROIT DE TOTALISER CE MONTANT ? — `null` si oui. La facture ne dépasse
 * jamais le montant accordé (`demanderPaiementPoste`) : un bon de commande plus gros ferait une
 * commande que le poste ne pourra jamais payer en entier, et le visa du centre porte sur ce qui a été
 * accordé. Le refus dit les DEUX montants et les gestes qui lèvent l'écart (§118.30).
 */
export function refusDepassement(totalTtc: number, accorde: number | null, totalHt?: number, tvaIndiquee = true): string | null {
  if (accorde == null || !(accorde > 0)) return null;
  if (cents(totalTtc) <= cents(accorde)) return null;
  // AUCUNE TVA INDIQUÉE sur le devis = aucune TVA : le total est celui du papier, et la phrase le dit.
  if (!tvaIndiquee) {
    return `Les lignes validées pour ce poste totalisent ${formatDzd(totalTtc)} (aucune TVA indiquée sur le devis), au-delà des ${formatDzd(accorde)} accordés (+${formatDzd(totalTtc - accorde)}). `
      + "Demandez une révision du poste pour relever le montant accordé, ou décochez une ligne.";
  }
  // LE MONTANT ACCORDÉ S'ENTEND TTC — et le devis s'imprime HT : un devis de 400 000 HT pèse 476 000 TTC à 19 %.
  // Quand l'écart ne vient que de la taxe, la phrase le DIT (Direction, 06/10 : « c'est 400 000 dans le devis,
  // je ne comprends pas »), avec le montant à demander.
  const taxe = totalHt != null && cents(totalHt) < cents(totalTtc)
    ? `${formatDzd(totalHt)} HT, soit ${formatDzd(totalTtc)} TTC avec ${formatDzd(totalTtc - totalHt)} de taxes`
    : `${formatDzd(totalTtc)} TTC`;
  return `Les lignes validées pour ce poste totalisent ${taxe}, au-delà des ${formatDzd(accorde)} accordés (+${formatDzd(totalTtc - accorde)}). `
    + "Le montant accordé s'entend TTC : demandez une révision du poste pour le relever (ou décochez une ligne) — le bon de commande ne dépasse pas ce que la Direction a accordé.";
}

/**
 * LE PLAFOND, SUR LES DEVIS QUI COMPTENT — la somme des lignes validées des devis vivants qui ne sont pas mis à part
 * (une copie de la même pièce ne se paie pas deux fois ; une proposition écartée ne se commande pas). Lue par la
 * carte ET par l'action (`refusMontantDuPoste`) : un seul calcul (§118.5).
 */
export interface DevisAuPlafond {
  annule: boolean;
  miseAPart: MiseAPart | null;
  nbValidees: number;
  totalValideHt: number;
  totalValideTtc: number;
  entete: { tvaRate: number | null };
}

export const devisQuiComptent = <T extends Pick<DevisAuPlafond, "annule" | "miseAPart">>(devis: readonly T[]): T[] =>
  devis.filter((d) => !d.annule && !d.miseAPart);

export function totalValideDesDevis(devis: readonly DevisAuPlafond[]): { ht: number; ttc: number } {
  const comptes = devisQuiComptent(devis);
  return {
    ht: comptes.reduce((s, d) => s + cents(d.totalValideHt), 0) / 100,
    ttc: comptes.reduce((s, d) => s + cents(d.totalValideTtc), 0) / 100,
  };
}

export function refusMontantDesDevis(devis: readonly DevisAuPlafond[], accorde: number | null): string | null {
  const t = totalValideDesDevis(devis);
  const tvaIndiquee = devisQuiComptent(devis).filter((d) => d.nbValidees > 0).every((d) => d.entete.tvaRate !== null);
  return refusDepassement(t.ttc, accorde, t.ht, tvaIndiquee);
}

/**
 * LE PLAFOND QUAND UN BC CORRIGÉ PREND LA PLACE DES LIGNES DE SON DEVIS (audit M-03, Direction 14/10/2026) — UN calcul TTC pour la
 * génération, la correction de l'aperçu, sa validation et « Modifier le BC ». Le total que la FABRIQUE compose pour le BC
 * corrigé (remises, TVA par ligne, remise globale, taxes, timbre) remplace les lignes validées de son devis ; les autres devis
 * qui comptent restent ce qu'ils sont. Sans correction, c'est exactement `refusMontantDesDevis` : l'accordé s'entend TTC partout.
 * Une correction dont le devis n'est pas dans la liste (un BC sans devis amont) s'ajoute.
 */
export function plafondDesDevis(
  devis: readonly (DevisAuPlafond & { pieceId: string })[],
  corriges: ReadonlyMap<string, { ht: number; ttc: number }> = new Map(),
): { ht: number; ttc: number; tvaIndiquee: boolean } {
  let ht = 0;
  let ttc = 0;
  let tvaIndiquee = true;
  const vus = new Set<string>();
  for (const d of devisQuiComptent(devis)) {
    const c = corriges.get(d.pieceId);
    vus.add(d.pieceId);
    if (c) { ht += cents(c.ht); ttc += cents(c.ttc); continue; }
    ht += cents(d.totalValideHt);
    ttc += cents(d.totalValideTtc);
    if (d.nbValidees > 0 && d.entete.tvaRate === null) tvaIndiquee = false;
  }
  for (const [pieceId, c] of corriges) {
    if (vus.has(pieceId) || devis.some((d) => d.pieceId === pieceId)) continue;
    ht += cents(c.ht);
    ttc += cents(c.ttc);
  }
  return { ht: ht / 100, ttc: ttc / 100, tvaIndiquee };
}

// ───────────────────────── La même pièce ne se compte qu'une fois ─────────────────────────

/**
 * LA MÊME PIÈCE, DÉPOSÉE PLUSIEURS FOIS — ET LES PROPOSITIONS CONCURRENTES (Direction, 10/2026).
 *
 * « Les lignes validées pour ce poste totalisent 586 250 DZD » pour une pro forma de 117 250 DZD : la pièce de
 * l'agence avait été déposée cinq fois (une par voyageur), chaque dépôt lu et ses lignes validées d'office — et la
 * carte additionnait les cinq. Le plafond bloquait la génération, et la carte n'avait plus de geste.
 *
 * DEUX RÈGLES, ET RIEN DE DEVINÉ :
 *
 *   1. UNE PIÈCE NE SE COMPTE QU'UNE FOIS. Deux devis sont la MÊME pièce quand ils portent les mêmes lignes ET qu'on
 *      le sait d'ailleurs : le même fichier (empreinte SHA-256 des octets), ou le même numéro imprimé chez le même
 *      fournisseur. Les mêmes lignes SEULES ne suffisent pas : deux voyageurs au même trajet ont deux billets au même
 *      prix — deux commandes. Une seule copie compte : celle qui a déjà un BC, sinon la retenue, sinon la première.
 *   2. UNE PROPOSITION ÉCARTÉE NE SE COMMANDE PAS. Un voyageur qui a plusieurs propositions n'en commande qu'UNE —
 *      celle qu'on a retenue (`validerDevisVoyageur`) ; seule, elle l'est d'office. Plusieurs et aucune retenue : la
 *      carte dit de choisir, aucune ne compte en attendant.
 *
 * Un devis qui porte déjà un BC n'est jamais mis à part : sa commande existe, elle se lit telle quelle.
 */
export interface DevisAComparer {
  pieceId: string;
  /** Ce que la personne lit : la référence, sinon le titre. */
  nom: string;
  annule: boolean;
  /** Les empreintes (SHA-256) de ses fichiers. */
  empreintes: readonly string[];
  /** Le numéro du devis (tel que saisi ou imprimé), et son fournisseur. */
  reference: string | null;
  fournisseur: string | null;
  lignes: readonly Pick<LigneDevisPoste, "reference" | "quantity" | "unitPrice">[];
  aUnBc: boolean;
  nbValidees: number;
  /** Le voyageur pour qui il a été déposé (billetterie), et s'il est sa proposition retenue. */
  voyageur: { id: string; nom: string; retenu: boolean } | null;
}

export type MiseAPart =
  | { motif: "COPIE"; de: string; phrase: string }
  | { motif: "ECARTE"; de: string; phrase: string }
  | { motif: "A_CHOISIR"; de: null; phrase: string };

const normal = (s: string | null | undefined): string => (s ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

/** La signature des lignes d'un devis — désignation, quantité, prix — sans l'ordre. Vide : le devis n'a pas de lignes. */
export function signatureDesLignes(lignes: DevisAComparer["lignes"]): string {
  return lignes
    .map((l) => `${normal(l.reference)}|${l.quantity ?? "?"}|${l.unitPrice ?? "?"}`)
    .sort()
    .join("¶");
}

/** Deux devis sont-ils la MÊME pièce ? Mêmes lignes, et le même fichier ou le même numéro chez le même fournisseur. */
export function memePiece(a: DevisAComparer, b: DevisAComparer): boolean {
  const sa = signatureDesLignes(a.lignes);
  if (!sa || sa !== signatureDesLignes(b.lignes)) return false;
  if (a.empreintes.some((e) => b.empreintes.includes(e))) return true;
  const ra = normal(a.reference);
  const fa = normal(a.fournisseur);
  return ra !== "" && ra === normal(b.reference) && fa !== "" && fa === normal(b.fournisseur);
}

/**
 * MÊME CONTENU, PAS FORCÉMENT LA MÊME PIÈCE — mêmes lignes, même fournisseur, mais rien d'autre ne le prouve. On ne
 * le décide pas à la place de la personne (§118.16) : la carte le DIT, avec le geste (retirer la copie). Rend, pour
 * chaque devis concerné, le nom de l'autre.
 */
export function doublonsProbables(devis: readonly DevisAComparer[]): Map<string, string> {
  const res = new Map<string, string>();
  const vivants = devis.filter((d) => !d.annule && d.lignes.length > 0);
  for (let i = 0; i < vivants.length; i++) {
    for (let j = 0; j < i; j++) {
      const a = vivants[i]!;
      const b = vivants[j]!;
      if (memePiece(a, b)) continue;
      if (signatureDesLignes(a.lignes) !== signatureDesLignes(b.lignes)) continue;
      if (normal(a.fournisseur) !== normal(b.fournisseur)) continue;
      if (!res.has(a.pieceId)) res.set(a.pieceId, b.nom);
    }
  }
  return res;
}

export function devisMisAPart(devis: readonly DevisAComparer[]): Map<string, MiseAPart> {
  const res = new Map<string, MiseAPart>();
  const vivants = devis.filter((d) => !d.annule);
  const parId = new Map(vivants.map((d) => [d.pieceId, d]));

  // 1. LES COPIES : des groupes de la même pièce (union de proche en proche), et dans chacun UNE pièce qui compte.
  const groupe = new Map<string, string>(vivants.map((d) => [d.pieceId, d.pieceId]));
  const racine = (id: string): string => {
    let r = id;
    while (groupe.get(r) !== r) r = groupe.get(r)!;
    return r;
  };
  for (let i = 0; i < vivants.length; i++) {
    for (let j = 0; j < i; j++) {
      if (memePiece(vivants[i]!, vivants[j]!)) groupe.set(racine(vivants[i]!.pieceId), racine(vivants[j]!.pieceId));
    }
  }
  const membres = new Map<string, DevisAComparer[]>();
  vivants.forEach((d) => { const r = racine(d.pieceId); membres.set(r, [...(membres.get(r) ?? []), d]); });
  const canonique = new Map<string, string>();
  for (const liste of membres.values()) {
    const rang = (d: DevisAComparer) => [d.aUnBc ? 0 : 1, d.voyageur?.retenu ? 0 : 1, d.nbValidees > 0 ? 0 : 1, vivants.indexOf(d)];
    const tete = [...liste].sort((a, b) => {
      const ra = rang(a), rb = rang(b);
      for (let k = 0; k < ra.length; k++) if (ra[k] !== rb[k]) return ra[k]! - rb[k]!;
      return 0;
    })[0]!;
    for (const d of liste) {
      canonique.set(d.pieceId, tete.pieceId);
      if (d.pieceId === tete.pieceId || d.aUnBc) continue;
      const pour = tete.voyageur ? ` (déposée pour ${tete.voyageur.nom})` : "";
      res.set(d.pieceId, {
        motif: "COPIE", de: tete.pieceId,
        phrase: `Même pièce que « ${tete.nom} »${pour} : elle ne se compte qu'une fois.`,
      });
    }
  }

  // 2. LES PROPOSITIONS D'UN VOYAGEUR : seule la retenue (ou l'unique) se commande.
  const parVoyageur = new Map<string, { nom: string; groupes: Set<string>; retenu: string | null }>();
  for (const d of vivants) {
    if (!d.voyageur) continue;
    const v = parVoyageur.get(d.voyageur.id) ?? { nom: d.voyageur.nom, groupes: new Set<string>(), retenu: null };
    const c = canonique.get(d.pieceId)!;
    v.groupes.add(c);
    if (d.voyageur.retenu) v.retenu = c;
    parVoyageur.set(d.voyageur.id, v);
  }
  const retenus = new Set<string>();
  const ecartes = new Map<string, { voyageur: string; retenu: string }>();
  const aChoisir = new Map<string, { voyageur: string; n: number }>();
  for (const v of parVoyageur.values()) {
    const retenu = v.retenu ?? (v.groupes.size === 1 ? [...v.groupes][0]! : null);
    if (retenu) {
      retenus.add(retenu);
      for (const g of v.groupes) if (g !== retenu && !ecartes.has(g)) ecartes.set(g, { voyageur: v.nom, retenu });
    } else {
      for (const g of v.groupes) if (!aChoisir.has(g)) aChoisir.set(g, { voyageur: v.nom, n: v.groupes.size });
    }
  }
  for (const [r, liste] of membres) {
    const c = canonique.get(r)!;
    // Compte : une pièce du poste (sans voyageur), une proposition retenue, ou une commande déjà faite.
    if (retenus.has(c) || liste.some((d) => !d.voyageur || d.aUnBc)) continue;
    const e = ecartes.get(c);
    const tete = parId.get(c)!;
    const mise: MiseAPart | null = e
      ? { motif: "ECARTE", de: e.retenu, phrase: `Proposition écartée pour ${e.voyageur} : le devis retenu est « ${parId.get(e.retenu)?.nom ?? "un autre"} » — elle ne se commande pas.` }
      : aChoisir.has(c)
        ? { motif: "A_CHOISIR", de: null, phrase: `${aChoisir.get(c)!.n} propositions pour ${aChoisir.get(c)!.voyageur} : retenez-en une (Voyageurs › « Choisir le devis ») — d'ici là, aucune ne se commande.` }
        : null;
    if (mise && !tete.aUnBc) res.set(c, mise);
  }
  return res;
}

// ───────────────────────── Ce que le BC peut porter ─────────────────────────

/**
 * LES TAUX DE TVA QU'UN BON DE COMMANDE PEUT PORTER, en POUR CENT — ceux de l'Algérie (0, 9, 19), les mêmes que la
 * fabrique (`TAUX_TVA_ADMIS`, en fraction : un test les compare). Un devis qui en porte un autre (une lecture de
 * travers, une saisie) ne se commande pas tel quel : la fabrique refuserait APRÈS qu'on a pris la marche du BC.
 */
export const TAUX_TVA_PCT_ADMIS: readonly number[] = [0, 9, 19];

export function refusTauxDuDevis(tvaRate: number | null): string | null {
  // PAS DE TVA IMPRIMÉE = PAS DE TVA (Direction, 06/10) : le bon de commande se génère sans TVA, comme le devis.
  if (tvaRate === null) return null;
  if (TAUX_TVA_PCT_ADMIS.some((t) => Math.abs(t - tvaRate) < 1e-9)) return null;
  return `Le taux de TVA du devis (${tvaRate} %) n'existe pas en Algérie : un bon de commande porte 0, 9 ou 19 %. Corrigez-le dans les lignes du devis (« Corriger les lignes »).`;
}

// ───────────────────────── Peut-on générer ? ─────────────────────────

/**
 * LA GÉNÉRATION EST-ELLE OUVERTE POUR CE POSTE ? — `null` si oui, sinon la raison. Lue par l'ACTION
 * (`genererBonDeCommandePoste`) ET par la carte : un bouton offert est un geste que l'action accepte (§118.83), et
 * deux copies des mêmes conditions finiraient par ne plus s'accorder (§118.5). Les mêmes portes que « demander le
 * BC » : le poste est accordé, son montant et son budget posés, aucun paiement demandé, aucune demande de BC ouverte
 * chez l'assistante (deux chemins pour le même BC feraient deux commandes).
 */
export function refusGenerationBC(p: {
  status: string;
  amountGranted: number | null;
  budgetCategoryId: string | null;
  orderStage: string;
  expenseOrderId: string | null;
  /** La demande de BC chez l'assistante : son nom quand elle est ouverte, `null` sinon. */
  demandeChez: string | null | undefined;
  demandeOuverte: boolean;
}): string | null {
  if (p.expenseOrderId || p.orderStage === "ISSUED") return "Le paiement de ce poste est déjà demandé : ses bons de commande ne changent plus.";
  if (p.status !== "APPROVED") return "Le poste doit d'abord être accordé par la Direction.";
  if (p.orderStage === "NONE" || p.orderStage === "REFUSED") {
    if (!(typeof p.amountGranted === "number" && Number.isFinite(p.amountGranted) && p.amountGranted > 0)) return "Affectez d'abord un montant à ce poste.";
    if (!p.budgetCategoryId) return "Choisissez d'abord le budget (enveloppe) qui portera ce poste.";
  }
  if (p.demandeOuverte) {
    return `La demande de bon de commande est déjà chez ${p.demandeChez ?? "l'assistante de direction"} : annulez-la (« Annuler la demande de BC ») pour générer le bon de commande d'ici — deux chemins pour le même BC feraient deux commandes.`;
  }
  return null;
}

// ───────────────────────── La lecture, traduite en lignes ─────────────────────────

/** Une ligne préremplie par la lecture (`LignePreremplie`), telle qu'elle s'écrit en base. */
export interface LigneAEcrire {
  position: number;
  reference: string;
  unit: string | null;
  quantity: number | null;
  unitPrice: number | null;
  lue: number | null;
  aVerifier: string | null;
}

/**
 * LES LIGNES QUE LA LECTURE PROPOSE → les lignes du devis. Un chiffre illisible reste `null` (jamais
 * deviné) ; ce qu'il faut vérifier sur le papier voyage avec la ligne, dit à la personne.
 */
/**
 * LES RÉSERVES DE LECTURE ENCORE VRAIES. Une réserve « « DZD 300,000.00 » : des caractères inattendus » a été écrite
 * par une version du lecteur qui ne comprenait pas la devise en préfixe ; le lecteur actuel lit ce montant. La garder
 * affichée en orange sur une ligne juste ferait douter de tout le devis : on ne garde que les réserves qu'un nombre
 * lisible ne dément pas. `lisible` : le lecteur de montants actuel (`montantLu`), injecté pour garder ce module pur.
 */
export function reservesEncoreVraies(aVerifier: string | null, lisible: (texte: string) => number | null): string | null {
  if (!aVerifier) return null;
  const gardees = aVerifier.split(" ; ").filter((r) => {
    const m = r.match(/^« (.+) » : des caractères inattendus/);
    return !(m && lisible(m[1]) !== null);
  });
  return gardees.length > 0 ? gardees.join(" ; ") : null;
}

/**
 * LES DOUTES QU'UNE LECTURE LAISSE SUR UN DEVIS (audit Ad & Pro, 14/10) — ce que le contrôle arithmétique a trouvé contre
 * les totaux IMPRIMÉS (un TTC, une TVA, un HT que les lignes lues ne font pas ; deux lectures du même total qui
 * divergent), et la TVA que le modèle a proposée sans que le papier l'imprime. Jusqu'ici ce contrôle était calculé puis
 * JETÉ par l'ingestion : un TTC imprimé de 400 000 contre 476 000 recalculés ne se voyait nulle part, et les lignes
 * étaient validées d'office. Une liste vide : rien ne contredit la lecture.
 */
export function doutesDeLaLecture(
  controle: { ecarts?: readonly string[]; desaccords?: readonly string[] } | null | undefined,
  tvaNonImprimee: number | null,
): string[] {
  const doutes: string[] = [];
  if (tvaNonImprimee != null) {
    doutes.push(`TVA de ${tvaNonImprimee.toLocaleString("fr-FR")} % proposée par la lecture mais imprimée nulle part : non reprise (pas de TVA imprimée, pas de TVA).`);
  }
  for (const p of [...(controle?.ecarts ?? []), ...(controle?.desaccords ?? [])]) if (p.trim() && !doutes.includes(p)) doutes.push(p.trim());
  return doutes;
}

/** La note gardée avec le devis : d'où viennent les lignes, puis ce qu'il faut vérifier — bornée à 600 caractères (la colonne). */
export function noteDeLecture(noteMethode: string, doutes: readonly string[]): string {
  const base = noteMethode.trim();
  if (doutes.length === 0) return base.slice(0, 600);
  const suite = `${MARQUE_DOUTE}${doutes.join(" ")}`;
  const tout = `${base}${suite}`;
  return tout.length <= 600 ? tout : `${tout.slice(0, 599)}…`;
}

const MARQUE_DOUTE = " — À VÉRIFIER SUR LE PAPIER : ";

/**
 * LA NOTE APRÈS UNE CORRECTION À LA MAIN — les doutes de la lecture ont été tranchés par une personne devant le papier :
 * ils ne restent pas affichés en avertissement pour toujours (un avertissement qui ne s'éteint jamais apprend à ne plus
 * le lire). La note le dit. Sans doute écrit, la note est rendue telle quelle.
 */
export function noteApresCorrection(note: string | null): string | null {
  if (!note) return note;
  const i = note.indexOf(MARQUE_DOUTE);
  if (i < 0) return note;
  return `${note.slice(0, i)} — les doutes de la lecture ont été revus et les lignes corrigées à la main.`.slice(0, 600);
}

export function lignesDepuisLaLecture(
  lues: readonly { rang: number; reference: string; unit: string | null; quantity: number | null; unitPrice: number | null; notes: string[] }[],
): LigneAEcrire[] {
  return lues
    .filter((l) => l.reference.trim() !== "")
    .map((l, i) => ({
      position: i, reference: l.reference.trim(), unit: l.unit?.trim() || null,
      quantity: l.quantity != null && Number.isFinite(l.quantity) && l.quantity > 0 ? l.quantity : null,
      unitPrice: l.unitPrice != null && Number.isFinite(l.unitPrice) && l.unitPrice >= 0 ? l.unitPrice : null,
      lue: l.rang, aVerifier: l.notes.length > 0 ? l.notes.join(" ; ").slice(0, 600) : null,
    }));
}
