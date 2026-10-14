/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE BUREAU DU SECRÉTARIAT, REFONDU (maquette validée, 10/2026) — les règles d'AFFICHAGE, pures.
 *
 * « Chaque information a UN seul endroit. » La fiche d'une demande montrait le montant à sept
 * endroits (champ « budget » du formulaire, accord du N+1, montant du matériel promotionnel, BC,
 * facture, ordre de dépense, imputation aux moyens généraux) et trois blocs de validations ; le
 * tableau n'en montrait aucun. Ce module dit, une fois, pour le tableau ET la fiche :
 *
 *   • `montantDeLaDemande` — LE montant d'une ligne du tableau, avec sa précédence ;
 *   • `lignesDeMontant`    — la carte « Montant » de la fiche, une ligne par étape ;
 *   • `friseDeLaDemande`   — Déposée → Validée → Traitement → Paiement → Terminée ;
 *   • `chezQuiDeLaDemande` — où en est la demande, et chez qui ;
 *   • `gesteSuivant`       — le bouton principal de l'en-tête ;
 *   • `TUILES` / `dansLaTuile` — les tuiles-filtres du tableau.
 *
 * Module PUR (aucun import) : la page serveur, le tableau client et les bancs lisent la même règle.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

// ─────────────────────────── Le montant ───────────────────────────

/**
 * Les FAITS d'argent d'une demande, chacun lu à sa source (jamais recopié) — `null` : le fait
 * n'existe pas. Les sommes portent sur ce qui est EN VIE (un BC ou une facture annulés, un ordre
 * annulé ne comptent pas — le chargeur les écarte).
 */
export interface FaitsMontant {
  /** Saisi à la demande : champ « Montant » / « Budget estimé », ou lignes d'achat chiffrées au catalogue. */
  estime: number | null;
  /** Retenu sur les devis retranscrits (lignes cochées par le demandeur, TTC). */
  devisRetenu: number | null;
  /** Accordé : la dernière approbation ACCORDÉE qui porte un montant (N+1, Finances). */
  valide: number | null;
  /** Engagé : la somme des bons de commande en vie de la demande. */
  engage: number | null;
  /** Facturé : la somme des factures en vie de la demande. */
  facture: number | null;
  /** Réglé par les Finances : la somme des ordres de dépense PAYÉS. */
  paye: number | null;
  /** En attente de règlement : la somme des ordres émis, ni payés ni annulés. */
  enAttentePaiement: number | null;
  /** Imputé aux moyens généraux à la fin du traitement (« montant réellement dépensé »). */
  impute: number | null;
}

export const FAITS_VIDES: FaitsMontant = {
  estime: null, devisRetenu: null, valide: null, engage: null, facture: null, paye: null, enAttentePaiement: null, impute: null,
};

export type EtapeMontant = "PAYE" | "IMPUTE" | "FACTURE" | "ENGAGE" | "VALIDE" | "DEVIS" | "ESTIME";

/**
 * LA PRÉCÉDENCE — le fait le plus AVANCÉ dans la vie de l'argent l'emporte :
 *
 *   payé (Finances) › imputé (fin du traitement) › facturé › engagé (BC) › accordé › devis retenu › estimé.
 *
 * Pourquoi cet ordre : chaque étape CORRIGE la précédente avec un fait plus sûr. L'estimation est
 * une intention, l'accord un plafond, le BC un engagement, la facture une dette, le règlement de
 * l'argent sorti. Le tableau montre donc toujours le chiffre le plus proche de la réalité, et dit
 * de quelle étape il vient. Un montant nul, négatif ou illisible n'est pas un fait (« 0 DZD » se
 * lirait « gratuit ») : on passe au suivant.
 */
export const PRECEDENCE_MONTANT: readonly EtapeMontant[] = ["PAYE", "IMPUTE", "FACTURE", "ENGAGE", "VALIDE", "DEVIS", "ESTIME"];

export const LIBELLE_ETAPE_MONTANT: Record<EtapeMontant, string> = {
  PAYE: "payé", IMPUTE: "imputé", FACTURE: "facturé", ENGAGE: "engagé (BC)", VALIDE: "validé", DEVIS: "devis retenu", ESTIME: "estimé",
};

const CHAMP_DE: Record<EtapeMontant, keyof FaitsMontant> = {
  PAYE: "paye", IMPUTE: "impute", FACTURE: "facture", ENGAGE: "engage", VALIDE: "valide", DEVIS: "devisRetenu", ESTIME: "estime",
};

const utilisable = (n: number | null | undefined): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;

/** LE montant d'une demande — `null` quand aucun fait n'en porte un. */
export function montantDeLaDemande(f: FaitsMontant): { montant: number; etape: EtapeMontant } | null {
  for (const etape of PRECEDENCE_MONTANT) {
    const v = f[CHAMP_DE[etape]];
    if (utilisable(v)) return { montant: v, etape };
  }
  return null;
}

/** Une ligne de la carte « Montant » de la fiche. */
export interface LigneMontant { cle: "ESTIME" | "VALIDE" | "ENGAGE" | "PAYE"; libelle: string; montant: number | null; detail: string }

/**
 * LA CARTE « MONTANT » — une ligne par étape, dans l'ordre où l'argent avance : estimé, validé,
 * engagé (BC), payé. Chaque ligne a sa source ; une étape sans fait le DIT (« en attente des
 * Finances », « aucun bon de commande ») au lieu d'afficher un zéro.
 */
export function lignesDeMontant(f: FaitsMontant, sources: { estimePar?: string | null; validePar?: string | null; bcs?: string | null } = {}): LigneMontant[] {
  const estime = utilisable(f.estime) ? f.estime : utilisable(f.devisRetenu) ? f.devisRetenu : null;
  return [
    {
      cle: "ESTIME", libelle: "Estimé à la demande", montant: estime,
      detail: utilisable(f.estime) ? (sources.estimePar ? `saisi par ${sources.estimePar}` : "saisi à la demande")
        : utilisable(f.devisRetenu) ? "lignes retenues sur les devis" : "aucun montant saisi",
    },
    { cle: "VALIDE", libelle: "Validé", montant: utilisable(f.valide) ? f.valide : null, detail: utilisable(f.valide) ? (sources.validePar ? `par ${sources.validePar}` : "accordé") : "aucun accord chiffré" },
    { cle: "ENGAGE", libelle: "Engagé (bon de commande)", montant: utilisable(f.engage) ? f.engage : null, detail: utilisable(f.engage) ? (sources.bcs ?? "bon de commande") : "aucun bon de commande" },
    {
      cle: "PAYE", libelle: "Payé", montant: utilisable(f.paye) ? f.paye : utilisable(f.impute) ? f.impute : null,
      detail: utilisable(f.paye) ? "réglé par les Finances"
        : utilisable(f.impute) ? "imputé aux moyens généraux"
          : utilisable(f.enAttentePaiement) ? `en attente des Finances (${Math.round(f.enAttentePaiement).toLocaleString("fr-FR")} DZD)` : "rien de réglé",
    },
  ];
}

/** Le montant estimé lu dans les champs saisis : « Montant » (paiement), « Budget estimé », ou les lignes d'achat chiffrées. */
export function montantEstimeDesChamps(fields: unknown): number | null {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return null;
  const f = fields as Record<string, unknown>;
  for (const cle of ["montant", "budget", "totalEstime"]) {
    const v = typeof f[cle] === "number" ? f[cle] as number : typeof f[cle] === "string" ? Number(String(f[cle]).replace(/\s/g, "").replace(",", ".")) : NaN;
    if (utilisable(v)) return v;
  }
  const lignes = Array.isArray(f.purchaseLines) ? f.purchaseLines : [];
  let total = 0; let chiffre = false;
  for (const l of lignes) {
    if (!l || typeof l !== "object") continue;
    const q = Number((l as Record<string, unknown>).quantity);
    const p = (l as Record<string, unknown>).unitPrice;
    if (typeof p === "number" && p > 0 && Number.isFinite(q) && q > 0) { total += q * p; chiffre = true; }
  }
  return chiffre ? total : null;
}

// ─────────────────────────── La frise ───────────────────────────

export type EtatEtapeFrise = "FAITE" | "COURANTE" | "A_VENIR" | "SANS_OBJET" | "REFUSEE";
export interface EtapeFrise { cle: "DEPOSEE" | "VALIDEE" | "TRAITEMENT" | "PAIEMENT" | "TERMINEE"; libelle: string; etat: EtatEtapeFrise; detail: string }

export interface EntreeFrise {
  /** Le statut tel qu'il s'AFFICHE (`statutAffiche`). */
  statut: string;
  commencee: boolean;
  /** Les approbations de la demande (N+1, Finances…), la plus récente d'abord ou non — l'ordre n'importe pas. */
  approbations: { status: string; decideur?: string | null; le?: string | null }[];
  /** Une validation du bureau central (hors pièces) est en attente. */
  validationEnAttente: boolean;
  /** Un ordre de dépense a été émis pour elle (payé ou non). */
  ordreEmis: boolean;
  demandeur?: string | null;
  deposeeLe?: string | null;
  responsable?: string | null;
}

/**
 * LA FRISE, CALCULÉE DE L'ÉTAT — jamais posée à la main. « Validée » et « Paiement » sont
 * facultatives : une demande qui n'a demandé aucun accord, ou que personne ne paie, les montre
 * « sans objet ». Une demande ANNULÉE garde ce qui a été fait, et le reste passe « sans objet ».
 */
export function friseDeLaDemande(e: EntreeFrise): EtapeFrise[] {
  const s = e.statut;
  const close = s === "DONE";
  const annulee = s === "CANCELLED";
  const refusAppro = e.approbations.find((a) => a.status === "REJECTED");
  const accord = e.approbations.find((a) => a.status === "APPROVED");
  const attenteAppro = e.approbations.some((a) => a.status === "PENDING") || e.validationEnAttente || s === "AWAITING_VALIDATION";

  const deposee: EtapeFrise = { cle: "DEPOSEE", libelle: "Déposée", etat: "FAITE", detail: [e.demandeur, e.deposeeLe].filter(Boolean).join(" · ") };

  let validee: EtapeFrise;
  if (attenteAppro && !close && !annulee) validee = { cle: "VALIDEE", libelle: "Validée", etat: "COURANTE", detail: "en attente" };
  else if (s === "BLOCKED" && refusAppro) validee = { cle: "VALIDEE", libelle: "Validée", etat: "REFUSEE", detail: [refusAppro.decideur, refusAppro.le].filter(Boolean).join(" · ") || "refusée" };
  else if (accord) validee = { cle: "VALIDEE", libelle: "Validée", etat: "FAITE", detail: [accord.decideur, accord.le].filter(Boolean).join(" · ") };
  else validee = { cle: "VALIDEE", libelle: "Validée", etat: "SANS_OBJET", detail: "non requise" };

  let traitement: EtapeFrise;
  if (close || s === "AWAITING_PAYMENT") traitement = { cle: "TRAITEMENT", libelle: "Traitement", etat: "FAITE", detail: e.responsable ?? "" };
  else if (annulee) traitement = { cle: "TRAITEMENT", libelle: "Traitement", etat: e.commencee ? "FAITE" : "SANS_OBJET", detail: "" };
  else if (validee.etat === "COURANTE" || validee.etat === "REFUSEE") traitement = { cle: "TRAITEMENT", libelle: "Traitement", etat: "A_VENIR", detail: e.responsable ?? "" };
  else traitement = { cle: "TRAITEMENT", libelle: "Traitement", etat: "COURANTE", detail: e.commencee ? (e.responsable ?? "en cours") : "à commencer" };

  let paiement: EtapeFrise;
  if (s === "AWAITING_PAYMENT") paiement = { cle: "PAIEMENT", libelle: "Paiement", etat: "COURANTE", detail: "Finances" };
  else if (close) paiement = { cle: "PAIEMENT", libelle: "Paiement", etat: e.ordreEmis ? "FAITE" : "SANS_OBJET", detail: e.ordreEmis ? "Finances" : "" };
  else if (annulee) paiement = { cle: "PAIEMENT", libelle: "Paiement", etat: "SANS_OBJET", detail: "" };
  else paiement = { cle: "PAIEMENT", libelle: "Paiement", etat: "A_VENIR", detail: e.ordreEmis ? "Finances" : "" };

  const terminee: EtapeFrise = annulee
    ? { cle: "TERMINEE", libelle: "Annulée", etat: "REFUSEE", detail: "" }
    : { cle: "TERMINEE", libelle: "Terminée", etat: close ? "FAITE" : "A_VENIR", detail: "" };

  return [deposee, validee, traitement, paiement, terminee];
}

// ─────────────────────────── Chez qui ───────────────────────────

export interface ChezQui { etape: string; personne: string | null }

/**
 * OÙ EN EST LA DEMANDE, ET CHEZ QUI — la colonne du tableau et la phrase de l'en-tête.
 * `bc` : l'étape la plus en retard d'un bon de commande de la demande (`LIBELLE_ETAPE_BC`), quand
 * il y en a un en route — c'est alors lui qu'on attend, pas l'assistante.
 */
export function chezQuiDeLaDemande(e: {
  statut: string;
  responsable: string | null;
  demandeur: string | null;
  validateurEnAttente: string | null;
  bc?: "A_VALIDER" | "SANS_PORTE" | "A_SIGNER" | "A_REVOIR" | "A_CORRIGER" | null;
  devisARetenir?: boolean;
}): ChezQui | null {
  switch (e.statut) {
    case "DONE":
    case "CANCELLED":
      return null;
    case "AWAITING_VALIDATION":
      return { etape: "Validateur", personne: e.validateurEnAttente };
    case "AWAITING_PAYMENT":
      return { etape: "Finances", personne: "Comptabilité" };
    case "BLOCKED":
      return { etape: "Demandeur", personne: e.demandeur };
    default: break;
  }
  if (e.statut === "IN_PROGRESS") {
    if (e.bc === "A_VALIDER" || e.bc === "SANS_PORTE") return { etape: "Centre de validations", personne: "bon de commande" };
    if (e.bc === "A_SIGNER") return { etape: "Signature du BC", personne: "module Bons de commande" };
    if (e.bc === "A_REVOIR" || e.bc === "A_CORRIGER") return { etape: "Bon de commande à revoir", personne: e.demandeur };
    if (e.devisARetenir) return { etape: "Demandeur", personne: e.demandeur ? `${e.demandeur} — devis à retenir` : "devis à retenir" };
  }
  return { etape: "Assistante", personne: e.responsable ?? "non attribuée" };
}

// ─────────────────────────── Le geste suivant ───────────────────────────

export type GesteSuivant = "COMMENCER" | "TERMINER" | "RELANCER" | "ROUVRIR" | null;

/**
 * LE BOUTON PRINCIPAL DE L'EN-TÊTE — le geste suivant de cette demande, pour cette personne.
 * L'assistante : commencer, puis terminer ; en attente d'un tiers (validateur, Finances), relancer ;
 * terminée, rouvrir. Une demande ANNULÉE ne se rouvre pas (§118.191). Le demandeur : relancer, tant
 * que la demande attend quelqu'un d'autre que lui.
 */
export function gesteSuivant(e: { statut: string; commencee: boolean; gere: boolean; estDemandeur: boolean }): GesteSuivant {
  const s = e.statut;
  if (s === "CANCELLED") return null;
  if (e.gere) {
    if (s === "DONE") return "ROUVRIR";
    if (s === "AWAITING_VALIDATION" || s === "AWAITING_PAYMENT") return "RELANCER";
    if (s === "NEW" || (s === "IN_PROGRESS" && !e.commencee)) return "COMMENCER";
    return "TERMINER";
  }
  if (e.estDemandeur && s !== "DONE" && s !== "BLOCKED") return "RELANCER";
  return null;
}

// ─────────────────────────── Les tuiles du tableau ───────────────────────────

export type CleTuile = "NEW" | "IN_PROGRESS" | "AWAITING_VALIDATION" | "AWAITING_PAYMENT" | "RETARD" | "DONE_30";
export const TUILES: readonly { cle: CleTuile; libelle: string; alerte?: boolean }[] = [
  { cle: "NEW", libelle: "À traiter" },
  { cle: "IN_PROGRESS", libelle: "En cours" },
  { cle: "AWAITING_VALIDATION", libelle: "En validation" },
  { cle: "AWAITING_PAYMENT", libelle: "En paiement" },
  { cle: "RETARD", libelle: "En retard", alerte: true },
  { cle: "DONE_30", libelle: "Terminées (30 j)" },
];

const JOUR_MS = 86_400_000;

/** En retard : ouverte, et le JOUR de son échéance est passé (l'échéance du jour n'est pas encore en retard). */
export function enRetard(r: { statut: string; echeance: string | null }, maintenant: number): boolean {
  if (!r.echeance || r.statut === "DONE" || r.statut === "CANCELLED") return false;
  const t = Date.parse(r.echeance);
  return Number.isFinite(t) && t + JOUR_MS <= maintenant;
}

/** La ligne entre-t-elle dans la tuile ? « En cours » compte aussi une demande bloquée (elle attend quelqu'un). */
export function dansLaTuile(r: { statut: string; echeance: string | null; termineeLe: string | null }, tuile: CleTuile, maintenant: number): boolean {
  switch (tuile) {
    case "RETARD": return enRetard(r, maintenant);
    case "DONE_30": {
      if (r.statut !== "DONE") return false;
      const t = r.termineeLe ? Date.parse(r.termineeLe) : NaN;
      return Number.isFinite(t) && maintenant - t <= 30 * JOUR_MS;
    }
    case "IN_PROGRESS": return r.statut === "IN_PROGRESS" || r.statut === "BLOCKED";
    default: return r.statut === tuile;
  }
}
