/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'ANTI-FRACTIONNEMENT — des demandes qui, une à une, restent sous un seuil, et ensemble le dépassent.
 *
 * Les seuils de la maison se lisent sur le TOTAL d'une demande (la porte du Directeur Général à 1 M DZD, le visa des bons
 * de commande, les règles du centre de validations). Couper une dépense de 1,5 M en trois demandes de 500 000 au même
 * fournisseur fait passer chacune sous la porte : aucune n'est fausse, l'ensemble contourne l'arbitrage. Le constat des
 * garde-fous (Super Admin, 24/11/2026) : « la somme des demandes du même bénéficiaire sur 30 jours compte ».
 *
 * La règle SIGNALE, elle ne re-route rien : les circuits et leurs seuils restent ceux d'aujourd'hui (décision du Super
 * Admin). Le signal accompagne la demande là où l'on décide de l'argent — tout paiement passe par le centre de paiement —
 * avec les demandes liées, pour que la Direction générale tranche en connaissance de cause.
 *
 * Ce qui LIE deux demandes : le MÊME DEMANDEUR, et le même bénéficiaire (nom comparé casse, accents et espaces mis à part,
 * comme `memeBeneficiaire`) OU la même ligne budgétaire. Sur une fenêtre de 30 jours qui contient la demande examinée.
 * Seules comptent les demandes qui, chacune, restent sous le seuil : une demande au-dessus a déjà franchi sa porte.
 *
 * Module PUR : aucun import (la date du jour n'est pas lue — la fenêtre est celle de la demande).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const FENETRE_FRACTIONNEMENT_JOURS = 30;
const FENETRE_MS = FENETRE_FRACTIONNEMENT_JOURS * 24 * 60 * 60 * 1000;

export interface DemandeComparable {
  id: string;
  reference?: string | null;
  montant: number;
  /** La date de la demande (naissance de l'ordre). */
  date: Date;
  demandeurId: string | null;
  beneficiaire: string | null;
  /** La ligne budgétaire (catégorie d'enveloppe), quand la demande en porte une. */
  ligneBudgetaire: string | null;
}

export interface SeuilDeFractionnement {
  cle: string;
  /** Ce que la personne lit : « porte du Directeur Général sur le total Ad & Pro ». */
  libelle: string;
  montant: number;
  /**
   * `true` : le seuil s'atteint À PARTIR de son montant (règle du centre de validations, `amount >= minAmount`) ;
   * `false` : STRICTEMENT au-dessus (porte DG, seuils des BC — `porteDgRequise`).
   */
  inclusif: boolean;
}

export interface DemandeLiee {
  id: string;
  reference: string | null;
  montant: number;
  date: Date;
  /** Ce qui la lie à la demande examinée. */
  par: "BENEFICIAIRE" | "LIGNE_BUDGETAIRE";
}

export interface SignalFractionnement {
  seuil: SeuilDeFractionnement;
  /** Le cumul de la fenêtre, demande examinée comprise. */
  cumul: number;
  debut: Date;
  fin: Date;
  /** Les AUTRES demandes de la fenêtre, de la plus ancienne à la plus récente. */
  liees: DemandeLiee[];
}

const plie = (s: string | null | undefined): string =>
  (s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").trim().replace(/\s+/g, " ").toLocaleLowerCase("fr");

const sousLeSeuil = (montant: number, s: SeuilDeFractionnement): boolean =>
  montant > 0 && (s.inclusif ? montant < s.montant : montant <= s.montant);
const franchit = (cumul: number, s: SeuilDeFractionnement): boolean =>
  s.inclusif ? cumul >= s.montant : cumul > s.montant;

/** Ce qui lie `autre` à `cible`, ou `null`. Un demandeur inconnu (ordre émis par le système) ne lie personne. */
function lien(cible: DemandeComparable, autre: DemandeComparable): DemandeLiee["par"] | null {
  if (!cible.demandeurId || autre.demandeurId !== cible.demandeurId) return null;
  const b = plie(cible.beneficiaire);
  if (b && plie(autre.beneficiaire) === b) return "BENEFICIAIRE";
  if (cible.ligneBudgetaire && autre.ligneBudgetaire === cible.ligneBudgetaire) return "LIGNE_BUDGETAIRE";
  return null;
}

/** Le signal pour UN seuil : la fenêtre de 30 jours contenant la cible dont le cumul est le plus haut, si elle franchit. */
function pourUnSeuil(cible: DemandeComparable, autres: readonly DemandeComparable[], s: SeuilDeFractionnement): SignalFractionnement | null {
  if (!sousLeSeuil(cible.montant, s)) return null;
  const t0 = cible.date.getTime();
  const liees: DemandeLiee[] = [];
  for (const a of autres) {
    if (a.id === cible.id || !sousLeSeuil(a.montant, s)) continue;
    if (Math.abs(a.date.getTime() - t0) > FENETRE_MS) continue;
    const par = lien(cible, a);
    if (par) liees.push({ id: a.id, reference: a.reference ?? null, montant: a.montant, date: a.date, par });
  }
  if (liees.length === 0) return null;

  // Chaque début possible d'une fenêtre qui contient la cible : la cible elle-même, ou une demande liée antérieure.
  const debuts = [t0, ...liees.map((l) => l.date.getTime()).filter((t) => t <= t0 && t0 - t <= FENETRE_MS)];
  let meilleur: { cumul: number; debut: number; dans: DemandeLiee[] } | null = null;
  for (const debut of debuts) {
    const fin = debut + FENETRE_MS;
    const dans = liees.filter((l) => l.date.getTime() >= debut && l.date.getTime() <= fin);
    const cumul = cible.montant + dans.reduce((n, l) => n + l.montant, 0);
    if (!meilleur || cumul > meilleur.cumul) meilleur = { cumul, debut, dans };
  }
  if (!meilleur || meilleur.dans.length === 0 || !franchit(meilleur.cumul, s)) return null;
  const tri = [...meilleur.dans].sort((x, y) => x.date.getTime() - y.date.getTime());
  return {
    seuil: s,
    cumul: Math.round(meilleur.cumul * 100) / 100,
    debut: new Date(meilleur.debut),
    fin: new Date(meilleur.debut + FENETRE_MS),
    liees: tri,
  };
}

/**
 * LA DEMANDE `cible` EST-ELLE UN POSSIBLE FRACTIONNEMENT ? Le seuil le plus HAUT qu'elle contourne avec ses voisines, ou
 * `null`. Le plus haut parce que c'est l'arbitrage le plus lourd qui a été évité (la porte du DG plutôt qu'un visa de BC).
 */
export function detecterFractionnement(
  cible: DemandeComparable, autres: readonly DemandeComparable[], seuils: readonly SeuilDeFractionnement[],
): SignalFractionnement | null {
  const parHauteur = [...seuils].filter((s) => s.montant > 0).sort((a, b) => b.montant - a.montant);
  for (const s of parHauteur) {
    const signal = pourUnSeuil(cible, autres, s);
    if (signal) return signal;
  }
  return null;
}

/**
 * LES SEUILS EN VIGUEUR, lus dans les réglages — ceux d'aujourd'hui, sans en inventer. Un seuil à 0 (ou absent) est
 * DÉSARMÉ (« tout passe » ou « rien ne passe ») : il n'y a rien à contourner.
 */
export function seuilsDeFractionnement(r: {
  adProDgThreshold: number;
  bcValidationThreshold: number;
  bcValidationThresholdCentre: number;
  /** Les règles ACTIVES du centre de validations qui partent d'un montant (`ValidationRule.minAmount`). */
  reglesDeValidation?: readonly { nom: string; minAmount: number }[];
}): SeuilDeFractionnement[] {
  const seuils: SeuilDeFractionnement[] = [];
  if (r.adProDgThreshold > 0) seuils.push({ cle: "DG_AD_PRO", libelle: "porte du Directeur Général sur le total Ad & Pro", montant: r.adProDgThreshold, inclusif: false });
  if (r.bcValidationThreshold > 0) seuils.push({ cle: "BC_AD_PRO", libelle: "visa des bons de commande au centre Ad & Pro", montant: r.bcValidationThreshold, inclusif: false });
  if (r.bcValidationThresholdCentre > 0) seuils.push({ cle: "BC_CENTRE", libelle: "visa des bons de commande au centre de validations", montant: r.bcValidationThresholdCentre, inclusif: false });
  for (const regle of r.reglesDeValidation ?? []) {
    if (regle.minAmount > 0) seuils.push({ cle: `REGLE:${regle.nom}`, libelle: `règle de validation « ${regle.nom} »`, montant: regle.minAmount, inclusif: true });
  }
  return seuils;
}

const dzd = (n: number) => `${Math.round(n).toLocaleString("fr-FR")} DZD`;

/** La phrase du signal — la même à l'écran, dans l'audit et pour l'assistant. */
export function phraseFractionnement(signal: SignalFractionnement): string {
  const n = signal.liees.length + 1;
  const par = signal.liees.every((l) => l.par === "BENEFICIAIRE") ? "au même bénéficiaire"
    : signal.liees.every((l) => l.par === "LIGNE_BUDGETAIRE") ? "sur la même ligne budgétaire"
      : "au même bénéficiaire ou sur la même ligne budgétaire";
  const refs = signal.liees.map((l) => l.reference ?? l.id).join(", ");
  return `Possible fractionnement : ${n} demandes du même demandeur ${par} en ${FENETRE_FRACTIONNEMENT_JOURS} jours totalisent `
    + `${dzd(signal.cumul)}, au-delà du seuil de ${dzd(signal.seuil.montant)} (${signal.seuil.libelle}), chacune restant en dessous. `
    + `Demandes liées : ${refs}.`;
}
