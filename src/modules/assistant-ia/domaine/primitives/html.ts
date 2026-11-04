/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LOT I3 — `produire(docx|pdf)` : LA MISE EN PAGE LIBRE, ASSAINIE (décision 0065, audit AU2 §6.1 (c)). Règle PURE.
 *
 * Le modèle écrit le document en HTML (titres, paragraphes, listes, tableaux, styles en ligne) : il décide la forme.
 * L'INVARIANT n'est pas une consigne, c'est cette liste blanche : balises permises, propriétés CSS en ligne permises,
 * `url(`, `expression(`, `javascript:` et tout le reste retirés ; un lien n'est gardé que vers http(s) ou l'ERP.
 *
 * DÉFAUT PROFESSIONNEL, LIBERTÉ SUR DEMANDE : sans style, la CHARTE Adventum (feuille nommée `charte:adventum`) habille
 * les titres et les en-têtes de tableaux ; `presentation: "libre"` n'ajoute rien (ce que le modèle a écrit, tel quel —
 * « pas forcément très pro » compris) ; `class="charte"` sur n'importe quel élément l'habille à la charte, ailleurs non.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const BALISES_PERMISES = new Set([
  "p", "br", "div", "span", "strong", "b", "em", "i", "u", "s", "sup", "sub", "small", "ul", "ol", "li", "table", "thead", "tbody", "tfoot",
  "tr", "th", "td", "caption", "h1", "h2", "h3", "h4", "hr", "a", "blockquote", "code", "pre",
]);
export const CSS_PERMIS = new Set([
  "color", "background", "background-color", "border", "border-top", "border-bottom", "border-left", "border-right", "border-collapse", "border-color",
  "padding", "padding-top", "padding-bottom", "padding-left", "padding-right", "margin", "margin-top", "margin-bottom", "font-weight", "font-size",
  "font-family", "font-style", "text-align", "text-decoration", "vertical-align", "width", "line-height", "letter-spacing", "text-transform",
]);
const RETIRES_AVEC_CONTENU = /<(script|style|iframe|object|embed|svg|math|template|noscript|head|title|form|select|textarea|button)\b[\s\S]*?<\/\1\s*>/gi;
const CSS_INTERDIT = /url\s*\(|expression\s*\(|javascript:|@import|behaviou?r|-moz-binding|position|z-index/i;

/** La CHARTE nommée : la feuille `charte:adventum` (couleur #087084, texte blanc sur la couleur). */
export const CHARTE_ADVENTUM = {
  nom: "charte:adventum",
  accent: "#087084",
  surAccent: "#FFFFFF",
  texte: "#1F2933",
  police: "Calibri, Arial, Helvetica, sans-serif",
} as const;

const STYLE_CHARTE: Record<string, string> = {
  h1: `color:${CHARTE_ADVENTUM.accent};font-size:20px;font-weight:bold;margin-bottom:10px`,
  h2: `color:${CHARTE_ADVENTUM.accent};font-size:16px;font-weight:bold;margin-top:14px`,
  h3: `color:${CHARTE_ADVENTUM.accent};font-size:14px;font-weight:bold`,
  table: "border-collapse:collapse;width:100%",
  th: `background-color:${CHARTE_ADVENTUM.accent};color:${CHARTE_ADVENTUM.surAccent};padding:6px;border:1px solid ${CHARTE_ADVENTUM.accent};text-align:left`,
  td: "padding:6px;border:1px solid #D0D7DE",
  p: `color:${CHARTE_ADVENTUM.texte}`,
};

export type Presentation = "professionnelle" | "libre";

const echapperAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

function stylePropre(brut: string): string {
  return brut.split(";").map((d) => d.trim()).filter((d) => {
    const [prop] = d.split(":");
    return prop && d.includes(":") && CSS_PERMIS.has(prop.trim().toLowerCase()) && !CSS_INTERDIT.test(d);
  }).map((d) => d.replace(/\s*:\s*/, ":")).join(";");
}

const attr = (attrs: string, nom: string): string | null => {
  const m = new RegExp(`\\b${nom}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(attrs);
  return m ? (m[2] ?? m[3] ?? m[4] ?? "") : null;
};

export interface HtmlAssaini { html: string; retire: number; balisesRetirees: string[] }

/**
 * Assainir : seules les balises et propriétés permises passent ; la charte s'applique là où elle est demandée
 * (`class="charte"`), ou partout où aucun style n'est écrit en présentation professionnelle.
 */
export function assainirHtml(source: string, presentation: Presentation = "professionnelle"): HtmlAssaini {
  const retirees = new Set<string>();
  const sansBlocs = String(source ?? "").replace(RETIRES_AVEC_CONTENU, (_t, b: string) => { retirees.add(b.toLowerCase()); return ""; })
    .replace(/<!--[\s\S]*?-->/g, "");
  const html = sansBlocs.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)([^>]*)>/g, (tout, b: string, attrs: string) => {
    const balise = b.toLowerCase();
    if (!BALISES_PERMISES.has(balise)) { retirees.add(balise); return ""; }
    if (tout.startsWith("</")) return `</${balise}>`;
    const style = stylePropre(attr(attrs, "style") ?? "");
    const charte = /\bcharte\b/i.test(attr(attrs, "class") ?? "") || (presentation === "professionnelle" && !style);
    const final = [charte ? STYLE_CHARTE[balise] ?? "" : "", style].filter(Boolean).join(";");
    const href = balise === "a" ? attr(attrs, "href") : null;
    const hrefSur = href && /^(https?:\/\/|\/(?!\/))[^\s"'<>]*$/i.test(href) && !/^javascript:/i.test(href) ? href : null;
    const span = (balise === "td" || balise === "th") ? ["colspan", "rowspan"].map((n) => { const v = attr(attrs, n); return v && /^\d{1,2}$/.test(v) ? ` ${n}="${v}"` : ""; }).join("") : "";
    return `<${balise}${final ? ` style="${echapperAttr(final)}"` : ""}${hrefSur ? ` href="${echapperAttr(hrefSur)}"` : ""}${span}>`;
  });
  return { html, retire: Math.max(0, String(source ?? "").length - html.length), balisesRetirees: [...retirees] };
}

// ─── Du HTML assaini à des BLOCS de document (le moteur Word les compose) ──────────────────

export interface Morceau { texte: string; gras?: boolean; italique?: boolean; souligne?: boolean; couleur?: string | null; lien?: string | null }
export type BlocDocument =
  | { type: "titre"; niveau: 1 | 2 | 3; morceaux: Morceau[]; couleur: string | null; alignement: string | null }
  | { type: "paragraphe"; morceaux: Morceau[]; couleur: string | null; alignement: string | null; fond: string | null }
  | { type: "liste"; ordonnee: boolean; items: Morceau[][] }
  | { type: "tableau"; lignes: { cellules: { morceaux: Morceau[]; entete: boolean; fond: string | null; couleur: string | null }[] }[] }
  | { type: "separateur" };

const couleurDe = (style: string, prop: "color" | "background-color" | "background"): string | null => {
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*(#[0-9a-f]{3,6}|[a-z]+)`, "i").exec(style);
  if (!m) return null;
  const c = m[1]!;
  if (/^#[0-9a-f]{3}$/i.test(c)) return `#${c.slice(1).split("").map((x) => x + x).join("")}`.toUpperCase();
  return /^#[0-9a-f]{6}$/i.test(c) ? c.toUpperCase() : NOMMEES[c.toLowerCase()] ?? null;
};
const NOMMEES: Record<string, string> = { black: "#000000", white: "#FFFFFF", red: "#C62828", green: "#2E7D32", blue: "#1565C0", gray: "#6B7280", grey: "#6B7280", orange: "#EF6C00", teal: "#087084" };
const alignDe = (style: string) => /text-align\s*:\s*(left|center|right|justify)/i.exec(style)?.[1]?.toLowerCase() ?? null;
const decoder = (t: string) => t.replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&amp;/g, "&");

/** Les morceaux de texte d'un fragment en ligne (gras, italique, souligné, couleur, lien). */
export function morceauxDe(fragment: string): Morceau[] {
  const out: Morceau[] = [];
  const pile: { b: string; style: string; href: string | null }[] = [];
  for (const m of fragment.matchAll(/<\/?([a-z0-9]+)([^>]*)>|([^<]+)/gi)) {
    if (m[3] !== undefined) {
      const texte = decoder(m[3]).replace(/\s+/g, " ");
      if (!texte.trim() && !out.length) continue;
      const actifs = pile.map((p) => p.b);
      const style = pile.map((p) => p.style).join(";");
      out.push({
        texte, gras: actifs.some((b) => b === "strong" || b === "b") || /font-weight\s*:\s*(bold|[6-9]00)/i.test(style),
        italique: actifs.some((b) => b === "em" || b === "i"), souligne: actifs.includes("u"),
        couleur: couleurDe(style, "color"), lien: [...pile].reverse().find((p) => p.href)?.href ?? null,
      });
      continue;
    }
    const b = m[1]!.toLowerCase();
    if (b === "br") { out.push({ texte: "\n" }); continue; }
    if (m[0].startsWith("</")) { const i = pile.map((p) => p.b).lastIndexOf(b); if (i >= 0) pile.splice(i); continue; }
    pile.push({ b, style: /style="([^"]*)"/i.exec(m[2] ?? "")?.[1] ?? "", href: /href="([^"]*)"/i.exec(m[2] ?? "")?.[1] ?? null });
  }
  while (out.length && !out[out.length - 1]!.texte.trim()) out.pop();
  return out;
}

/** Découper un HTML ASSAINI en blocs : titres, paragraphes, listes, tableaux, séparateurs. */
export function blocsDuHtml(html: string): BlocDocument[] {
  const blocs: BlocDocument[] = [];
  // Un `div` est un contenant : ses blocs se lisent comme s'il n'était pas là (un tableau dans un div reste un tableau).
  const plat = html.replace(/<\/?div\b[^>]*>/gi, "\n");
  const re = /<(h[1-4]|p|blockquote|pre)\b([^>]*)>([\s\S]*?)<\/\1>|<(ul|ol)\b[^>]*>([\s\S]*?)<\/\4>|<table\b[^>]*>([\s\S]*?)<\/table>|<hr\b[^>]*>|((?:[^<]|<\/?(?:strong|b|em|i|u|s|span|a|br|sup|sub|small|code)\b[^>]*>)+)/gi;
  for (const m of plat.matchAll(re)) {
    if (m[1]) {
      const style = /style="([^"]*)"/i.exec(m[2] ?? "")?.[1] ?? "";
      const morceaux = morceauxDe(m[3] ?? "");
      if (!morceaux.length) continue;
      const balise = m[1].toLowerCase();
      if (/^h[1-4]$/.test(balise)) blocs.push({ type: "titre", niveau: Math.min(3, +balise[1]!) as 1 | 2 | 3, morceaux, couleur: couleurDe(style, "color"), alignement: alignDe(style) });
      else blocs.push({ type: "paragraphe", morceaux, couleur: couleurDe(style, "color"), alignement: alignDe(style), fond: couleurDe(style, "background-color") ?? couleurDe(style, "background") });
    } else if (m[4]) {
      const items = [...(m[5] ?? "").matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].map((x) => morceauxDe(x[1] ?? "")).filter((x) => x.length);
      if (items.length) blocs.push({ type: "liste", ordonnee: m[4].toLowerCase() === "ol", items });
    } else if (m[6] !== undefined) {
      const lignes = [...m[6].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((tr) => ({
        cellules: [...(tr[1] ?? "").matchAll(/<(t[hd])\b([^>]*)>([\s\S]*?)<\/\1>/gi)].map((c) => {
          const style = /style="([^"]*)"/i.exec(c[2] ?? "")?.[1] ?? "";
          return { morceaux: morceauxDe(c[3] ?? ""), entete: c[1]!.toLowerCase() === "th", fond: couleurDe(style, "background-color") ?? couleurDe(style, "background"), couleur: couleurDe(style, "color") };
        }),
      })).filter((l) => l.cellules.length);
      if (lignes.length) blocs.push({ type: "tableau", lignes });
    } else if (/^<hr/i.test(m[0])) {
      blocs.push({ type: "separateur" });
    } else if (m[7] && m[7].trim()) {
      const morceaux = morceauxDe(m[7]);
      if (morceaux.length) blocs.push({ type: "paragraphe", morceaux, couleur: null, alignement: null, fond: null });
    }
  }
  return blocs;
}
