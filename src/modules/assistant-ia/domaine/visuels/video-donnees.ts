/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA VIDÉO DE DONNÉES (lot K2, décision 0032) — un graphique ANIMÉ (barres qui montent, courbe qui se trace,
 * classement), aux couleurs de la charte, SOUS-TITRÉ EN FRANÇAIS, rendu image par image en SVG.
 *
 * LES CHIFFRES VIENNENT DU CODE, JAMAIS DU MODÈLE :
 *   • une valeur n'est acceptée que si elle figure dans ce que les OUTILS du tour ont rendu (`provenanceDesValeurs`),
 *     sinon la vidéo est refusée — le même principe que l'UI générative (`ui/composants.ts`) ;
 *   • les sous-titres (plus haut, total, évolution, source) sont CALCULÉS ici, à partir de ces valeurs : le modèle
 *     donne un titre et désigne la série, il n'écrit aucun chiffre de la vidéo.
 *
 * Module PUR : une image est une fonction de (spécification, instant). Le serveur (`infra/visuels/rendu-donnees.ts`)
 * la rastérise (sharp) et l'encode (ffmpeg, H.264 compatible iPhone).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const FORMES_VIDEO_DONNEES = ["barres", "courbe", "classement"] as const;
export type FormeVideoDonnees = (typeof FORMES_VIDEO_DONNEES)[number];

export interface SpecVideoDonnees {
  titre: string;
  forme: FormeVideoDonnees;
  libelles: string[];
  valeurs: number[];
  unite: string | null;
  /** D'où viennent les chiffres — l'outil (et sa lecture), affiché en dernier sous-titre. */
  source: string;
}

export const VIDEO_LARGEUR = 1080;
export const VIDEO_HAUTEUR = 1080;
export const VIDEO_IPS = 24;
export const VIDEO_DUREE_S = 8;
export const POINTS_MAX = 12;

const COULEURS = {
  fond: "#FFFFFF", encre: "#1B2540", doux: "#5B6478", grille: "#E4E8F0",
  bleu: "#2C59A7", sarcelle: "#2B6E82", bande: "#101828",
};

// ─────────────────────────────── LA SPÉCIFICATION, VÉRIFIÉE ───────────────────────────────

const str = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : typeof v === "number" ? String(v) : "");

export type SpecLue = { ok: true; spec: SpecVideoDonnees } | { ok: false; raison: string };

/**
 * Lire ce que le modèle propose — forme, titre, libellés, valeurs, source — et le VÉRIFIER : chaque valeur doit être
 * un nombre lu par les outils du tour (`connu`). Une seule valeur sans source, et la vidéo n'est pas faite.
 */
export function lireSpecVideoDonnees(brut: Record<string, unknown>, connu: (v: number) => boolean, outilsAppeles: boolean): SpecLue {
  if (!outilsAppeles) return { ok: false, raison: "Aucune donnée n'a été lue dans ce tour : lis d'abord les chiffres avec un outil de l'ERP (budget, ventes, classement…), puis demande la vidéo." };
  const libelles = (Array.isArray(brut.libelles) ? brut.libelles : []).map((x) => str(x, 40)).filter(Boolean).slice(0, POINTS_MAX);
  const valeursBrutes = Array.isArray(brut.valeurs) ? brut.valeurs.slice(0, POINTS_MAX) : [];
  const valeurs = valeursBrutes.map((v) => (typeof v === "number" ? v : Number(String(v).replace(/[\s  ]/g, "").replace(",", "."))));
  if (libelles.length < 2 || valeurs.length !== libelles.length || valeurs.some((v) => !Number.isFinite(v))) {
    return { ok: false, raison: "Il faut au moins deux points, un libellé par valeur, et des nombres." };
  }
  const inconnues = valeurs.filter((v) => !connu(v));
  if (inconnues.length) {
    return { ok: false, raison: `Ces valeurs ne figurent pas dans les données lues pendant ce tour : ${inconnues.slice(0, 4).join(", ")}. Une vidéo de données ne montre que des chiffres LUS par les outils — relis-les, ne les recompose pas.` };
  }
  const forme = (FORMES_VIDEO_DONNEES as readonly string[]).includes(String(brut.forme)) ? (brut.forme as FormeVideoDonnees) : "barres";
  const titre = str(brut.titre, 90) || "Données de l'ERP";
  if (/\d{2,}/.test(titre.replace(/\b(19|20)\d{2}\b/g, ""))) {
    return { ok: false, raison: "Le titre ne porte pas de chiffre (les chiffres sont écrits par l'application, depuis les données) : retire-les du titre." };
  }
  return { ok: true, spec: { titre, forme, libelles, valeurs, unite: str(brut.unite, 12) || null, source: str(brut.source, 90) || "données de l'ERP" } };
}

// ─────────────────────────────── LES NOMBRES, EN FRANÇAIS ───────────────────────────────

const ESPACE = " ";

function grouper(n: number, decimales = 0): string {
  const fixe = Math.abs(n).toFixed(decimales);
  const [ent, dec] = fixe.split(".");
  const groupes = ent.replace(/\B(?=(\d{3})+(?!\d))/g, ESPACE);
  return `${n < 0 ? "−" : ""}${groupes}${dec && Number(dec) !== 0 ? `,${dec}` : ""}`;
}

/** Exact : « 12 430 000 DZD », « 7,5 % ». */
export function nombreExact(v: number, unite: string | null): string {
  const dec = Number.isInteger(v) ? 0 : Math.abs(v) < 10 ? 2 : 1;
  return `${grouper(v, dec)}${unite ? `${ESPACE}${unite}` : ""}`;
}

/** Compact, pour une étiquette de barre : « 12,4 M », « 1,24 Md », « 830 ». */
export function nombreCompact(v: number, unite: string | null): string {
  const a = Math.abs(v);
  const u = unite ? `${ESPACE}${unite}` : "";
  if (a >= 1e9) return `${grouper(v / 1e9, 2)}${ESPACE}Md${u}`;
  if (a >= 1e6) return `${grouper(v / 1e6, 1)}${ESPACE}M${u}`;
  if (a >= 1e4) return `${grouper(v / 1e3, 0)}${ESPACE}k${u}`;
  return nombreExact(v, unite);
}

// ─────────────────────────────── LES SOUS-TITRES, CALCULÉS ───────────────────────────────

export interface SousTitre { debut: number; fin: number; texte: string }

/** Les sous-titres de la vidéo — tous calculés depuis les valeurs ; aucun mot du modèle hormis le titre. */
export function sousTitres(s: SpecVideoDonnees): SousTitre[] {
  const iMax = s.valeurs.indexOf(Math.max(...s.valeurs));
  const total = s.valeurs.reduce((a, b) => a + b, 0);
  const premier = s.valeurs[0];
  const dernier = s.valeurs[s.valeurs.length - 1];
  const milieu = s.forme === "courbe"
    ? premier !== 0
      ? `De ${nombreExact(premier, s.unite)} (${s.libelles[0]}) à ${nombreExact(dernier, s.unite)} (${s.libelles[s.libelles.length - 1]}) : ${dernier >= premier ? "+" : "−"}${grouper(Math.abs((dernier - premier) / premier) * 100, 1)} %`
      : `De ${nombreExact(premier, s.unite)} à ${nombreExact(dernier, s.unite)}`
    : `Total : ${nombreExact(total, s.unite)} sur ${s.valeurs.length} ${s.forme === "classement" ? "rangs" : "postes"}`;
  return [
    { debut: 0, fin: 2.6, texte: s.titre },
    { debut: 2.6, fin: 5, texte: `${s.forme === "courbe" ? "Point le plus haut" : "En tête"} : ${s.libelles[iMax]} — ${nombreExact(s.valeurs[iMax], s.unite)}` },
    { debut: 5, fin: 7, texte: milieu },
    { debut: 7, fin: VIDEO_DUREE_S + 0.01, texte: `Source : ${s.source}` },
  ];
}

// ─────────────────────────────── L'IMAGE À L'INSTANT t ───────────────────────────────

const xml = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const tronquer = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
const sortie = (x: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3);
const fenetre = (t: number, debut: number, duree: number) => sortie((t - debut) / duree);

/** Couper un texte en lignes d'au plus `n` caractères (mots entiers). */
export function lignes(texte: string, n: number, max = 2): string[] {
  const out: string[] = [];
  let cur = "";
  for (const mot of texte.split(" ")) {
    if ((cur ? `${cur} ${mot}` : mot).length > n && cur) { out.push(cur); cur = mot; } else cur = cur ? `${cur} ${mot}` : mot;
  }
  if (cur) out.push(cur);
  return out.length > max ? [...out.slice(0, max - 1), tronquer(out.slice(max - 1).join(" "), n)] : out;
}

const POLICE = "Inter, 'DejaVu Sans', 'Liberation Sans', Arial, sans-serif";

/** Le cadre de tracé (sous le titre, au-dessus de la bande des sous-titres). */
const ZONE = { x: 96, y: 250, l: VIDEO_LARGEUR - 96 - 64, h: 560 };

function barresVerticales(s: SpecVideoDonnees, t: number): string {
  const n = s.valeurs.length;
  const max = Math.max(...s.valeurs, 0) || 1;
  const pas = ZONE.l / n;
  const larg = Math.min(110, pas * 0.62);
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    const p = fenetre(t, 0.7 + i * 0.22, 1.4);
    const h = Math.max(0, (s.valeurs[i] / max) * (ZONE.h - 60)) * p;
    const x = ZONE.x + i * pas + (pas - larg) / 2;
    const y = ZONE.y + ZONE.h - h;
    parts.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${larg.toFixed(1)}" height="${h.toFixed(1)}" rx="10" fill="url(#degrade)"/>`);
    if (p > 0.05) parts.push(`<text x="${(x + larg / 2).toFixed(1)}" y="${(y - 14).toFixed(1)}" text-anchor="middle" font-size="26" font-weight="700" fill="${COULEURS.encre}" opacity="${p.toFixed(2)}">${xml(nombreCompact(s.valeurs[i] * (p >= 0.999 ? 1 : p), s.unite))}</text>`);
    parts.push(`<text x="${(x + larg / 2).toFixed(1)}" y="${ZONE.y + ZONE.h + 38}" text-anchor="middle" font-size="24" fill="${COULEURS.doux}">${xml(tronquer(s.libelles[i], Math.max(6, Math.floor(pas / 14))))}</text>`);
  }
  return parts.join("");
}

function barresHorizontales(s: SpecVideoDonnees, t: number, trier: boolean): string {
  const ordre = s.valeurs.map((v, i) => ({ v, l: s.libelles[i] }));
  if (trier) ordre.sort((a, b) => b.v - a.v);
  const n = ordre.length;
  const max = Math.max(...s.valeurs, 0) || 1;
  const pas = ZONE.h / n;
  const haut = Math.min(56, pas * 0.66);
  const xBarre = ZONE.x + 250;
  const lMax = ZONE.l - 250 - 170;
  const parts: string[] = [];
  ordre.forEach((e, i) => {
    const p = fenetre(t, 0.7 + i * 0.18, 1.3);
    const y = ZONE.y + i * pas + (pas - haut) / 2;
    const l = Math.max(0, (e.v / max) * lMax) * p;
    parts.push(`<text x="${xBarre - 18}" y="${(y + haut / 2 + 9).toFixed(1)}" text-anchor="end" font-size="26" fill="${COULEURS.encre}">${trier ? `<tspan font-weight="700" fill="${COULEURS.sarcelle}">${i + 1}. </tspan>` : ""}${xml(tronquer(e.l, 16))}</text>`);
    parts.push(`<rect x="${xBarre}" y="${y.toFixed(1)}" width="${l.toFixed(1)}" height="${haut.toFixed(1)}" rx="9" fill="url(#degradeH)"/>`);
    if (p > 0.05) parts.push(`<text x="${(xBarre + l + 14).toFixed(1)}" y="${(y + haut / 2 + 9).toFixed(1)}" font-size="26" font-weight="700" fill="${COULEURS.encre}" opacity="${p.toFixed(2)}">${xml(nombreCompact(e.v * (p >= 0.999 ? 1 : p), s.unite))}</text>`);
  });
  return parts.join("");
}

function courbe(s: SpecVideoDonnees, t: number): string {
  const n = s.valeurs.length;
  const min = Math.min(...s.valeurs, 0);
  const max = Math.max(...s.valeurs) || 1;
  const etendue = max - min || 1;
  const px = (i: number) => ZONE.x + (i / (n - 1)) * ZONE.l;
  const py = (v: number) => ZONE.y + ZONE.h - 40 - ((v - min) / etendue) * (ZONE.h - 90);
  const p = fenetre(t, 0.7, 3.6) * (n - 1);
  const pts: [number, number][] = [];
  for (let i = 0; i <= Math.floor(p); i++) pts.push([px(i), py(s.valeurs[i])]);
  const frac = p - Math.floor(p);
  if (frac > 0 && Math.floor(p) < n - 1) {
    const i = Math.floor(p);
    pts.push([px(i) + (px(i + 1) - px(i)) * frac, py(s.valeurs[i]) + (py(s.valeurs[i + 1]) - py(s.valeurs[i])) * frac]);
  }
  const ligne = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const aire = pts.length > 1 ? `<polygon points="${pts[0][0].toFixed(1)},${ZONE.y + ZONE.h} ${ligne} ${pts[pts.length - 1][0].toFixed(1)},${ZONE.y + ZONE.h}" fill="${COULEURS.sarcelle}" opacity="0.10"/>` : "";
  const parts = [aire, pts.length > 1 ? `<polyline points="${ligne}" fill="none" stroke="${COULEURS.bleu}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>` : ""];
  const pasLib = Math.ceil(n / 7);
  for (let i = 0; i < n; i++) {
    const visible = i <= p + 0.001;
    if (visible) parts.push(`<circle cx="${px(i).toFixed(1)}" cy="${py(s.valeurs[i]).toFixed(1)}" r="10" fill="#fff" stroke="${COULEURS.sarcelle}" stroke-width="5"/>`);
    if (visible && (i === n - 1 || i === 0 || s.valeurs[i] === max)) {
      parts.push(`<text x="${px(i).toFixed(1)}" y="${(py(s.valeurs[i]) - 24).toFixed(1)}" text-anchor="${i === 0 ? "start" : i === n - 1 ? "end" : "middle"}" font-size="26" font-weight="700" fill="${COULEURS.encre}" stroke="#FFFFFF" stroke-width="8" stroke-linejoin="round" paint-order="stroke">${xml(nombreCompact(s.valeurs[i], s.unite))}</text>`);
    }
    if (i % pasLib === 0 || i === n - 1) parts.push(`<text x="${px(i).toFixed(1)}" y="${ZONE.y + ZONE.h + 38}" text-anchor="middle" font-size="24" fill="${COULEURS.doux}">${xml(tronquer(s.libelles[i], 10))}</text>`);
  }
  return parts.join("");
}

/**
 * L'IMAGE de la vidéo à l'instant `t` (secondes) — un SVG complet, 1080 × 1080. `logo` : une URI `data:` du logo
 * Adventum (facultative ; le serveur la lit dans `public/adventum-ia/`).
 */
export function imageVideoDonnees(s: SpecVideoDonnees, t: number, logo?: string | null): string {
  const titre = lignes(s.titre, 30, 2);
  const apparition = fenetre(t, 0, 0.6);
  const grille = [0.25, 0.5, 0.75, 1].map((f) => `<line x1="${ZONE.x}" x2="${ZONE.x + ZONE.l}" y1="${(ZONE.y + ZONE.h - f * (ZONE.h - 60)).toFixed(1)}" y2="${(ZONE.y + ZONE.h - f * (ZONE.h - 60)).toFixed(1)}" stroke="${COULEURS.grille}" stroke-width="2"/>`).join("");
  const trace = s.forme === "courbe" ? courbe(s, t) : s.forme === "classement" || s.valeurs.length > 7 ? barresHorizontales(s, t, s.forme === "classement") : barresVerticales(s, t);
  const st = sousTitres(s).find((x) => t >= x.debut && t < x.fin) ?? null;
  const stLignes = st ? lignes(st.texte, 46, 2) : [];
  const stOpacite = st ? Math.min(fenetre(t, st.debut, 0.25), 1) : 0;
  const bandeH = 64 + stLignes.length * 46;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${VIDEO_LARGEUR}" height="${VIDEO_HAUTEUR}" viewBox="0 0 ${VIDEO_LARGEUR} ${VIDEO_HAUTEUR}" font-family="${POLICE}">`,
    `<defs><linearGradient id="degrade" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="${COULEURS.sarcelle}"/><stop offset="1" stop-color="${COULEURS.bleu}"/></linearGradient>`,
    `<linearGradient id="degradeH" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${COULEURS.sarcelle}"/><stop offset="1" stop-color="${COULEURS.bleu}"/></linearGradient></defs>`,
    `<rect width="100%" height="100%" fill="${COULEURS.fond}"/>`,
    `<rect x="0" y="0" width="${VIDEO_LARGEUR}" height="10" fill="url(#degradeH)"/>`,
    logo ? `<image x="64" y="48" width="64" height="64" xlink:href="${logo}" href="${logo}"/>` : "",
    `<text x="${logo ? 148 : 64}" y="92" font-size="26" font-weight="600" fill="${COULEURS.sarcelle}" letter-spacing="1">ADVENTUM PHARMA</text>`,
    `<g opacity="${apparition.toFixed(2)}">${titre.map((l, i) => `<text x="64" y="${168 + i * 56}" font-size="48" font-weight="800" fill="${COULEURS.encre}">${xml(l)}</text>`).join("")}</g>`,
    s.forme === "courbe" || (s.forme === "barres" && s.valeurs.length <= 7) ? grille : "",
    trace,
    st ? `<g opacity="${stOpacite.toFixed(2)}"><rect x="48" y="${VIDEO_HAUTEUR - 48 - bandeH}" width="${VIDEO_LARGEUR - 96}" height="${bandeH}" rx="20" fill="${COULEURS.bande}" opacity="0.86"/>`
      + stLignes.map((l, i) => `<text x="${VIDEO_LARGEUR / 2}" y="${VIDEO_HAUTEUR - 48 - bandeH + 72 + i * 46}" text-anchor="middle" font-size="36" font-weight="600" fill="#FFFFFF">${xml(l)}</text>`).join("") + "</g>" : "",
    "</svg>",
  ].join("");
}

/** Le nombre d'images de la vidéo. */
export const IMAGES_VIDEO = VIDEO_DUREE_S * VIDEO_IPS;
