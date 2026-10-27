import { describe, expect, it } from "vitest";
import { decouper, differences, natureSensible, texteAdmissible } from "@/lib/agent/operations/documents-lus";
import { masquerSensible, restaurerSensible } from "@/lib/agent/filtre-confidentialite";

/** LES PORTES AVANT LE MODÈLE — identité et paie refusées, valeurs bancaires masquées ; et la comparaison. */
describe("documents — portes avant le modèle", () => {
  it("LIMITE : une page de passeport (zone MRZ) est une pièce d'identité — refusée", () => {
    const t = "PASSEPORT\nP<DZABENALI<<MOHAMED<AMINE<<<<<<<<<<<<<<<<<<<\n1234567897DZA8501014M3101012<<<<<<<<<<<<<<06";
    expect(natureSensible(t)).toBe("IDENTITE");
    expect(texteAdmissible(t)).toEqual({ ok: false, refus: expect.stringMatching(/ne part jamais au modèle/) });
  });

  it("LIMITE : un bulletin de paie est refusé en entier", () => {
    expect(natureSensible("BULLETIN DE PAIE — Octobre 2026\nSalaire de base 180 000\nNet à payer 150 000")).toBe("PAIE");
  });

  it("un programme qui demande d'apporter son passeport n'est PAS une pièce d'identité", () => {
    expect(natureSensible("Programme du congrès. Pensez à apporter votre passeport. Accueil à 9 h.")).toBeNull();
  });

  it("LIMITE : un RIB cité dans un contrat est masqué, le reste passe", () => {
    const r = texteAdmissible("Le prestataire sera payé sur le RIB 00799999000123456789 sous 30 jours.");
    expect(r.ok && r.texte).not.toMatch(/00799999000123456789/);
    expect(r.ok && r.texte).toMatch(/sous 30 jours/);
  });

  it("masque réversible : la valeur ne part pas, et revient à sa place", () => {
    const m = masquerSensible("Virement : IBAN DZ5800400174401234567890, merci.");
    expect(m.texte).not.toMatch(/DZ58/);
    expect(m.texte).toMatch(/⟦S1⟧/);
    expect(restaurerSensible(m.texte.replace("Virement", "Transfer").replace("merci", "thanks"), m.valeurs)).toBe("Transfer : IBAN DZ5800400174401234567890, thanks.");
  });

  it("un long texte se découpe en parties, sans perte", () => {
    const t = Array.from({ length: 400 }, (_, i) => `Paragraphe ${i} ${"x".repeat(150)}`).join("\n\n");
    const p = decouper(t, 10_000);
    expect(p.length).toBeGreaterThan(5);
    expect(p.join("")).toBe(t);
  });

  it("comparer deux versions : modifiées, ajoutées, retirées", () => {
    const d = differences("Article 1 : durée 12 mois\nArticle 2 : prix 100 000 DZD\nArticle 3 : résiliation", "Article 1 : durée 12 mois\nArticle 2 : prix 120 000 DZD\nArticle 3 : résiliation\nArticle 4 : confidentialité");
    expect(d.modifiees).toEqual([{ avant: "Article 2 : prix 100 000 DZD", apres: "Article 2 : prix 120 000 DZD" }]);
    expect(d.ajoutees).toEqual(["Article 4 : confidentialité"]);
    expect(d.retirees).toEqual([]);
    expect(d.identiques).toBe(2);
  });
});
