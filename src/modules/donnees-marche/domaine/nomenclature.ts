/**
 * LA NOMENCLATURE NATIONALE — lecture PURE du classeur publié par le ministère (« Nomenclature », « Non renouvelés »,
 * « Retraits »). Une ligne = UNE décision d'enregistrement : un laboratoire détenteur, une marque, une présentation.
 *
 * Ce qui compte pour la suite :
 *   • `code` (« 01 A 003 ») identifie DCI + dosage + forme : c'est la clé d'une ligne du portefeuille ;
 *   • `statut` F (fabrication locale) / I (importation) est porté PAR DÉCISION : une même DCI peut avoir les deux ;
 *   • seul l'onglet EN_VIGUEUR dit qui a le droit de vendre aujourd'hui.
 */
import { dateIso, normEntete, ligneEntete, texte, type Feuille } from "./commun";

export const ONGLETS_NOMENCLATURE = ["EN_VIGUEUR", "NON_RENOUVELE", "RETRAIT"] as const;
export type OngletNomenclature = (typeof ONGLETS_NOMENCLATURE)[number];

export interface LigneNomenclature {
  onglet: OngletNomenclature;
  numero: number | null;
  numEnregistrement: string;
  code: string | null;
  dci: string;
  marque: string | null;
  forme: string | null;
  dosage: string | null;
  conditionnement: string | null;
  liste: string | null;
  p1: string | null;
  p2: string | null;
  obs: string | null;
  laboratoire: string | null;
  paysLaboratoire: string | null;
  dateInitiale: string | null;
  dateFinale: string | null;
  type: string | null;
  statut: "F" | "I" | null;
  stabilite: string | null;
  dateRetrait: string | null;
  motifRetrait: string | null;
}

export interface NomenclatureLue {
  lignes: LigneNomenclature[];
  /** « 2026-06-30 », lu dans le titre (« … AU 30 JUIN 2026 »), ou `null`. */
  dateArrete: string | null;
  parOnglet: Record<OngletNomenclature, number>;
}

const COLONNES = {
  numero: ["N°", "N"],
  numEnregistrement: ["N°ENREGISTREMENT", "N° ENREGISTREMENT"],
  code: ["CODE"],
  dci: ["DENOMINATION COMMUNE INTERNATIONALE"],
  marque: ["NOM DE MARQUE"],
  forme: ["FORME"],
  dosage: ["DOSAGE"],
  conditionnement: ["CONDITIONNEMENT"],
  liste: ["LISTE"],
  p1: ["P1"],
  p2: ["P2"],
  obs: ["OBS"],
  laboratoire: ["LABORATOIRES DETENTEUR DE LA DECISION D'ENREGISTREMENT"],
  paysLaboratoire: ["PAYS DU LABORATOIRE DETENTEUR DE LA DECISION D'ENREGISTREMENT"],
  dateInitiale: ["DATE D'ENREGISTREMENT INITIAL"],
  dateFinale: ["DATE D'ENREGISTREMENT FINAL"],
  type: ["TYPE"],
  statut: ["STATUT"],
  stabilite: ["DUREE DE STABILITE"],
  dateRetrait: ["DATE DE RETRAIT"],
  motifRetrait: ["MOTIF DE RETRAIT"],
} as const;

const MOIS: Record<string, string> = {
  JANVIER: "01", FEVRIER: "02", MARS: "03", AVRIL: "04", MAI: "05", JUIN: "06", JUILLET: "07", AOUT: "08",
  SEPTEMBRE: "09", OCTOBRE: "10", NOVEMBRE: "11", DECEMBRE: "12",
};

/** L'onglet d'une feuille, d'après son nom puis son titre. */
export function ongletDe(nomFeuille: string, titre: string): OngletNomenclature {
  const t = normEntete(nomFeuille + " " + titre);
  if (t.includes("RETRAIT")) return "RETRAIT";
  if (t.includes("RENOUVEL")) return "NON_RENOUVELE";
  return "EN_VIGUEUR";
}

/** « … AU 30 JUIN 2026 … » → « 2026-06-30 ». */
export function dateDuTitre(titre: string): string | null {
  const m = normEntete(titre).match(/AU (\d{1,2}) ([A-Z]+) (\d{4})/);
  if (!m || !MOIS[m[2]!]) return null;
  return `${m[3]}-${MOIS[m[2]!]}-${m[1]!.padStart(2, "0")}`;
}

function statutDe(v: unknown): "F" | "I" | null {
  const s = (texte(v) ?? "").toUpperCase();
  return s === "F" || s === "I" ? s : null;
}

/** Lit toutes les feuilles qui ont l'en-tête de la nomenclature. Renvoie `null` si aucune ne l'a. */
export function lireNomenclature(feuilles: Feuille[]): NomenclatureLue | null {
  const lignes: LigneNomenclature[] = [];
  let dateArrete: string | null = null;
  let trouve = false;
  for (const f of feuilles) {
    const h = ligneEntete(f.lignes, ["CODE", "DENOMINATION COMMUNE INTERNATIONALE", "STATUT"]);
    if (h < 0) continue;
    trouve = true;
    const titre = f.lignes.slice(0, h).map((l) => (l ?? []).map((c) => texte(c) ?? "").join(" ")).join(" ");
    const onglet = ongletDe(f.nom, titre);
    if (onglet === "EN_VIGUEUR" && !dateArrete) dateArrete = dateDuTitre(titre);
    const entete = (f.lignes[h] ?? []).map(normEntete);
    const ix = Object.fromEntries(
      Object.entries(COLONNES).map(([cle, noms]) => [cle, entete.findIndex((e) => (noms as readonly string[]).includes(e))]),
    ) as Record<keyof typeof COLONNES, number>;
    const cell = (l: unknown[], cle: keyof typeof COLONNES) => (ix[cle] >= 0 ? l[ix[cle]] : null);
    for (const l of f.lignes.slice(h + 1)) {
      if (!l) continue;
      const numEnr = texte(cell(l, "numEnregistrement"));
      const dci = texte(cell(l, "dci"));
      if (!numEnr || !dci) continue;
      const n = cell(l, "numero");
      lignes.push({
        onglet,
        numero: typeof n === "number" ? n : null,
        numEnregistrement: numEnr,
        code: texte(cell(l, "code")),
        dci,
        marque: texte(cell(l, "marque")),
        forme: texte(cell(l, "forme")),
        dosage: texte(cell(l, "dosage")),
        conditionnement: texte(cell(l, "conditionnement")),
        liste: texte(cell(l, "liste")),
        p1: texte(cell(l, "p1")),
        p2: texte(cell(l, "p2")),
        obs: texte(cell(l, "obs")),
        laboratoire: texte(cell(l, "laboratoire")),
        paysLaboratoire: texte(cell(l, "paysLaboratoire")),
        dateInitiale: dateIso(cell(l, "dateInitiale")),
        dateFinale: dateIso(cell(l, "dateFinale")),
        type: texte(cell(l, "type")),
        statut: statutDe(cell(l, "statut")),
        stabilite: texte(cell(l, "stabilite")),
        dateRetrait: dateIso(cell(l, "dateRetrait")),
        motifRetrait: texte(cell(l, "motifRetrait")),
      });
    }
  }
  if (!trouve) return null;
  const parOnglet = { EN_VIGUEUR: 0, NON_RENOUVELE: 0, RETRAIT: 0 } as Record<OngletNomenclature, number>;
  for (const l of lignes) parOnglet[l.onglet]++;
  return { lignes, dateArrete, parOnglet };
}
