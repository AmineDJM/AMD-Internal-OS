/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'ANNUAIRE ET LE MARKETING — LES RÈGLES PURES (lot T2, décision 0052).
 *
 *   • `motsDuNom`        — les mots qui DÉSIGNENT une fiche (« le Dr Karima BENSALEM » → karima, bensalem) ;
 *   • `cleDeDoublon`     — la clé qui rapproche deux fiches d'établissement (« Pharmacie Es-Salam » ≡ « PHARMACIE ES SALAM ») ;
 *   • `bornesPeriode`    — une période dite (« ce mois-ci », « l'année ») en bornes, et la période précédente ;
 *   • `agregerDepenses`  — les totaux exacts par axe (BU, produit, nature, mois, demandeur), et l'écart avec la période d'avant.
 *
 * Pur : ni base, ni réseau — testé seul (`analyse.test.ts`).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const TITRES = new Set(["dr", "docteur", "pr", "professeur", "mme", "madame", "m", "mr", "monsieur", "mlle", "le", "la", "les", "l", "de", "du", "des", "d", "et"]);
export const plier = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Les mots d'une désignation, titres et articles retirés (casse et ponctuation ignorées) — l'ordre ne compte pas. */
export function motsDuNom(texte: string): string[] {
  return texte.split(/[\s'’,;:()«»".-]+/).map((m) => m.trim()).filter((m) => m.length >= 2 && !TITRES.has(plier(m).replace(/\.$/, ""))).slice(0, 6);
}

/** LA CLÉ DE DOUBLON d'un établissement : nom sans accents, sans « pharmacie / clinique », sans ponctuation, et sa wilaya. */
export function cleDeDoublon(nom: string, wilaya: string | null): string {
  const n = plier(nom).replace(/\b(pharmacie|officine|clinique|cabinet|chu|eph|ehs)\b/g, " ").replace(/[^a-z0-9]+/g, "");
  return `${plier(wilaya ?? "").replace(/[^a-z]+/g, "")}|${n}`;
}

export const pourcentage = (part: number, total: number): number => (total > 0 ? Math.round((1000 * part) / total) / 10 : 0);

export const PERIODES = ["annee", "trimestre", "mois", "mois_precedent", "annee_precedente", "trente_jours"] as const;
export type Periode = (typeof PERIODES)[number];
export interface Bornes { du: Date; au: Date; libelle: string; precedente: { du: Date; au: Date; libelle: string } }

const MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const utc = (a: number, m: number, j = 1) => new Date(Date.UTC(a, m, j));

/** Les bornes [du, au[ d'une période, et celles de la période précédente de même longueur (comparaison). */
export function bornesPeriode(p: Periode, maintenant: Date, du?: string | null, au?: string | null): Bornes {
  const a = maintenant.getUTCFullYear();
  const m = maintenant.getUTCMonth();
  if (du) {
    const d = new Date(du);
    const f = au ? new Date(new Date(au).getTime() + 86_400_000) : maintenant;
    const duree = f.getTime() - d.getTime();
    return { du: d, au: f, libelle: `du ${du}${au ? ` au ${au}` : ""}`, precedente: { du: new Date(d.getTime() - duree), au: d, libelle: "période précédente de même durée" } };
  }
  switch (p) {
    case "mois": return { du: utc(a, m), au: utc(a, m + 1), libelle: `${MOIS[m]} ${a}`, precedente: { du: utc(a, m - 1), au: utc(a, m), libelle: `${MOIS[(m + 11) % 12]} ${m === 0 ? a - 1 : a}` } };
    case "mois_precedent": return { du: utc(a, m - 1), au: utc(a, m), libelle: `${MOIS[(m + 11) % 12]} ${m === 0 ? a - 1 : a}`, precedente: { du: utc(a, m - 2), au: utc(a, m - 1), libelle: "le mois d'avant" } };
    case "trimestre": {
      const t = Math.floor(m / 3) * 3;
      return { du: utc(a, t), au: utc(a, t + 3), libelle: `T${t / 3 + 1} ${a}`, precedente: { du: utc(a, t - 3), au: utc(a, t), libelle: "le trimestre précédent" } };
    }
    case "annee_precedente": return { du: utc(a - 1, 0), au: utc(a, 0), libelle: String(a - 1), precedente: { du: utc(a - 2, 0), au: utc(a - 1, 0), libelle: String(a - 2) } };
    case "trente_jours": {
      const d = new Date(maintenant.getTime() - 30 * 86_400_000);
      return { du: d, au: maintenant, libelle: "les 30 derniers jours", precedente: { du: new Date(d.getTime() - 30 * 86_400_000), au: d, libelle: "les 30 jours d'avant" } };
    }
    default: return { du: utc(a, 0), au: utc(a + 1, 0), libelle: `année ${a}`, precedente: { du: utc(a - 1, 0), au: utc(a, 0), libelle: `année ${a - 1}` } };
  }
}

export type AxeDepense = "bu" | "produit" | "nature" | "mois" | "demandeur";
export interface LigneDepense {
  nature: string; reference: string | null; objet: string; bu: string | null; produit: string | null; le: Date; montant: number | null; etat: string; demandeur: string | null;
}

const valeurAxe = (l: LigneDepense, axe: AxeDepense): string => {
  if (axe === "mois") return `${l.le.getUTCFullYear()}-${String(l.le.getUTCMonth() + 1).padStart(2, "0")}`;
  return (axe === "bu" ? l.bu : axe === "produit" ? l.produit : axe === "nature" ? l.nature : l.demandeur)?.trim() || "(non renseigné)";
};

/** Les totaux EXACTS par axe ; avec `avant`, l'écart (DZD et %) de chaque valeur et du total. Refusées / annulées exclues. */
export function agregerDepenses(lignes: LigneDepense[], axes: AxeDepense[], avant: LigneDepense[] | null = null) {
  const retenues = (xs: LigneDepense[]) => xs.filter((l) => l.montant != null && !/REFUS|CANCEL|ANNUL|REJECT/i.test(l.etat));
  const somme = (xs: LigneDepense[]) => retenues(xs).reduce((s, l) => s + (l.montant ?? 0), 0);
  const parAxe = axes.map((axe) => {
    const g = new Map<string, { total: number; nombre: number }>();
    for (const l of retenues(lignes)) {
      const k = valeurAxe(l, axe);
      const x = g.get(k) ?? { total: 0, nombre: 0 };
      x.total += l.montant ?? 0; x.nombre += 1; g.set(k, x);
    }
    const g0 = new Map<string, number>();
    for (const l of retenues(avant ?? [])) g0.set(valeurAxe(l, axe), (g0.get(valeurAxe(l, axe)) ?? 0) + (l.montant ?? 0));
    return {
      axe,
      valeurs: [...g].map(([valeur, x]) => ({
        [axe]: valeur, totalDzd: Math.round(x.total), demandes: x.nombre,
        ...(avant ? { periodePrecedenteDzd: Math.round(g0.get(valeur) ?? 0), ecartDzd: Math.round(x.total - (g0.get(valeur) ?? 0)), ecartPct: g0.get(valeur) ? Math.round((1000 * (x.total - g0.get(valeur)!)) / g0.get(valeur)!) / 10 : null } : {}),
      })).sort((a, b) => b.totalDzd - a.totalDzd),
    };
  });
  const total = Math.round(somme(lignes));
  const totalAvant = avant ? Math.round(somme(avant)) : null;
  return {
    totalDzd: total, demandes: retenues(lignes).length,
    ...(totalAvant != null ? { periodePrecedenteDzd: totalAvant, ecartDzd: total - totalAvant, ecartPct: totalAvant ? Math.round((1000 * (total - totalAvant)) / totalAvant) / 10 : null } : {}),
    parAxe,
  };
}
