/**
 * LIRE UN `.docx` — les PARAGRAPHES : propriétés en cascade, étiquette de liste, fragments, champs
 * PAGE / NUMPAGES, tabulations, sauts, dessins en ligne et ancrés.
 */
import { type XmlNode, textOf, attr, children, child } from "@/lib/artifact/object-model/xml";
import type { ProprietesTexte, Etiquette, Paragraphe, Inline, Ancre } from "./modele";
import { att, enfant, elements } from "./unites";
import { type PPr, type RPr, lirePPr, fusionPPr, fusionRPr, resoudreTexte, resoudreParagraphe, lireRPr } from "./proprietes";
import { chaine } from "./styles";
import { niveauDe, puceDe, formaterNombre } from "./listes";
import type { Ctx } from "./contexte";
import { lireDessin, lireVml } from "./dessins";

// ─────────────────────────── Paragraphes ───────────────────────────

interface EtatChamp { instr: string; phase: "instr" | "resultat"; masquer: boolean; emis: boolean }

const codeChamp = (instr: string): "PAGE" | "NUMPAGES" | null => {
  const m = /^\s*(PAGE|NUMPAGES|SECTIONPAGES)\b/i.exec(instr);
  if (!m) return null;
  return m[1]!.toUpperCase() === "PAGE" ? "PAGE" : "NUMPAGES";
};

function proprietesDuParagraphe(pPr: XmlNode | null, ctx: Ctx): { pPr: PPr; rPrStyle: RPr; styleId: string | null } {
  const direct = lirePPr(pPr, ctx.theme);
  const styleId = att(enfant(pPr, "w:pStyle"), "w:val") ?? ctx.styles.paragrapheDefaut;
  const ch = chaine(ctx.styles, styleId);
  const pStyle = fusionPPr(...ch.map((s) => s.pPr));
  const rStyle = fusionRPr(...ch.map((s) => s.rPr));
  // La liste : celle de la mise en forme directe, sinon celle du style.
  const numId = direct.numId ?? pStyle.numId;
  const niveau = direct.niveau ?? pStyle.niveau ?? 0;
  const lvl = numId && numId !== "0" ? niveauDe(ctx.num, numId, niveau) : null;
  const pPrFinal = fusionPPr(ctx.styles.defautPPr, ctx.tableau?.pPr, pStyle, lvl?.pPr, direct);
  pPrFinal.numId = numId;
  pPrFinal.niveau = niveau;
  return { pPr: pPrFinal, rPrStyle: fusionRPr(ctx.styles.defautRPr, ctx.tableau?.rPr, rStyle), styleId };
}

function etiquette(ctx: Ctx, numId: string | undefined, ilvl: number, marque: ProprietesTexte): Etiquette | null {
  if (!numId || numId === "0") return null;
  const def = ctx.num.nums.get(numId);
  const lvl = niveauDe(ctx.num, numId, ilvl);
  if (!def || !lvl) return null;
  // Les compteurs vivent par LISTE ABSTRAITE : deux `w:num` d'une même liste se suivent, sauf `startOverride`.
  const cle = def.abstrait;
  const cpt = ctx.num.compteurs.get(cle) ?? [];
  const surcharge = def.surcharges.get(ilvl)?.debut;
  const premiereFois = !ctx.num.dejaVus.has(`${numId}:${ilvl}`);
  ctx.num.dejaVus.add(`${numId}:${ilvl}`);
  if (surcharge != null && premiereFois) cpt[ilvl] = surcharge;
  else cpt[ilvl] = cpt[ilvl] == null ? lvl.debut : cpt[ilvl]! + 1;
  for (let i = ilvl + 1; i < 9; i++) cpt[i] = undefined;
  ctx.num.compteurs.set(cle, cpt);
  const symbole = !!lvl.policeSymbole && /symbol|wingdings|webdings/i.test(lvl.policeSymbole);
  const p = resoudreTexte({ ...marque, ...lvl.rPr, souligne: lvl.rPr.souligne ?? null, police: symbole ? marque.police : lvl.rPr.police ?? marque.police });
  if (lvl.format === "bullet") {
    const forme = puceDe(lvl.texte, lvl.policeSymbole);
    return { texte: forme === "texte" ? lvl.texte : "", p, puce: forme === "texte" ? null : forme, suffixe: lvl.suffixe, symbole };
  }
  const texte = lvl.texte.replace(/%(\d)/g, (_, d: string) => {
    const i = Number(d) - 1;
    const niv = niveauDe(ctx.num, numId, i);
    return formaterNombre(cpt[i] ?? niv?.debut ?? 1, niv?.format ?? "decimal");
  });
  return { texte, p, puce: null, suffixe: lvl.suffixe, symbole: false };
}

export function lireParagraphe(pNode: XmlNode, ctx: Ctx): Paragraphe {
  const pPrNode = enfant(pNode, "w:pPr");
  const { pPr, rPrStyle, styleId } = proprietesDuParagraphe(pPrNode, ctx);
  const pp = resoudreParagraphe(pPr, styleId);
  const marque = resoudreTexte(fusionRPr(rPrStyle, lireRPr(enfant(pPrNode, "w:rPr"), ctx.theme)));
  const contenu: Inline[] = [];
  const ancres: Ancre[] = [];
  const pile: EtatChamp[] = [];
  const masque = () => pile.some((e) => e.phase === "instr" || e.masquer);

  const proprietesRun = (r: XmlNode, lien: string | null): ProprietesTexte => {
    const rPr = enfant(r, "w:rPr");
    const rStyle = att(enfant(rPr, "w:rStyle"), "w:val");
    const ch = rStyle ? chaine(ctx.styles, rStyle) : [];
    const props = resoudreTexte(fusionRPr(rPrStyle, ...ch.map((s) => s.rPr), lireRPr(rPr, ctx.theme)));
    if (lien) props.lien = lien;
    return props;
  };

  const ajouterDessins = (res: { inline?: Inline; ancre?: Ancre }[]) => {
    for (const d of res) {
      if (d.inline) contenu.push(d.inline);
      if (d.ancre) ancres.push(d.ancre);
    }
  };

  const lireContenuRun = (n: XmlNode, props: ProprietesTexte) => {
    for (const c of elements(n)) {
      switch (c.name) {
        case "w:t":
          if (!masque()) contenu.push({ k: "texte", texte: textOf(c), p: props });
          break;
        case "w:tab":
          if (!masque()) contenu.push({ k: "tab", p: props });
          break;
        case "w:ptab": {
          const a = attr(c, "w:alignment");
          if (!masque()) contenu.push({ k: "ptab", alignement: a === "center" ? "center" : a === "right" ? "right" : "left", p: props });
          break;
        }
        case "w:br": {
          if (masque()) break;
          const t = attr(c, "w:type");
          contenu.push({ k: "saut", type: t === "page" ? "page" : t === "column" ? "colonne" : "ligne", p: props });
          break;
        }
        case "w:cr":
          if (!masque()) contenu.push({ k: "saut", type: "ligne", p: props });
          break;
        case "w:noBreakHyphen":
          if (!masque()) contenu.push({ k: "texte", texte: "\u2011", p: props });
          break;
        case "w:sym": {
          if (masque()) break;
          const code = parseInt(attr(c, "w:char") ?? "", 16);
          if (!Number.isFinite(code)) break;
          const police = attr(c, "w:font") ?? "";
          const forme = puceDe(String.fromCodePoint(code), police);
          contenu.push({ k: "texte", texte: forme === "texte" ? String.fromCodePoint(code >= 0xf000 ? code - 0xf000 : code) : forme === "carre" ? "\u25aa" : "\u2022", p: props });
          break;
        }
        case "w:fldChar": {
          const t = attr(c, "w:fldCharType");
          if (t === "begin") pile.push({ instr: "", phase: "instr", masquer: false, emis: false });
          else if (t === "separate") {
            const e = pile[pile.length - 1];
            if (e) {
              e.phase = "resultat";
              const code = codeChamp(e.instr);
              if (code && !pile.slice(0, -1).some((x) => x.phase === "instr" || x.masquer)) {
                contenu.push({ k: "champ", code, repli: "1", p: props });
                e.emis = true;
                e.masquer = true;
              }
            }
          } else if (t === "end") {
            const e = pile.pop();
            if (e && !e.emis && e.phase === "instr") {
              const code = codeChamp(e.instr);
              if (code && !masque()) contenu.push({ k: "champ", code, repli: "1", p: props });
            }
          }
          break;
        }
        case "w:instrText": {
          const e = pile[pile.length - 1];
          if (e && e.phase === "instr") e.instr += textOf(c);
          break;
        }
        case "w:drawing":
          if (!masque()) ajouterDessins([lireDessin(c, ctx, props)]);
          break;
        case "w:pict":
        case "w:object":
          if (!masque()) ajouterDessins(lireVml(c, ctx, props));
          break;
        case "mc:AlternateContent": {
          const choix = children(c, "mc:Choice").find((x) => /wps|wpg|wp14|w14/.test(attr(x, "Requires") ?? "")) ?? child(c, "mc:Choice");
          const avant = contenu.length + ancres.length;
          if (choix) lireContenuRun(choix, props);
          if (contenu.length + ancres.length === avant) {
            const repli = child(c, "mc:Fallback");
            if (repli) lireContenuRun(repli, props);
          }
          break;
        }
        case "w:footnoteReference":
        case "w:endnoteReference":
          ctx.ignores.add("notes de bas de page");
          break;
        default:
          break;
      }
    }
  };

  const marcher = (n: XmlNode, lien: string | null) => {
    for (const c of elements(n)) {
      switch (c.name) {
        case "w:r": {
          const props = proprietesRun(c, lien);
          if (props.masque) {
            // Le texte masqué ne s'imprime pas — mais ses marques de champ comptent pour l'état.
            for (const e of elements(c)) if (e.name === "w:fldChar" || e.name === "w:instrText") lireContenuRun({ ...c, children: [e] }, props);
            break;
          }
          lireContenuRun(c, props);
          break;
        }
        case "w:hyperlink": {
          const rid = attr(c, "r:id");
          const rel = rid ? ctx.rels.get(rid) : undefined;
          marcher(c, rel?.externe ? rel.cible : lien);
          break;
        }
        case "w:fldSimple": {
          const code = codeChamp(attr(c, "w:instr") ?? "");
          if (code) {
            const r = child(c, "w:r");
            contenu.push({ k: "champ", code, repli: r ? textOf(r) || "1" : "1", p: r ? proprietesRun(r, lien) : marque });
          } else marcher(c, lien);
          break;
        }
        case "w:sdt": {
          const sc = child(c, "w:sdtContent");
          if (sc) marcher(sc, lien);
          break;
        }
        case "w:ins":
        case "w:moveTo":
        case "w:smartTag":
        case "w:customXml":
        case "w:dir":
        case "w:bdo":
          marcher(c, lien);
          break;
        case "m:oMathPara":
        case "m:oMath": {
          const t = textOf(c);
          if (t) contenu.push({ k: "texte", texte: t, p: marque });
          ctx.ignores.add("équations (rendues en texte)");
          break;
        }
        default:
          break;
      }
    }
  };
  marcher(pNode, null);
  return { type: "paragraphe", pp, marque, contenu, ancres, etiquette: etiquette(ctx, pPr.numId, pPr.niveau ?? 0, marque) };
}
