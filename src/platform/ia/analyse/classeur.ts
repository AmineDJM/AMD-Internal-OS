import type { UtilisateurOutil as CurrentUser } from "@/platform/ia/outil";
import { construireClasseurDrive, construireClasseurOctets, type SpecClasseur } from "@/platform/ia/artifact/sheets";
import { enClair } from "@/platform/ia/analyse/affichage";
import type { BlocAnalyseForme, CelluleAnalyse, ColonneAnalyse, FormatColonne, GraphiqueAnalyse } from "@/platform/ia/workspace/analyse";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CLASSEUR D'UNE ANALYSE (lot K1, décision 0031) — un Excel PROPRE, pas un vidage.
 *
 * Feuille « Analyse » : en-tête figé, filtre automatique, formats (DZD, %, entiers, dates), largeurs lues sur le
 * contenu, et une ligne de TOTAUX en VRAIES formules (`=SUM(C2:C41)`) — recalculées par le constructeur vérifié du
 * socle (`artifact/sheets.ts` → `construireClasseurVerifie`) avant d'être livrées : un total faux ne part pas.
 * Feuille « Méthode » : la source, le moteur, chaque étape et sa formule, ce qui a été ignoré ou masqué.
 * Une feuille par graphique : ses catégories et ses séries, telles que dessinées.
 *
 * Deux sorties : le DÉPÔT au Drive de la personne (dossier « Analyses », inscrit à la Bibliothèque par le port du
 * Live Office) et les OCTETS (export d'un clic, rien d'écrit).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const DOSSIER_ANALYSES = "Analyses";

const FORMAT_EXCEL: Record<FormatColonne, string | undefined> = {
  dzd: '#,##0.00 "DZD"', pourcent: '0.0" %"', entier: "#,##0", nombre: "#,##0.00", date: "dd/mm/yyyy", texte: undefined,
};

const largeur = (c: ColonneAnalyse, valeurs: readonly CelluleAnalyse[]): number =>
  Math.max(10, Math.min(48, Math.max(c.libelle.length, ...valeurs.slice(0, 300).map((v) => enClair(v, c.format).length)) + 3));

const nomFeuille = (t: string): string => t.replace(/[\\/?*[\]:]/g, " ").replace(/\s+/g, " ").trim().slice(0, 31) || "Feuille";

function feuilleGraphique(g: GraphiqueAnalyse, i: number): SpecClasseur["feuilles"][number] | null {
  const cats = g.donnees.categories ?? [];
  const series = g.donnees.series ?? [];
  if (cats.length && series.length) {
    const colonnes = [{ cle: "cat", titre: "Catégorie", largeur: 28 }, ...series.map((s, j) => ({ cle: `s${j + 1}`, titre: s.label || `Série ${j + 1}`, format: g.unite === "%" ? FORMAT_EXCEL.pourcent : g.unite === "DZD" ? FORMAT_EXCEL.dzd : FORMAT_EXCEL.nombre, largeur: 18 }))];
    return {
      nom: nomFeuille(`Graphique ${i + 1}`), colonnes, figerEntete: true, filtre: true,
      lignes: cats.map((c, k) => ({ cat: c, ...Object.fromEntries(series.map((s, j) => [`s${j + 1}`, s.valeurs[k] ?? null])) })),
    };
  }
  const lignes = g.donnees.lignes ?? []; const cols = g.donnees.colonnes ?? []; const vals = g.donnees.valeurs ?? [];
  if (lignes.length && cols.length) {
    return {
      nom: nomFeuille(`Graphique ${i + 1}`), figerEntete: true,
      colonnes: [{ cle: "l", titre: "", largeur: 28 }, ...cols.map((c, j) => ({ cle: `c${j + 1}`, titre: c, format: FORMAT_EXCEL.nombre, largeur: 14 }))],
      lignes: lignes.map((l, k) => ({ l, ...Object.fromEntries(cols.map((_, j) => [`c${j + 1}`, vals[k]?.[j] ?? null])) })),
    };
  }
  const points = g.donnees.points ?? [];
  if (points.length) {
    return { nom: nomFeuille(`Graphique ${i + 1}`), figerEntete: true, colonnes: [{ cle: "label", titre: "Point", largeur: 24 }, { cle: "x", titre: "x", largeur: 14 }, { cle: "y", titre: "y", largeur: 14 }], lignes: points.map((p) => ({ label: p.label ?? "", x: p.x, y: p.y })) };
  }
  return null;
}

export interface OptionsClasseur {
  /** Les lignes à exporter (l'écran filtré) — par défaut celles du bloc. */
  lignes?: CelluleAnalyse[][];
  /** Seulement les données de ce graphique (export « données du graphique »). */
  graphique?: number | null;
}

/** LA SPÉCIFICATION — pure : testée sans Excel, relue par le constructeur vérifié. */
export function specClasseurAnalyse(bloc: Pick<BlocAnalyseForme, "title" | "colonnes" | "lignes" | "totaux" | "graphiques" | "journal" | "source" | "total">, opts: OptionsClasseur = {}): SpecClasseur {
  const lignes = opts.lignes ?? bloc.lignes;
  const cles = bloc.colonnes.map((_, j) => `c${j + 1}`);
  const valeur = (v: CelluleAnalyse, f: FormatColonne): string | number | Date | null => {
    if (v === null) return null;
    if (f === "date" && typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return new Date(`${v}T00:00:00.000Z`);
    return v;
  };
  const feuilles: SpecClasseur["feuilles"] = [];
  const seulGraphique = typeof opts.graphique === "number" ? bloc.graphiques[opts.graphique] : null;
  if (!seulGraphique) {
    const totaux = bloc.totaux && lignes.length > 1
      ? Object.fromEntries(bloc.colonnes.flatMap((_, j) => (bloc.totaux?.[j] !== null && bloc.totaux?.[j] !== undefined ? [[cles[j], "SUM" as const]] : [])))
      : undefined;
    feuilles.push({
      nom: "Analyse", figerEntete: true, filtre: true,
      colonnes: bloc.colonnes.map((c, j) => ({ cle: cles[j], titre: c.libelle, format: FORMAT_EXCEL[c.format], largeur: largeur(c, lignes.map((r) => r[j] ?? null)) })),
      lignes: lignes.map((r) => Object.fromEntries(bloc.colonnes.map((c, j) => [cles[j], valeur(r[j] ?? null, c.format)]))),
      ...(totaux && Object.keys(totaux).length ? { totaux, libelleTotal: "Total" } : {}),
    });
  }
  bloc.graphiques.forEach((g, i) => {
    if (seulGraphique && g !== seulGraphique) return;
    const f = feuilleGraphique(g, i);
    if (f) feuilles.push(f);
  });
  const j = bloc.journal;
  const methode: [string, string][] = [
    ["Analyse", bloc.title],
    ["Source", [bloc.source, ...j.sources.filter((x) => x !== bloc.source)].join(" · ")],
    ["Calculé par", `${j.moteur} — chaque nombre de ce classeur vient du code, jamais d'un modèle de langage`],
    ["Calculé le", j.calculeLe.replace("T", " ").slice(0, 16)],
    ["Lignes", opts.lignes && opts.lignes.length !== bloc.total ? `${opts.lignes.length} lignes exportées (filtre de l'écran) sur ${bloc.total}` : `${bloc.total} ligne(s)${bloc.total > bloc.lignes.length ? ` (${bloc.lignes.length} affichées et exportées ; le résultat complet se recalcule à la source)` : ""}`],
    ...j.etapes.map((e, i): [string, string] => [`Étape ${i + 1} — ${e.op}`, `${e.formule} (${e.avant} → ${e.apres} lignes)${e.note ? ` · ${e.note}` : ""}`]),
    ...j.resultats.map((r): [string, string] => [r.libelle, r.valeur]),
    ...(bloc.totaux ? [["Totaux", "ligne « Total » de la feuille Analyse : formules =SUM() sur la colonne, recalculées et vérifiées avant livraison"] as [string, string]] : []),
    ...bloc.graphiques.map((g, i): [string, string] => [`Graphique ${i + 1}`, `${g.titre} — ${g.type}${g.raison ? ` : ${g.raison}` : ""}${g.alertes?.length ? ` · ${g.alertes.join(" ; ")}` : ""}`]),
    ...j.ignores.map((x): [string, string] => ["Ignoré", x]),
    ...j.refusees.map((x): [string, string] => ["Étape refusée", x]),
    ...j.masquees.map((x): [string, string] => ["Colonne masquée", `${x} — confidentielle : ni lue par le modèle, ni calculée`]),
  ];
  feuilles.push({ nom: "Méthode", figerEntete: true, colonnes: [{ cle: "rubrique", titre: "Rubrique", largeur: 26 }, { cle: "detail", titre: "Détail", largeur: 100 }], lignes: methode.map(([rubrique, detail]) => ({ rubrique, detail })) });
  return { feuilles };
}

export const nomDuClasseur = (titre: string, maintenant = new Date()): string =>
  `${titre.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 90) || "Analyse"} (${maintenant.toISOString().slice(0, 16).replace("T", " ").replace(":", "h")}).xlsx`;

/** Les OCTETS d'un classeur d'analyse — l'export d'un clic (rien n'est écrit). */
export function octetsClasseurAnalyse(bloc: Parameters<typeof specClasseurAnalyse>[0], auteur: string, opts: OptionsClasseur = {}) {
  return construireClasseurOctets(specClasseurAnalyse(bloc, opts), auteur);
}

/** DÉPOSER le classeur au Drive de la personne — un nouveau fichier, vérifié, ou rien. */
export async function deposerClasseurAnalyse(user: CurrentUser, bloc: Parameters<typeof specClasseurAnalyse>[0]): Promise<{ ok: true; nom: string; nodeId: string; href: string } | { ok: false; motif: string }> {
  const r = await construireClasseurDrive(user, { nom: nomDuClasseur(bloc.title), spec: specClasseurAnalyse(bloc), dossier: DOSSIER_ANALYSES });
  if (!r.ok) return { ok: false, motif: r.motif };
  return { ok: true, nom: r.nom, nodeId: r.nodeId, href: `/api/drive/${r.nodeId}/raw?dl=1` };
}
