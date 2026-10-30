import { describe, expect, it } from "vitest";
import { distance, identifiantDe, indexer, resoudreDans, sigle, type CandidatEntite } from "./resolution";

const C: CandidatEntite[] = [
  { ref: "PERSONNE:1", type: "PERSONNE", libelle: "Ahmed Benali" },
  { ref: "PERSONNE:2", type: "PERSONNE", libelle: "Mohamed Benali" },
  { ref: "PERSONNE:3", type: "PERSONNE", libelle: "Karima Cherif" },
  { ref: "ORGANISATION:1", type: "ORGANISATION", libelle: "Groupe Saidal SPA", identifiants: ["000116001234567"] },
  { ref: "ORGANISATION:2", type: "ORGANISATION", libelle: "Entreprise Nationale des Produits Pharmaceutiques" },
  { ref: "ORGANISATION:3", type: "ORGANISATION", libelle: "Hikma Pharma Algérie", alias: ["Hikma"] },
];
const idx = indexer(C);

describe("résolution d'entités — pure", () => {
  it("identifiant, exact, ordre, arabe, sigle, faute", () => {
    expect(resoudreDans(idx, "NIF 0001 1600 1234 567").retenu?.candidat.ref).toBe("ORGANISATION:1");
    expect(resoudreDans(idx, "BENALI Ahmed").retenu?.candidat.ref).toBe("PERSONNE:1");
    expect(resoudreDans(idx, "محمد بن علي").retenu?.candidat.ref).toBe("PERSONNE:2");
    expect(resoudreDans(idx, "مجمع صيدال").retenu?.candidat.ref).toBe("ORGANISATION:1");
    expect(resoudreDans(idx, "ENPP").retenu?.candidat.ref).toBe("ORGANISATION:2");
    expect(resoudreDans(idx, "Karima Cherf").retenu?.candidat.ref).toBe("PERSONNE:3");
    expect(resoudreDans(idx, "Sadial").retenu?.candidat.ref).toBe("ORGANISATION:1");
  });

  it("un nom partagé est une question, jamais un choix", () => {
    const r = resoudreDans(idx, "Benali");
    expect(r.verdict).toBe("AMBIGU");
    expect(r.candidats.map((c) => c.candidat.ref).sort()).toEqual(["PERSONNE:1", "PERSONNE:2"]);
  });

  it("une mention inconnue reste inconnue ; le filtre écarte avant de noter", () => {
    expect(resoudreDans(idx, "Zoubir Tlemcani").verdict).toBe("INCONNU");
    expect(resoudreDans(idx, "Hikma", { filtre: (c) => c.type !== "ORGANISATION" }).verdict).toBe("INCONNU");
  });

  it("aides", () => {
    expect(sigle("Entreprise Nationale des Produits Pharmaceutiques")).toBe("enpp");
    expect(identifiantDe("RC 16/00-1234567 B 21")).toBe("16001234567B21");
    expect(distance("saidal", "sadial")).toBe(1);
  });
});
