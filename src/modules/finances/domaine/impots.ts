/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * IMPÔTS & COTISATIONS — LES RÈGLES (maquette validée par le Super Admin, 24/11/2026).
 *
 * Les Finances demandent au centre de paiement le paiement des obligations fiscales et sociales de chaque société :
 * la G50 du mois (TVA, IRG salaires, autres lignes), la CNAS, un acompte d'IBS, un paiement ponctuel.
 *
 * LA PLATEFORME N'APPLIQUE NI TAUX NI ASSIETTE. Elle ADDITIONNE ce qui est inscrit — l'IRG et la CNAS = la somme des
 * retenues que les RH ont portées sur les fiches salariés ; la TVA du mois = collectée − déductible des FACTURES (décision
 * du Super Admin du 24/11/2026 : la source arrive avec le lot « tva », `prerempliTva` ; d'ici là, recopiées de la G50) —
 * et elle RECOPIE le reste (acomptes, autres lignes). Un montant
 * proposé par la paie reste modifiable : l'écart avec l'envoyé est gardé, jamais effacé.
 *
 * L'état d'une ligne ne se saisit pas : il se LIT sur l'ordre de dépense qui la paie (`etatDeLEcheance`), seul écrit
 * par le centre (`decidePayment`) et la banque (`settleExpenseOrder`).
 *
 * Module PUR — sans base ni session, importable par un écran (réexporté par `partage.ts`).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import type { BadgeTone } from "@/lib/labels";

// ── Le calendrier ────────────────────────────────────────────────────────────────────────────

/** Ce que la préparation décompose : la G50 (TVA + IRG + autres lignes), la CNAS (deux parts), un montant unique. */
export type CompositionFiscale = "G50" | "CNAS" | "MONTANT";
export const COMPOSITIONS_FISCALES: readonly CompositionFiscale[] = ["G50", "CNAS", "MONTANT"];
export const LIBELLE_COMPOSITION: Record<CompositionFiscale, string> = {
  G50: "G50 (TVA, IRG)",
  CNAS: "CNAS (parts salariale et patronale)",
  MONTANT: "Montant unique",
};

export type PeriodiciteFiscale = "MENSUELLE" | "TRIMESTRIELLE" | "ANNUELLE" | "SELON_AVIS";
export const PERIODICITES_FISCALES: readonly PeriodiciteFiscale[] = ["MENSUELLE", "TRIMESTRIELLE", "ANNUELLE", "SELON_AVIS"];
export const LIBELLE_PERIODICITE: Record<PeriodiciteFiscale, string> = {
  MENSUELLE: "Mensuelle", TRIMESTRIELLE: "Trimestrielle", ANNUELLE: "Annuelle", SELON_AVIS: "Selon avis",
};

export const estCompositionFiscale = (v: unknown): v is CompositionFiscale => (COMPOSITIONS_FISCALES as readonly unknown[]).includes(v);
export const estPeriodiciteFiscale = (v: unknown): v is PeriodiciteFiscale => (PERIODICITES_FISCALES as readonly unknown[]).includes(v);

/** La suivante dans le cycle d'un bouton « ↻ » (maquette : un clic change la périodicité). */
export function suivanteDansLeCycle<T>(liste: readonly T[], actuelle: T): T {
  const i = liste.indexOf(actuelle);
  return liste[(i + 1) % liste.length]!;
}

export interface ObligationSaisie {
  organisme: string;
  nature: string;
  composition: string;
  periodicite: string;
  /** Le jour tel que saisi (« 20 », « » pour « à renseigner »). */
  jour: string;
  /** Une obligation ANNUELLE : le mois de l'année suivante (« 4 » pour avril) — vide = janvier. */
  mois?: string;
}

/** Une obligation lisible, ou le refus qui dit le remède. */
export function validerObligation(o: ObligationSaisie):
  | { ok: true; organisme: string; nature: string; composition: CompositionFiscale; periodicite: PeriodiciteFiscale; jourLimite: number | null; moisLimite: number | null }
  | { ok: false; error: string } {
  const organisme = o.organisme.trim();
  const nature = o.nature.trim();
  if (!organisme || !nature) return { ok: false, error: "Chaque échéance du calendrier porte un organisme et une nature : complétez-les, ou retirez la ligne." };
  if (!estCompositionFiscale(o.composition)) return { ok: false, error: `Composition inconnue pour « ${nature} » : choisissez G50, CNAS ou montant unique.` };
  if (!estPeriodiciteFiscale(o.periodicite)) return { ok: false, error: `Périodicité inconnue pour « ${nature} ».` };
  const moisBrut = (o.mois ?? "").trim();
  const moisLimite = o.periodicite === "ANNUELLE" && moisBrut ? Number(moisBrut) : null;
  if (moisLimite !== null && (!Number.isInteger(moisLimite) || moisLimite < 1 || moisLimite > 12)) {
    return { ok: false, error: `Mois limite illisible pour « ${nature} » : un nombre de 1 à 12 (le mois de l'année suivante), ou laissez vide pour janvier.` };
  }
  const brut = o.jour.trim();
  if (!brut) return { ok: true, organisme, nature, composition: o.composition, periodicite: o.periodicite, jourLimite: null, moisLimite };
  const jour = Number(brut.replace(/\D.*$/, ""));
  if (!Number.isInteger(jour) || jour < 1 || jour > 31) {
    return { ok: false, error: `Jour limite illisible pour « ${nature} » : un nombre de 1 à 31 (le jour du mois qui suit la période), ou laissez vide.` };
  }
  return { ok: true, organisme, nature, composition: o.composition, periodicite: o.periodicite, jourLimite: jour, moisLimite };
}

// ── La période et son échéance ───────────────────────────────────────────────────────────────

const MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];

export interface PeriodeFiscale {
  /** La clé unique par obligation (« 2026-11 », « 2026-T4 », « 2026 »). */
  cle: string;
  libelle: string;
  /** Le mois (1..12) et l'année où tombe le jour limite : le mois qui SUIT la période. */
  echeanceAnnee: number;
  echeanceMois: number;
}

/**
 * La période EN COURS d'une obligation à la date donnée — la ligne « À préparer » de novembre naît en novembre, payable
 * le mois suivant. `SELON_AVIS` n'a pas de période calendaire : `null` (voir `periodeSelonAvis`).
 */
export function periodeCourante(periodicite: PeriodiciteFiscale, maintenant: Date): PeriodeFiscale | null {
  const annee = maintenant.getUTCFullYear();
  const mois = maintenant.getUTCMonth() + 1;
  if (periodicite === "MENSUELLE") {
    return {
      cle: `${annee}-${String(mois).padStart(2, "0")}`, libelle: `${MOIS[mois - 1]} ${annee}`,
      echeanceAnnee: mois === 12 ? annee + 1 : annee, echeanceMois: mois === 12 ? 1 : mois + 1,
    };
  }
  if (periodicite === "TRIMESTRIELLE") {
    const t = Math.ceil(mois / 3);
    const finTrimestre = t * 3;
    return {
      cle: `${annee}-T${t}`, libelle: `${t}${t === 1 ? "er" : "e"} trimestre ${annee}`,
      echeanceAnnee: finTrimestre === 12 ? annee + 1 : annee, echeanceMois: finTrimestre === 12 ? 1 : finTrimestre + 1,
    };
  }
  if (periodicite === "ANNUELLE") return { cle: `${annee}`, libelle: `année ${annee}`, echeanceAnnee: annee + 1, echeanceMois: 1 };
  return null;
}

/** « Selon avis » (un acompte d'IBS) : une ligne à la fois, numérotée dans l'exercice ; l'échéance vient de l'avis. */
export function periodeSelonAvis(annee: number, rang: number): { cle: string; libelle: string } {
  return { cle: `${annee}-A${rang}`, libelle: rang > 1 ? `exercice ${annee} (${rang}e)` : `exercice ${annee}` };
}

/** Le jour limite dans le mois donné — un 31 en février devient le dernier jour du mois. Midi UTC : aucun fuseau ne le décale. */
export function dateEcheance(jourLimite: number | null | undefined, annee: number, mois: number): Date | null {
  if (!jourLimite) return null;
  const dernier = new Date(Date.UTC(annee, mois, 0)).getUTCDate();
  return new Date(Date.UTC(annee, mois - 1, Math.min(jourLimite, dernier), 12));
}

/** Le jour limite d'une période déjà née (« 2026-11 » → décembre 2026) — `null` pour « selon avis » ou sans jour. */
export function echeanceDeLaPeriode(periode: string | null | undefined, jourLimite: number | null | undefined, moisLimite?: number | null): Date | null {
  if (!periode || !jourLimite) return null;
  const m = /^(\d{4})-(\d{2})$/.exec(periode);
  const t = /^(\d{4})-T([1-4])$/.exec(periode);
  const a = /^(\d{4})$/.exec(periode);
  const fin = m ? Number(m[2]) : t ? Number(t[2]) * 3 : a ? 12 : null;
  const annee = Number((m ?? t ?? a)?.[1]);
  if (fin === null || !annee) return null;
  if (a) return dateEcheance(jourLimite, annee + 1, moisLimite ?? 1);
  return dateEcheance(jourLimite, fin === 12 ? annee + 1 : annee, fin === 12 ? 1 : fin + 1);
}

/** « avant le 20 déc. », « selon l'avis » — et « · à confirmer » tant que le jour n'est pas confirmé au calendrier. */
export function texteEcheance(echeance: Date | string | null | undefined, aConfirmer: boolean): string {
  if (!echeance) return "selon l'avis";
  const d = typeof echeance === "string" ? new Date(echeance) : echeance;
  const jour = d.toLocaleDateString("fr-FR", { day: "numeric", month: "short", timeZone: "UTC" });
  return `avant le ${jour}${aConfirmer ? " · à confirmer" : ""}`;
}

// ── Les montants ─────────────────────────────────────────────────────────────────────────────

/** Un montant saisi (« 1 214 600 », « 1214600,50 ») — `null` quand rien n'est saisi ou que c'est illisible. */
export function lireMontantFiscal(s: string | number | null | undefined): number | null {
  if (s === null || s === undefined) return null;
  if (typeof s === "number") return Number.isFinite(s) ? s : null;
  const net = s.replace(/[\s  ]/g, "").replace(",", ".");
  if (!net) return null;
  if (!/^-?\d+(\.\d{1,2})?$/.test(net)) return null;
  return Number(net);
}

/** 1214600 → « 1 214 600 » (espace fine, comme l'écran). */
export function formatDzd(n: number | null | undefined): string {
  return Math.round(n ?? 0).toLocaleString("fr-FR").replace(/[  ]/g, " ");
}

/** Les saisies des Finances sur une ligne — chaînes telles que tapées (un brouillon garde « » distinct de « 0 »). */
export interface SaisiesFiscales {
  irg?: string;
  /** La TVA à payer quand une source la PROPOSE (les factures, lot « tva ») — corrigée par les Finances. */
  tva?: string;
  tvaC?: string;
  tvaD?: string;
  autres?: { libelle: string; montant: string }[];
  sal?: string;
  pat?: string;
  montant?: string;
}

/**
 * Ce que la plateforme PROPOSE avant saisie : la somme des retenues inscrites sur les fiches (IRG, CNAS), et la TVA du
 * mois quand une source la fournit (`tva` — les factures, décision du Super Admin du 24/11/2026 ; aucune source
 * aujourd'hui). `null` = rien à proposer : la saisie redevient manuelle.
 */
export interface PropositionsPaie {
  irg: number | null;
  sal: number | null;
  pat: number | null;
  /** TVA à payer du mois (collectée − déductible) tirée des factures — `null` tant qu'aucune source ne la fournit. */
  tva: number | null;
  /** Le nombre de fiches additionnées. */
  fiches: number;
}

export const AUCUNE_PROPOSITION: PropositionsPaie = { irg: null, sal: null, pat: null, tva: null, fiches: 0 };

/** Les retenues FIXES d'une fiche salarié (Employee.retIrg, retSS9, retSS35) — saisies par les RH, jamais calculées. */
export interface RetenuesFiche {
  retIrg: number | null;
  retSS9: number | null;
  retSS35: number | null;
}

/**
 * La part patronale d'une fiche : la retenue « SS 35 % » (cotisation totale de la fiche) MOINS la retenue salariale
 * « SS 9 % ». Sans SS 35 % inscrite, aucune part patronale n'est proposée pour cette fiche (rien n'est deviné).
 */
export function partPatronaleDeLaFiche(f: RetenuesFiche): number | null {
  if (f.retSS35 === null) return null;
  return Math.max(0, f.retSS35 - (f.retSS9 ?? 0));
}

/** La somme des fiches — `null` pour une retenue qu'AUCUNE fiche ne porte : la saisie redevient manuelle, et l'écran le dit. */
export function propositionsDesFiches(fiches: readonly RetenuesFiche[]): PropositionsPaie {
  const somme = (lire: (f: RetenuesFiche) => number | null): number | null => {
    const v = fiches.map(lire).filter((x): x is number => x !== null);
    return v.length ? Math.round(v.reduce((a, b) => a + b, 0) * 100) / 100 : null;
  };
  return { irg: somme((f) => f.retIrg), sal: somme((f) => f.retSS9), pat: somme(partPatronaleDeLaFiche), tva: null, fiches: fiches.length };
}

/** D'où vient un montant : proposé par la paie (fiches), proposé par les factures (TVA), recopié d'une pièce. */
export type SourceMontant = "PAIE" | "FACTURES" | "DECLARATION" | "JUSTIFICATIF";

export interface LigneDecomposee {
  cle: "irg" | "tva" | "sal" | "pat" | "montant" | `autre${number}`;
  label: string;
  source: SourceMontant;
  montant: number;
  /** Le montant proposé (lignes « PAIE », TVA « FACTURES »), `null` ailleurs. */
  propose: number | null;
  /** La ligne n'est pas saisie (l'envoi la réclame). */
  manque: boolean;
  /** Le montant envoyé diffère du proposé — l'écart est tracé. */
  modifie: boolean;
}

export interface Decomposition {
  lignes: LigneDecomposee[];
  total: number;
  dePaie: number;
  /** La part proposée par les factures (la TVA, quand une source la fournit). */
  deFactures: number;
  deDeclaration: number;
  /** Ce qui reste à saisir, en mots (« TVA collectée et déductible »). */
  manque: string[];
  /** TVA collectée − déductible négative : rien n'est ajouté au total (crédit de TVA — à vérifier sur la déclaration). */
  tvaNegative: number | null;
  /** Une « autre ligne » porte un montant sans libellé. */
  autreSansLibelle: boolean;
}

/** La valeur d'une ligne PROPOSÉE : la saisie si elle existe, sinon la proposition de la paie. */
function valeurProposee(saisie: string | undefined, propose: number | null): { valeur: number | null; modifie: boolean } {
  const lu = saisie !== undefined && saisie.trim() !== "" ? lireMontantFiscal(saisie) : null;
  if (lu === null) return { valeur: propose, modifie: false };
  return { valeur: lu, modifie: propose !== null && Math.round(lu * 100) !== Math.round(propose * 100) };
}

/**
 * LA DÉCOMPOSITION D'UNE LIGNE — ce qui s'affiche au panneau « Préparer », ce qui part au centre. Aucun taux, aucune
 * assiette : des montants recopiés, une soustraction (TVA) et une somme.
 */
export function decomposer(composition: CompositionFiscale, s: SaisiesFiscales, p: PropositionsPaie): Decomposition {
  const lignes: LigneDecomposee[] = [];
  const manque: string[] = [];
  let tvaNegative: number | null = null;
  let autreSansLibelle = false;
  const saisi = (k: keyof SaisiesFiscales) => {
    const v = s[k];
    return typeof v === "string" && v.trim() !== "" ? lireMontantFiscal(v) : null;
  };

  const paie = (cle: "irg" | "sal" | "pat", label: string, propose: number | null, motManquant: string) => {
    const { valeur, modifie } = valeurProposee(s[cle], propose);
    if (valeur === null) manque.push(motManquant);
    lignes.push({ cle, label, source: "PAIE", montant: valeur ?? 0, propose, manque: valeur === null, modifie });
  };
  const declaree = (cle: "montant", label: string, source: SourceMontant, motManquant: string) => {
    const v = saisi(cle);
    if (v === null) manque.push(motManquant);
    lignes.push({ cle, label, source, montant: v ?? 0, propose: null, manque: v === null, modifie: false });
  };

  if (composition === "G50") {
    paie("irg", "IRG retenu sur les salaires", p.irg, "IRG");
    if (p.tva !== null) {
      // LA TVA PROPOSÉE PAR LES FACTURES : comme l'IRG — reprise telle quelle, corrigible, l'écart tracé à l'envoi.
      const { valeur, modifie } = valeurProposee(s.tva, Math.max(0, p.tva));
      lignes.push({ cle: "tva", label: "TVA à payer (factures du mois)", source: "FACTURES", montant: valeur ?? 0, propose: Math.max(0, p.tva), manque: false, modifie });
      if (p.tva < 0) tvaNegative = p.tva;
    } else {
      const c = saisi("tvaC");
      const d = saisi("tvaD");
      const tva = c !== null && d !== null ? c - d : null;
      if (tva === null) manque.push("TVA collectée et déductible");
      if (tva !== null && tva < 0) tvaNegative = tva;
      lignes.push({
        cle: "tva", label: c !== null && d !== null ? `TVA à payer (collectée ${formatDzd(c)} − déductible ${formatDzd(d)})` : "TVA du mois",
        source: "DECLARATION", montant: tva !== null ? Math.max(0, tva) : 0, propose: null, manque: tva === null, modifie: false,
      });
    }
    (s.autres ?? []).forEach((a, i) => {
      const m = lireMontantFiscal(a.montant);
      if (m !== null && m !== 0 && !a.libelle.trim()) autreSansLibelle = true;
      lignes.push({
        cle: `autre${i}`, label: a.libelle.trim() || "Autre ligne de la G50", source: "DECLARATION",
        montant: m ?? 0, propose: null, manque: false, modifie: false,
      });
    });
  } else if (composition === "CNAS") {
    paie("sal", "Part salariale — retenue SS 9 %", p.sal, "part salariale");
    paie("pat", "Part patronale", p.pat, "part patronale");
  } else {
    declaree("montant", "Montant à payer", "JUSTIFICATIF", "montant");
  }

  const arrondi = (n: number) => Math.round(n * 100) / 100;
  const total = arrondi(lignes.reduce((t, l) => t + l.montant, 0));
  const part = (src: SourceMontant) => arrondi(lignes.filter((l) => l.source === src).reduce((t, l) => t + l.montant, 0));
  const dePaie = part("PAIE");
  const deFactures = part("FACTURES");
  return { lignes, total, dePaie, deFactures, deDeclaration: arrondi(total - dePaie - deFactures), manque, tvaNegative, autreSansLibelle };
}

/** Le justificatif attendu, nommé (le libellé du champ obligatoire et le remède du refus). */
export function justificatifAttendu(composition: CompositionFiscale, periodeLibelle: string, organisme: string): string {
  if (composition === "G50") return `déclaration G50 de ${periodeLibelle}, signée`;
  if (composition === "CNAS") return `bordereau de déclaration CNAS de ${periodeLibelle}`;
  return `bordereau (ou l'avis, la lettre) de ${organisme}`;
}

/**
 * POURQUOI L'ENVOI EST REFUSÉ — `null` s'il peut partir. Le JUSTIFICATIF est obligatoire (décision du Super Admin) :
 * sans lui, la demande n'atteint ni le centre ni les Finances.
 */
export function refusEnvoiEcheance(e: {
  composition: CompositionFiscale; decomposition: Decomposition; justificatif: boolean; periodeLibelle: string; organisme: string;
}): string | null {
  if (e.decomposition.manque.length) {
    return `Encore à saisir : ${e.decomposition.manque.join(", ")} (mettez 0 si la ligne de la déclaration est vide).`;
  }
  if (e.decomposition.autreSansLibelle) return "Donnez son libellé (comme sur la déclaration) à chaque autre ligne qui porte un montant.";
  if (!e.justificatif) {
    const article = e.composition === "G50" ? "la" : "le";
    return `Le justificatif est obligatoire : joignez ${article} ${justificatifAttendu(e.composition, e.periodeLibelle, e.organisme)}.`;
  }
  if (e.decomposition.total <= 0) return "Le total est nul : rien à demander au centre de paiement.";
  return null;
}

/** Le sous-texte d'un montant envoyé, ligne par ligne (« Proposé par la paie — non modifié », « corrigé (proposé 401 600) »). */
export function origineDuMontant(l: Pick<LigneDecomposee, "source" | "propose" | "modifie">): string {
  if (l.source === "PAIE") {
    if (l.propose === null) return "Saisi par les Finances (aucune retenue sur les fiches)";
    return l.modifie ? `Proposé par la paie, corrigé (proposé ${formatDzd(l.propose)})` : "Proposé par la paie — non modifié";
  }
  if (l.source === "FACTURES") {
    return l.modifie ? `Proposé par les factures, corrigé (proposé ${formatDzd(l.propose)})` : "Proposé par les factures — non modifié";
  }
  return l.source === "DECLARATION" ? "Saisi depuis la déclaration" : "Saisi depuis le justificatif";
}

// ── L'état, lu sur l'ordre ───────────────────────────────────────────────────────────────────

export type EtatEcheance = "A_PREPARER" | "REFUSE" | "AU_CENTRE" | "AUTORISE" | "PAYE";

export const ETATS_ECHEANCE: Record<EtatEcheance, { label: string; tone: BadgeTone; ordre: number }> = {
  A_PREPARER: { label: "À préparer", tone: "neutral", ordre: 0 },
  REFUSE: { label: "Refusé", tone: "danger", ordre: 1 },
  AU_CENTRE: { label: "Au centre de paiement", tone: "warning", ordre: 2 },
  AUTORISE: { label: "Autorisé — à payer", tone: "info", ordre: 3 },
  PAYE: { label: "Payé", tone: "success", ordre: 4 },
};

/** Les filtres de la liste, dans l'ordre de la maquette. */
export const FILTRES_ECHEANCES: readonly { cle: "TOUS" | EtatEcheance; label: string }[] = [
  { cle: "TOUS", label: "Toutes" }, { cle: "A_PREPARER", label: "À préparer" }, { cle: "AU_CENTRE", label: "Au centre" },
  { cle: "AUTORISE", label: "Autorisé" }, { cle: "PAYE", label: "Payé" }, { cle: "REFUSE", label: "Refusé" },
];

/**
 * L'ÉTAT D'UNE LIGNE, LU SUR SON ORDRE. Sans ordre (ou ordre annulé) : à préparer. Payé : le statut d'exécution le dit
 * (seuls `settleExpenseOrder` / `verserLaRemise` l'écrivent). Sinon l'autorisation du centre.
 */
export function etatDeLEcheance(ordre: { status: string; centralStatus: string } | null | undefined): EtatEcheance {
  if (!ordre || ordre.status === "CANCELLED") return "A_PREPARER";
  if (ordre.status === "PAID") return "PAYE";
  if (ordre.centralStatus === "REFUSED") return "REFUSE";
  if (ordre.centralStatus === "APPROVED" || ordre.centralStatus === "NOT_REQUIRED") return "AUTORISE";
  return "AU_CENTRE";
}

/**
 * L'ÉTAT D'UNE LIGNE PAYÉE PAR PLUSIEURS ORDRES (une G50 ventilée sur plusieurs lignes du budget) : un refus l'emporte
 * (la ligne se reprend), puis une décision attendue ; payée quand TOUS ses ordres le sont ; autorisée sinon.
 */
export function etatDesOrdres(ordres: readonly { status: string; centralStatus: string }[]): EtatEcheance {
  const etats = ordres.filter((o) => o.status !== "CANCELLED").map((o) => etatDeLEcheance(o));
  if (etats.length === 0) return "A_PREPARER";
  if (etats.includes("REFUSE")) return "REFUSE";
  if (etats.includes("AU_CENTRE")) return "AU_CENTRE";
  return etats.every((e) => e === "PAYE") ? "PAYE" : "AUTORISE";
}

/** Les statuts du centre qui n'ont PAS encore décidé : on peut retirer la demande. */
export const CENTRE_NON_DECIDE = ["AWAITING", "AWAITING_PROOF", "CHANGES_REQUESTED", "INFO_REQUESTED"] as const;

export const refusRetraitEcheance = (etat: EtatEcheance): string | null =>
  etat === "AU_CENTRE" ? null
    : etat === "A_PREPARER" ? "Cette ligne n'est pas au centre de paiement : rien à retirer."
      : "Le centre de paiement a déjà décidé : la demande ne se retire plus d'ici.";

export const refusCorrectionEcheance = (etat: EtatEcheance): string | null =>
  etat === "REFUSE" ? null : "Seule une demande refusée par le centre se corrige pour être renvoyée.";

export const refusQuittanceEcheance = (etat: EtatEcheance): string | null =>
  etat === "PAYE" ? null : "La quittance se joint une fois la ligne payée par Banque & paiements.";

export const refusPreparationEcheance = (etat: EtatEcheance): string | null =>
  etat === "A_PREPARER" ? null : "Cette ligne est déjà partie au centre de paiement : retirez-la d'abord pour la modifier.";

// ── Le rappel avant échéance ─────────────────────────────────────────────────────────────────

export const JOURS_RAPPEL = 7;

/** Le rappel part UNE fois, dans les sept jours qui précèdent le jour limite, pour une ligne encore à préparer. */
export function rappelDu(l: {
  echeance: Date | null; rappel: boolean; etat: EtatEcheance; rappelEnvoyeLe: Date | null; maintenant: Date;
}): boolean {
  if (!l.rappel || !l.echeance || l.rappelEnvoyeLe || l.etat !== "A_PREPARER") return false;
  const debut = l.echeance.getTime() - JOURS_RAPPEL * 86_400_000;
  return l.maintenant.getTime() >= debut && l.maintenant.getTime() <= l.echeance.getTime() + 86_400_000;
}
