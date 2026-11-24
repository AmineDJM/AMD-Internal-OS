/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA TVA DES FACTURES — et celle du mois, que la G50 déclare (Super Admin, 24/11/2026 : « très, très, très important »).
 *
 * Une facture porte son HT, sa TVA et son TTC, PAR TAUX (19 %, 9 %, 0 %). Facture de VENTE : sa TVA est
 * COLLECTÉE ; facture d'ACHAT : elle est DÉDUCTIBLE. La TVA du mois = collectée − déductible : positive, elle
 * est à payer ; négative, c'est un CRÉDIT de TVA.
 *
 * ── CE QUE CES RÈGLES TIENNENT ──────────────────────────────────────────────────────────────
 *
 *   • LES TAUX vivent ICI, une fois (`TAUX_TVA`) : le formulaire, la lecture, le calcul et l'écran les lisent. La
 *     fabrique des pièces garde sa liste en fraction (`TAUX_TVA_ADMIS`) ; un test les compare.
 *   • HT + TVA + autres taxes (timbre, taxe additionnelle) = TTC, au dinar près ; et, par taux, la TVA vaut
 *     la base × le taux à 1 DZD près (une facture calcule sa TVA ligne à ligne : quelques centimes d'arrondi).
 *   • RIEN N'EST INVENTÉ : une facture sans TVA renseignée, sans sens (vente ou achat ?), sans date d'émission, ou
 *     dont le TTC a changé depuis la saisie de sa TVA, n'entre pas dans le calcul — elle est LISTÉE « à compléter ».
 *   • LE RATTACHEMENT À LA PÉRIODE : la DATE DE FACTURE (sa date d'émission), au mois d'Alger (UTC+1) — décision du
 *     Super Admin, `REGLE_DE_RATTACHEMENT`.
 *   • TVA NETTE = collectée − déductible, sans prorata de déduction (décision du Super Admin).
 *   • UN AVOIR retranche sa TVA du sens de sa facture.
 *
 * Module PUR (aucun import hors du domaine) : le formulaire du navigateur et le serveur lisent les mêmes règles.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import { debutDuMoisAlger, moisAlger } from "./resultat-mensuel";

/** UN TAUX DE TVA EN VIGUEUR — en pour cent. */
export interface TauxTva {
  taux: number;
  /** « 19 % », « 0 % » — ce que la colonne affiche. */
  court: string;
}

/**
 * LES TAUX DE TVA ALGÉRIENS — 19 %, 9 %, 0 %. La SEULE liste du calcul : un taux qui change (loi de
 * finances) se règle ici, et le formulaire, la lecture et le calcul suivent. Tout autre taux est refusé.
 */
export const TAUX_TVA: readonly TauxTva[] = [
  { taux: 19, court: "19 %" },
  { taux: 9, court: "9 %" },
  { taux: 0, court: "0 %" },
];

export const estTauxTva = (t: number): boolean => TAUX_TVA.some((x) => Math.abs(x.taux - t) < 1e-9);
export const libelleTaux = (t: number): string => TAUX_TVA.find((x) => Math.abs(x.taux - t) < 1e-9)?.court ?? `${t} %`;

/** LA RÈGLE DE RATTACHEMENT, dite une fois (décision du Super Admin) : l'écran la cite. */
export const REGLE_DE_RATTACHEMENT = "La TVA d'une facture compte au mois de sa date de facture (heure d'Alger).";

/** D'où vient la TVA enregistrée. */
export const SOURCES_TVA = ["FABRIQUE", "SAISIE", "LECTURE", "LIGNES"] as const;
export type SourceTva = (typeof SOURCES_TVA)[number];
export const LIBELLE_SOURCE_TVA: Record<SourceTva, string> = {
  FABRIQUE: "calculée par la plateforme",
  SAISIE: "saisie",
  LECTURE: "lue sur la pièce, confirmée",
  LIGNES: "calculée des lignes de la facture",
};

export type SensTva = "COLLECTEE" | "DEDUCTIBLE";
export const LIBELLE_SENS_TVA: Record<SensTva, string> = { COLLECTEE: "TVA collectée (ventes)", DEDUCTIBLE: "TVA déductible (achats)" };

/** Le sens d'une facture d'après sa direction : `IN` = vente (collectée), `OUT` = achat (déductible). */
export function sensDeLaDirection(direction: string | null | undefined): SensTva | null {
  return direction === "IN" ? "COLLECTEE" : direction === "OUT" ? "DEDUCTIBLE" : null;
}

// ─────────────────────────────── La saisie d'une facture ───────────────────────────────

export interface LigneTva {
  /** En pour cent (19, 9, 0). */
  taux: number;
  baseHt: number;
  tva: number;
}

export interface SaisieTva {
  lignes: LigneTva[];
  /** Timbre et taxes additionnelles, hors base de TVA. */
  autresTaxes: number;
  ttc: number;
}

/** Les champs du formulaire — leurs noms viennent de la table des taux, jamais d'une liste recopiée. */
export const CHAMP_TVA_ENVOYEE = "tvaSaisie";
export const CHAMP_TVA_AUTRES = "tvaAutres";
export const CHAMP_TVA_LUE = "tvaLue";
export const champHt = (taux: number): string => `tvaHt_${taux}`;
export const champTva = (taux: number): string => `tvaMontant_${taux}`;
/** Tous les noms de champ de la TVA (le prérempli et la garde des champs touchés les lisent). */
export const CHAMPS_TVA: readonly string[] = [
  ...TAUX_TVA.flatMap((t) => (t.taux === 0 ? [champHt(t.taux)] : [champHt(t.taux), champTva(t.taux)])),
  CHAMP_TVA_AUTRES,
];

/** Arrondi au centime, en entier de centimes — toutes les comparaisons se font là, jamais sur des flottants. */
export const centimes = (x: number): number => Math.round(Number((x * 100).toFixed(6)));
const dzd = (c: number): number => c / 100;
const fr = (x: number): string =>
  `${x.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/ /g, " ")} DZD`;

/** L'écart toléré, par taux, entre la TVA imprimée et la base × le taux : 1 DZD (arrondis ligne à ligne). */
export const TOLERANCE_TVA_CENTIMES = 100;

/** L'écart toléré entre HT + TVA + autres taxes et le TTC : 1 DZD (arrondis des totaux imprimés). */
export const TOLERANCE_TTC_CENTIMES = 100;

/** La TVA d'une base à un taux, au centime. */
export const tvaDe = (baseHt: number, taux: number): number => dzd(centimes((baseHt * taux) / 100));

export function totauxDeLaSaisie(s: Pick<SaisieTva, "lignes">): { ht: number; tva: number } {
  return {
    ht: dzd(s.lignes.reduce((a, l) => a + centimes(l.baseHt), 0)),
    tva: dzd(s.lignes.reduce((a, l) => a + centimes(l.tva), 0)),
  };
}

/**
 * CE QUI REND UNE SAISIE INACCEPTABLE, en clair et avec le remède — ou `null`. La cohérence est jugée au serveur :
 * le formulaire peut la montrer, il ne la garantit pas.
 */
export function refusSaisieTva(s: SaisieTva): string | null {
  if (s.lignes.length === 0) return "Indiquez au moins une base HT (à 19 %, 9 % ou 0 %).";
  const vus = new Set<number>();
  for (const l of s.lignes) {
    if (!estTauxTva(l.taux)) return `Taux de TVA ${l.taux} % inconnu : les taux admis sont ${TAUX_TVA.map((t) => t.court).join(", ")}.`;
    if (vus.has(l.taux)) return `Le taux ${libelleTaux(l.taux)} est saisi deux fois : regroupez sa base HT.`;
    vus.add(l.taux);
    if (!Number.isFinite(l.baseHt) || l.baseHt < 0) return `Base HT à ${libelleTaux(l.taux)} invalide : un montant positif ou nul.`;
    if (!Number.isFinite(l.tva) || l.tva < 0) return `TVA à ${libelleTaux(l.taux)} invalide : un montant positif ou nul.`;
    if (l.taux === 0 && centimes(l.tva) !== 0) return "Une base à 0 % ne porte pas de TVA : laissez la TVA à zéro.";
    const attendu = centimes((l.baseHt * l.taux) / 100);
    if (Math.abs(centimes(l.tva) - attendu) > TOLERANCE_TVA_CENTIMES) {
      return `TVA à ${libelleTaux(l.taux)} incohérente : ${fr(l.tva)} pour une base de ${fr(l.baseHt)}, `
        + `qui en donne ${fr(dzd(attendu))}. Corrigez la base ou la TVA (écart admis : 1 DZD).`;
    }
  }
  if (!Number.isFinite(s.autresTaxes) || s.autresTaxes < 0) return "Timbre et autres taxes : un montant positif ou nul.";
  if (!Number.isFinite(s.ttc) || s.ttc <= 0) return "Indiquez le montant TTC de la facture : c'est lui que HT + TVA doivent faire.";
  const t = totauxDeLaSaisie(s);
  const somme = centimes(t.ht) + centimes(t.tva) + centimes(s.autresTaxes);
  // Au dinar près : la fabrique arrondit la base de chaque taux après la remise globale, une facture imprimée arrondit
  // ses totaux — la même tolérance que le contrôle du total imprimé d'une facture de matériel.
  if (Math.abs(somme - centimes(s.ttc)) > TOLERANCE_TTC_CENTIMES) {
    return `HT + TVA${s.autresTaxes ? " + autres taxes" : ""} = ${fr(dzd(somme))}, mais le TTC de la facture est ${fr(s.ttc)}. `
      + "Corrigez les bases, la TVA ou le montant TTC (un timbre ou une taxe hors TVA se saisit à part).";
  }
  return null;
}

/** Un nombre tapé dans un champ de montant (« 1234.5 », « 1 234,50 ») — vide = absent, illisible = `NaN`. */
function nombreSaisi(v: FormDataEntryValue | null): number | null {
  if (v === null || typeof v !== "string") return null;
  const s = v.replace(/[\s  ]/g, "").replace(",", ".");
  if (!s) return null;
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : Number.NaN;
}

export type LectureSaisieTva =
  | { ok: true; envoyee: boolean; saisie: SaisieTva | null; lue: boolean }
  | { ok: false; error: string };

/**
 * LIRE LA TVA D'UN FORMULAIRE de facture. `envoyee` : le formulaire portait les champs (une modification qui les vide
 * EFFACE la TVA — « une clé présente et vide l'efface ») ; `saisie` nulle : rien de tapé. Une base sans sa TVA reçoit la
 * TVA calculée (base × taux) ; une TVA sans sa base est refusée — on ne devine pas la base.
 */
export function lireSaisieTva(fd: FormData, ttc: number | null): LectureSaisieTva {
  const envoyee = fd.has(CHAMP_TVA_ENVOYEE) || CHAMPS_TVA.some((c) => fd.has(c));
  const lue = fd.get(CHAMP_TVA_LUE) === "1";
  const lignes: LigneTva[] = [];
  for (const t of TAUX_TVA) {
    const base = nombreSaisi(fd.get(champHt(t.taux)));
    const tva = t.taux === 0 ? null : nombreSaisi(fd.get(champTva(t.taux)));
    if (Number.isNaN(base) || Number.isNaN(tva)) return { ok: false, error: `Montant illisible à ${t.court} : tapez un nombre (ex. 125000,50).` };
    if (base === null && tva === null) continue;
    if (base === null) return { ok: false, error: `TVA à ${t.court} sans sa base HT : indiquez la base HT de ce taux.` };
    lignes.push({ taux: t.taux, baseHt: base, tva: tva ?? tvaDe(base, t.taux) });
  }
  const autres = nombreSaisi(fd.get(CHAMP_TVA_AUTRES));
  if (Number.isNaN(autres)) return { ok: false, error: "Timbre et autres taxes : tapez un nombre." };
  if (lignes.length === 0) {
    return autres ? { ok: false, error: "Un timbre ou une taxe sans base HT : indiquez la base HT de la facture." } : { ok: true, envoyee, saisie: null, lue };
  }
  if (ttc === null) return { ok: false, error: "Indiquez le montant TTC de la facture : c'est lui que HT + TVA doivent faire." };
  const saisie: SaisieTva = { lignes, autresTaxes: autres ?? 0, ttc };
  const refus = refusSaisieTva(saisie);
  return refus ? { ok: false, error: refus } : { ok: true, envoyee, saisie, lue };
}

/**
 * LA TVA D'UNE PIÈCE DU REGISTRE, lue de son formulaire : seules une facture et un avoir en déclarent (sur un bail, les
 * champs sont ignorés, comme le sens de l'argent). Une TVA sans date d'émission ne se rattache à aucun mois : refusée.
 */
export function lireTvaDeLaPiece(fd: FormData, p: { kind: string; ttc: number | null; dateEmission: Date | null }): LectureSaisieTva {
  if (p.kind !== "INVOICE" && p.kind !== "CREDIT_NOTE") return { ok: true, envoyee: false, saisie: null, lue: false };
  const lu = lireSaisieTva(fd, p.ttc);
  if (lu.ok && lu.saisie && !p.dateEmission) {
    return { ok: false, error: "Indiquez la date d'émission de la facture : c'est elle qui rattache sa TVA au mois de la G50." };
  }
  return lu;
}

/** Les valeurs des champs, pour rouvrir le formulaire sur une TVA déjà renseignée. */
export function valeursDuFormulaire(s: Pick<SaisieTva, "lignes" | "autresTaxes"> | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!s) return out;
  for (const l of s.lignes) {
    out[champHt(l.taux)] = String(l.baseHt);
    if (l.taux !== 0) out[champTva(l.taux)] = String(l.tva);
  }
  if (s.autresTaxes) out[CHAMP_TVA_AUTRES] = String(s.autresTaxes);
  return out;
}

/**
 * LA TVA D'UNE PIÈCE ÉMISE PAR LA FABRIQUE — ses totaux, calculés par le code (base et montant par taux, en
 * FRACTION ; taxes additionnelles et timbre hors TVA). Le type est structurel : le domaine n'importe pas la fabrique.
 */
export function saisieDesTotaux(t: {
  tva: readonly { taux: number; base: number; montant: number }[];
  totalTaxes: number;
  timbre: number;
  totalTtc: number;
}): SaisieTva {
  return {
    lignes: t.tva.map((x) => ({ taux: Math.round(x.taux * 10_000) / 100, baseHt: x.base, tva: x.montant })),
    autresTaxes: dzd(centimes(t.totalTaxes) + centimes(t.timbre)),
    ttc: t.totalTtc,
  };
}

// ─────────────────────────────── La TVA du mois ───────────────────────────────

/** Une période de TVA : un mois, `AAAA-MM`. */
export const estPeriodeTva = (p: string | null | undefined): p is string => Boolean(p && /^\d{4}-(0[1-9]|1[0-2])$/.test(p));

/** Les bornes d'un mois à l'heure d'Alger : [début, fin[. */
export function bornesDeLaPeriode(periode: string): { debut: Date; fin: Date } {
  const [a, m] = periode.split("-").map(Number) as [number, number];
  const suivant = m === 12 ? `${a + 1}-01` : `${a}-${String(m + 1).padStart(2, "0")}`;
  return { debut: debutDuMoisAlger(periode), fin: debutDuMoisAlger(suivant) };
}

/** Le mois de TVA d'une facture : celui de sa date d'émission (`REGLE_DE_RATTACHEMENT`). */
export const periodeDeLaFacture = (dateEmission: Date): string => moisAlger(dateEmission);

/** Une facture (ou un avoir) telle que le calcul la lit. */
export interface FacturePourTva {
  id: string;
  reference: string | null;
  titre: string;
  avoir: boolean;
  /** La direction de la pièce — ou, pour un avoir, celle de sa facture. */
  direction: string | null;
  /** Le montant de la pièce (son TTC) aujourd'hui. */
  montant: number | null;
  /** La date d'émission ; `null` : non renseignée. */
  dateEmission: Date | null;
  tva: { sens: string | null; lignes: LigneTva[]; autresTaxes: number; montantTtc: number } | null;
}

export type RaisonIncomplete = "TVA_NON_RENSEIGNEE" | "SENS_INCONNU" | "DATE_MANQUANTE" | "TTC_MODIFIE";

export const PHRASE_INCOMPLETE: Record<RaisonIncomplete, string> = {
  TVA_NON_RENSEIGNEE: "TVA non renseignée : saisissez le HT et la TVA par taux.",
  SENS_INCONNU: "Vente ou achat ? Le sens de la facture n'est pas renseigné.",
  DATE_MANQUANTE: "Date d'émission manquante : c'est elle qui rattache la TVA au mois.",
  TTC_MODIFIE: "Le montant de la facture a changé depuis la saisie de sa TVA : revoyez-la.",
};

export interface FactureIncomplete {
  id: string;
  reference: string | null;
  titre: string;
  raison: RaisonIncomplete;
  phrase: string;
}

/** Pourquoi une facture n'entre pas dans le calcul — `null` : elle y entre. */
export function raisonIncomplete(f: Pick<FacturePourTva, "direction" | "montant" | "dateEmission" | "tva">): RaisonIncomplete | null {
  if (!f.tva) return "TVA_NON_RENSEIGNEE";
  if (!f.dateEmission) return "DATE_MANQUANTE";
  if (!sensDeLaDirection(f.direction) && !estSens(f.tva.sens)) return "SENS_INCONNU";
  if (f.montant !== null && centimes(f.montant) !== centimes(f.tva.montantTtc)) return "TTC_MODIFIE";
  return null;
}

const estSens = (s: string | null | undefined): s is SensTva => s === "COLLECTEE" || s === "DEDUCTIBLE";

export interface DetailTaux {
  taux: number;
  collectee: { base: number; tva: number };
  deductible: { base: number; tva: number };
}

export interface ResultatTvaDuMois {
  periode: string;
  collectee: number;
  deductible: number;
  /** Collectée − déductible. Négative : un CRÉDIT de TVA (`credit`). */
  aPayer: number;
  credit: number;
  detailParTaux: DetailTaux[];
  /** Les pièces de la période qui n'entrent pas dans le calcul, et pourquoi. */
  facturesIncompletes: FactureIncomplete[];
  /** Les pièces comptées (factures et avoirs). */
  facturesComptees: number;
  regle: string;
}

/**
 * LA TVA DU MOIS d'une société : les factures (et avoirs) DÉJÀ choisies pour la période — la requête fait le tri par
 * société et par date ; cette règle additionne, par taux et par sens, et met à part ce qui ne se compte pas.
 */
export function calculerTvaDuMois(periode: string, factures: readonly FacturePourTva[]): ResultatTvaDuMois {
  const parTaux = new Map<number, { cb: number; ct: number; db: number; dt: number }>();
  const incompletes: FactureIncomplete[] = [];
  let comptees = 0;
  for (const f of factures) {
    const raison = raisonIncomplete(f);
    if (raison || !f.tva) {
      const r = raison ?? "TVA_NON_RENSEIGNEE";
      incompletes.push({ id: f.id, reference: f.reference, titre: f.titre, raison: r, phrase: PHRASE_INCOMPLETE[r] });
      continue;
    }
    comptees += 1;
    const sens = sensDeLaDirection(f.direction) ?? (f.tva.sens as SensTva);
    const signe = f.avoir ? -1 : 1;
    for (const l of f.tva.lignes) {
      const cumul = parTaux.get(l.taux) ?? { cb: 0, ct: 0, db: 0, dt: 0 };
      if (sens === "COLLECTEE") { cumul.cb += signe * centimes(l.baseHt); cumul.ct += signe * centimes(l.tva); }
      else { cumul.db += signe * centimes(l.baseHt); cumul.dt += signe * centimes(l.tva); }
      parTaux.set(l.taux, cumul);
    }
  }
  const detailParTaux: DetailTaux[] = [...parTaux.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([taux, c]) => ({ taux, collectee: { base: dzd(c.cb), tva: dzd(c.ct) }, deductible: { base: dzd(c.db), tva: dzd(c.dt) } }));
  const collecteeC = [...parTaux.values()].reduce((a, c) => a + c.ct, 0);
  const deductibleC = [...parTaux.values()].reduce((a, c) => a + c.dt, 0);
  const aPayerC = collecteeC - deductibleC;
  return {
    periode, collectee: dzd(collecteeC), deductible: dzd(deductibleC), aPayer: dzd(aPayerC), credit: dzd(Math.max(0, -aPayerC)),
    detailParTaux, facturesIncompletes: incompletes, facturesComptees: comptees, regle: REGLE_DE_RATTACHEMENT,
  };
}

/**
 * CE QUE LA LIGNE « TVA DU MOIS » DE LA G50 PEUT PRÉREMPLIR — ou `null` : aucune pièce dans la période (rien à
 * proposer), ou une pièce à compléter (un chiffre partiel présenté comme complet serait une TVA inventée). Un crédit
 * de TVA propose 0 à payer : le crédit se reporte, il ne se paie pas.
 */
export function tvaAPreremplir(r: ResultatTvaDuMois): number | null {
  if (r.facturesIncompletes.length > 0 || r.facturesComptees === 0) return null;
  return Math.max(0, r.aPayer);
}
