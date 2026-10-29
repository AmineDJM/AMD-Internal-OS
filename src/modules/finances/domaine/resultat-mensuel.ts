/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE RÉSULTAT MENSUEL — sur la période qu'on choisit, et la paie dans le mois qu'elle paie.
 *
 * « Les paies d'un mois doivent aller dans ses dépenses » ; « 1 mois, 3 mois, 6 mois, 1 an, ou une
 * période donnée » — la Direction, 04/10/2026.
 *
 * ── LA PAIE SE RANGE DANS SON MOIS DE PAIE, PAS AU JOUR DU VIREMENT ─────────────────────────
 *
 * La paie de septembre virée le 3 octobre est une dépense de SEPTEMBRE : c'est le travail de
 * septembre qu'elle rémunère, et le résultat de septembre sans ses salaires serait un bénéfice
 * qui n'existe pas — pendant qu'octobre en porterait deux. Les autres écritures restent au jour
 * où elles ont été réglées : c'est le « réalisé » que ce tableau a toujours montré.
 *
 * Une écriture de paie se reconnaît par son LIEN, jamais par sa catégorie (une avance est aussi
 * « salaire », et ne se rattache à aucun mois de paie) : le virement de la paie qui la porte
 * (`PayrollWire.transactionId`, ou l'ordre de dépense de ce virement), ou la ligne de paie de
 * l'ancien « transfert au budget » (`PayrollEntry.transactionId`). Chaque écriture est comptée
 * UNE fois — déplacée vers son mois de paie, jamais ajoutée en plus.
 *
 * ── LA PAIE VERSÉE SANS ÉCRITURE ────────────────────────────────────────────────────────────
 *
 * Avant que la paie passe par le centre (§118.176), « marquer payé » voulait dire « versé », et
 * rien n'était écrit au livre. Ces salaires ont bien quitté la société : ils comptent dans leur
 * mois de paie, à leur NET — ce qui a été versé au salarié, comme la somme qu'un virement déclare
 * aujourd'hui. Ils n'ont aucune écriture, donc aucun double comptage possible.
 *
 * Module PUR — testé, sans base de données.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type ChoixPeriode = "1m" | "3m" | "6m" | "12m" | "perso";

export const CHOIX_PERIODE: { valeur: ChoixPeriode; libelle: string }[] = [
  { valeur: "1m", libelle: "1 mois" },
  { valeur: "3m", libelle: "3 mois" },
  { valeur: "6m", libelle: "6 mois" },
  { valeur: "12m", libelle: "1 an" },
  { valeur: "perso", libelle: "Période donnée" },
];

/** Au-delà, la période se choisit en plusieurs fois — limite opérationnelle, pas d'architecture. */
export const PERIODE_MAX_MOIS = 36;

export interface Periode {
  choix: ChoixPeriode;
  /** Les mois de la période, du plus ancien au plus récent, au format AAAA-MM. */
  mois: string[];
  debut: string;
  fin: string;
  libelle: string;
  /** Ce que la lecture des paramètres n'a pas pu suivre — dit à l'écran, jamais tu. */
  avertissement: string | null;
}

const MOIS_COURTS = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];

/** « sept. 2026 » */
export function libelleMois(m: string): string {
  const [y, mm] = m.split("-").map(Number);
  return `${MOIS_COURTS[(mm ?? 1) - 1] ?? mm} ${y}`;
}

const decaler = (m: string, n: number): string => {
  const [y, mm] = m.split("-").map(Number) as [number, number];
  const t = y * 12 + (mm - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
};

const ecart = (a: string, b: string): number => {
  const [ya, ma] = a.split("-").map(Number) as [number, number];
  const [yb, mb] = b.split("-").map(Number) as [number, number];
  return (yb * 12 + mb) - (ya * 12 + ma);
};

/** AAAA-MM, ou AAAA-MM-JJ dont on garde le mois. `null` sur tout le reste. */
function lireMois(v: string | undefined): { mois: string; jour: boolean } | null {
  const t = (v ?? "").trim();
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(t);
  if (!m) return null;
  const mm = Number(m[2]);
  const y = Number(m[1]);
  if (mm < 1 || mm > 12 || y < 2000 || y > 2100) return null;
  return { mois: `${m[1]}-${m[2]}`, jour: Boolean(m[3]) };
}

/**
 * LA PÉRIODE, lue dans l'adresse. `moisCourant` est le mois d'aujourd'hui (AAAA-MM, heure
 * d'Alger) — un paramètre, jamais lu ici, pour que la règle se teste à n'importe quelle date.
 * Une période illisible retombe sur 6 mois EN LE DISANT.
 */
export function lirePeriode(
  params: { periode?: string; du?: string; au?: string },
  moisCourant: string,
): Periode {
  const glissante = (choix: Exclude<ChoixPeriode, "perso">, avertissement: string | null): Periode => {
    const n = choix === "1m" ? 1 : choix === "3m" ? 3 : choix === "6m" ? 6 : 12;
    const debut = decaler(moisCourant, -(n - 1));
    return construire(choix, debut, moisCourant, avertissement);
  };
  const choix = params.periode as ChoixPeriode | undefined;
  if (choix === "1m" || choix === "3m" || choix === "6m" || choix === "12m") return glissante(choix, null);
  if (choix !== "perso") {
    return glissante("6m", params.periode ? `Période « ${params.periode} » inconnue : les 6 derniers mois sont affichés.` : null);
  }
  const du = lireMois(params.du);
  const au = lireMois(params.au);
  if (!du || !au) {
    return glissante("6m", "Indiquez le premier et le dernier mois de la période (du… au…) : les 6 derniers mois sont affichés.");
  }
  if (ecart(du.mois, au.mois) < 0) {
    return glissante("6m", "Le premier mois de la période est après le dernier : les 6 derniers mois sont affichés.");
  }
  if (ecart(du.mois, au.mois) + 1 > PERIODE_MAX_MOIS) {
    return glissante("6m", `Une période de plus de ${PERIODE_MAX_MOIS} mois se lit en plusieurs fois : les 6 derniers mois sont affichés.`);
  }
  return construire(
    "perso", du.mois, au.mois,
    du.jour || au.jour ? "Le résultat se lit au mois : la période couvre les mois entiers des dates données." : null,
  );
}

function construire(choix: ChoixPeriode, debut: string, fin: string, avertissement: string | null): Periode {
  const n = ecart(debut, fin) + 1;
  const mois = Array.from({ length: n }, (_, i) => decaler(debut, i));
  const libelle = n === 1 ? libelleMois(debut) : `${libelleMois(debut)} – ${libelleMois(fin)}`;
  return { choix, mois, debut, fin, libelle, avertissement };
}

/** Le premier instant (UTC) d'un mois à l'heure d'Alger — UTC+1, sans heure d'été. */
export function debutDuMoisAlger(m: string): Date {
  const [y, mm] = m.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, mm - 1, 1) - 3600_000);
}

/** Le premier instant APRÈS la période (borne exclue). */
export function finDeLaPeriodeAlger(p: Periode): Date {
  return debutDuMoisAlger(decaler(p.fin, 1));
}

/** Le mois (AAAA-MM, heure d'Alger) d'une date. */
export function moisAlger(d: Date): string {
  const t = new Date(d.getTime() + 3600_000);
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Une écriture RÉGLÉE du livre. */
export interface EcritureReglee {
  id: string;
  date: Date;
  direction: "IN" | "OUT";
  amount: number;
}

export interface LigneResultat {
  mois: string;
  libelle: string;
  recettes: number;
  depenses: number;
  /** La part de la paie dans les dépenses du mois — déjà comprise dans `depenses`. */
  dontPaie: number;
  resultat: number;
}

export interface ResultatPeriode {
  lignes: LigneResultat[];
  total: { recettes: number; depenses: number; dontPaie: number; resultat: number };
}

/**
 * LE TABLEAU — chaque écriture une fois, la paie dans son mois de paie.
 *
 * `moisDePaie` dit, pour une écriture de paie, le mois qu'elle paie (AAAA-MM) ; une écriture qui
 * n'y figure pas reste au mois de son règlement. `paieSansEcriture` est la paie versée par l'ancien
 * circuit sans écriture au livre (son net, par mois de paie). Une écriture ou un montant hors de la
 * période est ÉCARTÉ — jamais rangé dans un mois voisin.
 * Les montants s'additionnent en centimes : une somme de flottants dérive au centime.
 */
export function resultatParMois(input: {
  periode: Periode;
  ecritures: readonly EcritureReglee[];
  moisDePaie: ReadonlyMap<string, string>;
  paieSansEcriture: readonly { mois: string; montant: number }[];
}): ResultatPeriode {
  const index = new Map(input.periode.mois.map((m, i) => [m, i]));
  const rec = input.periode.mois.map(() => 0);
  const dep = input.periode.mois.map(() => 0);
  const paie = input.periode.mois.map(() => 0);
  const vues = new Set<string>();
  for (const e of input.ecritures) {
    if (vues.has(e.id)) continue;
    vues.add(e.id);
    const moisPaie = input.moisDePaie.get(e.id);
    const i = index.get(moisPaie ?? moisAlger(e.date));
    if (i === undefined) continue;
    const c = Math.round(e.amount * 100);
    if (e.direction === "IN") rec[i]! += c;
    else {
      dep[i]! += c;
      if (moisPaie) paie[i]! += c;
    }
  }
  for (const p of input.paieSansEcriture) {
    const i = index.get(p.mois);
    if (i === undefined) continue;
    const c = Math.round(p.montant * 100);
    dep[i]! += c;
    paie[i]! += c;
  }
  const lignes = input.periode.mois.map((m, i) => ({
    mois: m,
    libelle: libelleMois(m),
    recettes: rec[i]! / 100,
    depenses: dep[i]! / 100,
    dontPaie: paie[i]! / 100,
    resultat: (rec[i]! - dep[i]!) / 100,
  }));
  const somme = (t: number[]) => t.reduce((a, b) => a + b, 0);
  return {
    lignes,
    total: {
      recettes: somme(rec) / 100,
      depenses: somme(dep) / 100,
      dontPaie: somme(paie) / 100,
      resultat: (somme(rec) - somme(dep)) / 100,
    },
  };
}
