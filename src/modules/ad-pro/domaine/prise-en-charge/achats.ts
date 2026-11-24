/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * PRISE EN CHARGE — LE CIRCUIT D'ACHAT PAR BONS DE COMMANDE NUMÉROTÉS (Super Admin, 24/11/2026) — les règles, pures.
 *
 *   professionnel ajouté → chiffrage par l'assistante → validation de la Direction Marketing → « Lancer les achats » :
 *   BC n°k → signature DM → visa du centre Ad & Pro → signature des Finances → l'assistante achète CE QUI EST DANS LE BC →
 *   facture → UN ordre de dépense.
 *
 * Trois montants par poste, chacun avec son rôle :
 *   • le PRIX (`prixDzd`) : le dernier chiffré par l'assistante (ou corrigé par la Direction Marketing) ;
 *   • le VALIDÉ (`valideDzd`) : ce que la Direction Marketing a validé ;
 *   • les LIGNES de BC : ce que chaque BC porte (`montantDzd`, figé : un BC ne se réécrit jamais) et ce qui a réellement été
 *     acheté (`montantAchatDzd`, dans la marge de 10 %).
 * Ce qui est validé et pas encore couvert par une ligne vivante part au prochain BC (complémentaire si besoin).
 *
 * Module PUR (les seules règles des fiches) : lu par les actions, les écrans et les lignes du bureau ; testé sans base.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import { resumeBillet, resumeHotel, type CellRow } from "./fiches";

/** La marge de prix de l'assistante après la mise en BC : +10 % au plus sans nouveau BC (une baisse est toujours permise). */
export const MARGE_PRIX = 0.1;

export type StatutLigneAchat = "ACTIVE" | "ACHETEE" | "RETIREE_AVANT_ACHAT" | "RETIREE_APRES_ACHAT";

export interface LigneAchat {
  bcNumero: number;
  statut: StatutLigneAchat;
  /** Le montant porté par le BC (DZD) — figé. */
  montantDzd: number;
  /** Le montant réellement acheté (DZD), quand il diffère dans la marge ; `null` = celui du BC. */
  montantAchatDzd: number | null;
  /** Après un retrait suivant l'achat : `null` tant que personne n'a répondu « Remboursé ? ». */
  rembourse: boolean | null;
  rembourseDzd: number | null;
  /** Le BC est-il signé par les Finances (l'achat est alors permis) ? */
  bcSigneFinances: boolean;
  /** Le paiement du BC est-il demandé (l'ordre de dépense existe) ? */
  bcPaiementDemande?: boolean;
}

const centimes = (n: number) => Math.round(n * 100);
const dzd = (c: number) => c / 100;

/** Une ligne VIVANTE compte dans l'engagement : dans le BC ou achetée. Barrée ou retirée après achat, non. */
export const ligneVivante = (l: Pick<LigneAchat, "statut">) => l.statut === "ACTIVE" || l.statut === "ACHETEE";

/** Ce qu'une ligne coûte réellement : son achat corrigé, sinon le montant du BC. */
export const effectifDeLaLigne = (l: Pick<LigneAchat, "montantDzd" | "montantAchatDzd">) => l.montantAchatDzd ?? l.montantDzd;

/** Le total que les BC portent pour un poste (lignes vivantes) — la base de la marge. */
export function totalPorteParLesBc(lignes: readonly LigneAchat[]): number {
  return dzd(lignes.filter(ligneVivante).reduce((s, l) => s + centimes(l.montantDzd), 0));
}

/** Ce que les lignes vivantes coûtent réellement (achats corrigés compris). */
export function totalEffectif(lignes: readonly LigneAchat[]): number {
  return dzd(lignes.filter(ligneVivante).reduce((s, l) => s + centimes(effectifDeLaLigne(l)), 0));
}

/** Ce qui est validé et pas encore couvert par une ligne vivante : la part du prochain BC (0 s'il n'y a rien). */
export function resteAMettreEnBc(valideDzd: number | null, lignes: readonly LigneAchat[]): number {
  if (valideDzd == null) return 0;
  return Math.max(0, dzd(centimes(valideDzd) - centimes(totalEffectif(lignes))));
}

export type JugementPrix =
  /** Aucun BC ne porte encore ce poste : le prix change librement (il redevient « à valider »). */
  | { voie: "LIBRE" }
  /** Dans la marge (ou une baisse) : le prix d'achat est corrigé sans nouveau BC. */
  | { voie: "DANS_LA_MARGE"; base: number; plafond: number }
  /** Au-delà de la marge : le BC signé ne bouge pas, le complément part dans un BC complémentaire. */
  | { voie: "HORS_MARGE"; base: number; plafond: number; complement: number }
  /** Le paiement du BC est déjà demandé : le montant ne change plus d'ici. */
  | { voie: "PAIEMENT_DEMANDE"; bcNumero: number };

/** LA MARGE DE PRIX : jusqu'où un nouveau prix peut aller sans nouveau BC. */
export function jugerNouveauPrix(nouveauDzd: number, lignes: readonly LigneAchat[]): JugementPrix {
  const vivantes = lignes.filter(ligneVivante);
  if (vivantes.length === 0) return { voie: "LIBRE" };
  const payee = vivantes.find((l) => l.bcPaiementDemande);
  if (payee) return { voie: "PAIEMENT_DEMANDE", bcNumero: payee.bcNumero };
  const base = totalPorteParLesBc(vivantes);
  const plafond = dzd(Math.round(centimes(base) * (1 + MARGE_PRIX)));
  if (centimes(nouveauDzd) <= centimes(plafond)) return { voie: "DANS_LA_MARGE", base, plafond };
  return { voie: "HORS_MARGE", base, plafond, complement: dzd(centimes(nouveauDzd) - centimes(totalEffectif(vivantes))) };
}

/**
 * LE PRIX D'ACHAT RÉPARTI SUR LES LIGNES dans la marge : l'écart (hausse ou baisse) se porte sur la DERNIÈRE ligne vivante,
 * sans jamais passer sous zéro. Rend, par position dans `lignes`, le nouveau montant d'achat (ou `null` : inchangé).
 */
export function achatsApresCorrection(nouveauDzd: number, lignes: readonly LigneAchat[]): (number | null)[] {
  const out: (number | null)[] = lignes.map(() => null);
  const idx = lignes.map((l, i) => (ligneVivante(l) ? i : -1)).filter((i) => i >= 0);
  if (idx.length === 0) return out;
  const dernier = idx[idx.length - 1]!;
  const autres = idx.slice(0, -1).reduce((s, i) => s + centimes(effectifDeLaLigne(lignes[i]!)), 0);
  out[dernier] = dzd(Math.max(0, centimes(nouveauDzd) - autres));
  return out;
}

// ───────────────────────────── L'état d'un poste, d'un professionnel ─────────────────────────────

export type EtatAchat =
  | "PROPOSE"
  | "CHIFFRAGE_DEMANDE"
  | "A_VALIDER"
  | "VALIDE"
  | "DANS_BC_SIGNATURE"
  | "DANS_BC_A_ACHETER"
  | "ACHETE"
  | "RETIRE"
  | "RETIRE_APRES_ACHAT"
  | "REMBOURSE";

export interface FaitsPoste {
  chiffre: boolean;
  prixDzd: number | null;
  valideDzd: number | null;
  /** Une demande de chiffrage ouverte couvre ce poste. */
  enChiffrage: boolean;
  lignes: readonly LigneAchat[];
}

export interface EtatLu { code: EtatAchat; libelle: string }

const plusRecent = (lignes: readonly LigneAchat[]) => lignes.reduce((m, l) => Math.max(m, l.bcNumero), 0);

/** Le prix chiffré attend-il la Direction Marketing ? Un prix différent de ce qu'elle a validé (complément compris). */
export function prixAValider(f: Pick<FaitsPoste, "chiffre" | "prixDzd" | "valideDzd">): boolean {
  if (!f.chiffre || f.prixDzd == null) return false;
  return f.valideDzd == null || centimes(f.prixDzd) !== centimes(f.valideDzd);
}

/** OÙ EN EST UN POSTE — une phrase, la même pour la fiche, le tableau et le bureau. */
export function etatDuPoste(f: FaitsPoste): EtatLu {
  const vivantes = f.lignes.filter(ligneVivante);
  if (f.lignes.length > 0 && vivantes.length === 0) {
    const apres = f.lignes.filter((l) => l.statut === "RETIREE_APRES_ACHAT");
    const n = plusRecent(f.lignes);
    if (apres.some((l) => l.rembourse === true)) return { code: "REMBOURSE", libelle: "Remboursé" };
    if (apres.some((l) => l.rembourse == null)) return { code: "RETIRE_APRES_ACHAT", libelle: `Retiré après achat (BC n°${n}) — remboursé ?` };
    if (apres.length > 0) return { code: "RETIRE_APRES_ACHAT", libelle: `Retiré après achat (BC n°${n}) — non remboursé` };
    return { code: "RETIRE", libelle: `Retiré du BC n°${n} avant achat` };
  }
  if (prixAValider(f)) return { code: "A_VALIDER", libelle: vivantes.length ? "Complément chiffré — à valider" : "Chiffré — à valider" };
  if (resteAMettreEnBc(f.valideDzd, f.lignes) > 0) return { code: "VALIDE", libelle: vivantes.length ? "Complément validé — pas encore dans un BC" : "Validé — pas encore dans un BC" };
  const actives = vivantes.filter((l) => l.statut === "ACTIVE");
  if (actives.length > 0) {
    const n = plusRecent(actives);
    return actives.every((l) => l.bcSigneFinances)
      ? { code: "DANS_BC_A_ACHETER", libelle: `Dans le BC n°${n} — à acheter` }
      : { code: "DANS_BC_SIGNATURE", libelle: `Dans le BC n°${n} — en signature` };
  }
  if (vivantes.length > 0) return { code: "ACHETE", libelle: `Acheté · BC n°${plusRecent(vivantes)}` };
  if (f.enChiffrage) return { code: "CHIFFRAGE_DEMANDE", libelle: "Chiffrage demandé" };
  return { code: "PROPOSE", libelle: "Proposé" };
}

/** L'ordre dans lequel un professionnel se lit : ce qui attend un geste d'abord. */
const PRIORITE: Record<EtatAchat, number> = {
  A_VALIDER: 0, CHIFFRAGE_DEMANDE: 1, PROPOSE: 2, VALIDE: 3, RETIRE_APRES_ACHAT: 4,
  DANS_BC_SIGNATURE: 5, DANS_BC_A_ACHETER: 6, ACHETE: 7, REMBOURSE: 8, RETIRE: 9,
};

/**
 * OÙ EN EST UN PROFESSIONNEL — son poste le moins avancé (ce qui attend un geste se lit en premier). Retiré, il se lit
 * barré : « Retiré », ou ce qui reste à dire de ses achats (« remboursé ? »).
 */
export function etatDuProfessionnel(p: { retire: boolean; enChiffrage: boolean; postes: readonly FaitsPoste[] }): EtatLu {
  const etats = p.postes.map(etatDuPoste);
  if (p.retire) {
    const apres = etats.find((e) => e.code === "RETIRE_APRES_ACHAT") ?? etats.find((e) => e.code === "REMBOURSE");
    return apres ?? etats.find((e) => e.code === "RETIRE") ?? { code: "RETIRE", libelle: "Retiré" };
  }
  if (etats.length === 0) return p.enChiffrage ? { code: "CHIFFRAGE_DEMANDE", libelle: "Chiffrage demandé" } : { code: "PROPOSE", libelle: "Proposé" };
  return [...etats].sort((a, b) => PRIORITE[a.code] - PRIORITE[b.code])[0]!;
}

// ───────────────────────────── L'argent ─────────────────────────────

/**
 * CE QU'UN POSTE ENGAGE — ce que lit la porte du DG et le bandeau des montants : ses lignes (achat réel ; barrées : rien ;
 * retirées après achat : l'achat moins le remboursement) et, tant que la personne est prise en charge, son prix chiffré
 * s'il dépasse ce que les lignes portent déjà.
 */
export function montantEngage(f: { actif: boolean; chiffre: boolean; prixDzd: number | null; lignes: readonly LigneAchat[] }): number {
  let c = 0;
  for (const l of f.lignes) {
    if (l.statut === "RETIREE_AVANT_ACHAT") continue;
    const eff = centimes(effectifDeLaLigne(l));
    if (l.statut === "RETIREE_APRES_ACHAT") c += l.rembourse ? Math.max(0, eff - centimes(l.rembourseDzd ?? effectifDeLaLigne(l))) : eff;
    else c += eff;
  }
  if (f.actif && f.chiffre && f.prixDzd != null) c = Math.max(c, centimes(f.prixDzd));
  return dzd(c);
}

/** CE QU'UN BC COÛTE À PAYER : les lignes achetées (achat réel), et les retirées après achat moins leur remboursement. */
export function totalAPayer(lignes: readonly LigneAchat[]): number {
  let c = 0;
  for (const l of lignes) {
    const eff = centimes(effectifDeLaLigne(l));
    if (l.statut === "ACHETEE") c += eff;
    else if (l.statut === "RETIREE_APRES_ACHAT") c += l.rembourse ? Math.max(0, eff - centimes(l.rembourseDzd ?? effectifDeLaLigne(l))) : eff;
  }
  return dzd(c);
}

/** POURQUOI LE PAIEMENT D'UN BC NE SE DEMANDE PAS ENCORE — `null` quand il se demande. Le refus dit le geste qui manque. */
export function refusPaiementDuBc(b: { signeFinances: boolean; paiementDemande: boolean; facture: boolean; lignes: readonly LigneAchat[] }): string | null {
  if (b.paiementDemande) return "Le paiement de ce BC est déjà demandé : un seul ordre de dépense par BC.";
  if (!b.signeFinances) return "Ce BC n'est pas encore signé par les Finances : rien ne s'achète ni ne se paie avant.";
  const aAcheter = b.lignes.filter((l) => l.statut === "ACTIVE").length;
  if (aAcheter > 0) return `${aAcheter} ligne${aAcheter > 1 ? "s" : ""} du BC ${aAcheter > 1 ? "ne sont" : "n'est"} pas encore achetée${aAcheter > 1 ? "s" : ""} : achetez-la${aAcheter > 1 ? "s" : ""} (ou retirez le professionnel) avant de demander le paiement.`;
  const enQuestion = b.lignes.filter((l) => l.statut === "RETIREE_APRES_ACHAT" && l.rembourse == null).length;
  if (enQuestion > 0) return "Répondez d'abord à « Remboursé ? » pour chaque professionnel retiré après l'achat : le montant à payer en dépend.";
  if (totalAPayer(b.lignes) <= 0) return "Rien n'a été acheté sur ce BC : il n'y a rien à payer.";
  if (!b.facture) return "Joignez la facture : le paiement d'un BC ne se demande jamais sans elle.";
  return null;
}

/** L'ACHAT D'UNE LIGNE : seulement ce qui est DANS un BC signé par les Finances, et pas déjà acheté ou retiré. */
export function refusAchatDeLaLigne(l: Pick<LigneAchat, "statut" | "bcSigneFinances" | "bcNumero">): string | null {
  if (l.statut === "ACHETEE") return "Cette ligne est déjà achetée.";
  if (l.statut === "RETIREE_AVANT_ACHAT" || l.statut === "RETIREE_APRES_ACHAT") return "Ce professionnel est retiré : sa ligne ne s'achète plus.";
  if (!l.bcSigneFinances) return `Le BC n°${l.bcNumero} n'est pas encore signé par les Finances : on n'achète qu'après leur signature.`;
  return null;
}

/** Le refus d'un dépôt (billet, confirmation) sur un poste du circuit d'achat qui n'est dans aucun BC signé. */
export function refusAchatHorsBc(lignes: readonly Pick<LigneAchat, "statut" | "bcSigneFinances" | "bcNumero">[]): string | null {
  if (lignes.some((l) => (l.statut === "ACTIVE" || l.statut === "ACHETEE") && l.bcSigneFinances)) return null;
  const enSignature = lignes.find((l) => l.statut === "ACTIVE");
  if (enSignature) return `Ce poste est dans le BC n°${enSignature.bcNumero}, pas encore signé par les Finances : on n'achète qu'après leur signature.`;
  return "Ce poste n'est dans aucun bon de commande signé : la Direction Marketing doit d'abord le valider et « Lancer les achats ».";
}

// ───────────────────────────── Le circuit d'un BC ─────────────────────────────

export type EtapeCircuitBc = "SIGNATURE_DM" | "CENTRE" | "SIGNATURE_FINANCES" | "ACHAT" | "PAIEMENT" | "PAYE" | "ANNULE" | "REFUSE";

export interface FaitsCircuitBc {
  annule: boolean;
  signeDm: boolean;
  /** L'étape du BC lue par le circuit des bons de commande (`etapeBC`) : A_VALIDER, A_REVOIR, REFUSE, A_SIGNER, SIGNE… */
  etapeBc: string;
  lignesActives: number;
  paiementDemande: boolean;
  paye: boolean;
}

/** OÙ EN EST LE CIRCUIT D'UN BC — l'étape qui attend. */
export function etapeDuCircuitBc(f: FaitsCircuitBc): EtapeCircuitBc {
  if (f.annule) return "ANNULE";
  if (!f.signeDm) return "SIGNATURE_DM";
  if (f.etapeBc === "REFUSE") return "REFUSE";
  if (f.etapeBc !== "SIGNE") return f.etapeBc === "A_SIGNER" || f.etapeBc === "A_CORRIGER" ? "SIGNATURE_FINANCES" : "CENTRE";
  if (f.lignesActives > 0) return "ACHAT";
  if (!f.paiementDemande) return "PAIEMENT";
  return f.paye ? "PAYE" : "PAIEMENT";
}

export const LIBELLE_ETAPE_CIRCUIT_BC: Record<EtapeCircuitBc, string> = {
  SIGNATURE_DM: "À signer par la Direction Marketing",
  CENTRE: "Signé DM → au centre Ad & Pro",
  SIGNATURE_FINANCES: "Signé DM → visé → à signer par les Finances",
  ACHAT: "Signé Finances → à acheter",
  PAIEMENT: "Acheté → paiement à demander",
  PAYE: "Acheté → payé",
  ANNULE: "Annulé",
  REFUSE: "Refusé par le centre Ad & Pro",
};

/** La phrase du circuit, avec le paiement en cours quand il est demandé. */
export function phraseCircuitBc(f: FaitsCircuitBc): string {
  const e = etapeDuCircuitBc(f);
  if (e === "PAIEMENT" && f.paiementDemande) return "Acheté → paiement demandé (centre de paiement → Finances)";
  return LIBELLE_ETAPE_CIRCUIT_BC[e];
}

/** La Direction Marketing (ou le Super Admin) : qui valide les montants, lance les achats et signe le BC pour elle. */
export function estDirectionMarketing(roles: readonly string[]): boolean {
  return roles.some((r) => r === "PRODUCT_MANAGER" || r === "SUPER_ADMIN");
}

/** Qui tient les montants : l'assistante de direction, la Direction Marketing, le Super Admin. */
export function tientLesMontants(roles: readonly string[]): boolean {
  return roles.some((r) => r === "DIRECTION_ASSISTANT" || r === "PRODUCT_MANAGER" || r === "SUPER_ADMIN");
}

/** Le détail d'un poste, lisible seul (la colonne « Détail » du chiffrage, la ligne du BC). */
export function detailDuPoste(c: CellRow): string {
  if (c.serviceKind === "TICKET") return resumeBillet(c);
  if (c.serviceKind === "HOTEL") return resumeHotel(c);
  const quand = c.dateStart ? c.dateStart.split("-").reverse().join("/") : null;
  return [c.notes, quand, c.timeStart, c.address].filter((x) => x && String(x).trim()).join(" · ") || "à préciser";
}

/** Le nom court d'un poste dans le tableau des professionnels (« Billet, Hôtel »). */
export function nomCourtDuPoste(serviceKind: string | null): string {
  switch (serviceKind) {
    case "TICKET": return "Billet";
    case "HOTEL": return "Hôtel";
    case "TRANSPORT": return "Transport";
    case "CATERING": return "Repas";
    case "REGISTRATION": return "Accès";
    case "VISA_FEE": return "Visa";
    default: return "Autre";
  }
}
