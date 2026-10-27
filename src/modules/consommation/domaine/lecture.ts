import { normalizeHeader } from "@/lib/medical/directory-sheet";

/**
 * CONSUMPTION INTELLIGENCE — LIRE UN FICHIER DE CONSOMMATION QUI N'A PAS NOS EN-TÊTES.
 *
 * Les fichiers des hôpitaux changent de colonnes, d'ordre, de feuilles, d'unités et de forme. Ce module :
 *   • TROUVE la ligne d'en-tête de chaque feuille (elle n'est pas forcément la première) ;
 *   • RECONNAÎT les colonnes (« Hôpital », « Etablissement », « Structure », « CHU »…), avec une CONFIANCE et
 *     l'ORIGINE de la reconnaissance (synonyme, mémoire d'une confirmation passée, ressemblance) ;
 *   • comprend le format LARGE (une colonne par mois) et le DÉPLIE en lignes ;
 *   • lit les PÉRIODES (date, « janvier 2026 », « janv-26 », « 01/2026 », « T1 2026 », « 2025 », nom de feuille) ;
 *   • NORMALISE les unités (boîte → unités quand la présentation dit combien) ;
 *   • rend des lignes au FORMAT CANONIQUE, chacune avec sa feuille et sa ligne d'origine.
 * Il ne résout PAS l'établissement ni le produit (c'est le service, contre la base) et n'invente rien :
 * ce qu'il ne reconnaît pas est RENDU, pas ignoré.
 *
 * Module PUR — testé sans base.
 */

export type Feuilles = Record<string, unknown[][]>;

export type ChampConso =
  | "etablissement" | "produit" | "molecule" | "dosage" | "presentation"
  | "quantite" | "unite" | "valeur" | "devise" | "periode" | "annee" | "mois" | "debut" | "fin";

const SYNONYMES: Record<ChampConso, string[]> = {
  etablissement: ["etablissement", "etab", "hopital", "structure", "chu", "ehs", "eph", "cdr", "site", "centre", "client", "beneficiaire", "nom etablissement", "raison sociale", "etablissement de sante", "structure de sante", "pharmacie", "hopitaux"],
  produit: ["produit", "designation", "article", "libelle", "denomination", "nom commercial", "medicament", "specialite pharmaceutique", "designation produit", "libelle produit", "nom du produit", "reference"],
  molecule: ["dci", "molecule", "principe actif", "substance", "substance active", "denomination commune"],
  dosage: ["dosage", "dose", "force"],
  presentation: ["presentation", "forme", "conditionnement", "forme galenique", "forme pharmaceutique", "colisage"],
  quantite: ["quantite", "qte", "qt", "consommation", "quantite consommee", "qte consommee", "conso", "sorties", "quantite sortie", "volume", "nombre", "nbre", "qte livree", "quantite livree", "unites consommees"],
  unite: ["unite", "udm", "um", "unite de mesure", "u m"],
  valeur: ["valeur", "montant", "cout", "prix total", "valeur totale", "ca", "montant total", "valeur da", "montant da"],
  devise: ["devise", "monnaie"],
  periode: ["periode", "mois annee", "date", "date de sortie", "date consommation", "mois de consommation"],
  annee: ["annee", "exercice", "an"],
  mois: ["mois"],
  debut: ["date debut", "debut", "du", "periode du"],
  fin: ["date fin", "fin", "au", "periode au"],
};

export interface ColonneLue {
  index: number;
  texte: string;
  champ: ChampConso | null;
  /** 0..100 */
  confiance: number;
  origine: "memoire" | "synonyme" | "ressemblance" | "periode" | "aucune";
  /** Format LARGE : la période que cette colonne porte. */
  periode?: Periode;
}

export interface Periode { debut: string; fin: string; libelle: string }

const MOIS: Record<string, number> = {
  janvier: 1, janv: 1, jan: 1, january: 1, fevrier: 2, fevr: 2, fev: 2, feb: 2, february: 2, mars: 3, mar: 3, march: 3,
  avril: 4, avr: 4, apr: 4, april: 4, mai: 5, may: 5, juin: 6, jun: 6, june: 6, juillet: 7, juil: 7, jul: 7, july: 7,
  aout: 8, aou: 8, aug: 8, august: 8, septembre: 9, sept: 9, sep: 9, september: 9, octobre: 10, oct: 10, october: 10,
  novembre: 11, nov: 11, november: 11, decembre: 12, dec: 12, december: 12,
};

const iso = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
/** Le dernier jour du mois `m` (1..12) — le jour 0 du mois suivant. */
const finDeMois = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
const an4 = (y: number) => (y < 100 ? 2000 + y : y);
const MOIS_LIBELLES = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];

function periodeMois(y: number, m: number): Periode {
  return { debut: iso(y, m, 1), fin: finDeMois(y, m), libelle: `${MOIS_LIBELLES[m - 1]} ${y}` };
}

/** Une date Excel (numéro de série) en date — `null` si le nombre ne ressemble pas à une date plausible. */
function dateExcel(n: number): Date | null {
  if (!Number.isFinite(n) || n < 30000 || n > 80000) return null; // ~1982 → ~2119
  return new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86_400_000);
}

/**
 * UNE PÉRIODE LUE DANS UNE CELLULE — mois, trimestre, semestre, année. `null` si la valeur n'en est pas une :
 * on ne fabrique jamais une période. `anneeParDefaut` sert à « janvier » seul quand la feuille dit l'année.
 */
export function lirePeriode(v: unknown, anneeParDefaut: number | null = null): Periode | null {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return periodeMois(v.getUTCFullYear(), v.getUTCMonth() + 1);
  if (typeof v === "number") {
    const d = dateExcel(v);
    if (d) return periodeMois(d.getUTCFullYear(), d.getUTCMonth() + 1);
    if (Number.isInteger(v) && v >= 2000 && v <= 2100) return { debut: iso(v, 1, 1), fin: iso(v, 12, 31), libelle: String(v) };
    return null;
  }
  const t = normalizeHeader(v);
  if (!t) return null;
  let m: RegExpMatchArray | null;
  if ((m = t.match(/^(\d{4}) (\d{1,2})(?: (\d{1,2}))?$/)) && +m[2] >= 1 && +m[2] <= 12) return periodeMois(+m[1], +m[2]);
  if ((m = t.match(/^(?:(\d{1,2}) )?(\d{1,2}) (\d{4}|\d{2})$/)) && +m[2] >= 1 && +m[2] <= 12) return periodeMois(an4(+m[3]), +m[2]);
  if ((m = t.match(/^([a-z]+) (\d{4}|\d{2})$/)) && MOIS[m[1]]) return periodeMois(an4(+m[2]), MOIS[m[1]]);
  if ((m = t.match(/^(\d{4}|\d{2}) ([a-z]+)$/)) && MOIS[m[2]]) return periodeMois(an4(+m[1]), MOIS[m[2]]);
  if ((m = t.match(/^([a-z]+)$/)) && MOIS[m[1]] && anneeParDefaut) return periodeMois(anneeParDefaut, MOIS[m[1]]);
  if ((m = t.match(/^(?:t|q|trim|trimestre) ?([1-4]) (\d{4}|\d{2})$/))) {
    const y = an4(+m[2]), q = +m[1];
    return { debut: iso(y, (q - 1) * 3 + 1, 1), fin: finDeMois(y, q * 3), libelle: `T${q} ${y}` };
  }
  if ((m = t.match(/^(?:s|sem|semestre) ?([12]) (\d{4}|\d{2})$/))) {
    const y = an4(+m[2]), s = +m[1];
    return { debut: iso(y, s === 1 ? 1 : 7, 1), fin: s === 1 ? iso(y, 6, 30) : iso(y, 12, 31), libelle: `S${s} ${y}` };
  }
  if ((m = t.match(/^(?:annee )?(\d{4})$/)) && +m[1] >= 2000 && +m[1] <= 2100) return { debut: iso(+m[1], 1, 1), fin: iso(+m[1], 12, 31), libelle: m[1] };
  return null;
}

/** La période qu'un TEXTE libre annonce (titre, nom de feuille) : « Consommation CHU Oran — 1er semestre 2025 ». */
export function periodeDuTexte(texte: string): Periode | null {
  const t = normalizeHeader(texte);
  const essais = [
    t.match(/\b(?:t|q|trimestre) ?[1-4] (?:\d{4})\b/)?.[0],
    t.match(/\b(?:s|semestre) ?[12] (?:\d{4})\b/)?.[0],
    t.match(/\b(?:1er|premier) semestre (\d{4})\b/) ? `s1 ${t.match(/\b(?:1er|premier) semestre (\d{4})\b/)![1]}` : undefined,
    t.match(/\b(?:2e|2eme|second|deuxieme) semestre (\d{4})\b/) ? `s2 ${t.match(/\b(?:2e|2eme|second|deuxieme) semestre (\d{4})\b/)![1]}` : undefined,
    t.match(/\b(janvier|fevrier|mars|avril|mai|juin|juillet|aout|septembre|octobre|novembre|decembre|janv|fev|avr|juil|sept|oct|nov|dec) (\d{4})\b/)?.[0],
    t.match(/\b(20\d{2}) (\d{1,2})\b/)?.[0],
    t.match(/\b(20\d{2})\b/)?.[0],
  ];
  for (const e of essais) if (e) { const p = lirePeriode(e); if (p) return p; }
  return null;
}

/** Le champ d'un en-tête, avec sa confiance. La MÉMOIRE (une confirmation passée) l'emporte. */
export function reconnaitreColonne(brut: unknown, memoire: ReadonlyMap<string, ChampConso> = new Map()): { champ: ChampConso | null; confiance: number; origine: ColonneLue["origine"] } {
  const n = normalizeHeader(brut);
  if (!n) return { champ: null, confiance: 0, origine: "aucune" };
  const mem = memoire.get(n);
  if (mem) return { champ: mem, confiance: 99, origine: "memoire" };
  for (const [champ, syn] of Object.entries(SYNONYMES) as [ChampConso, string[]][]) if (syn.includes(n)) return { champ, confiance: 95, origine: "synonyme" };
  // Ressemblance : l'en-tête CONTIENT un synonyme de 4 lettres ou plus (« Qté consommée 2025 », « Nom de l'hôpital »).
  let best: { champ: ChampConso; long: number } | null = null;
  for (const [champ, syn] of Object.entries(SYNONYMES) as [ChampConso, string[]][]) {
    for (const s of syn) if (s.length >= 4 && (` ${n} `).includes(` ${s} `) && (!best || s.length > best.long)) best = { champ, long: s.length };
  }
  return best ? { champ: best.champ, confiance: 75, origine: "ressemblance" } : { champ: null, confiance: 0, origine: "aucune" };
}

const UNITES: [RegExp, string][] = [
  [/^(cp|cps|comp|comprime|comprimes|gel|gelule|gelules|unite|unites|u|un|uni|unit|units|tab|tablet|tablets|caps|capsule|capsules|dose|doses)$/, "UNITE"],
  [/^(bte|btes|boite|boites|bt|box|boxes|b)$/, "BOITE"],
  [/^(fl|flc|flacon|flacons|vial|vials)$/, "FLACON"],
  [/^(amp|ampoule|ampoules)$/, "AMPOULE"],
  [/^(sach|sachet|sachets)$/, "SACHET"],
  [/^(ml)$/, "ML"], [/^(l|litre|litres)$/, "L"], [/^(mg)$/, "MG"], [/^(g|gr|gramme|grammes)$/, "G"],
];

/** L'unité canonique — `null` quand elle n'est pas reconnue (elle reste alors telle quelle, signalée). */
export function normaliserUnite(u: unknown): string | null {
  const n = normalizeHeader(u).replace(/ /g, "");
  if (!n) return null;
  for (const [re, c] of UNITES) if (re.test(n)) return c;
  return null;
}

/** Combien d'unités par boîte, quand la présentation le dit (« B/60 », « boîte de 30 », « 60 cp », « x28 »). */
export function unitesParBoite(presentation: string | null | undefined): number | null {
  const t = normalizeHeader(presentation);
  if (!t) return null;
  const m = t.match(/\b(?:b|bte|boite|boite de|x)\s?(\d{1,4})\b/) ?? t.match(/\b(\d{1,4}) ?(?:cp|cps|comprimes?|gelules?|unites?|sachets?|ampoules?|flacons?)\b/);
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * LA QUANTITÉ NORMALISÉE — en UNITÉS quand une boîte se convertit (la présentation dit combien), sinon dans
 * l'unité source canonique. La conversion est DITE ; rien n'est converti sans facteur lu.
 */
export function normaliserQuantite(q: number | null, unite: unknown, presentation: string | null): { quantite: number | null; unite: string | null; conversion: string | null } {
  if (q === null) return { quantite: null, unite: normaliserUnite(unite), conversion: null };
  const u = normaliserUnite(unite);
  if (u === "BOITE") {
    const k = unitesParBoite(presentation);
    if (k) return { quantite: q * k, unite: "UNITE", conversion: `${q} boîte(s) × ${k} = ${q * k} unités` };
  }
  return { quantite: q, unite: u, conversion: null };
}

export interface LigneCanonique {
  feuille: string;
  ligneSource: number;
  periode: Periode | null;
  etablissementBrut: string | null;
  produitBrut: string | null;
  molecule: string | null;
  dosage: string | null;
  presentation: string | null;
  quantiteSource: number | null;
  uniteSource: string | null;
  quantite: number | null;
  unite: string | null;
  valeur: number | null;
  devise: string | null;
  anomalies: string[];
}

export interface AnalyseFeuille {
  feuille: string;
  ligneEntete: number;
  format: "LONG" | "LARGE";
  colonnes: ColonneLue[];
  periodeFeuille: Periode | null;
  /** L'établissement de la feuille quand aucune colonne ne le porte (nom de feuille ou titre). */
  etablissementFeuille: string | null;
  lignes: LigneCanonique[];
  anomalies: string[];
}

const clean = (v: unknown): string => String(v ?? "").replace(/\s+/g, " ").trim();
const nombre = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const s = clean(v).replace(/\s/g, "").replace(/(\d)[.](\d{3})(?!\d)/g, "$1$2").replace(",", ".");
  return s && /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : null;
};

function trouverEntete(rows: unknown[][], memoire: ReadonlyMap<string, ChampConso>): { index: number; colonnes: ColonneLue[] } | null {
  for (let i = 0; i < Math.min(rows.length, 40); i++) {
    const r = rows[i] ?? [];
    const colonnes: ColonneLue[] = r.map((t, index) => ({ index, texte: clean(t), ...reconnaitreColonne(t, memoire) }));
    const anneeLigne = null;
    let periodes = 0;
    for (const c of colonnes) if (!c.champ) { const p = lirePeriode(r[c.index], anneeLigne); if (p) { c.champ = null; c.periode = p; c.origine = "periode"; c.confiance = 90; periodes++; } }
    const champs = new Set(colonnes.map((c) => c.champ).filter(Boolean));
    const entite = champs.has("produit") || champs.has("molecule") || champs.has("etablissement");
    if (entite && (champs.has("quantite") || periodes >= 2) && (champs.size >= 2 || periodes >= 2)) return { index: i, colonnes };
  }
  return null;
}

/**
 * ANALYSE UN CLASSEUR : chaque feuille qui a la forme d'une consommation rend ses colonnes reconnues et ses
 * lignes canoniques. `memoire` : en-tête normalisé → champ, confirmé par une personne lors d'un import passé.
 */
export function analyserClasseur(feuilles: Feuilles, memoire: ReadonlyMap<string, ChampConso> = new Map()): { feuilles: AnalyseFeuille[]; ignorees: string[] } {
  const out: AnalyseFeuille[] = [];
  const ignorees: string[] = [];
  for (const [feuille, rows] of Object.entries(feuilles)) {
    const e = trouverEntete(rows, memoire);
    if (!e) { ignorees.push(feuille); continue; }
    const { index: h } = e;
    // Une seule colonne par champ : la plus sûre l'emporte, les autres sont rendues comme non reconnues.
    const parChamp = new Map<ChampConso, ColonneLue>();
    for (const c of e.colonnes) if (c.champ) { const p = parChamp.get(c.champ); if (!p || c.confiance > p.confiance) parChamp.set(c.champ, c); }
    for (const c of e.colonnes) if (c.champ && parChamp.get(c.champ) !== c) { c.champ = null; c.origine = "aucune"; c.confiance = 0; }
    const colonnesPeriode = e.colonnes.filter((c) => c.periode);
    const format: AnalyseFeuille["format"] = !parChamp.has("quantite") && colonnesPeriode.length >= 2 ? "LARGE" : "LONG";
    const titre = rows.slice(0, h).flat().map(clean).filter(Boolean).join(" ");
    const periodeFeuille = periodeDuTexte(`${titre} ${feuille}`);
    const anomalies: string[] = [];
    const etabFeuille = parChamp.has("etablissement") ? null : (/^(feuil|sheet|feuille)\s*\d*$/i.test(feuille.trim()) ? null : feuille.trim()) || null;
    if (!parChamp.has("etablissement")) anomalies.push(etabFeuille ? `Aucune colonne établissement : la feuille « ${feuille} » est lue comme l'établissement (à confirmer).` : `Aucune colonne établissement dans la feuille « ${feuille} ».`);
    if (format === "LONG" && !parChamp.has("periode") && !parChamp.has("mois") && !parChamp.has("debut") && !periodeFeuille) anomalies.push(`Aucune période trouvée dans la feuille « ${feuille} » (ni colonne, ni titre, ni nom).`);
    const get = (r: unknown[], champ: ChampConso) => { const c = parChamp.get(champ); return c ? r[c.index] : null; };
    const lignes: LigneCanonique[] = [];
    const annee = periodeFeuille ? Number(periodeFeuille.debut.slice(0, 4)) : null;
    rows.slice(h + 1).forEach((r, i) => {
      if (!r || r.every((x) => clean(x) === "")) return;
      const ligneSource = h + i + 2;
      const etab = clean(get(r, "etablissement")) || etabFeuille;
      const produit = clean(get(r, "produit")) || null;
      const molecule = clean(get(r, "molecule")) || null;
      if (!produit && !molecule) return; // ligne de total, de titre ou de séparation
      if (/^(total|sous total|totaux)\b/i.test(normalizeHeader(produit ?? molecule ?? ""))) return;
      const presentation = clean(get(r, "presentation")) || null;
      const dosage = clean(get(r, "dosage")) || null;
      const uniteSource = clean(get(r, "unite")) || null;
      const valeur = nombre(get(r, "valeur"));
      const devise = clean(get(r, "devise")) || (valeur !== null ? null : null);
      const base = { feuille, ligneSource, etablissementBrut: etab || null, produitBrut: produit, molecule, dosage, presentation, uniteSource, valeur, devise };
      const ajouter = (periode: Periode | null, q: number | null, extra: string[] = []) => {
        const an: string[] = [...extra];
        if (q === null) an.push("Quantité absente ou illisible.");
        else if (q < 0) an.push("Quantité négative (retour ou correction ?).");
        if (!periode) an.push("Période inconnue.");
        if (uniteSource && !normaliserUnite(uniteSource)) an.push(`Unité « ${uniteSource} » non reconnue.`);
        const n = normaliserQuantite(q, uniteSource, presentation);
        lignes.push({ ...base, periode, quantiteSource: q, quantite: n.quantite, unite: n.unite ?? (uniteSource ? uniteSource.toUpperCase() : null), anomalies: n.conversion ? [...an, n.conversion] : an });
      };
      if (format === "LARGE") {
        for (const c of colonnesPeriode) { const q = nombre(r[c.index]); if (q === null || q === 0) continue; ajouter(c.periode!, q); }
        return;
      }
      let periode: Periode | null = null;
      const pDebut = lirePeriode(get(r, "debut")), pFin = lirePeriode(get(r, "fin"));
      if (pDebut && pFin) periode = { debut: pDebut.debut, fin: pFin.fin, libelle: `${pDebut.libelle} → ${pFin.libelle}` };
      else {
        const y = nombre(get(r, "annee")) ?? annee;
        periode = lirePeriode(get(r, "periode"), y) ?? (get(r, "mois") !== null ? lirePeriode(get(r, "mois"), y) ?? (y && nombre(get(r, "mois")) ? lirePeriode(`${y} ${nombre(get(r, "mois"))}`) : null) : null) ?? (get(r, "annee") !== null ? lirePeriode(nombre(get(r, "annee"))) : null) ?? periodeFeuille;
      }
      ajouter(periode, nombre(get(r, "quantite")));
    });
    out.push({ feuille, ligneEntete: h + 1, format, colonnes: e.colonnes.filter((c) => c.texte), periodeFeuille, etablissementFeuille: etabFeuille, lignes, anomalies });
  }
  return { feuilles: out, ignorees };
}

/** La clé d'une valeur brute pour la mémoire et les doublons (casse, accents, ponctuation mis de côté). */
export function cleBrute(v: string | null | undefined): string {
  return normalizeHeader(v ?? "");
}
