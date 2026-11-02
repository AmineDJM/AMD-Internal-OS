import type { Cellule, Rangee } from "@/lib/pieces-lues/tableau";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES RANGÉES D'UN PDF, PAR LES POSITIONS DE SES CARACTÈRES (lot B1, décision 0049). Serveur.
 *
 * mupdf rend chaque caractère avec sa position. On regroupe par LIGNE DE BASE (une rangée du
 * tableau), puis on coupe en CELLULES là où l'écart horizontal dépasse l'espace d'un mot — un
 * « 145 000,00 » reste une cellule, la colonne suivante en commence une autre. C'est ce qui
 * permet à `tableau.ts` de lire un tableau par colonnes, là où le texte à plat met chaque cellule
 * sur sa propre ligne.
 *
 * `null` : pas un PDF lisible, ou pas de couche texte (un scan) — la vision prend le relais.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

interface Glyphe { c: string; x0: number; x1: number; y: number; taille: number }

const PAGES_MAX = 40;

/** Les glyphes d'une page → rangées → cellules. Pur, exporté pour les tests. */
export function rangeesDesGlyphes(page: number, glyphes: readonly Glyphe[]): Rangee[] {
  const tri = [...glyphes].filter((g) => g.c.trim() !== "" || g.c === " ").sort((a, b) => a.y - b.y || a.x0 - b.x0);
  const lignes: Glyphe[][] = [];
  for (const g of tri) {
    const l = lignes[lignes.length - 1];
    if (l && Math.abs(l[0].y - g.y) <= Math.max(1.2, l[0].taille * 0.3)) l.push(g);
    else lignes.push([g]);
  }
  const rangees: Rangee[] = [];
  for (const l of lignes) {
    const s = l.sort((a, b) => a.x0 - b.x0);
    const taille = s.reduce((m, g) => Math.max(m, g.taille), 0) || 8;
    const cellules: Cellule[] = [];
    let cour: { t: string; x0: number; x1: number } | null = null;
    for (const g of s) {
      if (g.c === " ") { if (cour) cour.t += " "; continue; }
      if (cour && g.x0 - cour.x1 <= taille * 0.75) { cour.t += g.c; cour.x1 = Math.max(cour.x1, g.x1); continue; }
      if (cour) cellules.push({ texte: cour.t.replace(/\s+/g, " ").trim(), x0: cour.x0, x1: cour.x1 });
      cour = { t: g.c, x0: g.x0, x1: g.x1 };
    }
    if (cour) cellules.push({ texte: cour.t.replace(/\s+/g, " ").trim(), x0: cour.x0, x1: cour.x1 });
    const propres = cellules.filter((c) => c.texte);
    if (propres.length) rangees.push({ page, y: s[0].y, taille, cellules: propres });
  }
  return rangees;
}

/** Les rangées positionnées d'un PDF à couche texte ; `null` sans couche texte exploitable. */
export async function rangeesDuPdf(octets: Buffer, pagesMax = PAGES_MAX): Promise<Rangee[] | null> {
  let mupdf: typeof import("mupdf");
  try { mupdf = await import("mupdf"); } catch { return null; }
  let doc: InstanceType<typeof mupdf.Document> | null = null;
  try {
    doc = mupdf.Document.openDocument(new Uint8Array(octets), "application/pdf");
    const total = Math.min(doc.countPages(), pagesMax);
    const toutes: Rangee[] = [];
    let caracteres = 0;
    for (let i = 0; i < total; i++) {
      const page = doc.loadPage(i);
      const st = page.toStructuredText("preserve-whitespace");
      const glyphes: Glyphe[] = [];
      st.walk({
        onChar(c, origin, _font, size, quad) {
          const xs = [quad[0], quad[2], quad[4], quad[6]];
          glyphes.push({ c, x0: Math.min(...xs), x1: Math.max(...xs), y: origin[1], taille: size });
        },
      });
      caracteres += glyphes.filter((g) => g.c.trim()).length;
      toutes.push(...rangeesDesGlyphes(i + 1, glyphes));
      st.destroy?.();
      page.destroy?.();
    }
    return caracteres >= 20 ? toutes : null;
  } catch {
    return null;
  } finally {
    doc?.destroy?.();
  }
}
