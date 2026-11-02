import { describe, expect, it } from "vitest";
import { CARACTERES_PAR_JETON, decouper, JETONS_CIBLE, normaliserTexte } from "./decoupage";

const phrase = (i: number) => `Article ${i}. La durée de conservation du lot ${i} est fixée à vingt-quatre mois après fabrication.`;

describe("Le découpage en passages", () => {
  it("un texte court donne un seul passage, entier", () => {
    const p = decouper("Contrat de travail — Amina Benali, déléguée médicale.");
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ rang: 0, debut: 0 });
    expect(p[0].texte).toContain("déléguée médicale");
  });

  it("un texte long se découpe en passages d'environ 800 jetons, qui se chevauchent", () => {
    const texte = Array.from({ length: 400 }, (_, i) => phrase(i)).join(" ");
    const p = decouper(texte);
    expect(p.length).toBeGreaterThan(3);
    for (const x of p.slice(0, -1)) {
      expect(x.jetons).toBeLessThanOrEqual(JETONS_CIBLE + 1);
      expect(x.jetons).toBeGreaterThan(JETONS_CIBLE * 0.5);
    }
    // Chevauchement : chaque passage commence AVANT la fin du précédent.
    for (let i = 1; i < p.length; i++) expect(p[i].debut).toBeLessThan(p[i - 1].debut + p[i - 1].texte.length);
    // Les rangs se suivent, et tout le texte est couvert.
    expect(p.map((x) => x.rang)).toEqual(p.map((_, i) => i));
    expect(p.at(-1)!.texte.endsWith("fabrication.")).toBe(true);
  });

  it("coupe de préférence sur une fin de phrase, jamais au milieu d'un mot quand c'est évitable", () => {
    const texte = Array.from({ length: 200 }, (_, i) => phrase(i)).join(" ");
    for (const x of decouper(texte).slice(0, -1)) expect(x.texte).toMatch(/[.!?…]$/);
  });

  it("est déterministe (l'idempotence de l'ingestion en dépend)", () => {
    const texte = Array.from({ length: 300 }, (_, i) => phrase(i)).join("\n\n");
    expect(decouper(texte)).toEqual(decouper(texte));
  });

  it("normalise les blancs sans perdre les paragraphes ; un texte vide ne donne rien", () => {
    expect(normaliserTexte("a\r\n\r\n\r\n\r\nb  \t c\u0000")).toBe("a\n\nb c");
    expect(decouper("   \n\n ")).toEqual([]);
  });

  it("borne le chevauchement à la moitié du passage (pas de boucle infinie)", () => {
    const texte = "x".repeat(CARACTERES_PAR_JETON * 5_000);
    const p = decouper(texte, { jetonsCible: 100, jetonsChevauchement: 10_000 });
    expect(p.length).toBeGreaterThan(50);
    expect(p.length).toBeLessThan(200);
  });
});
