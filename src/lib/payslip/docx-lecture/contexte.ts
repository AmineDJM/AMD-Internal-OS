/**
 * LIRE UN `.docx` — le CONTEXTE de lecture (archive, thème, styles, listes, relations) et la
 * résolution des images par identifiant de relation.
 */
import PizZip from "pizzip";
import { parseXml, type XmlNode, attr } from "@/lib/artifact/object-model/xml";
import type { ImageDocx } from "./modele";
import { elements } from "./unites";
import type { Theme } from "./theme";
import type { PPr, RPr } from "./proprietes";
import type { Styles } from "./styles";
import type { Numerotation } from "./listes";

// ─────────────────────────── Le contexte de lecture ───────────────────────────

export interface Ctx {
  zip: PizZip;
  rels: Map<string, { cible: string; externe: boolean }>;
  styles: Styles;
  theme: Theme;
  num: Numerotation;
  images: Map<string, ImageDocx>;
  ignores: Set<string>;
  /** Le style de tableau en vigueur (cellules) : ses propriétés passent SOUS le style de paragraphe. */
  tableau: { pPr: PPr; rPr: RPr } | null;
}

export function lireRels(zip: PizZip, chemin: string): Map<string, { cible: string; externe: boolean }> {
  const dossier = chemin.slice(0, chemin.lastIndexOf("/") + 1);
  const nom = chemin.slice(dossier.length);
  const out = new Map<string, { cible: string; externe: boolean }>();
  const f = zip.file(`${dossier}_rels/${nom}.rels`);
  if (!f) return out;
  const racine = parseXml(f.asText());
  const visiter = (n: XmlNode) => {
    for (const r of elements(n)) {
      if (r.name === "Relationship") {
        const id = attr(r, "Id");
        const cible = attr(r, "Target");
        if (!id || !cible) continue;
        const externe = attr(r, "TargetMode") === "External";
        out.set(id, { cible: externe ? cible : cible.startsWith("/") ? cible.slice(1) : resoudre(dossier, cible), externe });
      } else visiter(r);
    }
  };
  visiter(racine);
  return out;
}

function resoudre(dossier: string, relatif: string): string {
  const pile: string[] = [];
  for (const p of `${dossier}${relatif}`.split("/")) {
    if (p === "..") pile.pop();
    else if (p !== "." && p !== "") pile.push(p);
  }
  return pile.join("/");
}

export function image(ctx: Ctx, rid: string | null): ImageDocx | null {
  if (!rid) return null;
  const rel = ctx.rels.get(rid);
  if (!rel || rel.externe) return null;
  const deja = ctx.images.get(rel.cible);
  if (deja) return deja;
  const f = ctx.zip.file(rel.cible);
  if (!f) return null;
  const im = { cle: rel.cible, octets: f.asNodeBuffer() };
  ctx.images.set(rel.cible, im);
  return im;
}
