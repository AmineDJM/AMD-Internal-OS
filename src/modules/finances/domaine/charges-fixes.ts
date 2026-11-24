/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES CHARGES FIXES DES LOCAUX ET LE BUDGET DE L'ADMINISTRATION (Super Admin, 24/11/2026 — audit des dépenses).
 *
 * « Loyer et autres charges fixes des locaux : se renseignent dans les INFORMATIONS DE LA SOCIÉTÉ et alimentent le
 * BUDGET DE L'ADMINISTRATION. » Une charge (site, nature, bénéficiaire, montant fixe ou « selon facture », périodicité,
 * jour d'échéance, début / fin) fait naître ses ÉCHÉANCES ; leur somme sur l'année est le montant de la ligne de sa
 * nature dans l'enveloppe « Administration <année> » de la société, tenue par les Finances. Chaque échéance apparaît
 * quinze jours avant dans « Aujourd'hui » des Finances, qui joignent la facture et demandent le paiement (un ordre
 * `FIXED_CHARGE`, par `createExpenseOrder`). Les mêmes échéances nourrissent la prévision de trésorerie à 12 mois et le
 * pré-remplissage de la campagne budgétaire (`AUTO_CHARGES_FIXES`).
 *
 * Module PUR — sans base ni session, importable par un écran : tout ce qui se calcule se calcule ici, et s'éprouve sans base.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

// ─────────────────────────────── Les natures, les périodicités ───────────────────────────────

/** Les natures d'une charge fixe — CLÉS STABLES : la clé relie la charge à la ligne de même clé du budget. */
export const NATURES_CHARGE_FIXE = [
  "LOYER", "ELECTRICITE", "EAU", "GAZ", "INTERNET", "TELEPHONIE", "NETTOYAGE", "GARDIENNAGE", "MAINTENANCE", "AUTRE_CHARGE_FIXE",
] as const;
export type NatureChargeFixe = (typeof NATURES_CHARGE_FIXE)[number];

export const LIBELLE_NATURE_CHARGE_FIXE: Record<NatureChargeFixe, string> = {
  LOYER: "Loyer",
  ELECTRICITE: "Électricité",
  EAU: "Eau",
  GAZ: "Gaz",
  INTERNET: "Internet",
  TELEPHONIE: "Téléphonie",
  NETTOYAGE: "Nettoyage",
  GARDIENNAGE: "Gardiennage",
  MAINTENANCE: "Maintenance",
  AUTRE_CHARGE_FIXE: "Autre charge fixe",
};

export const estNatureChargeFixe = (v: unknown): v is NatureChargeFixe =>
  typeof v === "string" && (NATURES_CHARGE_FIXE as readonly string[]).includes(v);

/** La rubrique comptable de l'ordre : le loyer est un loyer, le reste des charges. Le règlement n'a rien à classer. */
export function rubriqueDeNature(n: NatureChargeFixe): "LOYER" | "CHARGES" {
  return n === "LOYER" ? "LOYER" : "CHARGES";
}

export const PERIODICITES_CHARGE = ["MENSUELLE", "TRIMESTRIELLE", "ANNUELLE"] as const;
export type PeriodiciteCharge = (typeof PERIODICITES_CHARGE)[number];
export const LIBELLE_PERIODICITE_CHARGE: Record<PeriodiciteCharge, string> = {
  MENSUELLE: "Mensuelle", TRIMESTRIELLE: "Trimestrielle", ANNUELLE: "Annuelle",
};
const MOIS_ENTRE: Record<PeriodiciteCharge, number> = { MENSUELLE: 1, TRIMESTRIELLE: 3, ANNUELLE: 12 };
export const estPeriodiciteCharge = (v: unknown): v is PeriodiciteCharge =>
  typeof v === "string" && (PERIODICITES_CHARGE as readonly string[]).includes(v);

export const MODES_MONTANT_CHARGE = ["FIXE", "SELON_FACTURE"] as const;
export type ModeMontantCharge = (typeof MODES_MONTANT_CHARGE)[number];
export const LIBELLE_MODE_MONTANT: Record<ModeMontantCharge, string> = { FIXE: "Montant fixe", SELON_FACTURE: "Selon facture" };
export const estModeMontant = (v: unknown): v is ModeMontantCharge =>
  typeof v === "string" && (MODES_MONTANT_CHARGE as readonly string[]).includes(v);

// ─────────────────────────────── Les échéances ───────────────────────────────

/** Ce que le calcul lit d'une charge (la ligne `ChargeFixeSociete`, montants en nombre). */
export interface ChargeFixePourCalcul {
  id: string;
  companyId: string;
  nature: string;
  site: string;
  beneficiaire: string;
  modeMontant: string;
  montant: number;
  periodicite: string;
  jourEcheance: number;
  moisEcheance: number | null;
  dateDebut: Date;
  dateFin: Date | null;
  echeanceFixe: boolean;
  active: boolean;
}

export interface EcheanceCalculee {
  chargeId: string;
  companyId: string;
  nature: string;
  /** Le mois de l'échéance (« 2027-03 ») : la clé de l'échéance pour sa charge. */
  periode: string;
  date: Date;
  /** Le montant prévu : le montant fixe, ou l'estimation d'une charge « selon facture ». */
  montant: number;
}

const JOUR_MS = 86_400_000;
const debutDuJour = (d: Date): Date => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const finDuJour = (d: Date): Date => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999));

/** « 2027-03 ». */
export function periodeDe(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

const MOIS_FR = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];

/** « mars 2027 » (mensuelle), « 1er trimestre 2027 » (trimestrielle, à partir du mois de l'échéance), « 2027 » (annuelle). */
export function libellePeriode(periode: string, periodicite: string): string {
  const [a, m] = periode.split("-").map(Number);
  if (!a || !m) return periode;
  if (periodicite === "ANNUELLE") return String(a);
  if (periodicite === "TRIMESTRIELLE") {
    const t = Math.floor((m - 1) / 3) + 1;
    return `${t === 1 ? "1er" : `${t}e`} trimestre ${a}`;
  }
  return `${MOIS_FR[m - 1]} ${a}`;
}

/** Le jour d'échéance dans ce mois — ramené au dernier jour d'un mois plus court (le 31 → le 28 février). */
function dateDansLeMois(annee: number, mois0: number, jour: number): Date {
  const dernier = new Date(Date.UTC(annee, mois0 + 1, 0)).getUTCDate();
  return new Date(Date.UTC(annee, mois0, Math.min(Math.max(1, Math.trunc(jour) || 1), dernier)));
}

/**
 * LES ÉCHÉANCES D'UNE CHARGE ENTRE DEUX DATES (bornes comprises). Elles partent du mois de la première échéance — le mois
 * réglé (`moisEcheance`, trimestrielle et annuelle) ou, à défaut, le mois du début —, reviennent tous les 1, 3 ou 12 mois,
 * et ne tombent jamais avant le début ni après la fin. Une charge désactivée n'en a aucune.
 */
export function echeancesEntre(c: ChargeFixePourCalcul, debut: Date, fin: Date): EcheanceCalculee[] {
  if (!c.active || !estPeriodiciteCharge(c.periodicite) || !(c.montant > 0)) return [];
  const pas = MOIS_ENTRE[c.periodicite];
  const premierJour = debutDuJour(c.dateDebut);
  const borneBasse = debutDuJour(debut) > premierJour ? debutDuJour(debut) : premierJour;
  const borneHaute = c.dateFin && finDuJour(c.dateFin) < finDuJour(fin) ? finDuJour(c.dateFin) : finDuJour(fin);
  if (borneHaute < borneBasse) return [];
  // Le mois de la première échéance : le mois réglé (trimestrielle, annuelle) ou celui du début, jamais avant le début.
  const index = (d: Date) => d.getUTCFullYear() * 12 + d.getUTCMonth();
  const moisRegle = c.periodicite !== "MENSUELLE" && c.moisEcheance && c.moisEcheance >= 1 && c.moisEcheance <= 12 ? c.moisEcheance - 1 : null;
  let ancre = moisRegle === null ? index(premierJour) : premierJour.getUTCFullYear() * 12 + moisRegle;
  if (ancre < index(premierJour)) ancre += pas * Math.ceil((index(premierJour) - ancre) / pas);
  // Avancer jusqu'à la borne basse d'un coup, sans parcourir les années mois par mois.
  let courant = ancre + pas * Math.max(0, Math.floor((index(borneBasse) - ancre) / pas));
  const out: EcheanceCalculee[] = [];
  for (let garde = 0; garde < 400; garde++, courant += pas) {
    const d = dateDansLeMois(Math.floor(courant / 12), courant % 12, c.jourEcheance);
    if (d > borneHaute) break;
    if (d >= borneBasse) out.push({ chargeId: c.id, companyId: c.companyId, nature: c.nature, periode: periodeDe(d), date: d, montant: c.montant });
  }
  return out;
}

const bornesAnnee = (annee: number) => ({ debut: new Date(Date.UTC(annee, 0, 1)), fin: new Date(Date.UTC(annee, 11, 31, 23, 59, 59)) });

/** LE MONTANT ANNUEL D'UNE CHARGE : ses échéances de l'année × son montant (début et fin de bail compris). */
export function montantAnnuel(c: ChargeFixePourCalcul, annee: number): number {
  const { debut, fin } = bornesAnnee(annee);
  return echeancesEntre(c, debut, fin).reduce((s, e) => s + e.montant, 0);
}

/** Les montants de l'année par nature, pour UNE société — ce que porte chaque ligne du budget de l'Administration. */
export function totauxAnnuelsParNature(charges: readonly ChargeFixePourCalcul[], annee: number): Map<NatureChargeFixe, number> {
  const out = new Map<NatureChargeFixe, number>();
  for (const c of charges) {
    if (!estNatureChargeFixe(c.nature)) continue;
    const m = montantAnnuel(c, annee);
    if (m > 0 || c.active) out.set(c.nature, (out.get(c.nature) ?? 0) + m);
  }
  return out;
}

/** Une échéance apparaît dans « Aujourd'hui » des Finances QUINZE jours avant sa date. */
export const DELAI_APPARITION_JOURS = 15;
/** Une échéance jamais demandée reste visible un an (« en retard ») — au-delà, elle ne relève plus d'une file du jour. */
const RETARD_VISIBLE_JOURS = 365;

export const cleEcheance = (chargeId: string, periode: string): string => `${chargeId}:${periode}`;

/**
 * LES ÉCHÉANCES À DEMANDER AUJOURD'HUI : celles dont la date tombe d'ici quinze jours, et celles déjà passées qui n'ont pas
 * été demandées (`traitees` : les clés `charge:période` dont un ordre vit — au centre, autorisé ou payé).
 */
export function echeancesAApparaitre(
  charges: readonly ChargeFixePourCalcul[], maintenant: Date, traitees: ReadonlySet<string>,
): EcheanceCalculee[] {
  const debut = new Date(debutDuJour(maintenant).getTime() - RETARD_VISIBLE_JOURS * JOUR_MS);
  const fin = new Date(debutDuJour(maintenant).getTime() + DELAI_APPARITION_JOURS * JOUR_MS);
  return charges
    .flatMap((c) => echeancesEntre(c, debut, fin))
    .filter((e) => !traitees.has(cleEcheance(e.chargeId, e.periode)))
    .sort((a, b) => a.date.getTime() - b.date.getTime());
}

/** Les jours qui séparent aujourd'hui de l'échéance (négatif : en retard). */
export function joursAvant(echeance: Date, maintenant: Date): number {
  return Math.round((debutDuJour(echeance).getTime() - debutDuJour(maintenant).getTime()) / JOUR_MS);
}

// ─────────────────────────────── L'écart de la facture ───────────────────────────────

/** Au-delà de +10 % de l'estimation, la facture « selon facture » alerte le centre de paiement (défaut non contesté). */
export const SEUIL_ECART_FACTURE = 0.10;
const TOLERANCE_DZD = 1;

export interface AlerteEcartCharge { titre: string; detail: string; niveau: "BLOQUANT" | "ATTENTION" }

const dzd = (n: number): string => `${Math.round(n).toLocaleString("fr-FR")} DZD`;

/**
 * LA FACTURE CONFRONTÉE À CE QUE LA CHARGE PRÉVOYAIT. « Selon facture » : alerte au-delà de +10 % de l'estimation.
 * Montant fixe : la facture qui le dépasse alerte aussi (le montant est censé faire foi). Une baisse n'alerte jamais.
 */
export function ecartFacture(p: { modeMontant: string; prevu: number; facture: number }): AlerteEcartCharge | null {
  if (!(p.prevu > 0) || !(p.facture > 0)) return null;
  const pct = (p.facture - p.prevu) / p.prevu;
  const pctTexte = `+${(Math.round(pct * 1000) / 10).toLocaleString("fr-FR")} %`;
  if (p.modeMontant === "SELON_FACTURE") {
    if (p.facture <= p.prevu * (1 + SEUIL_ECART_FACTURE) + TOLERANCE_DZD) return null;
    return {
      titre: "Facture au-dessus de l'estimation",
      detail: `estimation ${dzd(p.prevu)} ; facture ${dzd(p.facture)} (${pctTexte}) : au-delà de 10 %`,
      niveau: "BLOQUANT",
    };
  }
  if (p.facture <= p.prevu + TOLERANCE_DZD) return null;
  return { titre: "Montant au-dessus du montant fixe", detail: `montant fixe ${dzd(p.prevu)} ; facture ${dzd(p.facture)} (${pctTexte})`, niveau: "BLOQUANT" };
}

// ─────────────────────────────── L'état d'une échéance, lu sur l'ordre ───────────────────────────────

export type EtatEcheanceCharge = "A_DEMANDER" | "SANS_JUSTIFICATIF" | "AU_CENTRE" | "AUTORISEE" | "PAYEE" | "REFUSEE" | "ANNULEE";

export const LIBELLE_ETAT_ECHEANCE: Record<EtatEcheanceCharge, string> = {
  A_DEMANDER: "À demander",
  SANS_JUSTIFICATIF: "Sans justificatif",
  AU_CENTRE: "Au centre de paiement",
  AUTORISEE: "Autorisée — à payer",
  PAYEE: "Payée",
  REFUSEE: "Refusée",
  ANNULEE: "Annulée",
};

export const TON_ETAT_ECHEANCE: Record<EtatEcheanceCharge, "neutral" | "info" | "warning" | "success" | "danger"> = {
  A_DEMANDER: "warning", SANS_JUSTIFICATIF: "warning", AU_CENTRE: "info", AUTORISEE: "info", PAYEE: "success", REFUSEE: "danger", ANNULEE: "neutral",
};

/** L'état d'une échéance — l'ordre qui la paie fait foi ; sans ordre, elle est à demander. */
export function etatEcheance(ordre: { status: string; centralStatus: string } | null | undefined): EtatEcheanceCharge {
  if (!ordre) return "A_DEMANDER";
  if (ordre.status === "PAID") return "PAYEE";
  if (ordre.status === "CANCELLED") return "ANNULEE";
  if (ordre.centralStatus === "REFUSED") return "REFUSEE";
  if (ordre.centralStatus === "AWAITING_PROOF") return "SANS_JUSTIFICATIF";
  if (ordre.centralStatus === "APPROVED" || ordre.centralStatus === "NOT_REQUIRED") return "AUTORISEE";
  return "AU_CENTRE";
}

/** Une échéance se (re)demande sans ordre vivant : jamais demandée, ou son ordre a été refusé ou annulé. */
export const peutDemanderPaiement = (etat: EtatEcheanceCharge): boolean => etat === "A_DEMANDER" || etat === "REFUSEE" || etat === "ANNULEE";

// ─────────────────────────────── Ce que l'écran reçoit ───────────────────────────────

export interface ChargeVue {
  id: string;
  site: string;
  nature: string;
  natureLibelle: string;
  libelle: string | null;
  beneficiaire: string;
  rib: string | null;
  legalDocumentId: string | null;
  bail: string | null;
  modeMontant: string;
  montant: number;
  periodicite: string;
  jourEcheance: number;
  moisEcheance: number | null;
  dateDebut: string;
  dateFin: string | null;
  echeanceFixe: boolean;
  active: boolean;
  notes: string | null;
  /** Les échéances de l'année en cours × montant. */
  montantAnnuel: number;
}

export interface EcheanceVue {
  cle: string;
  chargeId: string;
  periode: string;
  periodeLibelle: string;
  date: string;
  joursAvant: number;
  montantPrevu: number;
  modeMontant: string;
  nature: string;
  site: string;
  beneficiaire: string;
  etat: EtatEcheanceCharge;
  reference: string | null;
  montantFacture: number | null;
}

export interface LigneBudgetVue { id: string; cle: string | null; nom: string; alloue: number; sous: boolean }

/** La section « Locaux & charges fixes » d'une société, sérialisable. */
export interface SocieteChargesVue {
  charges: ChargeVue[];
  echeances: EcheanceVue[];
  budget: { id: string; nom: string; total: number; lignes: LigneBudgetVue[] } | null;
  baux: { id: string; titre: string; montant: number | null }[];
}

// ─────────────────────────────── La saisie d'une charge ───────────────────────────────

export interface SaisieChargeFixe {
  site: string;
  nature: NatureChargeFixe;
  libelle: string | null;
  beneficiaire: string;
  rib: string | null;
  legalDocumentId: string | null;
  modeMontant: ModeMontantCharge;
  montant: number;
  periodicite: PeriodiciteCharge;
  jourEcheance: number;
  moisEcheance: number | null;
  dateDebut: Date;
  dateFin: Date | null;
  echeanceFixe: boolean;
  notes: string | null;
}

const texte = (v: unknown, max = 200): string | null => {
  const s = typeof v === "string" ? v.trim() : "";
  return s ? s.slice(0, max) : null;
};
const nombre = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string" || !v.trim()) return null;
  const n = Number(v.replace(/\s| /g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
};
const dateIso = (v: unknown): Date | null => {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v.trim())) return null;
  const d = new Date(`${v.trim()}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * LIT ET VÉRIFIE LA SAISIE D'UNE CHARGE — chaque refus dit quoi corriger. Le loyer porte par défaut une échéance FIXE
 * (il ne se reporte pas sans motif) ; la case reste modifiable.
 */
export function lireSaisieCharge(brut: Record<string, unknown>): { ok: true; valeur: SaisieChargeFixe } | { ok: false; error: string } {
  const site = texte(brut.site, 120);
  if (!site) return { ok: false, error: "Indiquez le site ou le local (ex. « Siège — Alger »)." };
  if (!estNatureChargeFixe(brut.nature)) return { ok: false, error: "Choisissez la nature de la charge (loyer, électricité, eau…)." };
  const beneficiaire = texte(brut.beneficiaire, 160);
  if (!beneficiaire) return { ok: false, error: "Indiquez le bénéficiaire : c'est à lui que l'ordre de paiement sera fait." };
  const modeMontant = estModeMontant(brut.modeMontant) ? brut.modeMontant : "FIXE";
  const montant = nombre(brut.montant);
  if (montant === null || montant <= 0) {
    return { ok: false, error: modeMontant === "SELON_FACTURE" ? "Indiquez une estimation du montant : la facture fera foi au paiement." : "Indiquez le montant de chaque échéance." };
  }
  const periodicite = estPeriodiciteCharge(brut.periodicite) ? brut.periodicite : null;
  if (!periodicite) return { ok: false, error: "Choisissez la périodicité : mensuelle, trimestrielle ou annuelle." };
  const jour = nombre(brut.jourEcheance);
  if (jour === null || !Number.isInteger(jour) || jour < 1 || jour > 31) return { ok: false, error: "Le jour d'échéance va de 1 à 31." };
  const moisBrut = nombre(brut.moisEcheance);
  const moisEcheance = moisBrut !== null && Number.isInteger(moisBrut) && moisBrut >= 1 && moisBrut <= 12 ? moisBrut : null;
  const dateDebut = dateIso(brut.dateDebut);
  if (!dateDebut) return { ok: false, error: "Indiquez la date de début (celle du bail ou du contrat)." };
  const dateFin = dateIso(brut.dateFin);
  if (dateFin && dateFin < dateDebut) return { ok: false, error: "La date de fin précède la date de début : corrigez l'une des deux." };
  const nature = brut.nature;
  const echeanceFixe = brut.echeanceFixe === undefined || brut.echeanceFixe === null
    ? nature === "LOYER"
    : brut.echeanceFixe === true || brut.echeanceFixe === "on" || brut.echeanceFixe === "true";
  return {
    ok: true,
    valeur: {
      site, nature, libelle: texte(brut.libelle, 160), beneficiaire, rib: texte(brut.rib, 60),
      legalDocumentId: texte(brut.legalDocumentId, 60), modeMontant, montant: Math.round(montant * 100) / 100, periodicite,
      jourEcheance: jour, moisEcheance: periodicite === "MENSUELLE" ? null : moisEcheance, dateDebut, dateFin, echeanceFixe,
      notes: texte(brut.notes, 1000),
    },
  };
}

// ─────────────────────────────── Le budget de l'Administration ───────────────────────────────

/** Le code qui reconnaît l'enveloppe « Administration <année> » d'une société (`BudgetEnvelope.module`). */
export const CODE_ENVELOPPE_ADMINISTRATION = "ADMINISTRATION";
/** Le rôle qui TIENT l'enveloppe (gestion de son contenu) : les Finances, pas le DG (Super Admin, 24/11/2026). */
export const GESTIONNAIRES_ADMINISTRATION = ["FINANCE_BUDGET_MANAGER"] as const;

export const CLE_MOYENS_GENERAUX = "MOYENS_GENERAUX";
export const CLE_DONS_MECENAT = "DONS_MECENAT";
export const CLE_RESERVE_IMPREVUS = "RESERVE_IMPREVUS";
export const CLE_REMBOURSEMENT_EMPRUNT = "REMBOURSEMENT_EMPRUNT";

/**
 * LES LIGNES QUE L'ENVELOPPE PORTE D'OFFICE, en plus d'une ligne par nature de charge fixe : les moyens généraux de la
 * société (leurs natures `MG_*` en sous-lignes), les dons et le mécénat (séparés du sponsoring), la réserve pour imprévus
 * (budgétée ; libérée par le DG ou le Super Admin seulement), le remboursement d'emprunt (aucun aujourd'hui : disponible,
 * vide). Clés alignées sur la campagne budgétaire.
 */
export const LIGNES_STRUCTURE_ADMINISTRATION: readonly { cle: string; nom: string }[] = [
  { cle: CLE_MOYENS_GENERAUX, nom: "Moyens généraux" },
  { cle: CLE_DONS_MECENAT, nom: "Dons et mécénat" },
  { cle: CLE_RESERVE_IMPREVUS, nom: "Réserve pour imprévus" },
  { cle: CLE_REMBOURSEMENT_EMPRUNT, nom: "Remboursement d'emprunt" },
];

export const nomEnveloppeAdministration = (annee: number): string => `Administration ${annee}`;

type Porteur = { role: string; secondaryRole?: string | null };
const porte = (u: Porteur, r: string) => u.role === r || u.secondaryRole === r;

/** LA RÉSERVE POUR IMPRÉVUS se consomme ou se libère par le DG ou le Super Admin — personne d'autre, Finances comprises. */
export function peutLibererReserve(u: Porteur): boolean {
  return porte(u, "SUPER_ADMIN") || porte(u, "GENERAL_MANAGER");
}

export const REFUS_RESERVE =
  "La réserve pour imprévus se libère par le Directeur général ou le Super Admin seulement : demandez-leur de la libérer vers la ligne qui en a besoin.";

/**
 * LA RÈGLE SERVEUR DE LA RÉSERVE : baisser son montant (la libérer), ou y imputer une dépense (la consommer), est
 * refusé à quiconque n'est ni DG ni Super Admin. La BUDGÉTER (monter son montant) reste aux Finances qui tiennent l'enveloppe.
 */
export function refusSurReserve(p: { cle: string | null | undefined; geste: "BAISSER" | "IMPUTER" | "MONTER"; user: Porteur }): string | null {
  if (p.cle !== CLE_RESERVE_IMPREVUS || p.geste === "MONTER") return null;
  return peutLibererReserve(p.user) ? null : REFUS_RESERVE;
}

// ─────────────────────────────── La prévision de trésorerie ───────────────────────────────

export interface MoisPrevision {
  companyId: string;
  /** « 2027-03 ». */
  mois: string;
  montant: number;
  echeances: EcheanceCalculee[];
}

/**
 * LA PRÉVISION À 12 MOIS des charges fixes, par société et par mois — à partir du mois en cours. Une échéance déjà
 * demandée et réglée (`reglees`, clés `charge:période`) ne sort plus : elle est dans la trésorerie réelle. Les mois sans
 * échéance n'apparaissent pas.
 */
export function previsionChargesFixes(
  charges: readonly ChargeFixePourCalcul[], depuis: Date, mois = 12, reglees: ReadonlySet<string> = new Set(),
): MoisPrevision[] {
  const debut = new Date(Date.UTC(depuis.getUTCFullYear(), depuis.getUTCMonth(), 1));
  const fin = new Date(Date.UTC(depuis.getUTCFullYear(), depuis.getUTCMonth() + Math.max(1, mois), 0, 23, 59, 59));
  const par = new Map<string, MoisPrevision>();
  for (const e of charges.flatMap((c) => echeancesEntre(c, debut, fin))) {
    if (reglees.has(cleEcheance(e.chargeId, e.periode))) continue;
    const k = `${e.companyId}|${e.periode}`;
    const m = par.get(k) ?? { companyId: e.companyId, mois: e.periode, montant: 0, echeances: [] };
    m.montant += e.montant;
    m.echeances.push(e);
    par.set(k, m);
  }
  return [...par.values()].sort((a, b) => (a.companyId === b.companyId ? a.mois.localeCompare(b.mois) : a.companyId.localeCompare(b.companyId)));
}

// ─────────────────────────────── La campagne budgétaire ───────────────────────────────

/** La source des lignes pré-remplies depuis « Informations de la société » (point d'entrée de la campagne). */
export const SOURCE_PREFILL_CHARGES_FIXES = "AUTO_CHARGES_FIXES" as const;

/** Une ligne de pré-remplissage — la forme de `LignePrefill` de la campagne (sans l'importer : ce module est pur). */
export interface LignePrefillChargeFixe {
  key: string;
  label: string;
  categoryKey: string;
  source: typeof SOURCE_PREFILL_CHARGES_FIXES;
  realise2026: number;
  propose: number;
  justification: string;
}

/**
 * LE PRÉ-REMPLISSAGE `AUTO_CHARGES_FIXES` d'une société pour l'année budgétée : une ligne par nature, montant = les
 * échéances de l'année (début et fin de bail compris), justification = le détail par site. `realises` (facultatif) : ce
 * qui a été payé l'année en cours, par nature.
 */
export function lignesPrefillChargesFixes(
  charges: readonly ChargeFixePourCalcul[], annee: number, realises: ReadonlyMap<string, number> = new Map(),
): LignePrefillChargeFixe[] {
  const out: LignePrefillChargeFixe[] = [];
  for (const nature of NATURES_CHARGE_FIXE) {
    const siennes = charges.filter((c) => c.nature === nature && c.active);
    if (siennes.length === 0) continue;
    const detail = siennes
      .map((c) => ({ c, m: montantAnnuel(c, annee) }))
      .filter((x) => x.m > 0)
      .map((x) => `${x.c.site} : ${dzd(x.m)}${x.c.modeMontant === "SELON_FACTURE" ? " (estimation)" : ""}`);
    const propose = siennes.reduce((s, c) => s + montantAnnuel(c, annee), 0);
    out.push({
      key: `CHARGES_FIXES:${nature}`, label: LIBELLE_NATURE_CHARGE_FIXE[nature], categoryKey: nature,
      source: SOURCE_PREFILL_CHARGES_FIXES, realise2026: Math.round(realises.get(nature) ?? 0), propose: Math.round(propose),
      justification: detail.length ? `Échéances ${annee} — ${detail.join(" · ")}` : `Aucune échéance en ${annee}.`,
    });
  }
  return out;
}
