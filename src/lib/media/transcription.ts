import { plier } from "@/lib/utils";
export { plier };
/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA TRANSCRIPTION COMME CONNAISSANCE (mandat 5 §38) — pur.
 *
 * Un enregistrement devient des SEGMENTS horodatés (ce que le moteur de parole rend), puis :
 * des LOCUTEURS (attribués par un tour de modèle, appliqués ici), une STRUCTURE (chapitres aux
 * silences et aux changements de sujet), et une RECHERCHE qui rend l'instant exact — « où
 * exactement Yassine a-t-il parlé du budget ? » = le segment, son horodatage, son locuteur.
 *
 * Rien ici n'appelle un modèle ni une base : ce sont les opérations qu'un test peut tenir à la
 * seconde près. Le pont (`platform/in-process/media/transcription.ts`) transcrit, attribue,
 * extrait, indexe et range.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface Segment {
  /** Début et fin en secondes, depuis le début de l'enregistrement. */
  debut: number;
  fin: number;
  texte: string;
  locuteur?: string | null;
}

export interface Chapitre {
  debut: number;
  fin: number;
  titre: string;
  /** Les indices de segments couverts, bornes incluses. */
  de: number;
  a: number;
}

export interface OccurrenceTranscription {
  index: number;
  debut: number;
  fin: number;
  horodatage: string;
  locuteur: string | null;
  extrait: string;
  /** Part des termes cherchés présents dans le segment (1 = tous). */
  score: number;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => { const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN; return Number.isFinite(n) ? n : null; };

/** Les segments d'un moteur de parole (`verbose_json` : `{ start, end, text }`), ou déjà les nôtres — nettoyés, triés, bornés. */
export function normaliserSegments(brut: unknown): Segment[] {
  const liste = Array.isArray(brut) ? brut : isObj(brut) && Array.isArray(brut.segments) ? brut.segments : [];
  const out: Segment[] = [];
  for (const s of liste) {
    if (!isObj(s)) continue;
    const debut = num(s.debut ?? s.start); const fin = num(s.fin ?? s.end);
    const texte = typeof s.texte === "string" ? s.texte : typeof s.text === "string" ? s.text : "";
    if (debut === null || fin === null || !texte.trim()) continue;
    const loc = typeof s.locuteur === "string" ? s.locuteur : typeof s.speaker === "string" ? s.speaker : null;
    out.push({ debut: Math.max(0, debut), fin: Math.max(debut, fin), texte: texte.replace(/\s+/g, " ").trim(), locuteur: loc?.trim() || null });
  }
  return out.sort((a, b) => a.debut - b.debut || a.fin - b.fin).slice(0, 20_000);
}

/** `mm:ss` sous l'heure, `h:mm:ss` au-delà — ce qu'une personne tape pour se rendre à l'instant. */
export function formatHorodatage(secondes: number): string {
  const s = Math.max(0, Math.floor(secondes));
  const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const r = s % 60;
  const mm = String(m).padStart(2, "0"); const rr = String(r).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${rr}` : `${mm}:${rr}`;
}

/** « 1:02:03 », « 12:34 », « 754 » → des secondes, ou `null`. */
export function lireHorodatage(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) && v >= 0 ? v : null;
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
  const m = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})$/.exec(t);
  if (!m) return null;
  return (m[1] ? Number(m[1]) * 3600 : 0) + Number(m[2]) * 60 + Number(m[3]);
}

export const STOPWORDS_FR: ReadonlySet<string> = new Set([
  "le", "la", "les", "un", "une", "des", "du", "de", "d", "l", "et", "ou", "mais", "donc", "or", "ni", "car", "que", "qui", "quoi", "dont", "ou",
  "a", "au", "aux", "en", "dans", "sur", "sous", "par", "pour", "avec", "sans", "vers", "chez", "entre", "ce", "cet", "cette", "ces", "ca", "cela",
  "il", "elle", "ils", "elles", "on", "nous", "vous", "je", "tu", "me", "te", "se", "lui", "leur", "leurs", "mon", "ma", "mes", "ton", "ta", "tes", "son", "sa", "ses", "notre", "nos", "votre", "vos",
  "est", "sont", "etait", "ete", "etre", "avoir", "ai", "as", "avons", "avez", "ont", "fait", "faire", "va", "vais", "aller", "peut", "peux", "pouvoir", "faut", "doit",
  "pas", "ne", "plus", "moins", "tres", "bien", "aussi", "alors", "puis", "comme", "si", "oui", "non", "euh", "hein", "bon", "voila", "donc", "enfin", "quand", "meme", "tout", "tous", "toute", "toutes",
  "y", "il y a", "c", "s", "n", "qu", "j", "m", "t", "the", "and", "of", "to", "in", "is", "it", "that", "this", "we", "you", "i",
]);

/** Les termes utiles d'un texte : pliés, sans mots vides, trois lettres au moins. */
export function termes(texte: string): string[] {
  return plier(texte).split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !STOPWORDS_FR.has(t));
}

/**
 * OÙ EXACTEMENT : les segments qui portent TOUS les termes cherchés (ou la phrase exacte), avec
 * l'horodatage, le locuteur et un extrait — filtrables par locuteur (« Yassine »). Sans mot utile
 * dans la requête, rien n'est rendu : on ne devine pas ce que la personne cherche.
 */
export function chercher(
  segments: readonly Segment[],
  requete: string,
  opts: { locuteur?: string | null; max?: number; contexte?: number } = {},
): OccurrenceTranscription[] {
  const phrase = plier(requete).trim();
  const mots = [...new Set(termes(requete))];
  if (!phrase || (mots.length === 0 && phrase.length < 3)) return [];
  const loc = opts.locuteur ? plier(opts.locuteur) : null;
  const contexte = Math.max(0, opts.contexte ?? 1);
  const out: OccurrenceTranscription[] = [];
  segments.forEach((s, i) => {
    if (loc && !(s.locuteur && plier(s.locuteur).includes(loc))) return;
    const t = plier(s.texte);
    const exact = phrase.length >= 3 && t.includes(phrase);
    const presents = mots.filter((m) => t.includes(m)).length;
    const score = exact ? 1 : mots.length ? presents / mots.length : 0;
    if (!exact && (mots.length === 0 || presents < mots.length)) return;
    const de = Math.max(0, i - contexte); const a = Math.min(segments.length - 1, i + contexte);
    const extrait = segments.slice(de, a + 1).map((x) => x.texte).join(" ").slice(0, 320);
    out.push({ index: i, debut: s.debut, fin: s.fin, horodatage: formatHorodatage(s.debut), locuteur: s.locuteur ?? null, extrait, score });
  });
  return out.sort((x, y) => y.score - x.score || x.debut - y.debut).slice(0, Math.max(1, opts.max ?? 20));
}

/** Les mots les plus fréquents d'un texte, hors mots vides — pour nommer un chapitre, jamais pour le résumer. */
export function motsCles(texte: string, n = 4): string[] {
  const compte = new Map<string, number>();
  for (const t of termes(texte)) compte.set(t, (compte.get(t) ?? 0) + 1);
  return [...compte.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n).map(([t]) => t);
}

const jaccard = (a: readonly string[], b: readonly string[]): number => {
  const A = new Set(a); const B = new Set(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0; for (const x of A) if (B.has(x)) inter += 1;
  return inter / (A.size + B.size - inter);
};

/**
 * LA STRUCTURE : un chapitre se ferme sur un long silence, quand il dure trop, ou quand le
 * vocabulaire des segments qui suivent ne recoupe plus celui des segments qui précèdent. Le titre
 * est fait des mots-clés du chapitre — une étiquette de repérage, pas un résumé.
 */
export function decouperEnChapitres(
  segments: readonly Segment[],
  opts: { pauseMin?: number; dureeMax?: number; minSegments?: number; fenetre?: number; seuilSujet?: number } = {},
): Chapitre[] {
  if (segments.length === 0) return [];
  const pauseMin = opts.pauseMin ?? 6; const dureeMax = opts.dureeMax ?? 600; const minSegments = opts.minSegments ?? 3;
  const fenetre = opts.fenetre ?? 6; const seuilSujet = opts.seuilSujet ?? 0.06;
  const bornes: number[] = [0];
  for (let i = 1; i < segments.length; i += 1) {
    const debutChapitre = bornes[bornes.length - 1]!;
    const dansChapitre = i - debutChapitre;
    const pause = segments[i]!.debut - segments[i - 1]!.fin;
    const duree = segments[i]!.debut - segments[debutChapitre]!.debut;
    let coupe = false;
    if (dansChapitre >= minSegments) {
      if (pause >= pauseMin) coupe = true;
      else if (duree >= dureeMax) coupe = true;
      else if (i + fenetre <= segments.length && dansChapitre >= fenetre) {
        const avant = segments.slice(i - fenetre, i).flatMap((s) => termes(s.texte));
        const apres = segments.slice(i, i + fenetre).flatMap((s) => termes(s.texte));
        if (avant.length >= 8 && apres.length >= 8 && jaccard(avant, apres) < seuilSujet) coupe = true;
      }
    }
    if (coupe) bornes.push(i);
  }
  return bornes.map((de, k) => {
    const a = (bornes[k + 1] ?? segments.length) - 1;
    const texte = segments.slice(de, a + 1).map((s) => s.texte).join(" ");
    const cles = motsCles(texte, 4);
    const titre = cles.length ? cles.map((c, j) => (j === 0 ? c.charAt(0).toUpperCase() + c.slice(1) : c)).join(" · ") : `Passage ${k + 1}`;
    return { debut: segments[de]!.debut, fin: segments[a]!.fin, titre, de, a };
  });
}

/** Applique des TOURS DE PAROLE (« à partir du segment i, c'est X ») — ce qu'un modèle rend, ce que le code pose. */
export function attribuerLocuteurs(segments: readonly Segment[], tours: readonly { index: number; locuteur: string }[]): Segment[] {
  const tries = [...tours].filter((t) => Number.isInteger(t.index) && t.index >= 0 && t.locuteur.trim()).sort((a, b) => a.index - b.index);
  const out = segments.map((s) => ({ ...s }));
  let courant: string | null = null; let k = 0;
  for (let i = 0; i < out.length; i += 1) {
    while (k < tries.length && tries[k]!.index <= i) { courant = tries[k]!.locuteur.trim(); k += 1; }
    if (courant) out[i]!.locuteur = courant;
  }
  return out;
}

/** Qui a parlé, combien de temps, quelle part — les locuteurs inconnus comptent sous « ? ». */
export function locuteursDe(segments: readonly Segment[]): { locuteur: string; secondes: number; part: number; segments: number }[] {
  const total = segments.reduce((s, x) => s + Math.max(0, x.fin - x.debut), 0) || 1;
  const m = new Map<string, { secondes: number; segments: number }>();
  for (const s of segments) {
    const k = s.locuteur?.trim() || "?";
    const e = m.get(k) ?? { secondes: 0, segments: 0 };
    e.secondes += Math.max(0, s.fin - s.debut); e.segments += 1; m.set(k, e);
  }
  return [...m.entries()].map(([locuteur, e]) => ({ locuteur, secondes: Math.round(e.secondes), part: Math.round((e.secondes / total) * 100) / 100, segments: e.segments })).sort((a, b) => b.secondes - a.secondes);
}

/** Le texte HORODATÉ, une ligne par segment — ce qui s'indexe pour la recherche et se cite. */
export function texteHorodate(segments: readonly Segment[], opts: { locuteurs?: boolean } = {}): string {
  const avecLoc = opts.locuteurs ?? true;
  return segments.map((s) => `[${formatHorodatage(s.debut)}]${avecLoc && s.locuteur ? ` ${s.locuteur} :` : ""} ${s.texte}`).join("\n");
}

export function statistiques(segments: readonly Segment[]): { dureeS: number; mots: number; segments: number; locuteurs: number } {
  const dureeS = segments.length ? Math.round(Math.max(...segments.map((s) => s.fin))) : 0;
  const mots = segments.reduce((n, s) => n + s.texte.split(/\s+/).filter(Boolean).length, 0);
  return { dureeS, mots, segments: segments.length, locuteurs: new Set(segments.map((s) => s.locuteur).filter(Boolean)).size };
}

/** Les segments d'une fenêtre de temps — pour choisir les images d'une vidéo autour d'un passage. */
export function fenetre(segments: readonly Segment[], debut: number, fin: number): Segment[] {
  return segments.filter((s) => s.fin >= debut && s.debut <= fin);
}

/**
 * LES INSTANTS À REGARDER dans une vidéo : autour des passages qui répondent à la question, ou,
 * sans question, au début de chaque chapitre — bornés. Ce sont des SECONDES, pas des images :
 * l'extraction d'images est l'affaire du pont (et de ce que le serveur sait faire).
 */
export function instantsAregarder(segments: readonly Segment[], opts: { requete?: string | null; chapitres?: readonly Chapitre[]; max?: number } = {}): number[] {
  const max = Math.max(1, opts.max ?? 6);
  const out: number[] = [];
  if (opts.requete) for (const o of chercher(segments, opts.requete, { max })) out.push(Math.round((o.debut + o.fin) / 2));
  if (out.length === 0) for (const c of opts.chapitres ?? decouperEnChapitres(segments)) out.push(Math.round(c.debut + Math.min(5, (c.fin - c.debut) / 2)));
  return [...new Set(out)].sort((a, b) => a - b).slice(0, max);
}
