/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE MARKDOWN DES RÉPONSES — lu ici, jamais injecté en HTML.
 *
 * ── POURQUOI ─────────────────────────────────────────────────────────────────────────────
 *
 * L'Assistant IA écrivait son texte ligne à ligne, avec deux marqueurs seulement (gras et code) :
 * pas de titre, pas de vraie liste, pas de tableau. Une explication, une comparaison, une
 * procédure doivent se LIRE comme chez les meilleurs assistants.
 *
 * ── LA RÈGLE ─────────────────────────────────────────────────────────────────────────────
 *
 * Un sous-ensemble de Markdown (titres, gras, italique, barré, code, liens, listes, citations,
 * tableaux, séparateurs, blocs de code) est ANALYSÉ en un arbre de données ; l'écran le dessine
 * avec ses propres composants. Aucun HTML venu du modèle n'est jamais interprété : une balise
 * reste du texte. Un lien ne mène qu'à une adresse https, mailto ou à un chemin INTERNE de l'ERP.
 *
 * Le texte arrive EN FLUX : un marqueur ouvert (« **gras » sans sa fin, un bloc de code non
 * refermé, un tableau à moitié écrit) se dessine tel quel, sans casser le reste.
 *
 * Module PUR, sans import : lisible côté serveur et dans le navigateur.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type MdInline =
  | { t: "texte"; v: string }
  | { t: "gras"; c: MdInline[] }
  | { t: "italique"; c: MdInline[] }
  | { t: "barre"; c: MdInline[] }
  | { t: "code"; v: string }
  | { t: "lien"; href: string; c: MdInline[] }
  | { t: "saut" };

export type MdAlign = "gauche" | "centre" | "droite" | null;

export type MdBlock =
  | { t: "paragraphe"; c: MdInline[] }
  | { t: "titre"; niveau: 1 | 2 | 3 | 4; c: MdInline[] }
  | { t: "liste"; ordonnee: boolean; debut: number; items: MdBlock[][] }
  | { t: "tableau"; entete: MdInline[][]; align: MdAlign[]; lignes: MdInline[][][] }
  | { t: "code"; langue: string; v: string; ouvert: boolean }
  | { t: "citation"; c: MdBlock[] }
  | { t: "separateur" };

/** Les chemins internes de l'ERP qu'une réponse peut citer en clair — rendus cliquables. */
export const CHEMIN_INTERNE_RE =
  /(\/(?:api\/drive|drive|regulatory|legal|rh|events|sponsoring|validations|centre-de-paiement|centre-de-validations|calendar|chief-of-staff|assistant|workspace|courriers|stocks|finances|messages|meetings|ad-pro|mon-espace|mon-dossier|budgets|bons-de-commande|produits|documents|dossiers)\/[A-Za-z0-9_\-/.?=&%]+)/g;

const URL_RE = /(https:\/\/[^\s<>()"']+[^\s<>()"'.,;:!?»…])/g;

/** Une adresse de lien est-elle sûre ? https, mailto, ou chemin interne (jamais `//hôte`, jamais `javascript:`). */
export function lienSur(href: string): string | null {
  const h = href.trim();
  if (/^https:\/\/[^\s]+$/i.test(h)) return h;
  if (/^mailto:[^\s]+$/i.test(h)) return h;
  if (/^\/(?!\/)[^\s]*$/.test(h)) return h;
  return null;
}

// ─────────────────────────────────── les éléments en ligne ───────────────────────────────────

const estEspace = (c: string | undefined) => c === undefined || /\s/.test(c);
const estMot = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}]/u.test(c);

function fermeture(s: string, depuis: number, marque: string): number {
  // La fermeture suit un caractère non blanc, et n'est pas le début d'une marque plus longue.
  for (let j = depuis; j <= s.length - marque.length; j++) {
    if (s[j] === "\\") { j++; continue; }
    if (s.startsWith(marque, j) && !estEspace(s[j - 1]) && j > depuis) {
      if (marque.length === 1 && s[j + 1] === marque) { j++; continue; }
      if (marque === "_" && estMot(s[j + 1])) continue;
      return j;
    }
  }
  return -1;
}

function liensAutomatiques(texte: string): MdInline[] {
  const out: MdInline[] = [];
  const motif = new RegExp(`${URL_RE.source}|${CHEMIN_INTERNE_RE.source}`, "g");
  let dernier = 0;
  for (const m of texte.matchAll(motif)) {
    const brut = m[0];
    const propre = brut.replace(/[).,;:!?»…]+$/, "");
    const i = m.index ?? 0;
    if (i > dernier) out.push({ t: "texte", v: texte.slice(dernier, i) });
    out.push({ t: "lien", href: propre, c: [{ t: "texte", v: propre }] });
    if (propre.length < brut.length) out.push({ t: "texte", v: brut.slice(propre.length) });
    dernier = i + brut.length;
  }
  if (dernier < texte.length) out.push({ t: "texte", v: texte.slice(dernier) });
  return out;
}

/** Analyse une ligne (ou un paragraphe) en éléments en ligne. Un marqueur non refermé reste du texte. */
export function analyserEnLigne(s: string, profondeur = 0): MdInline[] {
  const out: MdInline[] = [];
  let tampon = "";
  const vider = () => { if (tampon) { out.push(...liensAutomatiques(tampon)); tampon = ""; } };
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === "\\" && i + 1 < s.length && /[\\`*_~[\]()#|>!-]/.test(s[i + 1]!)) { tampon += s[i + 1]; i += 2; continue; }
    if (c === "\n") { vider(); out.push({ t: "saut" }); i++; continue; }
    if (c === "`") {
      let n = 1; while (s[i + n] === "`") n++;
      const marque = "`".repeat(n);
      const fin = s.indexOf(marque, i + n);
      if (fin > i + n) { vider(); out.push({ t: "code", v: s.slice(i + n, fin).replace(/^ (.*) $/, "$1") }); i = fin + n; continue; }
      tampon += marque; i += n; continue;
    }
    if (profondeur < 4 && c === "[") {
      const finTexte = s.indexOf("]", i + 1);
      if (finTexte > i && s[finTexte + 1] === "(") {
        const finLien = s.indexOf(")", finTexte + 2);
        const href = finLien > 0 ? lienSur(s.slice(finTexte + 2, finLien)) : null;
        if (href) {
          vider();
          out.push({ t: "lien", href, c: analyserEnLigne(s.slice(i + 1, finTexte), profondeur + 1).filter((x) => x.t !== "lien") });
          i = finLien + 1;
          continue;
        }
      }
    }
    if (profondeur < 4 && (s.startsWith("**", i) || s.startsWith("__", i)) && !estEspace(s[i + 2])) {
      const marque = s.slice(i, i + 2);
      const fin = fermeture(s, i + 2, marque);
      if (fin > 0) { vider(); out.push({ t: "gras", c: analyserEnLigne(s.slice(i + 2, fin), profondeur + 1) }); i = fin + 2; continue; }
    }
    if (profondeur < 4 && s.startsWith("~~", i) && !estEspace(s[i + 2])) {
      const fin = fermeture(s, i + 2, "~~");
      if (fin > 0) { vider(); out.push({ t: "barre", c: analyserEnLigne(s.slice(i + 2, fin), profondeur + 1) }); i = fin + 2; continue; }
    }
    if (profondeur < 4 && (c === "*" || (c === "_" && !estMot(s[i - 1]))) && s[i + 1] !== c && !estEspace(s[i + 1])) {
      const fin = fermeture(s, i + 1, c);
      if (fin > 0) { vider(); out.push({ t: "italique", c: analyserEnLigne(s.slice(i + 1, fin), profondeur + 1) }); i = fin + 1; continue; }
    }
    tampon += c; i++;
  }
  vider();
  return out;
}

// ─────────────────────────────────────── les blocs ───────────────────────────────────────

const FENCE_RE = /^\s{0,3}(```+|~~~+)\s*([\w-]*)\s*$/;
const TITRE_RE = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const SEPARATEUR_RE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const CITATION_RE = /^\s{0,3}>\s?(.*)$/;
const PUCE_RE = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;
const LIGNE_SEP_TABLEAU_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function cellules(ligne: string): string[] {
  let l = ligne.trim();
  if (l.startsWith("|")) l = l.slice(1);
  if (l.endsWith("|") && !l.endsWith("\\|")) l = l.slice(0, -1);
  const out: string[] = [];
  let cour = "";
  for (let i = 0; i < l.length; i++) {
    if (l[i] === "\\" && l[i + 1] === "|") { cour += "|"; i++; continue; }
    if (l[i] === "|") { out.push(cour.trim()); cour = ""; continue; }
    cour += l[i];
  }
  out.push(cour.trim());
  return out;
}

const debutDeBloc = (l: string) =>
  FENCE_RE.test(l) || TITRE_RE.test(l) || SEPARATEUR_RE.test(l) || CITATION_RE.test(l) || PUCE_RE.test(l);

function analyserListe(lignes: string[]): MdBlock {
  const premiere = PUCE_RE.exec(lignes[0]!)!;
  const retrait = premiere[1]!.length;
  const ordonnee = /\d/.test(premiere[2]!);
  const debut = ordonnee ? Number.parseInt(premiere[2]!, 10) || 1 : 1;
  const items: string[][] = [];
  for (const l of lignes) {
    const m = PUCE_RE.exec(l);
    if (m && m[1]!.length <= retrait + 1) { items.push([m[3]!]); continue; }
    if (!items.length) items.push([]);
    items[items.length - 1]!.push(l.length > retrait + 2 ? l.slice(Math.min(l.search(/\S|$/), retrait + 2)) : l.trim());
  }
  return { t: "liste", ordonnee, debut, items: items.map((it) => analyserBlocs(it.join("\n"))) };
}

/**
 * LES CLÔTURES DE BLOC REMISES À LEUR LIGNE. Un modèle colle souvent l'ouverture au bout d'une phrase
 * (« … le circuit : ```schema ») et la fermeture devant la suite (« ``` - KAM : … ») — mesuré sur une vraie
 * réponse : le schéma s'affichait en JSON brut. On remet chaque clôture seule sur sa ligne avant d'analyser.
 */
export function normaliserClotures(texte: string): string {
  return texte
    .replace(/([^\n`])[ \t]*(```[\w-]*)[ \t]*\n/g, "$1\n$2\n")
    .replace(/^(```[\w-]+)[ \t]+(\S[^\n]*)$/gm, "$1\n$2")
    .replace(/^```[ \t]+(\S[^\n]*)$/gm, "```\n$1")
    .replace(/([}\]"])[ \t]*```[ \t]*(?:\n|$)?/g, "$1\n```\n");
}

/** Analyse un texte Markdown en blocs. Robuste aux textes partiels (flux). */
export function analyserMarkdown(texte: string): MdBlock[] {
  return analyserBlocs(normaliserClotures(texte.replace(/\r\n?/g, "\n")));
}

function analyserBlocs(texte: string): MdBlock[] {
  const lignes = texte.split("\n");
  const blocs: MdBlock[] = [];
  let i = 0;
  while (i < lignes.length) {
    const l = lignes[i]!;
    if (!l.trim()) { i++; continue; }

    const fence = FENCE_RE.exec(l);
    if (fence) {
      const marque = fence[1]!;
      const corps: string[] = [];
      let j = i + 1;
      let ferme = false;
      while (j < lignes.length) {
        if (lignes[j]!.trim().startsWith(marque[0]!.repeat(3)) && lignes[j]!.trim().replace(/[`~]/g, "") === "") { ferme = true; break; }
        corps.push(lignes[j]!);
        j++;
      }
      blocs.push({ t: "code", langue: fence[2]!.toLowerCase(), v: corps.join("\n"), ouvert: !ferme });
      i = ferme ? j + 1 : j;
      continue;
    }

    const titre = TITRE_RE.exec(l);
    if (titre) {
      const niveau = Math.min(4, titre[1]!.length) as 1 | 2 | 3 | 4;
      blocs.push({ t: "titre", niveau, c: analyserEnLigne(titre[2]!) });
      i++;
      continue;
    }

    if (SEPARATEUR_RE.test(l) && !PUCE_RE.test(l)) { blocs.push({ t: "separateur" }); i++; continue; }

    if (l.includes("|") && i + 1 < lignes.length && LIGNE_SEP_TABLEAU_RE.test(lignes[i + 1]!)) {
      const entete = cellules(l);
      const align: MdAlign[] = cellules(lignes[i + 1]!).map((c) =>
        c.startsWith(":") && c.endsWith(":") ? "centre" : c.endsWith(":") ? "droite" : c.startsWith(":") ? "gauche" : null);
      const corps: MdInline[][][] = [];
      let j = i + 2;
      while (j < lignes.length && lignes[j]!.includes("|") && lignes[j]!.trim()) {
        const cs = cellules(lignes[j]!);
        corps.push(entete.map((_, k) => analyserEnLigne(cs[k] ?? "")));
        j++;
      }
      blocs.push({ t: "tableau", entete: entete.map((c) => analyserEnLigne(c)), align: entete.map((_, k) => align[k] ?? null), lignes: corps });
      i = j;
      continue;
    }

    if (CITATION_RE.test(l)) {
      const corps: string[] = [];
      while (i < lignes.length && CITATION_RE.test(lignes[i]!)) { corps.push(CITATION_RE.exec(lignes[i]!)![1]!); i++; }
      blocs.push({ t: "citation", c: analyserBlocs(corps.join("\n")) });
      continue;
    }

    if (PUCE_RE.test(l)) {
      const corps: string[] = [];
      while (i < lignes.length) {
        const cour = lignes[i]!;
        if (!cour.trim()) {
          const suite = lignes[i + 1];
          if (suite !== undefined && (PUCE_RE.test(suite) || /^\s{2,}\S/.test(suite))) { i++; continue; }
          break;
        }
        if (corps.length && !PUCE_RE.test(cour) && !/^\s+\S/.test(cour) && debutDeBloc(cour)) break;
        corps.push(cour);
        i++;
      }
      blocs.push(analyserListe(corps));
      continue;
    }

    const para: string[] = [];
    while (i < lignes.length && lignes[i]!.trim() && (para.length === 0 || !debutDeBloc(lignes[i]!))) {
      if (lignes[i]!.includes("|") && i + 1 < lignes.length && LIGNE_SEP_TABLEAU_RE.test(lignes[i + 1]!)) break;
      para.push(lignes[i]!.trim());
      i++;
    }
    blocs.push({ t: "paragraphe", c: analyserEnLigne(para.join("\n")) });
  }
  return blocs;
}

/** Le texte brut d'un arbre — pour la copie, la recherche et les lecteurs d'écran. */
export function texteBrut(blocs: MdBlock[]): string {
  const enLigne = (xs: MdInline[]): string => xs.map((x) =>
    x.t === "texte" || x.t === "code" ? x.v : x.t === "saut" ? "\n" : enLigne(x.c)).join("");
  return blocs.map((b) => {
    switch (b.t) {
      case "paragraphe": case "titre": return enLigne(b.c);
      case "liste": return b.items.map((it, k) => `${b.ordonnee ? `${b.debut + k}.` : "-"} ${texteBrut(it)}`).join("\n");
      case "tableau": return [b.entete, ...b.lignes].map((r) => r.map(enLigne).join(" | ")).join("\n");
      case "code": return b.v;
      case "citation": return texteBrut(b.c);
      case "separateur": return "";
    }
  }).filter(Boolean).join("\n\n");
}
