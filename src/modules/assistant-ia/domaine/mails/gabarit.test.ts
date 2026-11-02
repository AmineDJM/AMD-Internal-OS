import { describe, expect, it } from "vitest";
import { lireContenuMail, type ContenuMail, prenomDe, rendreMailHtml, rendreMailTexte, type CharteMail, type SignatureMail } from "./gabarit";

/**
 * P1 (décision 0047) — « de BEAUX mails » : le contenu structuré du modèle, mis en page par le gabarit (jamais du HTML
 * libre), aux couleurs de la société, signé, avec sa version texte.
 */
const contenu = (b: unknown): ContenuMail => { const r = lireContenuMail(b); if (!r.ok) throw new Error(r.manque.join()); return r.contenu; };
const charte: CharteMail = { societe: "AMD Life Sciences", accent: "0B6E4F", texteSurAccent: "FFFFFF", police: "Calibri", coordonnees: ["Staoueli, Alger", "023 00 00 00 · contact@amd.dz"], mentions: ["SARL au capital de 10 000 000 DZD"] };
const signature: SignatureMail = { nom: "Amine Djemai", fonction: "Directeur général", societe: "AMD Life Sciences", telephone: "0550 00 00 00", email: "amine@amd.dz" };
const planning = {
  salutation: "Bonjour Redouane,",
  paragraphes: ["Voici ton planning de la semaine sur le chantier de Staoueli.", "La remise du dossier est fixée au **vendredi 6 novembre**."],
  tableau: { colonnes: ["Date", "Tâche", "Échéance"], lignes: [["Lun. 2/11", "Relevé des besoins", "18 h"], ["Mer. 4/11", "Devis fournisseurs", "**midi**"], ["Ven. 6/11", "Remise du dossier", "**10 h**"]] },
  apres: ["Dis-moi si un créneau ne te convient pas."],
  cloture: "Bonne semaine,",
};

describe("P1 — le gabarit des mails", () => {
  it("lit le contenu structuré, borné ; ce qui manque est nommé ; le HTML du modèle n'a pas cours", () => {
    const lu = lireContenuMail(planning);
    expect(lu.ok).toBe(true);
    expect(lireContenuMail({ salutation: "Bonjour" })).toEqual({ ok: false, manque: ["le corps du mail (au moins un paragraphe)"] });
    const html = rendreMailHtml(contenu({ salutation: "Bonjour,", paragraphes: ["<script>alert(1)</script> <b>x</b>"], cloture: "A+" }), signature, charte, "Test");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<b>x</b>");
  });

  it("rend un mail responsive, aux couleurs de la société, avec un TABLEAU propre, les échéances en gras, la signature et le pied", () => {
    const c = contenu(planning);
    const html = rendreMailHtml(c, signature, charte, "Ton planning — semaine du 2 novembre");
    expect(html).toContain('name="viewport"');
    expect(html).toContain("max-width:600px");
    expect(html).toContain("#0B6E4F");
    expect(html).toContain("AMD Life Sciences");
    expect(html).toMatch(/<th[^>]*>Date<\/th>/);
    expect(html).toContain("<strong>vendredi 6 novembre</strong>");
    expect(html).toContain("Bonjour Redouane,");
    expect(html).toContain("Amine Djemai");
    expect(html).toContain("Directeur général");
    expect(html).toContain("SARL au capital");
  });

  it("la version texte (multipart) dit la même chose, sans balisage", () => {
    const c = contenu(planning);
    const t = rendreMailTexte(c, signature, charte);
    expect(t).toContain("Bonjour Redouane,");
    expect(t).not.toContain(" | ");
    expect(t).toContain("• Ven. 6/11 — Tâche : Remise du dossier — Échéance : 10 h");
    expect(t).not.toContain("**");
    expect(t).toContain("-- \nAmine Djemai".replace("-- \n", "--\n"));
    expect(prenomDe("Redouane Benali")).toBe("Redouane");
  });
});
