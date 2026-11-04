/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * COMPOSER UN MAIL (lot I1, étape 5, décision 0063 ; audits AU1 C2, AU2 C1) — règles PURES, zéro import.
 *
 * Direction, 03/11/2026 : « laisser une totale liberté, créativité… mais que ça soit pro et bien ; des fois je peux demander
 * des choses pas forcément très pro, et qu'il les fasse » ; « la moitié en charte, l'autre en simple ».
 *
 * Le mail est un DOCUMENT DE BLOCS (paragraphe, titre, liste, tableau, bandeau, signature, pied, séparateur, HTML libre).
 * La CHARTE de la société est un STYLE, pas un gabarit : on l'applique à tout (`style: "charte"`), à rien (`"sobre"`, le
 * défaut : professionnel et sobre), à une partie (un bloc `style: "charte"` dans un mail sobre, ou un bloc `"simple"` dans
 * un mail à la charte), ou on n'envoie que du texte (`"texte"` : aucun HTML). Un bloc `html` laisse toute liberté.
 *
 * UN SEUL rendu (`composerMail`) pour toutes les boîtes ; il rend le HTML ET le texte (multipart). L'ASSAINISSEMENT est un
 * paramètre OBLIGATOIRE : tout le corps HTML — blocs écrits ici comme HTML libre du modèle — passe la liste blanche
 * (balises, propriétés CSS en ligne, `url()` / `expression` refusés) avant de partir. Tout texte de bloc est échappé ;
 * seul `**gras**` y est permis.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type StyleMail = "sobre" | "charte" | "texte";
export type StyleBloc = "sobre" | "charte" | "simple";

export type BlocMail =
  | { type: "paragraphe"; texte: string; style?: StyleBloc }
  | { type: "titre"; texte: string; style?: StyleBloc }
  | { type: "liste"; elements: string[]; style?: StyleBloc }
  | { type: "tableau"; colonnes: string[]; lignes: string[][]; style?: StyleBloc }
  | { type: "bandeau"; texte?: string }
  | { type: "signature"; style?: StyleBloc }
  | { type: "pied"; style?: StyleBloc }
  | { type: "separateur" }
  | { type: "html"; html: string };

export interface DocumentMail {
  style: StyleMail;
  blocs: BlocMail[];
}

export interface SignatureMail { nom: string; fonction: string | null; societe: string; telephone: string | null; email: string | null }

export interface CharteMail {
  societe: string;
  /** Hexadécimal sans dièse. */
  accent: string;
  texteSurAccent: string;
  police: string;
  coordonnees: string[];
  mentions: string[];
}

export const STYLES_MAIL: readonly StyleMail[] = ["sobre", "charte", "texte"];
export const STYLES_BLOC: readonly StyleBloc[] = ["sobre", "charte", "simple"];
export const BORNES_MAIL = { blocs: 40, liste: 20, colonnes: 8, lignes: 40, cellule: 300, texte: 2_000, html: 20_000 } as const;

const chaine = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim().slice(0, max) : "");
const chaines = (v: unknown, n: number, max: number): string[] => (Array.isArray(v) ? v.map((x) => chaine(x, max)).filter(Boolean).slice(0, n) : []);
const styleBloc = (v: unknown): StyleBloc | undefined => (STYLES_BLOC.includes(v as StyleBloc) ? (v as StyleBloc) : undefined);

function lireTableau(t: Record<string, unknown>, style?: StyleBloc): BlocMail | null {
  const colonnes = chaines(t.colonnes, BORNES_MAIL.colonnes, 80);
  const lignes = Array.isArray(t.lignes)
    ? t.lignes.slice(0, BORNES_MAIL.lignes).map((l) => (Array.isArray(l) ? l.slice(0, Math.max(colonnes.length, 1)).map((c) => chaine(String(c ?? ""), BORNES_MAIL.cellule)) : [])).filter((l) => l.some(Boolean))
    : [];
  if (!lignes.length) return null;
  const n = colonnes.length || Math.max(...lignes.map((l) => l.length));
  return { type: "tableau", colonnes, lignes: lignes.map((l) => Array.from({ length: n }, (_, i) => l[i] ?? "")), ...(style ? { style } : {}) };
}

function lireBloc(brut: unknown): BlocMail | null {
  if (!brut || typeof brut !== "object" || Array.isArray(brut)) return null;
  const b = brut as Record<string, unknown>;
  const style = styleBloc(b.style);
  const avec = <T extends BlocMail>(x: T): T => (style ? { ...x, style } : x);
  switch (b.type) {
    case "paragraphe": case "titre": {
      const texte = chaine(b.texte, BORNES_MAIL.texte);
      return texte ? avec({ type: b.type, texte }) : null;
    }
    case "liste": {
      const elements = chaines(b.elements, BORNES_MAIL.liste, 500);
      return elements.length ? avec({ type: "liste", elements }) : null;
    }
    case "tableau": return lireTableau(b, style);
    case "bandeau": return { type: "bandeau", ...(chaine(b.texte, 120) ? { texte: chaine(b.texte, 120) } : {}) };
    case "signature": return avec({ type: "signature" });
    case "pied": return avec({ type: "pied" });
    case "separateur": return { type: "separateur" };
    case "html": {
      const html = typeof b.html === "string" ? b.html.slice(0, BORNES_MAIL.html) : "";
      return html.trim() ? { type: "html", html } : null;
    }
    default: return null;
  }
}

/** L'ancien contenu structuré (salutation, paragraphes, liste, tableau, après, clôture) — lu comme des blocs. */
function blocsDeLAncienContenu(o: Record<string, unknown>): BlocMail[] {
  const p = (t: string): BlocMail => ({ type: "paragraphe", texte: t });
  const tableau = o.tableau && typeof o.tableau === "object" ? lireTableau(o.tableau as Record<string, unknown>) : null;
  const liste = chaines(o.liste, BORNES_MAIL.liste, 500);
  const corps = [...chaines(o.paragraphes, 12, BORNES_MAIL.texte).map(p), ...(liste.length ? [{ type: "liste", elements: liste } as BlocMail] : []), ...(tableau ? [tableau] : []), ...chaines(o.apres, 6, BORNES_MAIL.texte).map(p)];
  if (!corps.length) return [];
  return [p(chaine(o.salutation, 200) || "Bonjour,"), ...corps, p(chaine(o.cloture, 200) || "Bien cordialement,")];
}

/**
 * LIRE le document rendu par le modèle — borné, nettoyé ; ce qui manque est NOMMÉ. Le style par défaut est « sobre ». La
 * signature de la personne est ajoutée à la fin si aucun bloc ne la place (`signature: false` l'omet) ; « charte » met
 * aussi le bandeau et le pied s'ils ne sont pas placés.
 */
export function lireDocumentMail(brut: unknown): { ok: true; document: DocumentMail } | { ok: false; manque: string[] } {
  const o = brut && typeof brut === "object" && !Array.isArray(brut) ? (brut as Record<string, unknown>) : {};
  const style: StyleMail = STYLES_MAIL.includes(o.style as StyleMail) ? (o.style as StyleMail) : "sobre";
  const lus = Array.isArray(o.blocs) ? o.blocs.slice(0, BORNES_MAIL.blocs).map(lireBloc).filter((b): b is BlocMail => !!b) : blocsDeLAncienContenu(o);
  const ecrits = lus.filter((b) => ["paragraphe", "titre", "liste", "tableau", "html"].includes(b.type));
  if (!ecrits.length) return { ok: false, manque: ["le corps du mail (au moins un paragraphe)"] };
  const blocs = [...lus];
  if (o.signature !== false && !blocs.some((b) => b.type === "signature")) blocs.push({ type: "signature" });
  return { ok: true, document: style === "charte" ? toutALaCharte({ style, blocs }) : { style, blocs } };
}

/** Le document entier à la charte : bandeau en tête et pied à la fin s'ils ne sont pas placés, styles de blocs effacés. */
export function toutALaCharte(d: DocumentMail): DocumentMail {
  const blocs = d.blocs.map((b): BlocMail => ("style" in b && b.style ? ({ ...b, style: undefined } as BlocMail) : b));
  if (!blocs.some((b) => b.type === "bandeau")) blocs.unshift({ type: "bandeau" });
  if (!blocs.some((b) => b.type === "pied")) blocs.push({ type: "pied" });
  return { style: "charte", blocs };
}

const echapper = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** Le seul balisage permis dans un texte de bloc : `**gras**`, rendu après échappement ; un saut de ligne reste un saut. */
const enLigne = (t: string) => echapper(t).replace(/\*\*([^*]{1,200})\*\*/g, "<strong>$1</strong>").replace(/\n/g, "<br>");
const sansGras = (t: string) => t.replace(/\*\*([^*]{1,200})\*\*/g, "$1");
const hex = (h: string, defaut: string) => (/^[0-9A-Fa-f]{6}$/.test(h) ? `#${h.toUpperCase()}` : defaut);

interface Palette { accent: string; surAccent: string; police: string }

const TEXTE = "font-size:15px;line-height:1.55;color:#1F2933;";
function rendreBloc(b: BlocMail, s: StyleBloc, sig: SignatureMail, ch: CharteMail, pal: Palette, premier: boolean): string {
  const charte = s === "charte";
  const simple = s === "simple";
  switch (b.type) {
    case "paragraphe": return `<p style="margin:0 0 14px 0;${simple ? "" : TEXTE}">${enLigne(b.texte)}</p>`;
    case "titre": return `<h2 style="margin:18px 0 10px 0;font-size:17px;${simple ? "" : `font-weight:600;color:${charte ? pal.accent : "#102A43"};`}">${enLigne(b.texte)}</h2>`;
    case "liste": return `<ul style="margin:0 0 16px 0;padding:0 0 0 20px;">${b.elements.map((x) => `<li style="margin:0 0 6px 0;${simple ? "" : TEXTE}">${enLigne(x)}</li>`).join("")}</ul>`;
    case "tableau": {
      const th = charte ? `background:${pal.accent};color:${pal.surAccent};border:1px solid ${pal.accent};` : simple ? "border:1px solid #CCCCCC;" : "background:#F0F4F8;color:#102A43;border:1px solid #D9E2EC;";
      const td = (i: number) => (simple ? "border:1px solid #CCCCCC;" : `border:1px solid #D9E2EC;color:#1F2933;background:${charte && i % 2 ? "#F5F8FA" : "#FFFFFF"};`);
      const entete = b.colonnes.length ? `<tr>${b.colonnes.map((c) => `<th align="left" style="padding:9px 10px;font-weight:600;${th}">${echapper(c)}</th>`).join("")}</tr>` : "";
      return `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:4px 0 18px 0;font-size:14px;">${entete}${b.lignes.map((l, i) => `<tr>${l.map((c) => `<td style="padding:8px 10px;vertical-align:top;${td(i)}">${enLigne(c)}</td>`).join("")}</tr>`).join("")}</table>`;
    }
    case "bandeau": return `<div style="background:${pal.accent};padding:18px 28px;margin:${premier ? "-28px -28px 22px -28px" : "0 0 22px 0"};"><span style="font-size:18px;font-weight:700;letter-spacing:.2px;color:${pal.surAccent};">${echapper(b.texte ?? ch.societe)}</span></div>`;
    case "signature": {
      const lignes = [
        `<strong${simple ? "" : ' style="color:#102A43;"'}>${echapper(sig.nom)}</strong>`,
        sig.fonction ? echapper(sig.fonction) : null,
        charte ? `<span style="color:${pal.accent};font-weight:600;">${echapper(sig.societe)}</span>` : echapper(sig.societe),
        [sig.telephone, sig.email].filter(Boolean).map((x) => echapper(x!)).join(" · ") || null,
      ].filter(Boolean).join("<br>");
      const trait = charte ? `border-top:2px solid ${pal.accent};padding-top:12px;` : simple ? "" : "border-top:1px solid #D9E2EC;padding-top:12px;";
      return `<p style="margin:18px 0 0 0;font-size:14px;line-height:1.5;${simple ? "" : "color:#334E68;"}${trait}">${lignes}</p>`;
    }
    case "pied": {
      const pied = [...ch.coordonnees, ...ch.mentions].filter(Boolean).map(echapper).join("<br>");
      return pied ? `<p style="margin:22px 0 0 0;font-size:11.5px;line-height:1.5;color:#829AB1;">${pied}</p>` : "";
    }
    case "separateur": return '<hr style="border:0;border-top:1px solid #D9E2EC;margin:18px 0;">';
    case "html": return b.html;
  }
}

function texteDuBloc(b: BlocMail, sig: SignatureMail, ch: CharteMail, versTexte: (html: string) => string): string | null {
  switch (b.type) {
    case "paragraphe": case "titre": return sansGras(b.texte);
    case "liste": return b.elements.map((x) => `• ${sansGras(x)}`).join("\n");
    // Pas de tableau « en pipes » (illisible dans une boîte texte, relevé par le banc d'audit) : une ligne par rangée.
    case "tableau": return b.lignes.map((l) => `• ${l.map((v, i) => (i === 0 || !b.colonnes[i] ? sansGras(v) : `${b.colonnes[i]} : ${sansGras(v)}`)).join(" — ")}`).join("\n");
    case "bandeau": return null;
    case "signature": return ["--", sig.nom, sig.fonction, sig.societe, [sig.telephone, sig.email].filter(Boolean).join(" · ") || null].filter(Boolean).join("\n");
    case "pied": return [...ch.coordonnees, ...ch.mentions].filter(Boolean).join("\n") || null;
    case "separateur": return "—";
    case "html": return versTexte(b.html) || null;
  }
}

export interface MailCompose {
  /** Le HTML qui partira (assaini) — `null` : un mail texte seul. */
  html: string | null;
  /** La partie texte (multipart), ou le corps unique d'un mail texte. */
  texte: string;
}

/**
 * LE RENDU — un seul, pour toutes les boîtes. `assainir` est l'invariant : la liste blanche du serveur (balises, CSS en
 * ligne) appliquée à TOUT le corps. `versTexte` lit un bloc HTML libre pour la partie texte.
 */
export function composerMail(
  d: DocumentMail, sig: SignatureMail, ch: CharteMail, objet: string,
  outils: { assainir: (html: string) => string; versTexte: (html: string) => string },
): MailCompose {
  const texte = d.blocs.map((b) => texteDuBloc(b, sig, ch, outils.versTexte)).filter((x): x is string => !!x && !!x.trim()).join("\n\n");
  if (d.style === "texte") return { html: null, texte };
  const pal: Palette = { accent: hex(ch.accent, "#087084"), surAccent: hex(ch.texteSurAccent, "#FFFFFF"), police: `${echapper(ch.police)}, Calibri, Arial, Helvetica, sans-serif` };
  const defaut: StyleBloc = d.style === "charte" ? "charte" : "sobre";
  const corps = outils.assainir(d.blocs.map((b, i) => rendreBloc(b, ("style" in b && b.style) || defaut, sig, ch, pal, i === 0)).join("\n"));
  const fond = d.style === "charte" ? "#EEF2F5" : "#FFFFFF";
  const carte = d.style === "charte" ? "background:#FFFFFF;border-radius:10px;overflow:hidden;" : "background:#FFFFFF;";
  // Le cadre (fixe, sans aucune donnée du modèle) : 600 px, fluide sous 600 px (iPhone), tables pour Outlook.
  const html = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${echapper(objet)}</title>
<style>@media only screen and (max-width:620px){.conteneur{width:100%!important}.marge{padding:20px 16px!important}}</style></head>
<body style="margin:0;padding:0;background:${fond};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${fond};"><tr><td align="center" style="padding:24px 8px;">
<table role="presentation" class="conteneur" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;${carte}font-family:${pal.police};">
<tr><td class="marge" style="padding:28px 28px 8px 28px;">
${corps}
</td></tr></table></td></tr></table></body></html>`;
  return { html, texte };
}

/** L'APERÇU d'un mail texte seul — ce que la carte montre (le texte tel qu'il partira, sans mise en page). */
export const apercuTexte = (texte: string): string => `<pre style="white-space:pre-wrap;font-family:Calibri,Arial,sans-serif;font-size:15px;line-height:1.55;margin:16px;">${echapper(texte)}</pre>`;

/** Le prénom d'un nom complet — pour une salutation par défaut (« Bonjour Redouane, »). */
export const prenomDe = (nom: string): string => nom.trim().split(/\s+/)[0] ?? nom;
