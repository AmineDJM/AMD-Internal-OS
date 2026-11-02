import { describe, expect, it } from "vitest";
import {
  GENRE_FOURNISSEUR, decisionFournisseurAuto, identiteLocaleDuDevis, noteFicheAutomatique, phraseFournisseurAuto,
} from "./fournisseur";
import { IDENTITE_VIDE, type IdentiteEmetteur } from "./emetteur";

/**
 * LE FOURNISSEUR D'UN DEVIS DÉPOSÉ ENTRE DANS L'ANNUAIRE (Direction, 02/11/2026) — la règle, sans base.
 * Même NIF ou même RC = la même société ; le nom seul rattache sans créer ; rien sans nom imprimé.
 */
const GROUPE = {
  nifs: ["001616098765432"], rcs: ["16/00-1234567 B 16"],
  societes: [{ id: "adv", noms: ["Adventum Pharma", "Adventum"], nifs: ["001616098765432"], rcs: ["16/00-1234567 B 16"] }],
};
const ANNUAIRE = [
  { id: "c-insigne", nom: "INSIGNE SARL", nif: "001216098700412", rc: null },
  { id: "c-print", nom: "Print Plus", nif: null, rc: "16/00-5555555 B 10" },
  { id: "c-adv", nom: "Adventum Pharma", nif: "001616098765432", rc: null },
  { id: "c-h1", nom: "Hôtel El Djazair", nif: null, rc: null },
  { id: "c-h2", nom: "Hotel El-Djazair", nif: null, rc: null },
];
const lu = (x: Partial<IdentiteEmetteur>): IdentiteEmetteur => ({ ...IDENTITE_VIDE, ...x });

describe("le fournisseur d'un devis déposé, reconnu ou ajouté à l'annuaire", () => {
  it("même NIF : la fiche existante est rattachée, quel que soit le nom imprimé — aucune création", () => {
    expect(decisionFournisseurAuto(lu({ nom: "Insigne Communication", nif: "001 216 098 700 412" }), ANNUAIRE, GROUPE))
      .toEqual({ geste: "RATTACHER", contactId: "c-insigne", nom: "INSIGNE SARL", certitude: "CERTAIN" });
  });

  it("même RC : la fiche existante est rattachée", () => {
    expect(decisionFournisseurAuto(lu({ nom: "PRINT+", rc: "16/00-5555555B10" }), ANNUAIRE, GROUPE))
      .toMatchObject({ geste: "RATTACHER", contactId: "c-print", certitude: "CERTAIN" });
  });

  it("le nom seul : rattaché, PROBABLE — jamais un quasi-doublon créé à côté", () => {
    expect(decisionFournisseurAuto(lu({ nom: "Print Plus SARL" }), ANNUAIRE, GROUPE))
      .toEqual({ geste: "RATTACHER", contactId: "c-print", nom: "Print Plus", certitude: "PROBABLE" });
  });

  it("deux fiches à égalité : on ne choisit pas, on ne crée pas", () => {
    const d = decisionFournisseurAuto(lu({ nom: "Hôtel El Djazair" }), ANNUAIRE, GROUPE);
    expect(d).toEqual({ geste: "RIEN", raison: "AMBIGU", noms: ["Hôtel El Djazair", "Hotel El-Djazair"] });
  });

  it("inconnu avec un nom : une fiche « Fournisseur » est créée avec ce que le papier imprime", () => {
    const d = decisionFournisseurAuto(lu({
      nom: "  Atlas   Événementiel ", nif: "000 216 012 345 678", rc: "16/00-7777777 B 19", adresse: "3, rue Ben M'hidi, Alger",
      telephone: "023 45 67 89", email: "contact@atlas.dz", rib: "00799999000123456789",
    }), ANNUAIRE, GROUPE);
    expect(d).toEqual({
      geste: "CREER",
      fiche: {
        name: "Atlas Événementiel", nif: "000 216 012 345 678", rc: "16/00-7777777 B 19", address: "3, rue Ben M'hidi, Alger",
        phone: "023 45 67 89", email: "contact@atlas.dz", rib: "00799999000123456789",
      },
    });
    expect(GENRE_FOURNISSEUR).toBe("Fournisseur");
  });

  it("le NIF et le RC du GROUPE (le client du devis) ne s'écrivent jamais sur la fiche du fournisseur", () => {
    const d = decisionFournisseurAuto(lu({ nom: "Atlas Événementiel", nif: "001616098765432", rc: "16/00-1234567 B 16" }), ANNUAIRE, GROUPE);
    expect(d).toMatchObject({ geste: "CREER", fiche: { name: "Atlas Événementiel", nif: null, rc: null } });
  });

  it("un nom du groupe n'est jamais un fournisseur à créer, et la fiche du groupe n'est jamais rattachée", () => {
    expect(decisionFournisseurAuto(lu({ nom: "ADVENTUM PHARMA SPA" }), ANNUAIRE, GROUPE)).toEqual({ geste: "RIEN", raison: "SANS_NOM" });
  });

  it("sans nom imprimé : rien n'est créé — un NIF inconnu seul ne fait pas une fiche", () => {
    expect(decisionFournisseurAuto(lu({ nif: "000216012345678" }), ANNUAIRE, GROUPE)).toEqual({ geste: "RIEN", raison: "SANS_NOM" });
    expect(decisionFournisseurAuto(lu({ nom: "x".repeat(200) }), ANNUAIRE, GROUPE)).toEqual({ geste: "RIEN", raison: "SANS_NOM" });
  });

  it("un nom tiré du seul nom du fichier reconnaît une fiche, mais n'en crée pas", () => {
    expect(decisionFournisseurAuto(lu({ nom: "Print Plus" }), ANNUAIRE, GROUPE, { nomDuFichierSeul: true }))
      .toMatchObject({ geste: "RATTACHER", contactId: "c-print" });
    expect(decisionFournisseurAuto(lu({ nom: "Atlas" }), ANNUAIRE, GROUPE, { nomDuFichierSeul: true }))
      .toEqual({ geste: "RIEN", raison: "SANS_NOM" });
  });

  it("les phrases du dépôt", () => {
    expect(phraseFournisseurAuto({ statut: "CREE", contactId: "x", nom: "Atlas" })).toBe("Nouveau fournisseur ajouté à l'annuaire : « Atlas ».");
    expect(phraseFournisseurAuto({ statut: "RECONNU", contactId: "x", nom: "Atlas" })).toBe("Fournisseur reconnu dans l'annuaire : « Atlas ».");
    expect(phraseFournisseurAuto({ statut: "PROBABLE", contactId: "x", nom: "Atlas" })).toMatch(/par son nom seul .* vérifiez/);
    expect(phraseFournisseurAuto({ statut: "AMBIGU", noms: ["A", "B"] })).toMatch(/« A », « B ».*aucune n'a été choisie ni créée/);
    expect(phraseFournisseurAuto({ statut: "SANS_NOM" })).toMatch(/ne se lit pas.*pas été ajouté/);
  });

  it("la note de la fiche dit le devis, la date et le déposant", () => {
    expect(noteFicheAutomatique({ titreDevis: "Devis stand Atlas", deposant: "Samia B.", le: new Date("2026-11-02T10:00:00Z") }))
      .toBe("Ajouté automatiquement à l'annuaire depuis le devis « Devis stand Atlas », déposé le 02/11/2026 par Samia B. — à compléter (contact, wilaya) au besoin.");
  });

  it("l'identité locale d'un devis : l'émetteur, jamais le bloc client", () => {
    const texte = `INSIGNE
Agence de communication
Tél : 021 23 45 67
DEVIS N° DV-2026/318
Client :
ADVENTUM PHARMA
NIF : 001616098765432
RC : 16/00-1234567 B 16
Désignation
INSIGNE — RC 16/00-0987654 B 12 — NIF 001216098700412 — NIS 001216010203040`;
    const { identite, nomDuFichierSeul } = identiteLocaleDuDevis(texte, "devis.pdf", GROUPE);
    expect(identite).toMatchObject({ nom: "INSIGNE", nif: "001216098700412", rc: "16/00-0987654 B 12" });
    expect(nomDuFichierSeul).toBe(false);
  });
});
