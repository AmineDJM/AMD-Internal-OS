/**
 * L'AUDIT IQVIA (marché de ville) — lecture PURE de la feuille « ATC Prod Mol Lab » : ATC4, produit, présentation,
 * molécule, laboratoire, puis unités / valeurs du mois, du cumul annuel (YTD) et des 12 derniers mois (MAT).
 *
 * LE PIÈGE : une association est répétée UNE FOIS PAR MOLÉCULE, avec les mêmes chiffres. Les additionner compte le
 * marché plus de deux fois. On réunit donc les lignes par (ATC4, produit, présentation, laboratoire) : les molécules
 * vont dans une liste, les chiffres ne sont pris qu'une fois. Contrôle : la somme MAT = la ligne « Grand Total ».
 */
import { nombre, nombreOuNul, normEntete, ligneEntete, texte, type Feuille } from "./commun";

export interface PresentationIqvia {
  atc4: string;
  produit: string;
  presentation: string;
  molecules: string[];
  laboratoire: string;
  matUnites: number;
  matValeur: number;
  matCroissance: number | null;
  ytdUnites: number;
  ytdValeur: number;
  moisUnites: number;
  moisValeur: number;
}

export interface IqviaLu {
  presentations: PresentationIqvia[];
  /** « MAT Jul 2026 ». */
  periode: string | null;
  /** Le total MAT annoncé par le fichier (ligne « Grand Total ») et celui qu'on a recompté. */
  totalAnnonce: number | null;
  totalRecompte: number;
}

/** Les colonnes d'une période (« MAT Jul 2026 », « YTD Jul 2026 », « Jul 2026 ») : unités, valeurs, croissance. */
function colonnesPeriode(entete: string[], prefixe: "MAT" | "YTD" | "MOIS") {
  const cherche = (suffixe: string) =>
    entete.findIndex((e) => {
      const debut = e.split(" ")[0];
      const okPrefixe = prefixe === "MOIS" ? debut !== "MAT" && debut !== "YTD" : debut === prefixe;
      return okPrefixe && e.endsWith(suffixe);
    });
  return { unites: cherche(" UNITES"), valeurs: cherche(" VALEURS"), croissance: cherche(" VALEURS GROWTH % PY") };
}

export function lireIqvia(feuilles: Feuille[]): IqviaLu | null {
  for (const f of feuilles) {
    const h = ligneEntete(f.lignes, ["ATC4", "PRODUIT", "PRESENTATION", "MOLECULE", "LABORATOIRE"], 10);
    if (h < 0) continue;
    const brut = (f.lignes[h] ?? []).map((c) => String(c ?? ""));
    const entete = brut.map(normEntete);
    const ix = (nom: string) => entete.indexOf(nom);
    const iAtc = ix("ATC4"), iProd = ix("PRODUIT"), iPres = ix("PRESENTATION"), iMol = ix("MOLECULE"), iLab = ix("LABORATOIRE");
    const mat = colonnesPeriode(entete, "MAT"), ytd = colonnesPeriode(entete, "YTD"), mois = colonnesPeriode(entete, "MOIS");
    const enteteMat = mat.valeurs >= 0 ? brut[mat.valeurs]! : "";
    const periode = enteteMat ? enteteMat.split(/\r?\n/)[0]!.replace(/\s+/g, " ").trim() : null;

    const parCle = new Map<string, PresentationIqvia>();
    let totalAnnonce: number | null = null;
    for (const l of f.lignes.slice(h + 1)) {
      if (!l) continue;
      const atc4 = texte(l[iAtc]);
      if (!atc4) continue;
      if (normEntete(atc4) === "GRAND TOTAL") { totalAnnonce = mat.valeurs >= 0 ? nombre(l[mat.valeurs]) : null; continue; }
      const produit = texte(l[iProd]) ?? "";
      const presentation = texte(l[iPres]) ?? "";
      const laboratoire = texte(l[iLab]) ?? "";
      const molecule = texte(l[iMol]);
      const cle = [atc4, produit, presentation, laboratoire].join("|");
      const deja = parCle.get(cle);
      if (deja) {
        if (molecule && !deja.molecules.includes(molecule)) deja.molecules.push(molecule);
        continue;
      }
      parCle.set(cle, {
        atc4, produit, presentation, laboratoire,
        molecules: molecule ? [molecule] : [],
        matUnites: mat.unites >= 0 ? nombre(l[mat.unites]) : 0,
        matValeur: mat.valeurs >= 0 ? nombre(l[mat.valeurs]) : 0,
        matCroissance: mat.croissance >= 0 ? nombreOuNul(l[mat.croissance]) : null,
        ytdUnites: ytd.unites >= 0 ? nombre(l[ytd.unites]) : 0,
        ytdValeur: ytd.valeurs >= 0 ? nombre(l[ytd.valeurs]) : 0,
        moisUnites: mois.unites >= 0 ? nombre(l[mois.unites]) : 0,
        moisValeur: mois.valeurs >= 0 ? nombre(l[mois.valeurs]) : 0,
      });
    }
    const presentations = [...parCle.values()];
    const totalRecompte = presentations.reduce((s, p) => s + p.matValeur, 0);
    return { presentations, periode, totalAnnonce, totalRecompte };
  }
  return null;
}
