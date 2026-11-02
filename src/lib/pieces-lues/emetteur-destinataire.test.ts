import { describe, expect, it } from "vitest";
import { emetteurEtDestinataire, estDuGroupe, nomDuFichier, zoneDuClient } from "./emetteur-destinataire";
import { identiteEmetteurDuTexte } from "./emetteur";

/**
 * L'ÉMETTEUR EST LE FOURNISSEUR, LE CLIENT EST LA SOCIÉTÉ DU GROUPE (lot B1, décision 0049) — le défaut du
 * 02/11 : « Fournisseur : ADVENTUM PHARMA » sur le BC d'un devis INSIGNE.
 */
const GROUPE = [
  { id: "adv", noms: ["Adventum Pharma", "Adventum"], nifs: ["001616098765432"], rcs: ["16/00-1234567 B 16"] },
  { id: "phg", noms: ["Pharmagène"], nifs: [], rcs: [] },
];

const INSIGNE = `INSIGNE
INSIGNE
Agence de communication — Conception & impression
14, rue Didouche Mourad, Alger-Centre
DEVIS N° DV-2026/318
Client :
ADVENTUM PHARMA
Lot 12, Zone d'activité, Chéraga — Alger
NIF : 001616098765432
RC : 16/00-1234567 B 16
Objet : Matériel promotionnel — lancement ADV
N°
Désignation
INSIGNE — RC 16/00-0987654 B 12 — NIF 001216098700412 — NIS 001216010203040 — AI 16015432101`;

describe("émetteur et destinataire", () => {
  it("le bloc CLIENT n'est jamais lu comme l'émetteur — ni son NIF, ni son RC (la cause du 02/11)", () => {
    const lignes = INSIGNE.split("\n");
    const z = zoneDuClient(lignes);
    expect([...z].map((i) => lignes[i])).toEqual(["Client :", "ADVENTUM PHARMA", "Lot 12, Zone d'activité, Chéraga — Alger", "NIF : 001616098765432", "RC : 16/00-1234567 B 16"]);
    // L'ancienne lecture des étiquettes prenait le NIF et le RC du client : elle saute désormais le bloc.
    const id = identiteEmetteurDuTexte(INSIGNE);
    expect(id.nif).not.toBe("001616098765432");
    expect(id.rc).not.toBe("16/00-1234567 B 16");
  });

  it("INSIGNE émet, ADVENTUM reçoit — même quand le modèle dit l'inverse", () => {
    const r = emetteurEtDestinataire({ texte: INSIGNE, nomFichier: "Devis matériel promotionnel INSIGNE.pdf", groupe: GROUPE, nomModele: "ADVENTUM PHARMA" });
    expect(r.emetteur).toMatchObject({ nom: "INSIGNE", nif: "001216098700412", rc: "16/00-0987654 B 12", nis: "001216010203040", ai: "16015432101" });
    expect(r.destinataire).toEqual({ societeId: "adv", par: "NOM" });
  });

  it("une société du groupe n'est jamais retenue comme émetteur, sous aucun de ses noms", () => {
    expect(estDuGroupe("ADVENTUM PHARMA SPA", GROUPE)?.id).toBe("adv");
    expect(estDuGroupe("Pharmagène", GROUPE)?.id).toBe("phg");
    expect(estDuGroupe("INSIGNE", GROUPE)).toBeNull();
    const r = emetteurEtDestinataire({ texte: "Client : Adventum Pharma\nDésignation", nomFichier: "devis.pdf", groupe: GROUPE, nomModele: "Adventum" });
    expect(r.emetteur.nom).toBeNull();
  });

  it("le nom du fichier porte le nom de l'émetteur quand le papier ne le dit pas", () => {
    expect(nomDuFichier("Devis matériel promotionnel INSIGNE.pdf")).toBe("INSIGNE");
    expect(nomDuFichier("Proforma GOODIES DZ 2026-77.pdf")).toBe("GOODIES DZ");
    expect(nomDuFichier("devis_imp-0457.pdf")).toBeNull();
  });
});
