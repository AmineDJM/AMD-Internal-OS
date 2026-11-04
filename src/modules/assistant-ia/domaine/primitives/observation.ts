/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LOT I3 — L'OBSERVATION D'UN LIVRABLE (décision 0065, audit AU2 §6.1 (f), AU1 §4). Règle PURE, zéro import.
 *
 * Ce que la personne verra RÉELLEMENT, décrit par le CODE depuis le fichier écrit — jamais par le modèle : les feuilles,
 * les colonnes, le nombre de lignes, les totaux qu'il porte (et s'ils additionnent une colonne qui ne s'additionne pas),
 * le texte d'un document, ses tableaux, ses couleurs. `produire` et `fichier` la rendent à chaque appel ; `observer` la
 * relit seule. Le modèle confronte l'observation à la demande et se corrige (« architecture, pas consigne »).
 *
 * LE CONTRAT est celui d'I1 (`domaine/observation/contrat.ts`, décision 0063) : `observer("fichier", …)` le construit,
 * borné et empreint ; ce fichier n'en fournit que les MESURES propres à un classeur ou à un document.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

// ─── Les colonnes : ce qui s'additionne, ce qui ne s'additionne pas ─────────────────────────

/**
 * Une colonne qui ne s'additionne pas, par son SENS (son nom), pas par son format : un téléphone, un code, un identifiant,
 * une année, une wilaya, un numéro. C'est le défaut C8 de l'audit : `bloc.ts` jugeait au format, et la ligne « Total »
 * additionnait les numéros de téléphone (248 167 966).
 */
const NON_ADDITIVE = /(t[eé]l[eé]phone|phone|portable|mobile|fax|code|identifiant|\bid\b|^id$|num[eé]ro|n°|nif|nis|\brc\b|r[eé]f[eé]rence|ref\b|ann[eé]e|year|wilaya|postal|matricule|siret|lot\b|version|rang|ordre|index)/i;
export const colonneNonAdditive = (nom: string): boolean => NON_ADDITIVE.test(nom);

export interface FeuilleObservee {
  nom: string;
  colonnes: string[];
  /** Lignes de données (en-tête et lignes de total exclues). */
  lignes: number;
  /** Les lignes de total trouvées : leur libellé et les colonnes qu'elles additionnent. */
  totaux: { libelle: string; colonnes: string[] }[];
  /** Les cellules qui portent un tableau sérialisé (« ["Ouest — Oran"] ») : le défaut C8. */
  cellulesJson: number;
  /** Les premières lignes, telles qu'écrites (texte). */
  apercu: string[][];
}

const TOTAL = /^(total|totaux|sous-total|somme|grand total)\b/i;

/** Observer une feuille lue cellule par cellule (la 1re ligne = en-tête). */
export function observerFeuille(nom: string, cellules: readonly (readonly unknown[])[]): FeuilleObservee {
  const [entete = [], ...corps] = cellules;
  const colonnes = entete.map((c) => String(c ?? "").trim());
  const totaux: FeuilleObservee["totaux"] = [];
  let lignes = 0;
  let cellulesJson = 0;
  for (const l of corps) {
    if (l.every((c) => c === null || c === undefined || String(c).trim() === "")) continue;
    const premier = String(l.find((c) => c !== null && c !== undefined && String(c).trim() !== "") ?? "");
    if (TOTAL.test(premier.trim())) {
      totaux.push({ libelle: premier.trim(), colonnes: colonnes.filter((_, i) => i > 0 && l[i] !== null && l[i] !== undefined && String(l[i]).trim() !== "" && /^[-\d\s.,=A-Z():]+$/i.test(String(l[i]))) });
      continue;
    }
    lignes++;
    for (const c of l) if (typeof c === "string" && /^\s*[[{].*[\]}]\s*$/.test(c)) cellulesJson++;
  }
  return { nom, colonnes, lignes, totaux, cellulesJson, apercu: corps.slice(0, 5).map((l) => l.map((c) => String(c ?? ""))) };
}

/** Les ANOMALIES d'un classeur observé, dites au modèle (il décide quoi en faire ; le code n'efface rien en silence). */
export function anomaliesClasseur(feuilles: readonly FeuilleObservee[]): string[] {
  const a: string[] = [];
  for (const f of feuilles) {
    for (const t of f.totaux) {
      const absurdes = t.colonnes.filter(colonneNonAdditive);
      if (absurdes.length) a.push(`feuille « ${f.nom} » : la ligne « ${t.libelle} » additionne ${absurdes.join(", ")} — une colonne qui ne s'additionne pas`);
    }
    if (f.cellulesJson) a.push(`feuille « ${f.nom} » : ${f.cellulesJson} cellule(s) portent un tableau sérialisé (crochets) au lieu d'un texte lisible`);
    const doublons = f.colonnes.filter((c, i) => c && f.colonnes.indexOf(c) !== i);
    if (doublons.length) a.push(`feuille « ${f.nom} » : colonnes en double (${[...new Set(doublons)].join(", ")})`);
  }
  return a;
}

// ─── Le HTML d'un document produit ───────────────────────────────────────────────────────────

/** Ce que montre un HTML (déjà assaini) : tableaux, titres, paragraphes, éléments stylés, couleurs, texte. */
export function observerHtml(html: string): Record<string, unknown> {
  const parBalise: Record<string, number> = {};
  for (const m of html.matchAll(/<([a-z0-9]+)\s[^>]*style="[^"]*"/gi)) parBalise[m[1]!.toLowerCase()] = (parBalise[m[1]!.toLowerCase()] ?? 0) + 1;
  return {
    tableaux: (html.match(/<table\b/gi) ?? []).length,
    lignesDeTableau: (html.match(/<tr\b/gi) ?? []).length,
    titres: (html.match(/<h[1-3]\b/gi) ?? []).length,
    paragraphes: (html.match(/<p\b/gi) ?? []).length,
    listes: (html.match(/<(ul|ol)\b/gi) ?? []).length,
    elementsStyles: parBalise,
    couleurs: [...new Set([...html.matchAll(/#[0-9a-f]{6}\b|#[0-9a-f]{3}\b/gi)].map((m) => m[0].toUpperCase()))],
    texte: texteDuHtml(html).slice(0, 600),
  };
}

export function texteDuHtml(html: string): string {
  return html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|h[1-6]|li|tr|div)>/gi, "\n").replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
}

/** Où un texte cherché figure encore dans un texte (pour qu'un remplacement manqué se VOIE). */
export function occurrences(texte: string, cherche: string): number {
  if (!cherche) return 0;
  return texte.split(cherche).length - 1;
}
