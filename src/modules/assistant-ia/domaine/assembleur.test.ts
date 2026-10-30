import { describe, expect, it } from "vitest";
import { assembler, ENVELOPPES, estimerJetons, historiqueDansEnveloppe, souvenirsPourQuestion } from "./assembleur";
import { classer, ordonnerActifs, plier, racine, SOCLE_OUTILS } from "./selection-outils";

/** L'ASSEMBLEUR (J4) : l'enveloppe est TOUJOURS respectée, quelle que soit la taille de ce qu'on lui donne. */
describe("assembleur de contexte (J4)", () => {
  it("respecte l'enveloppe sur 200 tirages, obligatoires d'abord, morceaux jamais coupés", () => {
    let graine = 7;
    const hasard = () => { graine = (graine * 48271) % 2147483647; return graine / 2147483647; };
    for (let n = 0; n < 200; n++) {
      const morceaux = Array.from({ length: 1 + Math.floor(hasard() * 30) }, (_, i) => ({
        cle: `k${i}`, texte: "x".repeat(Math.floor(hasard() * 2_000)), priorite: Math.floor(hasard() * 5), obligatoire: hasard() < 0.1,
      }));
      const enveloppe = 200 + Math.floor(hasard() * 3_000);
      const a = assembler(morceaux, enveloppe);
      expect(a.jetons).toBeLessThanOrEqual(enveloppe);
      expect(a.gardes.reduce((s, m) => s + estimerJetons(m.texte), 0)).toBe(a.jetons);
      expect(a.gardes.length + a.ecartes.length).toBe(morceaux.length);
      for (const m of a.gardes) expect(morceaux).toContain(m);
    }
  });

  it("garde un obligatoire avant un prioritaire, et l'ordre d'entrée dans le texte", () => {
    const a = assembler([
      { cle: "a", texte: "a".repeat(400), priorite: 9 },
      { cle: "b", texte: "b".repeat(400), priorite: 0, obligatoire: true },
    ], 120);
    expect(a.gardes.map((m) => m.cle)).toEqual(["b"]);
    expect(a.ecartes).toEqual(["a"]);
  });

  it("les souvenirs pertinents pour la question passent devant les récents, dans leur enveloppe", () => {
    const souvenirs = ["Je préfère les réponses courtes.", ...Array.from({ length: 60 }, (_, i) => `Souvenir ancien numéro ${i} sur un sujet sans rapport, assez long pour peser dans l'enveloppe.`), "Ma société est Pharmagène, je gère le portefeuille hépatologie."];
    const gardes = souvenirsPourQuestion(souvenirs, "Quels produits d'hépatologie a ma société ?");
    expect(gardes[0]).toBe(souvenirs[0]);
    expect(gardes).toContain("Ma société est Pharmagène, je gère le portefeuille hépatologie.");
    expect(gardes.reduce((s, t) => s + estimerJetons(t), 0)).toBeLessThanOrEqual(ENVELOPPES.memoire);
  });

  it("l'historique garde les échanges récents, jamais une réponse orpheline en tête", () => {
    const tours = Array.from({ length: 40 }, (_, i) => ({ role: (i % 2 ? "assistant" : "user") as "user" | "assistant", content: `${i} `.repeat(150) }));
    const h = historiqueDansEnveloppe(tours, 1_000);
    expect(h.reduce((s, t) => s + estimerJetons(t.content), 0)).toBeLessThanOrEqual(1_000);
    expect(h[0].role).toBe("user");
    expect(h[h.length - 1]).toBe(tours[tours.length - 1]);
    expect(historiqueDansEnveloppe(tours.slice(0, 2), 10_000)).toEqual(tours.slice(0, 2));
  });
});

describe("sélection d'outils, règle pure (J4)", () => {
  it("plie accents et pluriels", () => {
    expect(plier("Règlement Intérieur !")).toBe("reglement interieur");
    expect(racine("salaires")).toBe(racine("salaire"));
  });

  it("classe par les mots de la personne, et rend vide sans mot utile", () => {
    const fiches = [
      { nom: "lire_paie", libelle: "Paie consultée", description: "Lit la paie." },
      { nom: "read_calendar", libelle: "Agenda consulté", description: "Lit le calendrier." },
    ];
    expect(classer("combien gagne Walid ?", fiches)[0].nom).toBe("lire_paie");
    expect(classer("le la les", fiches)).toEqual([]);
  });

  it("ordonne les actifs : socle d'abord, dans son ordre ; jamais un nom indisponible", () => {
    const dispo = new Set([...SOCLE_OUTILS, "zeta", "alpha"]);
    expect(ordonnerActifs(["zeta", "directory_lookup", "inconnu", "alpha", SOCLE_OUTILS[0]], dispo)).toEqual([SOCLE_OUTILS[0], "directory_lookup", "alpha", "zeta"]);
  });
});
