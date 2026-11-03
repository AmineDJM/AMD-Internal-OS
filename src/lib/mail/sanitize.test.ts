import { describe, it, expect } from "vitest";
import { assainirStyle, sanitizeMailHtml, htmlToText } from "./sanitize";

describe("Un mail est du code écrit par un inconnu", () => {
  it("retire les scripts ET leur contenu", () => {
    const out = sanitizeMailHtml('<p>Bonjour</p><script>fetch("/api/vol")</script>');
    expect(out).toContain("Bonjour");
    expect(out).not.toContain("script");
    expect(out).not.toContain("fetch");
  });

  it("retire TOUS les gestionnaires d'évènement, pas une liste connue", () => {
    // Une liste noire est toujours en retard d'une astuce : on coupe la famille `on*` entière.
    for (const attr of ["onclick", "onerror", "onload", "onmouseover", "onfocus", "onanimationstart"]) {
      const out = sanitizeMailHtml(`<img src="https://x/a.png" ${attr}="alert(1)">`);
      expect(out, attr).not.toContain(attr);
    }
  });

  it("neutralise javascript: dans un lien", () => {
    const out = sanitizeMailHtml('<a href="javascript:alert(1)">clic</a>');
    expect(out).not.toContain("javascript");
    expect(out).toContain("clic");
  });

  it("neutralise javascript: même déguisé par des caractères de contrôle", () => {
    // Le déguisement classique : un octet invisible au milieu du schéma. Le navigateur l'ignore
    // et exécute quand même — d'où le nettoyage AVANT de reconnaître le schéma.
    const sneaky = '<a href="java\u0009script:alert(1)">clic</a>';
    expect(sanitizeMailHtml(sneaky).toLowerCase()).not.toContain("javascript:");
  });

  it("supprime style, iframe, object, embed avec leur contenu", () => {
    for (const tag of ["style", "iframe", "object", "embed", "svg"]) {
      const out = sanitizeMailHtml(`<${tag}>charge</${tag}><p>ok</p>`);
      expect(out, tag).not.toContain(tag);
      expect(out, tag).not.toContain("charge");
      expect(out).toContain("ok");
    }
  });

  it("retire les commentaires conditionnels, qui peuvent cacher du balisage", () => {
    expect(sanitizeMailHtml("<!--[if IE]><script>x</script><![endif]--><p>a</p>")).not.toContain("script");
  });

  it("garde la mise en forme légitime d'un mail professionnel", () => {
    const out = sanitizeMailHtml('<p><strong>Objet</strong></p><table><tr><td colspan="2">Cellule</td></tr></table>');
    expect(out).toContain("<strong>");
    expect(out).toContain("<table>");
    expect(out).toContain('colspan="2"');
    expect(out).toContain("Cellule");
  });

  it("un lien s'ouvre ailleurs, sans donner la main à la page d'arrivée", () => {
    const out = sanitizeMailHtml('<a href="https://exemple.com">site</a>');
    expect(out).toContain('target="_blank"');
    expect(out).toContain("noopener");
  });

  it("accepte http(s), mailto et cid ; refuse le reste", () => {
    expect(sanitizeMailHtml('<a href="https://a.fr">x</a>')).toContain("https://a.fr");
    expect(sanitizeMailHtml('<a href="mailto:a@b.fr">x</a>')).toContain("mailto:");
    expect(sanitizeMailHtml('<img src="cid:logo">')).toContain("cid:logo");
    expect(sanitizeMailHtml('<a href="file:///etc/passwd">x</a>')).not.toContain("file:");
    expect(sanitizeMailHtml('<a href="vbscript:x">x</a>')).not.toContain("vbscript");
  });

  it("une image en data: est admise, un script en data: non", () => {
    expect(sanitizeMailHtml('<img src="data:image/png;base64,iVBORw0KGgo=">')).toContain("data:image/png");
    expect(sanitizeMailHtml('<a href="data:text/html,SCRIPT">x</a>')).not.toContain("data:text/html");
  });

  it("un corps vide ou absent ne fait pas tomber l'écran", () => {
    expect(sanitizeMailHtml(null)).toBe("");
    expect(sanitizeMailHtml(undefined)).toBe("");
    expect(sanitizeMailHtml("")).toBe("");
  });

  it("du HTML tordu s'appauvrit, il ne devient pas dangereux", () => {
    const out = sanitizeMailHtml('<p><script src="//evil">alert(1)</p>');
    expect(out).not.toContain("evil");
    expect(out).not.toContain("script");
  });
});

describe("La version texte, pour l'aperçu et la citation", () => {
  it("rend le texte sans balises, avec des retours à la ligne lisibles", () => {
    expect(htmlToText("<p>Une</p><p>Deux</p>")).toBe("Une\nDeux");
    expect(htmlToText("a<br>b")).toBe("a\nb");
  });

  it("décode les entités courantes", () => {
    expect(htmlToText("<p>Thés &amp; cafés</p>")).toContain("&");
    expect(htmlToText("<p>1 &lt; 2</p>")).toBe("1 < 2");
  });

  it("n'expose jamais le contenu d'un script", () => {
    expect(htmlToText("<script>secret</script><p>ok</p>")).toBe("ok");
  });

  it("un vide reste un vide", () => {
    expect(htmlToText(null)).toBe("");
  });
});

describe("Un mail COMPOSÉ par l'ERP garde sa mise en page — par liste blanche (I1, décision 0063)", () => {
  it("un mail REÇU ne garde aucun style (défaut inchangé)", () => {
    expect(sanitizeMailHtml('<p style="color:red" class="x">a</p>')).toBe("<p>a</p>");
  });
  it("styles en ligne filtrés : propriétés de la liste, valeurs inertes", () => {
    expect(assainirStyle("color:#087084; position:absolute; background:url(x); width:expression(1); font-size:15px !important")).toBe("color:#087084;font-size:15px");
    expect(assainirStyle("background:url&#40;x&#41;")).toBeNull();
    expect(assainirStyle("color:red;behavior:url(x.htc)")).toBe("color:red");
    expect(assainirStyle("display:flex")).toBeNull();
    expect(sanitizeMailHtml('<table width="600" cellpadding="0" onload="x()" style="border-collapse:collapse"><tr><td valign="top" class="marge ok">a</td></tr></table>', { styles: true }))
      .toBe('<table width="600" cellpadding="0" style="border-collapse:collapse"><tr><td valign="top" class="marge ok">a</td></tr></table>');
  });
});
