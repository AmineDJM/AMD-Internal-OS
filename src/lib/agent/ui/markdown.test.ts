import { describe, expect, it } from "vitest";
import { analyserEnLigne, analyserMarkdown, lienSur, texteBrut, type MdBlock } from "@/lib/agent/ui/markdown";

const premier = (t: string): MdBlock => analyserMarkdown(t)[0]!;

describe("markdown — les éléments en ligne", () => {
  it("gras, italique, barré, code — et un marqueur ouvert reste du texte (flux)", () => {
    expect(analyserEnLigne("un **mot** et *deux* et ~~trois~~ et `x`")).toEqual([
      { t: "texte", v: "un " }, { t: "gras", c: [{ t: "texte", v: "mot" }] },
      { t: "texte", v: " et " }, { t: "italique", c: [{ t: "texte", v: "deux" }] },
      { t: "texte", v: " et " }, { t: "barre", c: [{ t: "texte", v: "trois" }] },
      { t: "texte", v: " et " }, { t: "code", v: "x" },
    ]);
    expect(analyserEnLigne("début **sans fin")).toEqual([{ t: "texte", v: "début **sans fin" }]);
  });

  it("une multiplication n'est pas de l'italique, un mot_composé non plus", () => {
    expect(analyserEnLigne("5 * 3 = 15")).toEqual([{ t: "texte", v: "5 * 3 = 15" }]);
    expect(analyserEnLigne("ad_pro_item")).toEqual([{ t: "texte", v: "ad_pro_item" }]);
  });

  it("un lien ne mène qu'à https, mailto ou un chemin interne — jamais javascript:, http:, //hôte", () => {
    expect(lienSur("https://anpp.dz/x")).toBe("https://anpp.dz/x");
    expect(lienSur("/regulatory/abc")).toBe("/regulatory/abc");
    expect(lienSur("mailto:rh@adventum.dz")).toBe("mailto:rh@adventum.dz");
    for (const mauvais of ["javascript:alert(1)", "http://x.dz", "//evil.com/a", "data:text/html,x"]) expect(lienSur(mauvais)).toBeNull();
    expect(analyserEnLigne("[clic](javascript:alert(1))")).toEqual([{ t: "texte", v: "[clic](javascript:alert(1))" }]);
    expect(analyserEnLigne("voir [le dossier](/regulatory/r1)")).toEqual([
      { t: "texte", v: "voir " }, { t: "lien", href: "/regulatory/r1", c: [{ t: "texte", v: "le dossier" }] },
    ]);
  });

  it("une balise HTML reste du texte — rien n'est interprété", () => {
    expect(analyserEnLigne("<img src=x onerror=alert(1)>")).toEqual([{ t: "texte", v: "<img src=x onerror=alert(1)>" }]);
  });

  it("les chemins internes et les URL https écrits en clair deviennent des liens, ponctuation finale exclue", () => {
    expect(analyserEnLigne("Lien : /drive/abc123.")).toEqual([
      { t: "texte", v: "Lien : " }, { t: "lien", href: "/drive/abc123", c: [{ t: "texte", v: "/drive/abc123" }] }, { t: "texte", v: "." },
    ]);
    const x = analyserEnLigne("source https://www.anpp.dz/actu, lue hier");
    expect(x[1]).toEqual({ t: "lien", href: "https://www.anpp.dz/actu", c: [{ t: "texte", v: "https://www.anpp.dz/actu" }] });
  });
});

describe("markdown — les blocs", () => {
  it("titres, paragraphes avec retours à la ligne, séparateur", () => {
    const b = analyserMarkdown("## Le point\nPremière ligne\nseconde ligne\n\n---\n\nFin");
    expect(b.map((x) => x.t)).toEqual(["titre", "paragraphe", "separateur", "paragraphe"]);
    expect(b[1]).toEqual({ t: "paragraphe", c: [{ t: "texte", v: "Première ligne" }, { t: "saut" }, { t: "texte", v: "seconde ligne" }] });
  });

  it("listes à puces et numérotées, imbriquées, avec un départ conservé", () => {
    const l = premier("- un\n- deux\n  - deux.a\n- trois");
    expect(l.t).toBe("liste");
    if (l.t !== "liste") return;
    expect(l.ordonnee).toBe(false);
    expect(l.items).toHaveLength(3);
    expect(l.items[1]!.map((x) => x.t)).toEqual(["paragraphe", "liste"]);
    const o = premier("3. trois\n4. quatre");
    expect(o).toMatchObject({ t: "liste", ordonnee: true, debut: 3 });
  });

  it("un tableau GFM, avec alignements, cellules manquantes complétées et pipe échappé", () => {
    const t = premier("| Critère | Montant |\n|:--|--:|\n| Devis A | 2 450 000 |\n| B \\| C |");
    expect(t.t).toBe("tableau");
    if (t.t !== "tableau") return;
    expect(t.align).toEqual(["gauche", "droite"]);
    expect(t.lignes).toHaveLength(2);
    expect(t.lignes[1]![0]).toEqual([{ t: "texte", v: "B | C" }]);
    expect(t.lignes[1]![1]).toEqual([]);
  });

  it("un bloc de code garde sa langue ; non refermé (flux), il est marqué ouvert", () => {
    expect(premier("```schema\n{\"a\":1}\n```")).toEqual({ t: "code", langue: "schema", v: "{\"a\":1}", ouvert: false });
    expect(premier("```schema\n{\"a\":")).toEqual({ t: "code", langue: "schema", v: "{\"a\":", ouvert: true });
  });

  it("des clôtures collées au texte (vraie réponse mesurée) sont remises à leur ligne", () => {
    const reponse = 'Il suit cette chaîne : ```schema\n{"type":"processus","noeuds":[]}``` - KAM : crée la demande.\n- National Sales : décide.';
    const b = analyserMarkdown(reponse);
    expect(b.map((x) => x.t)).toEqual(["paragraphe", "code", "liste"]);
    expect(b[1]).toMatchObject({ t: "code", langue: "schema", v: '{"type":"processus","noeuds":[]}', ouvert: false });
    expect(analyserMarkdown("Voici :\n```schema {\"a\":1}\n```")[1]).toMatchObject({ t: "code", langue: "schema", v: '{"a":1}' });
  });

  it("une citation se lit récursivement", () => {
    expect(premier("> **À noter** : rien\n> de grave")).toMatchObject({ t: "citation", c: [{ t: "paragraphe" }] });
  });

  it("le texte brut redonne le contenu lisible", () => {
    expect(texteBrut(analyserMarkdown("# Titre\n- **a**\n- b"))).toBe("Titre\n\n- a\n- b");
  });

  it("ne lève jamais, quel que soit le texte partiel", () => {
    const corpus = "## Titre\n| a | b |\n|--|--|\n| 1 | 2 |\n- x\n  1. y\n> c\n```js\nz\n```\n**g** _i_ ~~b~~ [l](/drive/x) `c`";
    for (let n = 0; n <= corpus.length; n++) expect(() => analyserMarkdown(corpus.slice(0, n))).not.toThrow();
  });
});
