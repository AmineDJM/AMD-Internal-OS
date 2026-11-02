import { describe, expect, it } from "vitest";
import { choisirSujet, natureCoffreDe, sujetEstLePorteur } from "./sujets";

describe("le titulaire d'une pièce est-il la personne de la fiche où elle est déposée ?", () => {
  it("oui pour une pièce d'identité, une paie, un CV ; non pour l'émetteur d'un devis", () => {
    expect(sujetEstLePorteur("PASSEPORT", "TITULAIRE")).toBe(true);
    expect(sujetEstLePorteur("BULLETIN_PAIE", "TITULAIRE")).toBe(true);
    expect(sujetEstLePorteur("DEVIS", "EMETTEUR")).toBe(false);
    expect(sujetEstLePorteur("CARTE_VISITE", "TITULAIRE")).toBe(false);
  });
});

describe("la nature au coffre d'un attribut sensible", () => {
  it("un IBAN se reconnaît à ses lettres, un RIB algérien à ses chiffres", () => {
    expect(natureCoffreDe("personne.rib", "DZ58 0002 0000")).toBe("IBAN");
    expect(natureCoffreDe("organisation.rib", "00799999000123456789")).toBe("RIB");
    expect(natureCoffreDe("personne.passeport.numero", "198765432")).toBe("PASSEPORT_NUMERO");
    expect(natureCoffreDe("personne.nom", "Benali")).toBeNull();
  });
});

describe("choisirSujet — le contexte du dépôt, sous le contrôle des identifiants", () => {
  const rattacher = (ficheId: string) => ({ resultat: "RATTACHER" as const, ficheId, identifiants: ["N° de passeport"], raison: "Même numéro." });
  it("un identifiant qui désigne la personne du contexte : rattaché", () => {
    expect(choisirSujet({ contexte: ["p1"], parIdentifiant: rattacher("p1") }).sujetId).toBe("p1");
  });
  it("un identifiant qui désigne une AUTRE personne que celle du dépôt : rien n'est rattaché", () => {
    const c = choisirSujet({ contexte: ["p1"], parIdentifiant: rattacher("p2") });
    expect(c.sujetId).toBeNull();
    expect(c).toMatchObject({ ambigu: true });
  });
  it("un homonyme qui n'est que la personne du contexte ne bloque pas ; un autre, si", () => {
    const ambigu = (ids: string[]) => ({ resultat: "AMBIGU" as const, candidats: ids.map((id) => ({ id, libelle: id, motif: "nom" })), raison: "Homonymes." });
    expect(choisirSujet({ contexte: ["p1"], parIdentifiant: ambigu(["p1"]) }).sujetId).toBe("p1");
    expect(choisirSujet({ contexte: ["p1"], parIdentifiant: ambigu(["p1", "p9"]) }).sujetId).toBeNull();
  });
  it("sans contexte ni identifiant décisif, ou avec plusieurs personnes en contexte : jamais deviné", () => {
    expect(choisirSujet({ contexte: [], parIdentifiant: null }).sujetId).toBeNull();
    expect(choisirSujet({ contexte: ["p1", "p2"], parIdentifiant: null }).sujetId).toBeNull();
    expect(choisirSujet({ contexte: ["p1", "p1"], parIdentifiant: { resultat: "NOUVELLE_FICHE", raison: "" } }).sujetId).toBe("p1");
  });
});
