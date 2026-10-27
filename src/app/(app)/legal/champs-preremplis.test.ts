import { describe, expect, it } from "vitest";
import { legalFields } from "./legal-fields";
import { champsPreremplis, marquesAffichees } from "./champs-preremplis";
import type { FieldDef } from "@/components/shared/create-record-button";
import type { PrerempliDocumentLegal } from "@/lib/pieces-lues/prerempli-document-legal";

const BASE = legalFields({}, "create", [{ value: "u1", label: "Amel" }], [], [{ value: "bc-old", label: "BC ancien" }], false, { options: [], canCreate: true });

const prerempli = (sur: Partial<PrerempliDocumentLegal> = {}): PrerempliDocumentLegal => ({
  valeurs: { title: "Facture El Nour", reference: "F-2026/0318", kind: "INVOICE", amount: "357000" },
  marques: {
    title: { source: "LUNA", preuve: "Rédigé par Luna", ou: null },
    amount: { source: "REGLES", preuve: "Total TTC : 357 000,00", ou: "ligne 11" },
  },
  partie: { statut: "AUCUN", retenue: null, candidats: [], phrase: "Partie absente", aCreer: { nom: "El Nour", nif: "000916012345678", rc: null, adresse: null } },
  sensExige: false,
  montantConflit: null,
  bcSuivi: null,
  ...sur,
});

const champ = (fs: FieldDef[], name: string) => fs.find((f) => f.type !== "hidden" && f.name === name) as Extract<FieldDef, { name: string }> & Record<string, unknown>;

describe("champsPreremplis — le formulaire Legal rempli depuis sa pièce", () => {
  it("les valeurs lues deviennent les valeurs par défaut ; le reste ne bouge pas", () => {
    const fs = champsPreremplis(BASE, prerempli(), {}, false);
    expect(champ(fs, "title").defaultValue).toBe("Facture El Nour");
    expect(champ(fs, "amount").defaultValue).toBe("357000");
    expect(champ(fs, "notes").defaultValue).toBeUndefined();
    expect(fs.map((f) => f.type)).toEqual(BASE.map((f) => f.type));
  });

  it("ce que la personne a touché l'emporte sur une nouvelle lecture, et perd sa marque", () => {
    const gardes = { title: "Mon titre", counterpartyIds: ["c1"], readerId: ["u1"] };
    const fs = champsPreremplis(BASE, prerempli(), gardes, false);
    expect(champ(fs, "title").defaultValue).toBe("Mon titre");
    expect(champ(fs, "counterpartyIds").defaultValue).toEqual(["c1"]);
    expect(champ(fs, "counterpartyIds").propose).toBeUndefined();
    expect(champ(fs, "readerId").defaultValue).toEqual(["u1"]);
    expect(Object.keys(marquesAffichees(prerempli(), gardes))).toEqual(["amount"]);
  });

  it("une partie inconnue n'est pas choisie : le sélecteur propose de la créer avec ce qui a été lu", () => {
    const parties = champ(champsPreremplis(BASE, prerempli(), {}, false), "counterpartyIds");
    expect(parties.defaultValue).toEqual([]);
    expect(parties.propose).toMatchObject({ contact: { nom: "El Nour", nif: "000916012345678" } });
  });

  it("une partie CERTAINE est choisie, sans rien proposer d'autre", () => {
    const p = prerempli({ partie: { statut: "CERTAIN", retenue: "c-nour", candidats: [{ id: "c-nour", nom: "El Nour" }], phrase: "", aCreer: null } });
    const parties = champ(champsPreremplis(BASE, p, {}, false), "counterpartyIds");
    expect(parties.defaultValue).toEqual(["c-nour"]);
    expect(parties.propose).toBeUndefined();
  });

  it("un sens non prouvé : aucun défaut, et le serveur est prévenu qu'il doit être choisi", () => {
    const fs = champsPreremplis(BASE, prerempli({ sensExige: true }), {}, false);
    expect(champ(fs, "direction").defaultValue).toBe("");
    expect(fs).toContainEqual({ type: "hidden", name: "sensExige", value: "1" });
    // Choisi avant une relecture, il reste choisi — et le serveur n'a plus rien à exiger.
    const choisi = champsPreremplis(BASE, prerempli({ sensExige: true }), { direction: "IN" }, false);
    expect(champ(choisi, "direction").defaultValue).toBe("IN");
    expect(choisi.some((f) => f.type === "hidden" && f.name === "sensExige")).toBe(false);
  });

  it("le BC cité par la facture rejoint le menu « Fait suite à », et y est choisi", () => {
    const p = prerempli({ bcSuivi: { value: "bc112", label: "BC-2026-0112" }, valeurs: { chainFromId: "bc112" } });
    const chaine = champ(champsPreremplis(BASE, p, {}, false), "chainFromId") as unknown as { options: { value: string }[]; defaultValue: string };
    expect(chaine.options.map((o) => o.value)).toEqual(["bc112", "bc-old"]);
    expect(chaine.defaultValue).toBe("bc112");
  });

  it("sans pièce amont au menu, le BC cité crée le menu lui-même", () => {
    const sansChaine = legalFields({}, "create", [], [], [], false, { options: [], canCreate: false });
    const fs = champsPreremplis(sansChaine, prerempli({ bcSuivi: { value: "bc112", label: "BC-2026-0112" } }), {}, false);
    expect(champ(fs, "chainFromId")).toMatchObject({ type: "select", defaultValue: "bc112" });
  });

  it("une pièce confidentielle exige ses lecteurs", () => {
    expect(champ(champsPreremplis(BASE, null, {}, true), "readerId").required).toBe(true);
    expect(champ(champsPreremplis(BASE, null, {}, false), "readerId").required).toBeFalsy();
  });
});

describe("champsPreremplis — ce que la lecture de la vraie pièce a appris (essai en local, 27/10)", () => {
  it("une pièce lue comme facture prend les libellés d'une facture", () => {
    const fs = champsPreremplis(BASE, prerempli(), {}, false);
    expect(champ(fs, "startDate").label).toBe("Date d’émission");
    expect(champ(fs, "reference").label).toBe("N° de facture");
    // Changée par la personne, la nature décide des libellés.
    expect(champ(champsPreremplis(BASE, prerempli(), { kind: "CONTRACT" }, false), "startDate").label).toBe("Date de début (facultative)");
  });

  it("un NIF lu sans nom suffit à proposer la création du contact", () => {
    const p = prerempli({ partie: { statut: "AUCUN", retenue: null, candidats: [], phrase: "Partie absente", aCreer: { nom: null, nif: "000916012345678", rc: null, adresse: null } } });
    expect(champ(champsPreremplis(BASE, p, {}, false), "counterpartyIds").propose).toMatchObject({ contact: { nif: "000916012345678" } });
  });
});
