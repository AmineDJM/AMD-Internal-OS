/**
 * LIRE UN `.docx` — les DESSINS : DrawingML (images, formes, groupes, zones de texte, ancrages) et
 * leur équivalent VML des documents anciens. Une zone de texte contient des blocs : `lireBlocs`
 * (`blocs.ts`) est rappelé ici — récursion entre fonctions seulement, aucune valeur au chargement.
 */
import { type XmlNode, attr, textOf } from "@/lib/artifact/object-model/xml";
import type { Rognage, ElementGraphique, PositionAncre, ProprietesTexte, Inline, Ancre } from "./modele";
import { enfant, nombre, att, premier, EMU, elements } from "./unites";
import { couleurDrawing, COULEURS_NOMMEES } from "./theme";
import { type Ctx, image } from "./contexte";
import { lireBlocs } from "./blocs";

// ─────────────────────────── Dessins DrawingML ───────────────────────────

interface Cadre { x: number; y: number; largeur: number; hauteur: number }

function lireRognage(blipFill: XmlNode | null): Rognage | null {
  const r = enfant(blipFill, "a:srcRect");
  if (!r) return null;
  const v = (n: string) => (nombre(attr(r, n)) ?? 0) / 100000;
  const g = { gauche: v("l"), haut: v("t"), droite: v("r"), bas: v("b") };
  return g.gauche || g.haut || g.droite || g.bas ? g : null;
}

function xfrm(n: XmlNode | null): { off: [number, number]; ext: [number, number]; chOff: [number, number]; chExt: [number, number]; flipH: boolean; flipV: boolean } | null {
  if (!n) return null;
  const off = enfant(n, "a:off"), ext = enfant(n, "a:ext"), chOff = enfant(n, "a:chOff"), chExt = enfant(n, "a:chExt");
  const p = (e: XmlNode | null, a: string, b: string): [number, number] => [nombre(att(e, a)) ?? 0, nombre(att(e, b)) ?? 0];
  return { off: p(off, "x", "y"), ext: p(ext, "cx", "cy"), chOff: p(chOff, "x", "y"), chExt: p(chExt, "cx", "cy"), flipH: attr(n, "flipH") === "1", flipV: attr(n, "flipV") === "1" };
}

function lireForme(sp: XmlNode, cadre: Cadre, ctx: Ctx, flip: { h: boolean; v: boolean }): ElementGraphique {
  const spPr = enfant(sp, "wps:spPr") ?? enfant(sp, "pic:spPr");
  const geom = att(enfant(spPr, "a:prstGeom"), "prst") ?? "rect";
  const style = enfant(sp, "wps:style");
  let fond: string | null = null;
  if (enfant(spPr, "a:solidFill")) fond = couleurDrawing(enfant(spPr, "a:solidFill"), ctx.theme);
  else if (enfant(spPr, "a:gradFill")) fond = couleurDrawing(premier(enfant(spPr, "a:gradFill")!, "a:gs"), ctx.theme);
  else if (!enfant(spPr, "a:noFill") && style) {
    const ref = enfant(style, "a:fillRef");
    if (ref && (nombre(attr(ref, "idx")) ?? 0) > 0) fond = couleurDrawing(ref, ctx.theme);
  }
  let trait: { couleur: string; epaisseur: number } | null = null;
  const ln = enfant(spPr, "a:ln");
  const largeurTrait = (nombre(att(ln, "w")) ?? 9525) / EMU;
  if (ln && enfant(ln, "a:solidFill")) {
    const c = couleurDrawing(enfant(ln, "a:solidFill"), ctx.theme);
    if (c) trait = { couleur: c, epaisseur: largeurTrait };
  } else if (!(ln && enfant(ln, "a:noFill")) && style) {
    const ref = enfant(style, "a:lnRef");
    if (ref && (nombre(attr(ref, "idx")) ?? 0) > 0) {
      const c = couleurDrawing(ref, ctx.theme);
      if (c) trait = { couleur: c, epaisseur: largeurTrait };
    }
  }
  const geometrie: "rect" | "roundRect" | "ellipse" | "ligne" =
    /^(line|straightConnector\d*)$/.test(geom) ? "ligne" : geom === "ellipse" ? "ellipse" : /^roundRect$/.test(geom) ? "roundRect" : "rect";
  let texte: Extract<ElementGraphique, { type: "forme" }>["texte"] = null;
  const txbx = enfant(sp, "wps:txbx");
  const contenu = txbx ? enfant(txbx, "w:txbxContent") : null;
  if (contenu) {
    const bodyPr = enfant(sp, "wps:bodyPr");
    const ins = (n: string, d: number) => (nombre(att(bodyPr, n)) ?? d) / EMU;
    const a = att(bodyPr, "anchor");
    texte = {
      blocs: lireBlocs(contenu, { ...ctx, tableau: null }),
      marges: { gauche: ins("lIns", 91440), haut: ins("tIns", 45720), droite: ins("rIns", 91440), bas: ins("bIns", 45720) },
      ancrageV: a === "ctr" ? "centre" : a === "b" ? "bas" : "haut",
    };
  }
  const x = xfrm(enfant(spPr, "a:xfrm"));
  return { type: "forme", ...cadre, geometrie, fond, trait, retourneH: flip.h || !!x?.flipH, retourneV: flip.v || !!x?.flipV, texte };
}

function lireImage(pic: XmlNode, cadre: Cadre, ctx: Ctx): ElementGraphique | null {
  const blipFill = enfant(pic, "pic:blipFill");
  const blip = enfant(blipFill, "a:blip");
  const im = image(ctx, blip ? attr(blip, "r:embed") : null);
  if (!im) { ctx.ignores.add("image externe ou introuvable"); return null; }
  return { type: "image", ...cadre, image: im, rognage: lireRognage(blipFill) };
}

/** Un groupe : chaque enfant est placé dans l'espace de coordonnées du groupe, puis ramené au cadre. */
function lireGroupe(g: XmlNode, cadre: Cadre, ctx: Ctx, out: ElementGraphique[]): void {
  const t = xfrm(enfant(enfant(g, "wpg:grpSpPr"), "a:xfrm"));
  const chOff = t?.chOff ?? [0, 0];
  const chExt = t && t.chExt[0] > 0 && t.chExt[1] > 0 ? t.chExt : null;
  const kx = chExt ? cadre.largeur / chExt[0] : 1 / EMU;
  const ky = chExt ? cadre.hauteur / chExt[1] : 1 / EMU;
  for (const c of elements(g)) {
    const spPr = enfant(c, "wps:spPr") ?? enfant(c, "pic:spPr") ?? enfant(c, "wpg:grpSpPr");
    const x = xfrm(enfant(spPr, "a:xfrm"));
    if (!x) continue;
    const sous: Cadre = { x: cadre.x + (x.off[0] - chOff[0]) * kx, y: cadre.y + (x.off[1] - chOff[1]) * ky, largeur: x.ext[0] * kx, hauteur: x.ext[1] * ky };
    if (c.name === "wps:wsp") out.push(lireForme(c, sous, ctx, { h: false, v: false }));
    else if (c.name === "pic:pic") { const im = lireImage(c, sous, ctx); if (im) out.push(im); }
    else if (c.name === "wpg:grpSp") lireGroupe(c, sous, ctx, out);
  }
}

function lireGraphique(graphicData: XmlNode | null, largeur: number, hauteur: number, ctx: Ctx): ElementGraphique[] {
  const out: ElementGraphique[] = [];
  if (!graphicData) return out;
  const cadre: Cadre = { x: 0, y: 0, largeur, hauteur };
  for (const c of elements(graphicData)) {
    if (c.name === "pic:pic") { const im = lireImage(c, cadre, ctx); if (im) out.push(im); }
    else if (c.name === "wps:wsp") out.push(lireForme(c, cadre, ctx, { h: false, v: false }));
    else if (c.name === "wpg:wgp") lireGroupe(c, cadre, ctx, out);
    else ctx.ignores.add(c.name === "c:chart" ? "graphique" : c.name === "dgm:relIds" ? "diagramme SmartArt" : "objet dessiné");
  }
  return out;
}

function positionAncre(n: XmlNode | null, defaut: string): PositionAncre {
  if (!n) return { rel: defaut, decalage: 0, align: null, pct: null };
  const off = enfant(n, "wp:posOffset");
  const al = enfant(n, "wp:align");
  const pct = enfant(n, "wp14:pctPosHOffset") ?? enfant(n, "wp14:pctPosVOffset");
  return {
    rel: attr(n, "relativeFrom") ?? defaut,
    decalage: off ? (nombre(textOf(off).trim()) ?? 0) / EMU : null,
    align: al ? textOf(al).trim() : null,
    pct: pct ? (nombre(textOf(pct).trim()) ?? 0) / 100000 : null,
  };
}

export function lireDessin(d: XmlNode, ctx: Ctx, p: ProprietesTexte): { inline?: Inline; ancre?: Ancre } {
  const inline = enfant(d, "wp:inline");
  const anchor = enfant(d, "wp:anchor");
  const cont = inline ?? anchor;
  if (!cont) return {};
  const ext = enfant(cont, "wp:extent");
  const largeur = (nombre(att(ext, "cx")) ?? 0) / EMU;
  const hauteur = (nombre(att(ext, "cy")) ?? 0) / EMU;
  if (largeur <= 0 && hauteur <= 0) return {};
  const contenu = lireGraphique(enfant(enfant(cont, "a:graphic"), "a:graphicData"), largeur, hauteur, ctx);
  if (contenu.length === 0) return {};
  if (inline) return { inline: { k: "dessin", largeur, hauteur, contenu, p } };
  const a = anchor!;
  const simple = attr(a, "simplePos") === "1";
  const sp = enfant(a, "wp:simplePos");
  const h = simple ? { rel: "page", decalage: (nombre(att(sp, "x")) ?? 0) / EMU, align: null, pct: null } : positionAncre(enfant(a, "wp:positionH"), "column");
  const v = simple ? { rel: "page", decalage: (nombre(att(sp, "y")) ?? 0) / EMU, align: null, pct: null } : positionAncre(enfant(a, "wp:positionV"), "paragraph");
  const hab = elements(a).find((e) => /^wp:wrap/.test(e.name));
  const habillage = (hab ? hab.name.replace("wp:wrap", "") : "None").replace(/^./, (c) => c.toLowerCase()) as Ancre["habillage"];
  return { ancre: { largeur, hauteur, h, v, derriere: attr(a, "behindDoc") === "1", habillage: ["none", "square", "tight", "through", "topAndBottom"].includes(habillage) ? habillage : "none", contenu } };
}

// ─────────────────────────── VML (documents anciens) ───────────────────────────

function longueurCss(v: string | undefined): number | null {
  if (!v) return null;
  const m = /^(-?[\d.]+)\s*(pt|in|cm|mm|px|pc|emu)?$/.exec(v.trim());
  if (!m) return null;
  const n = Number(m[1]);
  switch (m[2]) {
    case "in": return n * 72;
    case "cm": return (n * 72) / 2.54;
    case "mm": return (n * 72) / 25.4;
    case "px": return n * 0.75;
    case "pc": return n * 12;
    case "emu": return n / EMU;
    case undefined: return n / EMU > 0 && n > 10000 ? n / EMU : n * 0.75;
    default: return n;
  }
}

function couleurVml(v: string | null): string | null {
  if (!v) return null;
  const s = v.trim().split(/\s+/)[0]!;
  const h = /^#?([0-9a-fA-F]{6})$/.exec(s);
  if (h) return h[1]!.toUpperCase();
  const c = /^#([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])$/.exec(s);
  if (c) return `${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}`.toUpperCase();
  return COULEURS_NOMMEES[s] ?? COULEURS_NOMMEES[s.toLowerCase()] ?? null;
}

export function lireVml(pict: XmlNode, ctx: Ctx, p: ProprietesTexte): { inline?: Inline; ancre?: Ancre }[] {
  const out: { inline?: Inline; ancre?: Ancre }[] = [];
  for (const forme of elements(pict)) {
    if (!/^v:(shape|rect|roundrect|oval|line|image)$/.test(forme.name)) continue;
    if (premier(forme, "v:textpath")) { ctx.ignores.add("filigrane WordArt"); continue; }
    const style = new Map((attr(forme, "style") ?? "").split(";").map((d) => d.split(":").map((x) => x.trim()) as [string, string]).filter(([k]) => k));
    const largeur = longueurCss(style.get("width")) ?? 0;
    const hauteur = longueurCss(style.get("height")) ?? 0;
    if (largeur <= 0 || hauteur <= 0) continue;
    const contenu: ElementGraphique[] = [];
    const cadre = { x: 0, y: 0, largeur, hauteur };
    const imd = enfant(forme, "v:imagedata");
    const tb = enfant(forme, "v:textbox");
    const filled = attr(forme, "filled");
    const stroked = attr(forme, "stroked");
    const fond = filled === "f" || filled === "false" ? null : couleurVml(attr(forme, "fillcolor")) ?? (tb ? "FFFFFF" : null);
    const trait = stroked === "f" || stroked === "false" ? null : { couleur: couleurVml(attr(forme, "strokecolor")) ?? "000000", epaisseur: longueurCss(attr(forme, "strokeweight") ?? "0.75pt") ?? 0.75 };
    if (imd) {
      const im = image(ctx, attr(imd, "r:id") ?? attr(imd, "o:relid"));
      if (im) contenu.push({ type: "image", ...cadre, image: im, rognage: null });
    } else {
      const corps = tb ? enfant(tb, "w:txbxContent") : null;
      contenu.push({
        type: "forme", ...cadre,
        geometrie: forme.name === "v:oval" ? "ellipse" : forme.name === "v:roundrect" ? "roundRect" : forme.name === "v:line" ? "ligne" : "rect",
        fond, trait: forme.name === "v:shape" && !attr(forme, "strokecolor") && tb ? null : trait, retourneH: false, retourneV: false,
        texte: corps ? { blocs: lireBlocs(corps, { ...ctx, tableau: null }), marges: { gauche: 7.2, haut: 3.6, droite: 7.2, bas: 3.6 }, ancrageV: "haut" } : null,
      });
    }
    if (contenu.length === 0) continue;
    if (style.get("position") === "absolute") {
      const relH = style.get("mso-position-horizontal-relative") ?? "column";
      const relV = style.get("mso-position-vertical-relative") ?? "paragraph";
      const alH = style.get("mso-position-horizontal");
      const alV = style.get("mso-position-vertical");
      const z = Number(style.get("z-index") ?? "0");
      out.push({
        ancre: {
          largeur, hauteur,
          h: { rel: relH === "text" ? "column" : relH, decalage: alH && alH !== "absolute" ? null : (longueurCss(style.get("margin-left")) ?? 0) + (longueurCss(style.get("left")) ?? 0), align: alH && alH !== "absolute" ? alH : null, pct: null },
          v: { rel: relV === "text" ? "paragraph" : relV, decalage: alV && alV !== "absolute" ? null : (longueurCss(style.get("margin-top")) ?? 0) + (longueurCss(style.get("top")) ?? 0), align: alV && alV !== "absolute" ? alV : null, pct: null },
          derriere: z < 0, habillage: "none", contenu,
        },
      });
    } else out.push({ inline: { k: "dessin", largeur, hauteur, contenu, p } });
  }
  return out;
}
