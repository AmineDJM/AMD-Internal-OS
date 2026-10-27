import { normalizeHeader } from "@/lib/medical/directory-sheet";

/**
 * L'AFFINITÉ D'UN PRODUIT PAR ÉTABLISSEMENT — consommation du produit ÷ consommation du marché pertinent
 * (cahier des charges §32-34). Le marché est un PANIER explicite (produits du référentiel et/ou molécules), la
 * période une fenêtre configurée. La granularité de la source est respectée : c'est une affinité d'HÔPITAL,
 * jamais une affinité de médecin (le passage au médecin est un proxy que la BU choisit, ailleurs, et qui se voit).
 *
 * Ne compare que des quantités de la MÊME unité normalisée : une boîte et un comprimé ne s'additionnent pas.
 * Les lignes d'une autre unité sont EXCLUES et comptées, pas converties en silence.
 *
 * Module PUR — testé sans base.
 */

export type TypePeriode = "MOIS" | "ROLLING_3M" | "ROLLING_6M" | "ROLLING_12M" | "PERSONNALISEE";
export const PERIODE_LABELS: Record<TypePeriode, string> = {
  MOIS: "Dernier mois disponible", ROLLING_3M: "3 mois glissants", ROLLING_6M: "6 mois glissants", ROLLING_12M: "12 mois glissants", PERSONNALISEE: "Période personnalisée",
};

export interface ConfigAffinite {
  productId: string;
  panier: { productIds: string[]; molecules: string[] };
  periode: TypePeriode;
  debut?: string | null;
  fin?: string | null;
}

export interface LigneAffinite {
  institutionId: string;
  productId: string | null;
  molecule: string | null;
  periodeDebut: string;
  periodeFin: string;
  quantite: number;
  unite: string | null;
}

export interface AffiniteEtablissement {
  institutionId: string;
  valeur: number;
  numerateur: number;
  denominateur: number;
  unite: string | null;
  periode: string;
  exclues: number;
}

/** La fenêtre de calcul. Glissante : elle se cale sur la DERNIÈRE donnée disponible, pas sur aujourd'hui (les fichiers arrivent en retard). */
export function fenetre(cfg: ConfigAffinite, derniereFin: string | null): { debut: string; fin: string; libelle: string } | null {
  if (cfg.periode === "PERSONNALISEE") return cfg.debut && cfg.fin ? { debut: cfg.debut, fin: cfg.fin, libelle: `du ${cfg.debut} au ${cfg.fin}` } : null;
  if (!derniereFin) return null;
  const fin = new Date(`${derniereFin}T00:00:00Z`);
  const mois = cfg.periode === "MOIS" ? 1 : cfg.periode === "ROLLING_3M" ? 3 : cfg.periode === "ROLLING_6M" ? 6 : 12;
  const debut = new Date(Date.UTC(fin.getUTCFullYear(), fin.getUTCMonth() - mois + 1, 1));
  const d = debut.toISOString().slice(0, 10);
  return { debut: d, fin: derniereFin, libelle: `${mois === 1 ? "mois" : `${mois} mois`} jusqu'au ${derniereFin}` };
}

const dansLePanier = (l: LigneAffinite, cfg: ConfigAffinite, molecules: Set<string>) =>
  (l.productId !== null && (l.productId === cfg.productId || cfg.panier.productIds.includes(l.productId)))
  || (l.molecule !== null && [...molecules].some((m) => ` ${normalizeHeader(l.molecule)} `.includes(` ${m} `)));

/** L'affinité de CHAQUE établissement pour le produit configuré. Un établissement sans marché n'a pas d'affinité (pas 0). */
export function calculerAffinites(lignes: readonly LigneAffinite[], cfg: ConfigAffinite): { fenetre: { debut: string; fin: string; libelle: string } | null; parEtablissement: AffiniteEtablissement[] } {
  const molecules = new Set(cfg.panier.molecules.map((m) => normalizeHeader(m)).filter(Boolean));
  const marche = lignes.filter((l) => dansLePanier(l, cfg, molecules));
  const derniere = marche.reduce<string | null>((m, l) => (!m || l.periodeFin > m ? l.periodeFin : m), null);
  const f = fenetre(cfg, derniere);
  if (!f) return { fenetre: null, parEtablissement: [] };
  // Une ligne compte si sa période est ENTIÈREMENT dans la fenêtre (un trimestre à cheval n'est pas coupé au hasard).
  const dedans = marche.filter((l) => l.periodeDebut >= f.debut && l.periodeFin <= f.fin);
  const parEtab = new Map<string, LigneAffinite[]>();
  for (const l of dedans) (parEtab.get(l.institutionId) ?? parEtab.set(l.institutionId, []).get(l.institutionId)!).push(l);
  const out: AffiniteEtablissement[] = [];
  for (const [institutionId, ls] of parEtab) {
    // L'unité de RÉFÉRENCE : celle du produit étudié dans cet établissement (la plus présente) ; sinon celle du marché.
    const compte = new Map<string, number>();
    for (const l of ls.filter((x) => x.productId === cfg.productId)) compte.set(l.unite ?? "", (compte.get(l.unite ?? "") ?? 0) + 1);
    if (compte.size === 0) for (const l of ls) compte.set(l.unite ?? "", (compte.get(l.unite ?? "") ?? 0) + 1);
    const unite = [...compte].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
    const memes = ls.filter((l) => (l.unite ?? "") === unite);
    const denominateur = memes.reduce((s, l) => s + Math.max(0, l.quantite), 0);
    if (denominateur <= 0) continue;
    const numerateur = memes.filter((l) => l.productId === cfg.productId).reduce((s, l) => s + Math.max(0, l.quantite), 0);
    out.push({ institutionId, valeur: numerateur / denominateur, numerateur, denominateur, unite: unite || null, periode: f.libelle, exclues: ls.length - memes.length });
  }
  return { fenetre: f, parEtablissement: out.sort((a, b) => b.valeur - a.valeur) };
}
