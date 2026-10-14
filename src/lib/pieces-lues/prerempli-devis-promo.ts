/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * PRÉREMPLIR LE DEVIS D'UN DOSSIER DE MATÉRIEL PROMOTIONNEL DEPUIS SON SCAN (lot D2-E).
 *
 * L'assistante de direction retranscrit chaque devis d'agence dans le tableau interne (§118.152).
 * La lecture lui PROPOSE ce qu'elle aurait recopié — fournisseur, n°, date, lignes, TVA, taxe, total
 * HT —, et c'est elle qui confirme, ligne à ligne, devant le papier : une proposition n'est jamais un
 * prix de la société (§118.152 i). Ce module décide, sans base, ce qui se PRÉREMPLIT et ce qui ne se
 * préremplit pas — et le DIT, chaque fois, avec le geste qui reste :
 *
 *   • le FOURNISSEUR seulement quand l'annuaire le reconnaît à coup sûr (NIF ou RC) et qu'il figure
 *     parmi les choix de l'écran : un nom ressemblant ne désigne personne (§118.34) ;
 *   • le TOTAL HT est celui que le REPÉRAGE a lu sur le papier, jamais celui du modèle (P4) : c'est
 *     contre lui que la retranscription se contrôle à un dinar près — le prendre chez le modèle
 *     comparerait le modèle à lui-même, une garde vraie qu'elle soit armée ou non (§118.17) ;
 *   • la TVA et la taxe additionnelle seulement s'il n'y en a qu'UNE : le devis interne porte un taux
 *     et une taxe ; plusieurs taux se saisissent en un devis par taux (décision de la Direction) ;
 *   • une REMISE n'est jamais convertie d'office en prix net (décision 7) : la ligne remisée vient
 *     sans prix, la remise globale est nommée ;
 *   • une DEVISE autre que le dinar : aucun montant prérempli.
 *
 * Les lignes préremplies sont aussi ce que la confirmation compare (`lignesProposeesDevisPromo`) :
 * l'écran et la garde du serveur lisent la MÊME traduction, sinon chaque ligne portant une référence
 * passerait pour « corrigée » sans que personne y ait touché (§118.5).
 *
 * Module PUR : l'écran (composant client) et l'action le lisent.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import { formaterTaux } from "@/lib/artifact/factory/commercial";
import type { LigneProposee } from "@/lib/pieces-lues/confirmation";
import type { ResultatControle } from "@/lib/pieces-lues/controle";
import type { EntetesReperes } from "@/lib/pieces-lues/entetes";
import type { ResultatFournisseur, StatutFournisseur } from "@/lib/pieces-lues/fournisseur";
import type { RaisonSansLignes } from "@/lib/pieces-lues/phrases";
import type { LigneLue, PieceLue } from "@/lib/pieces-lues/structure";

/** Une ligne préremplie dans l'éditeur du devis : ce que la lecture propose, et ce qu'elle en dit. */
export interface LignePreremplie {
  /** Le rang de la ligne lue — renvoyé par le formulaire (`ligneLue`) pour que la confirmation la retrouve. */
  rang: number;
  /** « Référence / désignation » du tableau interne. */
  reference: string;
  unit: string | null;
  /** `null` : illisible, à saisir depuis le papier. */
  quantity: number | null;
  /** `null` : illisible, remisé, ou libellé dans une autre devise — à saisir depuis le papier. */
  unitPrice: number | null;
  /** Ce qu'il faut vérifier sur cette ligne : chiffres illisibles, quantité × prix qui ne fait pas le montant imprimé, remise. */
  notes: string[];
  /** Les motifs d'injection repérés dans la désignation : signalés, jamais suivis (§104.10). */
  suspecte: string[];
}

export interface PrerempliDevisPromo {
  /** La fiche de l'annuaire — seulement si elle est reconnue à coup sûr ET proposée par l'écran. */
  fournisseurId: string | null;
  reference: string | null;
  /** ISO `AAAA-MM-JJ`. */
  quoteDate: string | null;
  /** Le total HT REPÉRÉ sur le papier — jamais celui du modèle (P4). */
  announcedTotal: number | null;
  /** En POUR CENT (19), comme le devis interne le porte. */
  tvaRate: number | null;
  extraTaxLabel: string | null;
  /** En POUR CENT. */
  extraTaxRate: number | null;
  lignes: LignePreremplie[];
  /** Tout ce qui N'EST PAS prérempli et pourquoi — avec le geste qui reste (§118.30). */
  reserves: string[];
  /**
   * Le taux (en POUR CENT) que le MODÈLE a proposé mais que RIEN sur le papier ne confirme — ni une TVA imprimée, ni
   * des totaux qui la contiennent : il n'est PAS repris (`tvaRate` reste `null`). `null` : aucun taux écarté.
   */
  tvaNonImprimee?: number | null;
}

/** Ce que l'écran affiche d'une lecture — et rien de plus : le texte lu ne quitte pas le serveur. */
export interface LectureDevisPromo {
  lectureId: string;
  nomFichier: string;
  methode: "texte" | "ocr";
  confiance: number | null;
  /** D'où vient le texte, ce qui n'a pas été lu — composée par notre code, jamais par le document. */
  noteMethode: string;
  /** Pourquoi il n'y a pas de lignes lues — `null` quand l'IA en a proposé. */
  sansLignes: string | null;
  /** La coupe du texte montré à l'IA, dite à la personne. */
  coupe: string | null;
  controle: { conforme: boolean; ecarts: string[]; manques: string[]; desaccords: string[] } | null;
  fournisseur: { statut: StatutFournisseur; phrase: string };
  suspectes: { rang: number; designation: string; motifs: string[] }[];
  prerempli: PrerempliDevisPromo;
}

/** Ce que l'écran a besoin de lire d'une proposition de lecture (`PropositionDeLecture` du service). */
export interface PropositionPourEcran {
  lectureId: string;
  nomFichier: string;
  faits: { methode: "texte" | "ocr"; confiance?: number | null };
  noteMethode: string;
  sansLignes: string | null;
  raisonSansLignes: RaisonSansLignes | null;
  coupe: string | null;
  entetes: EntetesReperes;
  piece: PieceLue | null;
  controle: ResultatControle | null;
  fournisseur: ResultatFournisseur;
  suspectes: { rang: number; designation: string; motifs: string[] }[];
}

const pct = (fraction: number): number => Math.round(fraction * 10_000) / 100;
const cleTaux = (fraction: number): number => Math.round(fraction * 10_000);
const court = (s: string): string => (s.length > 60 ? `${s.slice(0, 60)}…` : s);
const devisesEtrangeres = (piece: PieceLue | null): string | null => (piece?.devise && piece.devise !== "DZD" ? piece.devise : null);

/** La « référence / désignation » du tableau interne : la désignation imprimée, et la référence article quand il y en a une. */
export function designationDevis(l: Pick<LigneLue, "designation" | "reference">): string {
  const d = l.designation.trim();
  const r = l.reference?.trim();
  return r && !d.includes(r) ? `${d} (réf. ${r})` : d;
}

/**
 * LES LIGNES QUE L'ÉDITEUR REÇOIT — les lignes CHIFFRÉES lues (un titre de section n'est pas une
 * ligne de devis), chacune avec ce qu'il faut y vérifier.
 */
export function lignesPreremplies(piece: PieceLue | null, controle: ResultatControle | null = null): LignePreremplie[] {
  if (!piece) return [];
  const devise = devisesEtrangeres(piece);
  return piece.lignes.filter((l) => !l.section).map((l) => {
    const notes: string[] = l.illisibles.map((i) => i.raison);
    const remisee = l.remise !== null && l.remise > 0;
    if (remisee) notes.push(`remise de ${formaterTaux(l.remise as number)} lue : le prix unitaire n'est pas prérempli — saisissez le prix NET depuis le papier`);
    for (const d of controle?.desaccords ?? []) if (d.quoi === "LIGNE" && d.rang === l.rang) notes.push(d.phrase);
    return {
      rang: l.rang,
      reference: designationDevis(l),
      unit: l.unite,
      quantity: l.quantite,
      unitPrice: devise || remisee ? null : l.prixUnitaire,
      notes,
      suspecte: l.suspecte,
    };
  });
}

/** Ce que la confirmation compare : les lignes TELLES QUE L'ÉCRAN LES A PROPOSÉES. */
export function lignesProposeesDevisPromo(piece: PieceLue | null): LigneProposee[] {
  return lignesPreremplies(piece).map((l) => ({ rang: l.rang, designation: l.reference, quantite: l.quantity, prixUnitaire: l.unitPrice }));
}

/** LE PRÉREMPLISSAGE — `optionsEcran` : les identifiants des fournisseurs que l'éditeur propose. */
export function preremplirDevisPromo(
  p: Pick<PropositionPourEcran, "entetes" | "piece" | "fournisseur" | "controle">,
  optionsEcran: readonly string[],
): PrerempliDevisPromo {
  const { entetes, piece, fournisseur } = p;
  const reserves: string[] = [];
  const devise = devisesEtrangeres(piece);
  if (devise) reserves.push(`Pièce libellée en ${devise} : aucun montant n'est prérempli (prix, total HT) — le devis interne est en dinars ; saisissez-les depuis le papier.`);

  // LE FOURNISSEUR : reconnu à coup sûr, et proposé par l'écran — sinon la personne choisit.
  let fournisseurId: string | null = null;
  if (fournisseur.statut === "CERTAIN" && fournisseur.retenu) {
    if (optionsEcran.includes(fournisseur.retenu)) fournisseurId = fournisseur.retenu;
    else reserves.push(`Le fournisseur reconnu (« ${fournisseur.candidats[0]?.nom ?? "?"} ») ne figure pas parmi les choix de l'écran : choisissez-le dans l'annuaire.`);
  }

  // LE TOTAL HT : celui du papier, lu par le repérage — jamais celui du modèle.
  let announcedTotal: number | null = null;
  if (!devise) {
    if (entetes.totalHt?.valeur != null) announcedTotal = entetes.totalHt.valeur;
    else if (entetes.conflits.some((k) => k.quoi === "HT")) reserves.push("Plusieurs « Total HT » différents sont imprimés : aucun n'est prérempli — saisissez celui du papier.");
    else if (entetes.totalHt) reserves.push(`Total HT repéré mais illisible${entetes.totalHt.raison ? ` (${entetes.totalHt.raison.replace(/[.\s]+$/, "")})` : ""} : saisissez-le depuis le papier — c'est contre lui que la retranscription se contrôle.`);
    else reserves.push("Total HT non repéré sur le papier : facultatif — saisi, il contrôle la retranscription à un dinar près.");
  }

  // LA TVA : un taux, et un seul.
  const taux = new Map<number, number>();
  for (const t of entetes.tva) taux.set(cleTaux(t.taux), t.taux);
  if (piece) {
    if (piece.tvaDefaut !== null) taux.set(cleTaux(piece.tvaDefaut), piece.tvaDefaut);
    for (const l of piece.lignes) if (!l.section && l.tva !== null) taux.set(cleTaux(l.tva), l.tva);
  }
  let tvaRate: number | null = null;
  let tvaNonImprimee: number | null = null;
  if (taux.size === 1) {
    const t = [...taux.values()][0];
    // LE TAUX DU MODÈLE N'EST REPRIS QUE SI LE PAPIER LE PORTE (audit Ad & Pro, 14/10) : « s'il n'y a pas de TVA
    // renseignée, il n'y a pas de TVA ». Un 19 % rendu par le modèle sur un devis qui n'imprime aucune TVA faisait
    // un bon de commande de 476 000 TTC pour un devis de 400 000 — exactement ce que la Direction a interdit.
    if (t === 0 || tvaCorroboree(entetes, t, htDesLignesLues(piece))) tvaRate = pct(t);
    else {
      tvaNonImprimee = pct(t);
      reserves.push(phraseTvaNonImprimee(pct(t)));
    }
  } else if (taux.size > 1) {
    const liste = [...taux.values()].sort((a, b) => a - b).map((t) => formaterTaux(t)).join(", ");
    reserves.push(`Plusieurs taux de TVA lus (${liste}) : la TVA n'est pas préremplie — le devis interne porte UN taux ; saisissez un devis par taux (décision de la Direction).`);
  }

  // LA TAXE ADDITIONNELLE : celle du papier d'abord (repérage), celle du modèle sinon — une, et une seule.
  const taxes = new Map<number, { libelle: string; taux: number }>();
  const sources = entetes.taxes.length > 0
    ? entetes.taxes.map((t) => ({ libelle: t.libelle, taux: t.taux }))
    : (piece?.taxes ?? []).filter((t): t is typeof t & { taux: number } => t.taux !== null).map((t) => ({ libelle: t.libelle, taux: t.taux }));
  for (const t of sources) if (!taxes.has(cleTaux(t.taux))) taxes.set(cleTaux(t.taux), t);
  let extraTaxLabel: string | null = null;
  let extraTaxRate: number | null = null;
  if (taxes.size === 1) {
    const [t] = [...taxes.values()];
    extraTaxLabel = t.libelle;
    extraTaxRate = pct(t.taux);
  } else if (taxes.size > 1) {
    const liste = [...taxes.values()].map((t) => `${t.libelle} ${formaterTaux(t.taux)}`).join(", ");
    reserves.push(`Plusieurs taxes additionnelles lues (${liste}) : le devis interne n'en porte qu'une — aucune n'est préremplie ; saisissez celle du papier.`);
  }

  // LES REMISES : jamais converties en prix net.
  if (piece?.remiseGlobale != null && piece.remiseGlobale > 0) {
    reserves.push(`Remise globale de ${formaterTaux(piece.remiseGlobale)} lue : elle n'est pas reportée sur les lignes (une remise n'est jamais convertie d'office en prix net) — les prix préremplis sont BRUTS : corrigez-les, ou le total HT ne tombera pas juste.`);
  }
  const lignes = lignesPreremplies(piece, p.controle);
  const remisees = (piece?.lignes ?? []).filter((l) => !l.section && l.remise !== null && l.remise > 0);
  if (remisees.length > 0) {
    reserves.push(`Remise lue sur ${remisees.map((l) => `la ligne « ${court(l.designation)} »`).join(", ")} : le devis interne ne porte pas de remise — son prix unitaire n'est pas prérempli ; saisissez le prix NET depuis le papier.`);
  }

  return {
    fournisseurId,
    reference: entetes.numero?.valeur ?? piece?.numero ?? null,
    quoteDate: entetes.date?.valeur ?? piece?.date ?? null,
    announcedTotal,
    tvaRate,
    extraTaxLabel,
    extraTaxRate,
    lignes,
    reserves,
    tvaNonImprimee,
  };
}

// ───────────────────────── La TVA du modèle, confrontée au papier ─────────────────────────

const centimes = (x: number): number => Math.round(x * 100);
/** ± 1 DZD, la tolérance de toutes les retranscriptions du dépôt. */
const TOLERANCE_TVA_CENTIMES = 100;

/** Le hors-taxe des lignes chiffrées que le modèle a lues — `null` dès qu'une ligne est incomplète ou remisée. */
export function htDesLignesLues(piece: PieceLue | null): number | null {
  if (!piece || (piece.devise && piece.devise !== "DZD")) return null;
  const chiffrees = piece.lignes.filter((l) => !l.section);
  if (chiffrees.length === 0) return null;
  if (chiffrees.some((l) => l.quantite === null || l.prixUnitaire === null || (l.remise ?? 0) > 0)) return null;
  if ((piece.remiseGlobale ?? 0) > 0) return null;
  return chiffrees.reduce((s, l) => s + centimes((l.quantite as number) * (l.prixUnitaire as number)), 0) / 100;
}

/**
 * LE PAPIER CONFIRME-T-IL CE TAUX DE TVA ? (audit Ad & Pro, 14/10) — oui si le repérage a lu une TVA imprimée (à ce
 * taux, ou un « Total TVA » / « Montant TVA », ou deux valeurs en conflit : la TVA est là, même illisible) ; oui aussi
 * quand les TOTAUX IMPRIMÉS la contiennent : le TTC (ou le net à payer) imprimé vaut le HT — imprimé, sinon celui des
 * lignes — augmenté de ce taux (et des taxes additionnelles imprimées, et du timbre), à un dinar près. Sinon NON :
 * le taux ne vient que du modèle, et un taux qui ne vient que du modèle n'est jamais repris (§118.16, §118.34).
 *
 * Module PUR : la lecture du devis d'un poste et celle du matériel promotionnel lisent la même règle (§118.5).
 */
export function tvaCorroboree(entetes: Pick<EntetesReperes, "tva" | "totalTva" | "conflits" | "totalHt" | "totalTtc" | "netAPayer" | "taxes" | "timbre">, taux: number, htLignes: number | null = null): boolean {
  if (entetes.tva.some((t) => Math.abs(t.taux - taux) < 1e-9)) return true;
  // Un « Total TVA » imprimé — sauf « TVA : 0,00 », qui dit justement qu'il n'y en a pas.
  if (entetes.totalTva && !(entetes.totalTva.valeur === 0)) return true;
  if (entetes.conflits.some((k) => k.quoi === "TVA" || k.quoi === "TVA_TOTAL")) return true;
  const finaux = [entetes.totalTtc?.valeur, entetes.netAPayer?.valeur].filter((v): v is number => typeof v === "number");
  if (finaux.length === 0) return false;
  const bases = [entetes.totalHt?.valeur ?? null, htLignes].filter((v): v is number => typeof v === "number" && v > 0);
  if (bases.length === 0) return false;
  const taxesImprimees = entetes.taxes.reduce((s, t) => s + (typeof t.montant.valeur === "number" ? centimes(t.montant.valeur) : 0), 0);
  const timbre = typeof entetes.timbre?.valeur === "number" ? centimes(entetes.timbre.valeur) : 0;
  for (const ht of bases) {
    const attendu = centimes(ht) + Math.round(centimes(ht) * taux) + taxesImprimees;
    for (const f of finaux) {
      const c = centimes(f);
      if (Math.abs(c - attendu) <= TOLERANCE_TVA_CENTIMES || Math.abs(c - (attendu + timbre)) <= TOLERANCE_TVA_CENTIMES) return true;
    }
  }
  return false;
}

/** La réserve d'un taux écarté — elle dit ce qui a été vu, ce qui n'a pas été repris, et le geste qui reste. */
export function phraseTvaNonImprimee(tauxPct: number): string {
  return `TVA de ${tauxPct.toLocaleString("fr-FR")} % proposée par la lecture, mais aucune TVA n'est imprimée sur le papier (ni taux, ni montant, ni total TTC qui la contienne) : elle n'est PAS reprise — pas de TVA imprimée, pas de TVA. Si le devis en porte une, saisissez-la dans « Corriger les lignes ».`;
}

/** CE QUE L'ÉCRAN REÇOIT d'une lecture : la note, les absences, le contrôle en phrases, le préremplissage. */
export function lectureDevisPromo(p: PropositionPourEcran, optionsEcran: readonly string[]): LectureDevisPromo {
  const c = p.controle;
  return {
    lectureId: p.lectureId,
    nomFichier: p.nomFichier,
    methode: p.faits.methode,
    confiance: typeof p.faits.confiance === "number" ? p.faits.confiance : null,
    noteMethode: p.noteMethode,
    sansLignes: p.sansLignes,
    coupe: p.coupe,
    controle: c
      ? {
          conforme: c.conforme,
          ecarts: c.ecarts.map((e) => e.phrase),
          manques: c.manques.map((m) => m.phrase),
          // Les désaccords d'une ligne voyagent AVEC la ligne (ses notes) ; ici, ceux des totaux.
          desaccords: c.desaccords.filter((d) => d.quoi !== "LIGNE").map((d) => d.phrase),
        }
      : null,
    fournisseur: { statut: p.fournisseur.statut, phrase: p.fournisseur.phrase },
    suspectes: p.suspectes,
    prerempli: preremplirDevisPromo(p, optionsEcran),
  };
}
