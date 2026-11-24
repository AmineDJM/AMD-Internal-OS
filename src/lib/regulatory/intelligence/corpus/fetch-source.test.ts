import { describe, it, expect } from "vitest";
import { findPdfLink, extOf, htmlToText } from "./fetch-source";
import { extractDocumentLinks } from "./ingest-catalog";

/**
 * Ces trois fonctions décident de ce qui entre dans le corpus réglementaire. Une erreur ici ne
 * casse rien visiblement : elle remplit simplement la base de menus de site au lieu de lignes
 * directrices, et l'analyse cite alors des sources qui ne disent rien. D'où ces tests.
 */

describe("findPdfLink — atteindre le document, pas la page qui l'annonce", () => {
  it("suit un lien .pdf relatif", () => {
    const html = `<a href="/media/guide-variations.pdf">Guide</a>`;
    expect(findPdfLink(html, "https://anpp.dz/lignes-directrices/")).toBe("https://anpp.dz/media/guide-variations.pdf");
  });

  it("préfère un vrai PDF à un lien de téléchargement générique", () => {
    const html = `
      <a href="/download/1234">Télécharger</a>
      <a href="/media/le-vrai-texte.pdf">Le texte</a>`;
    expect(findPdfLink(html, "https://anpp.dz/x/")).toBe("https://anpp.dz/media/le-vrai-texte.pdf");
  });

  it("reconnaît le bouton « Télécharger » de l'ANPP même sans extension", () => {
    const html = `<a class="btn" href="/fichiers/get?id=88">  Télécharger le document  </a>`;
    expect(findPdfLink(html, "https://anpp.dz/p/")).toBe("https://anpp.dz/fichiers/get?id=88");
  });

  it("accepte « telecharger » sans accents", () => {
    const html = `<a href="/f/9">Telecharger</a>`;
    expect(findPdfLink(html, "https://anpp.dz/")).toBe("https://anpp.dz/f/9");
  });

  it("garde la query string d'un PDF paramétré", () => {
    const html = `<a href="/doc.pdf?v=3">x</a>`;
    expect(findPdfLink(html, "https://x.dz/")).toBe("https://x.dz/doc.pdf?v=3");
  });

  it("rend null quand la page ne propose aucun document — on lira alors son texte", () => {
    expect(findPdfLink(`<a href="/contact">Contact</a>`, "https://anpp.dz/")).toBeNull();
  });

  it("ne casse pas sur une URL de base invalide", () => {
    expect(findPdfLink(`<a href="::/x.pdf">x</a>`, "pas-une-url")).toBeNull();
  });
});

describe("extOf — le type MIME d'abord, l'URL en secours", () => {
  it("reconnaît un PDF servi sans extension dans l'URL", () => {
    expect(extOf("https://anpp.dz/download/12", "application/pdf")).toBe("pdf");
  });
  it("reconnaît un DOCX", () => {
    expect(extOf("https://x/f", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe("docx");
  });
  it("reconnaît un tableur", () => {
    expect(extOf("https://x/f", "application/vnd.ms-excel")).toBe("xlsx");
  });
  it("retombe sur l'extension de l'URL quand le serveur ne dit rien", () => {
    expect(extOf("https://x/guide.pdf", "")).toBe("pdf");
    expect(extOf("https://x/guide.pdf?dl=1", "application/octet-stream")).toBe("pdf");
  });
  it("considère par défaut qu'il s'agit d'une page", () => {
    expect(extOf("https://anpp.dz/lignes-directrices", "")).toBe("html");
  });
});

describe("htmlToText — garder le texte, jeter le site", () => {
  it("supprime scripts, styles, navigation, en-tête et pied de page", () => {
    const html = `
      <header><a href="/">Accueil</a></header>
      <nav>Menu Accueil Contact</nav>
      <script>var x = "Ligne directrice piégée";</script>
      <style>.a{color:red}</style>
      <p>Le dossier doit contenir un certificat d'analyse.</p>
      <footer>Tous droits réservés</footer>`;
    const t = htmlToText(html);
    expect(t).toContain("certificat d'analyse");
    expect(t).not.toContain("Menu");
    expect(t).not.toContain("piégée");
    expect(t).not.toContain("color:red");
    expect(t).not.toContain("Tous droits réservés");
  });

  it("transforme les fins de bloc en retours à la ligne", () => {
    expect(htmlToText("<p>Un</p><p>Deux</p>").split("\n").filter(Boolean)).toEqual(["Un", "Deux"]);
    expect(htmlToText("Un<br>Deux").split("\n").filter(Boolean)).toEqual(["Un", "Deux"]);
  });

  it("décode les entités, y compris numériques", () => {
    expect(htmlToText("<p>D&eacute;lai &amp; co&#233;fficient &lt; 5</p>")).toContain("& co");
    expect(htmlToText("<p>co&#233;fficient</p>")).toContain("coéfficient");
    expect(htmlToText("<p>a &lt; b &gt; c</p>")).toContain("a < b > c");
  });

  it("ne laisse pas de balise résiduelle", () => {
    expect(htmlToText(`<div class="x"><span data-a="<b>">Texte</span></div>`)).toBe("Texte");
  });

  // Audit sécurité (XSS stockée) : une page de régulateur piégée ne doit laisser AUCUNE construction
  // qu'un analyseur HTML lirait comme une balise — ni écrite telle quelle, ni encodée en entités.
  const TAG_ACTIF = /<[a-zA-Z!/?]/;
  it("une balise encodée en entités n'en redevient pas une (décodage AVANT retrait)", () => {
    const t = htmlToText(`<p>Article 3. &lt;img src=x onerror=alert(document.cookie)&gt; Les études de stabilité.</p>`);
    expect(t).not.toMatch(TAG_ACTIF);
    expect(t).toContain("Les études de stabilité");
    expect(htmlToText(`&lt;script&gt;alert(1)&lt;/script&gt;Texte`)).toBe("Texte");
    expect(htmlToText(`&#60;svg onload=alert(1)&#62;x &#x3C;iframe src=javascript:alert(1)&#x3E;y`)).not.toMatch(TAG_ACTIF);
  });

  it("balises réelles, malformées ou non fermées : aucune ne survit", () => {
    for (const piege of [
      `<script>alert(1)</script>Texte`,
      `<img src=x onerror=alert(1)>Texte`,
      `Texte <img src=x onerror=alert(1)`,
      `Texte &lt;img src=x onerror=alert(1)`,
      `<!-- <script>x</script> -->Texte`,
      `<a href="javascript:alert(1)" title='a>b'>Texte</a>`,
      `<scr<script>ipt>alert(1)</script>Texte`,
    ]) {
      const t = htmlToText(piege);
      expect(t, piege).not.toMatch(TAG_ACTIF);
      expect(t, piege).toContain("Texte");
    }
  });

  it("décode en une seule passe : « &amp;lt; » reste le texte « &lt; »", () => {
    expect(htmlToText("<p>&amp;lt;b&amp;gt;</p>")).toBe("&lt;b&gt;");
    expect(htmlToText("<p>D&eacute;lai &laquo; 5 &deg;C &raquo;</p>")).toBe("Délai « 5 °C »");
  });
});

describe("extractDocumentLinks — aide à la lecture, pas inventaire", () => {
  it("repère les intitulés qui ressemblent à des textes réglementaires", () => {
    const text = [
      "Accueil",
      "Ligne directrice relative aux variations des produits pharmaceutiques enregistrés",
      "Décision n° 12 du 3 mars 2024 portant modalités de dépôt des dossiers",
      "Contact",
    ].join("\n");
    const out = extractDocumentLinks(text);
    expect(out).toHaveLength(2);
    expect(out[0]).toContain("Ligne directrice");
  });

  it("ignore ce qui est trop court (un menu) ou trop long (un paragraphe)", () => {
    const text = ["Ligne directrice", "Formulaire " + "x".repeat(300)].join("\n");
    expect(extractDocumentLinks(text)).toEqual([]);
  });

  it("ne répète pas deux fois le même intitulé", () => {
    const line = "Formulaire de demande d'enregistrement d'un produit pharmaceutique";
    expect(extractDocumentLinks([line, line, line].join("\n"))).toHaveLength(1);
  });

  it("se borne — une page d'index n'est pas un catalogue", () => {
    const many = Array.from({ length: 200 }, (_, i) => `Ligne directrice numéro ${i} relative aux essais de stabilité`);
    expect(extractDocumentLinks(many.join("\n")).length).toBeLessThanOrEqual(60);
  });
});
