import { describe, it, expect } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { segmentsExtrait, texteExtrait, sansControles, DEBUT_SURLIGNE as D, FIN_SURLIGNE as F } from "./extrait";
import { ExtraitCitation } from "@/app/(app)/admin/regulatory-corpus/extrait-citation";

/**
 * L'extrait d'une citation du corpus : `ts_headline` marque les termes avec des sentinelles (pas `<b>`),
 * on découpe en segments, l'écran les rend en JSX. Aucun HTML venu du texte ne doit traverser.
 */
describe("segmentsExtrait — découpe d'un extrait marqué", () => {
  it("isole les termes surlignés", () => {
    expect(segmentsExtrait(`Les études de ${D}stabilité${F} doivent couvrir`)).toEqual([
      { texte: "Les études de ", fort: false },
      { texte: "stabilité", fort: true },
      { texte: " doivent couvrir", fort: false },
    ]);
  });

  it("fusionne deux termes voisins et jette les segments vides", () => {
    expect(segmentsExtrait(`${D}durée${F}${D} de${F} x`)).toEqual([{ texte: "durée de", fort: true }, { texte: " x", fort: false }]);
    expect(segmentsExtrait("")).toEqual([]);
  });

  it("tolère un marqueur orphelin (ne casse rien, n'injecte rien)", () => {
    expect(segmentsExtrait(`a ${F}b ${D}c`)).toEqual([{ texte: "a b ", fort: false }, { texte: "c", fort: true }]);
  });

  it("le texte d'une balise reste du TEXTE dans un segment", () => {
    const segs = segmentsExtrait(`<img src=x onerror=alert(1)> ${D}stabilité${F}`);
    expect(segs[0]).toEqual({ texte: "<img src=x onerror=alert(1)> ", fort: false });
  });

  it("texteExtrait / sansControles retirent marqueurs et contrôles, gardent sauts de ligne", () => {
    expect(texteExtrait(`a ${D}b${F} c`)).toBe("a b c");
    expect(sansControles("a\u0000b\nc\td\u007f")).toBe("ab\nc\td");
  });
});

describe("ExtraitCitation — rendu sans HTML injecté", () => {
  it("rend les termes en <mark> et échappe tout le reste", () => {
    const html = renderToStaticMarkup(React.createElement(ExtraitCitation, {
      c: { snippet: "", segments: segmentsExtrait(`<img src=x onerror=alert(1)><script>alert(2)</script> ${D}stabilité${F}`) },
    }));
    expect(html).toContain("<mark");
    expect(html).toContain(">stabilité</mark>");
    expect(html).not.toMatch(/<img|<script/i);
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("sans segments, retombe sur l'extrait brut, échappé lui aussi", () => {
    const html = renderToStaticMarkup(React.createElement(ExtraitCitation, { c: { snippet: "<b onmouseover=x>gras</b>" } }));
    expect(html).not.toMatch(/<b[\s>]/);
    expect(html).toContain("&lt;b onmouseover=x&gt;");
  });
});
