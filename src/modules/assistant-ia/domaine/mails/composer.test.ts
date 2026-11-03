import { describe, expect, it } from "vitest";
import { htmlToText, sanitizeMailHtml } from "@/lib/mail/sanitize";
import { composerMail, lireDocumentMail, prenomDe, toutALaCharte, type CharteMail, type DocumentMail, type SignatureMail } from "./composer";
import { natureDuRendu } from "../observation/projecteurs";

/**
 * I1 (décision 0063, étape 5) — le mail en BLOCS : la charte est un style (tout, rien, une partie), le défaut est sobre,
 * le HTML libre est permis, et TOUT le corps passe la liste blanche. La nature du rendu est relue sur le HTML produit.
 */
const charte: CharteMail = { societe: "AMD Life Sciences", accent: "0B6E4F", texteSurAccent: "FFFFFF", police: "Calibri", coordonnees: ["Staoueli, Alger"], mentions: ["SARL au capital de 10 000 000 DZD"] };
const signature: SignatureMail = { nom: "Amine Djemai", fonction: "Directeur général", societe: "AMD Life Sciences", telephone: "0550 00 00 00", email: "amine@amd.dz" };
const outils = { assainir: (h: string) => sanitizeMailHtml(h, { styles: true }), versTexte: (h: string) => htmlToText(sanitizeMailHtml(h)) };
const lire = (b: unknown): DocumentMail => { const r = lireDocumentMail(b); if (!r.ok) throw new Error(r.manque.join()); return r.document; };
const rendre = (b: unknown) => composerMail(lire(b), signature, charte, "Objet", outils);
const planning = { colonnes: ["Date", "Tâche"], lignes: [["Lun. 2/11", "Relevé"], ["Ven. 6/11", "**Remise**"]] };

describe("I1 — composer un mail en blocs", () => {
  it("défaut SOBRE : professionnel, sans bandeau ni couleur de charte ; signé", () => {
    const m = rendre({ blocs: [{ type: "paragraphe", texte: "Bonjour Radia," }, { type: "paragraphe", texte: "La réunion de jeudi est décalée à **15 h**." }] });
    expect(m.html).toContain("<strong>15 h</strong>");
    expect(m.html).toContain("Amine Djemai");
    expect(m.html).not.toContain("#0B6E4F");
    expect(natureDuRendu(m.html, m.texte).rendu).toBe("HTML sobre (sans couleur de charte)");
  });

  it("TEXTE : aucun HTML — « un mail tout simple, juste du texte » est servi par le mail lui-même", () => {
    const m = rendre({ style: "texte", blocs: [{ type: "paragraphe", texte: "Bonjour Radia," }, { type: "tableau", ...planning }] });
    expect(m.html).toBeNull();
    expect(m.texte).toContain("• Ven. 6/11 — Tâche : Remise");
    expect(m.texte).toContain("--\nAmine Djemai");
    expect(natureDuRendu(m.html, m.texte).rendu).toBe("texte brut (aucune mise en page)");
  });

  it("CHARTE : bandeau, tableau aux couleurs, pied — l'ancien gabarit est devenu un style", () => {
    const m = rendre({ style: "charte", blocs: [{ type: "paragraphe", texte: "Bonjour," }, { type: "tableau", ...planning }] });
    const r = natureDuRendu(m.html, m.texte);
    expect(r.bandeau).toBe(true);
    expect(r.tableaux).toBe(1);
    expect(r.rendu).toMatch(/^HTML à la charte — bandeau #0B6E4F/);
    expect(m.html).toContain("SARL au capital");
  });

  it("MOITIÉ-MOITIÉ : le tableau seul aux couleurs, le reste simple (demande de la Direction)", () => {
    const m = rendre({ blocs: [{ type: "paragraphe", texte: "Bonjour,", style: "simple" }, { type: "tableau", ...planning, style: "charte" }, { type: "paragraphe", texte: "Merci.", style: "simple" }] });
    const r = natureDuRendu(m.html, m.texte);
    expect(r.bandeau).toBe(false);
    expect(r.tableaux).toBe(1);
    expect(r.couleurs).toEqual(["#0B6E4F"]);
    expect(r.rendu).toMatch(/^HTML mixte \(charte en partie\)/);
    expect(m.html).toMatch(/<p style="margin:0 0 14px 0">Bonjour,<\/p>/);
  });

  it("HTML LIBRE permis, mais ASSAINI : script, gestionnaires, url() et expression tombent ; le style inerte reste", () => {
    const m = rendre({ blocs: [{ type: "html", html: `<p style="color:#C2185B;font-size:22px;background:url(https://x.io/p.png)" onclick="x()">Joyeux anniversaire !</p><script>alert(1)</script><div style="width:expression(alert(1));color:red">ok</div><img src="javascript:alert(1)"><a href="javascript:alert(1)">lien</a><p style="background:url&#40;https://x.io&#41;">e</p>` }] });
    expect(m.html).toContain('<p style="color:#C2185B;font-size:22px">Joyeux anniversaire !</p>');
    expect(m.html).not.toMatch(/script|onclick|url\(|expression|javascript|&#40;/i);
    expect(m.html).toContain('<div style="color:red">ok</div>');
    expect(m.texte).toContain("Joyeux anniversaire !");
  });

  it("le texte d'un bloc est échappé : le modèle ne glisse pas de balise par un paragraphe", () => {
    const m = rendre({ blocs: [{ type: "paragraphe", texte: "<script>alert(1)</script> <b>x</b>" }] });
    expect(m.html).not.toContain("<script>");
    expect(m.html).not.toContain("<b>x</b>");
  });

  it("l'ancien contenu structuré se lit encore (entrée normalisée côté serveur) ; ce qui manque est nommé", () => {
    const d = lire({ salutation: "Bonjour Redouane,", paragraphes: ["Voici ton planning."], tableau: planning, cloture: "Bonne semaine," });
    expect(d.style).toBe("sobre");
    expect(d.blocs.map((b) => b.type)).toEqual(["paragraphe", "paragraphe", "tableau", "paragraphe", "signature"]);
    expect(lireDocumentMail({ blocs: [{ type: "signature" }] })).toEqual({ ok: false, manque: ["le corps du mail (au moins un paragraphe)"] });
    expect(lire({ blocs: [{ type: "paragraphe", texte: "x" }], signature: false }).blocs.some((b) => b.type === "signature")).toBe(false);
    expect(prenomDe("Redouane Benali")).toBe("Redouane");
  });

  it("le repli (`ADAM_MAIL_BLOCS=0`) : tout à la charte, styles de blocs effacés", () => {
    const d = toutALaCharte(lire({ blocs: [{ type: "paragraphe", texte: "x", style: "simple" }] }));
    expect(d.style).toBe("charte");
    expect(d.blocs[0]!.type).toBe("bandeau");
    expect(d.blocs.some((b) => "style" in b && b.style)).toBe(false);
  });
});
