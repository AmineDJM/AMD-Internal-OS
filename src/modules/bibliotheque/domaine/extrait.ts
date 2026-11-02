/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'EXTRAIT SURLIGNÉ — la phrase qui montre POURQUOI la pièce est sortie (J1). Pur.
 *
 * Calculé ici, et non par `ts_headline` : les trois voies (plein texte, titre, vecteur) rendent le même
 * genre d'extrait, et l'écran reçoit des SEGMENTS (texte, fort) — jamais du HTML à injecter.
 * Le repli des accents se fait caractère par caractère, pour que les positions trouvées dans le texte
 * replié soient celles du texte affiché.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface Segment {
  texte: string;
  fort: boolean;
}

export const LONGUEUR_EXTRAIT = 260;

const MOTS_VIDES = new Set([
  "le", "la", "les", "un", "une", "des", "du", "de", "d", "l", "et", "ou", "en", "au", "aux", "a", "pour", "par", "sur",
  "dans", "avec", "sans", "que", "qui", "quoi", "est", "sont", "ce", "cet", "cette", "ces", "son", "sa", "ses", "leur", "leurs",
  "nos", "notre", "vos", "votre", "mon", "ma", "mes", "il", "elle", "on", "nous", "vous", "ils", "elles", "the", "of", "and",
]);

/** Un caractère replié — ou lui-même quand le repli changerait la longueur (« œ », « ß »…). */
function plierCar(c: string): string {
  const p = c.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  if (p.length === c.length) return p;
  const l = c.toLowerCase();
  return l.length === c.length ? l : c;
}

/** Le texte replié, de MÊME longueur que l'original (un caractère pour un caractère). */
export function plierAligne(texte: string): string {
  let out = "";
  for (const c of texte) out += plierCar(c);
  return out;
}

/** Les termes d'une requête qui méritent d'être surlignés : repliés, sans mots vides, ≥ 3 lettres. */
export function termesDe(requete: string): string[] {
  const mots = plierAligne(requete ?? "").split(/[^a-z0-9]+/i).filter((m) => m.length >= 3 && !MOTS_VIDES.has(m));
  return [...new Set(mots)].slice(0, 12);
}

/** Une racine grossière (le plein texte en a une vraie) : « reglements » trouve « règlement ». */
function racine(terme: string): string {
  return terme.length > 5 ? terme.slice(0, Math.max(4, terme.length - 2)) : terme;
}

/** Les positions [début, fin) des mots du texte qui commencent par une racine d'un terme. */
export function positions(texte: string, termes: readonly string[]): [number, number][] {
  if (!termes.length) return [];
  const plie = plierAligne(texte);
  const racines = termes.map(racine);
  const out: [number, number][] = [];
  const re = /[a-z0-9]+/gi;
  for (let m = re.exec(plie); m; m = re.exec(plie)) {
    const mot = m[0];
    if (racines.some((r) => mot.startsWith(r))) out.push([m.index, m.index + mot.length]);
  }
  return out;
}

export function extraire(texte: string, requete: string, longueur: number = LONGUEUR_EXTRAIT): Segment[] {
  const t = (texte ?? "").replace(/\s+/g, " ").trim();
  if (!t) return [];
  const pos = positions(t, termesDe(requete));
  // La fenêtre : centrée sur la PREMIÈRE occurrence, calée sur des blancs.
  let debut = 0;
  if (pos.length) debut = Math.max(0, pos[0][0] - Math.floor(longueur / 3));
  if (debut > 0) {
    const blanc = t.indexOf(" ", debut);
    debut = blanc > 0 && blanc < pos[0]?.[0] ? blanc + 1 : debut;
  }
  let fin = Math.min(t.length, debut + longueur);
  if (fin < t.length) {
    const blanc = t.lastIndexOf(" ", fin);
    if (blanc > debut + longueur / 2) fin = blanc;
  }
  const segments: Segment[] = [];
  if (debut > 0) segments.push({ texte: "… ", fort: false });
  let curseur = debut;
  for (const [a, b] of pos) {
    if (b <= debut || a >= fin) continue;
    const aa = Math.max(a, debut);
    const bb = Math.min(b, fin);
    if (aa > curseur) segments.push({ texte: t.slice(curseur, aa), fort: false });
    segments.push({ texte: t.slice(aa, bb), fort: true });
    curseur = bb;
  }
  if (curseur < fin) segments.push({ texte: t.slice(curseur, fin), fort: false });
  if (fin < t.length) segments.push({ texte: " …", fort: false });
  return segments;
}

/** L'extrait à plat (pour un modèle ou un journal) : les mots forts entre « ** ». */
export function extraitAPlat(segments: readonly Segment[]): string {
  return segments.map((s) => (s.fort ? `**${s.texte}**` : s.texte)).join("");
}
