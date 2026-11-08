import { describe, it, expect } from "vitest";
import {
  partiesText, resolveParties, matchesParty, withParty, partyLabel, partiesProches, partieDuNom, type PartyOption,
} from "./parties";

const p = (id: string, over: Partial<PartyOption> = {}): PartyOption => ({
  id, name: id.toUpperCase(), kind: null, contactName: null, email: null,
  phone: null, phoneAlt: null, city: null, companyLabel: null, ...over,
});

const ANNUAIRE: PartyOption[] = [
  p("imp", { name: "Imprimerie du Centre", kind: "Imprimeur", city: "Alger", phone: "021 45 67 89", email: "contact@idc.dz" }),
  p("tra", { name: "Transit Maghreb", kind: "Transitaire", city: "Oran" }),
  p("voy", { name: "Évasion Voyages", kind: "Agence de voyage", contactName: "Mme Belkacem" }),
];

describe("les parties, telles qu'elles s'affichent", () => {
  it("n'affiche que le nom — le reste est sous le clic", () => {
    expect(partyLabel(ANNUAIRE[0])).toBe("Imprimerie du Centre");
  });

  it("le texte enregistré suit l'ordre CHOISI, pas celui de l'annuaire", () => {
    expect(partiesText(ANNUAIRE, ["tra", "imp"])).toBe("Transit Maghreb, Imprimerie du Centre");
    expect(partiesText(ANNUAIRE, ["imp", "tra"])).toBe("Imprimerie du Centre, Transit Maghreb");
  });

  it("un identifiant inconnu est écarté plutôt qu'affiché en clair", () => {
    expect(partiesText(ANNUAIRE, ["imp", "disparu"])).toBe("Imprimerie du Centre");
    expect(resolveParties(ANNUAIRE, ["disparu"])).toEqual([]);
    expect(partiesText(ANNUAIRE, [])).toBe("");
  });
});

describe("la recherche — les trois entrées réelles", () => {
  it("trouve par le MÉTIER, parce que c'est ainsi qu'on cherche", () => {
    expect(ANNUAIRE.filter((o) => matchesParty(o, "imprimeur")).map((o) => o.id)).toEqual(["imp"]);
  });

  it("trouve par un fragment de NUMÉRO lu sur une facture", () => {
    expect(ANNUAIRE.filter((o) => matchesParty(o, "45 67")).map((o) => o.id)).toEqual(["imp"]);
  });

  it("ignore les accents et la casse — « evasion » trouve « Évasion »", () => {
    expect(ANNUAIRE.filter((o) => matchesParty(o, "evasion")).map((o) => o.id)).toEqual(["voy"]);
  });

  it("trouve par la personne qu'on demande, et par la ville", () => {
    expect(ANNUAIRE.filter((o) => matchesParty(o, "belkacem")).map((o) => o.id)).toEqual(["voy"]);
    expect(ANNUAIRE.filter((o) => matchesParty(o, "oran")).map((o) => o.id)).toEqual(["tra"]);
  });

  it("une recherche vide ne filtre rien", () => {
    expect(ANNUAIRE.filter((o) => matchesParty(o, "  ")).length).toBe(3);
  });
});

describe("la cardinalité — un expéditeur, mais plusieurs parties à un contrat", () => {
  it("« un seul » REMPLACE : choisir un second expéditeur n'en fait pas deux", () => {
    expect(withParty(["imp"], "tra", 1)).toEqual(["tra"]);
  });

  it("« plusieurs » AJOUTE, en gardant l'ordre", () => {
    expect(withParty(["imp"], "tra", "many")).toEqual(["imp", "tra"]);
  });

  it("rechoisir la même partie ne la double jamais", () => {
    expect(withParty(["imp"], "imp", "many")).toEqual(["imp"]);
    expect(withParty(["imp"], "imp", 1)).toEqual(["imp"]);
  });
});

describe("le bénéficiaire d'une demande de paiement, cherché dans l'annuaire (08/11/2026)", () => {
  const ATLAS: PartyOption[] = [
    p("idc", { name: "Imprimerie du Centre (Atlas)" }),
    p("agv", { name: "Agence Atlas Voyages" }),
    p("atl", { name: "Atlas" }),
    p("ats", { name: "Atlas Services" }),
    p("oran", { name: "Transit Ouest", city: "Atlas-Oran" }),
  ];

  it("le plus proche d'abord : le nom exact, le nom qui commence par la saisie, un mot du nom, puis le reste", () => {
    expect(partiesProches(ATLAS, "atlas").map((x) => x.id)).toEqual(["atl", "ats", "agv", "idc", "oran"]);
  });

  it("accents et casse ignorés ; moins de deux lettres ne proposent rien ; la liste est bornée", () => {
    expect(partiesProches(ANNUAIRE, "EVAS").map((x) => x.id)).toEqual(["voy"]);
    expect(partiesProches(ANNUAIRE, "i")).toEqual([]);
    expect(partiesProches(ATLAS, "atlas", 2)).toHaveLength(2);
  });

  it("un nom lu sur une pièce se reconnaît seulement s'il désigne UN contact", () => {
    expect(partieDuNom(ANNUAIRE, "  imprimerie DU centre ")?.id).toBe("imp");
    expect(partieDuNom(ANNUAIRE, "Imprimerie")).toBeNull();
    expect(partieDuNom([...ATLAS, p("bis", { name: "ATLAS" })], "Atlas")).toBeNull();
  });
});
