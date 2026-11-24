/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES RETENUES À LA SOURCE (Super Admin, 24/11/2026 : « honoraires de médecins et prestataires étrangers : OUI,
 * calculées au paiement, taux réglables »).
 *
 * Quand une dépense porte une retenue (nature marquée `retenue` dans `NATURES_DEPENSE`), la société ne verse pas tout au
 * bénéficiaire : elle garde la retenue et la reverse à l'administration fiscale avec la déclaration du mois du paiement.
 *
 *   brut (la note d'honoraires, la facture)  =  net versé au bénéficiaire  +  retenue à reverser
 *
 * Trois règles qui ne bougent pas :
 *   • l'ORDRE paie le NET : c'est lui qui sort de la banque à ce moment-là ;
 *   • la retenue se CALCULE au dinar (arrondi au plus proche, la moitié au-dessus), et le net est le reste — brut = net +
 *     retenue, exactement, jamais un centime perdu entre les deux ;
 *   • le COÛT de la dépense reste le BRUT : la retenue consomme la même ligne budgétaire que la dépense (pas de ligne
 *     d'impôt nouvelle) ; la déclaration qui la reverse ne la consomme pas une seconde fois.
 *
 * LES TAUX NE SONT PAS CERTAINS. Ils sont réglés par le Super Admin et restent marqués « à confirmer par le cabinet » tant
 * qu'il ne les a pas confirmés ; les défauts ci-dessous ne sont que des points de départ, à faire valider.
 *
 * Module PUR (navigateur compris), sans import.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type RegimeRetenueSource = "HONORAIRES_MEDECIN" | "PRESTATAIRE_ETRANGER";

export const REGIMES_RETENUE: readonly RegimeRetenueSource[] = ["HONORAIRES_MEDECIN", "PRESTATAIRE_ETRANGER"];

export const LIBELLE_REGIME_RETENUE: Readonly<Record<RegimeRetenueSource, string>> = {
  HONORAIRES_MEDECIN: "Honoraires de médecins",
  PRESTATAIRE_ETRANGER: "Prestataires étrangers",
};

/** Les taux par défaut, en % — des points de départ, À CONFIRMER PAR LE CABINET (jamais présentés comme certains). */
export const TAUX_RETENUE_DEFAUT: Readonly<Record<RegimeRetenueSource, number>> = {
  HONORAIRES_MEDECIN: 10,
  PRESTATAIRE_ETRANGER: 30,
};

export const MENTION_A_CONFIRMER = "taux à confirmer par le cabinet";

export interface TauxRetenue {
  regime: RegimeRetenueSource;
  /** En pourcentage (10 = 10 %). */
  taux: number;
  confirmeParCabinet: boolean;
}

/** Les taux en vigueur : ceux réglés par le Super Admin, sinon les défauts (non confirmés). */
export function tauxEnVigueur(regles: readonly { regime: string; taux: number; confirmeParCabinet: boolean }[]): Record<RegimeRetenueSource, TauxRetenue> {
  const out = {} as Record<RegimeRetenueSource, TauxRetenue>;
  for (const regime of REGIMES_RETENUE) {
    const r = regles.find((x) => x.regime === regime);
    out[regime] = r ? { regime, taux: r.taux, confirmeParCabinet: r.confirmeParCabinet } : { regime, taux: TAUX_RETENUE_DEFAUT[regime], confirmeParCabinet: false };
  }
  return out;
}

export function estRegimeRetenue(v: string | null | undefined): v is RegimeRetenueSource {
  return v != null && (REGIMES_RETENUE as readonly string[]).includes(v);
}

export interface CalculRetenue {
  brut: number;
  taux: number;
  retenue: number;
  net: number;
}

/**
 * LE CALCUL : la retenue au dinar, le net est le reste. Le produit se fait en entiers (centimes × centièmes de point) :
 * un calcul en virgule flottante arrondissait 0,5 dinar d'un côté ou de l'autre selon le montant.
 */
export function calculerRetenue(brut: number, taux: number): CalculRetenue {
  const brutC = Math.round(brut * 100);
  const tauxB = Math.round(taux * 100);
  const retenue = brutC > 0 && tauxB > 0 ? Math.round((brutC * tauxB) / 1_000_000) : 0;
  return { brut: brutC / 100, taux: tauxB / 100, retenue, net: (brutC - retenue * 100) / 100 };
}

/** Le taux saisi par le Super Admin, lu : un pourcentage de 0 à 100, deux décimales au plus. */
export function lireTauxSaisi(brut: string | null | undefined): { ok: true; taux: number } | { ok: false; error: string } {
  const t = Number(String(brut ?? "").replace(",", ".").replace("%", "").trim());
  if (!String(brut ?? "").trim() || !Number.isFinite(t)) return { ok: false, error: "Indiquez le taux en pourcentage (ex. 10)." };
  if (t < 0 || t > 100) return { ok: false, error: "Un taux de retenue se situe entre 0 et 100 %." };
  return { ok: true, taux: Math.round(t * 100) / 100 };
}

/** Le mois (AAAA-MM, heure d'Alger) d'un paiement — celui de la déclaration qui reverse la retenue. */
export function moisDeLaRetenue(date: Date): string {
  return new Date(date.getTime() + 60 * 60 * 1000).toISOString().slice(0, 7);
}

const dzd = (v: number): string => `${v.toLocaleString("fr-FR", { maximumFractionDigits: 2 })} DZD`;

/** « 10 % — taux à confirmer par le cabinet » ; rien de plus une fois confirmé. */
export function libelleTaux(t: { taux: number; confirmeParCabinet: boolean }): string {
  return `${t.taux.toLocaleString("fr-FR")} %${t.confirmeParCabinet ? "" : ` — ${MENTION_A_CONFIRMER}`}`;
}

/** La phrase écrite sur l'ordre et dans le fil : brut, retenue, net à verser. */
export function phraseRetenue(c: CalculRetenue, regime: RegimeRetenueSource, confirme: boolean): string {
  return `Brut ${dzd(c.brut)} · retenue à la source (${LIBELLE_REGIME_RETENUE[regime].toLowerCase()}, ${libelleTaux({ taux: c.taux, confirmeParCabinet: confirme })}) ${dzd(c.retenue)} · net à verser ${dzd(c.net)}.`;
}

export const STATUTS_RETENUE = ["PREVUE", "A_REVERSER", "REVERSEE", "ANNULEE"] as const;
export type StatutRetenue = (typeof STATUTS_RETENUE)[number];

export const LIBELLE_STATUT_RETENUE: Readonly<Record<StatutRetenue, string>> = {
  PREVUE: "Prévue (paiement à venir)",
  A_REVERSER: "À reverser",
  REVERSEE: "Reversée",
  ANNULEE: "Annulée",
};

/** Le total d'une liste de retenues — au centime, sans dérive de virgule flottante. */
export function totalRetenues(lignes: readonly { montant: number }[]): number {
  return lignes.reduce((s, l) => s + Math.round(l.montant * 100), 0) / 100;
}
