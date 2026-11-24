import { describe, expect, it } from "vitest";
import {
  lireNombre, lirePostesDuModele, LIGNE_VIDE, ligneDepuisPoste, montantDansLeTexte, natureLaPlusProche, nomDuCahier, NATURES_DU_FICHIER,
  phraseDeLaProposition, POSTES_MAX, posteDepuisLaSaisie, versFormulaireDuPoste, type PosteDuFichier,
} from "./postes-fichier";
import { ITEM_KIND_LABELS } from "./postes";

/**
 * LES POSTES LUS DANS UN FICHIER — la part pure (recette 24/11/2026) : la nature ramenée à une nature connue,
 * le montant gardé seulement s'il se lit dans le document, les lignes vides écartées, et le formulaire
 * d'ajout ordinaire composé à l'identique.
 */

const CAHIER = `CAHIER DES CHARGES — Congrès national de cardiologie, Oran, 11-13 décembre 2026
1. Stand de 12 m² dans le hall B, comptoir et deux tabourets. Budget : 1 250 000,00 DA HT.
2. Impression de 4 kakémonos 85 × 200 cm et 500 flyers A5.
3. Pause-café pour 150 personnes le 12 décembre (prix unitaire 900 DA).
Pack Gold de la Société Algérienne de Cardiologie : 2,5 millions DA.`;

describe("la nature la plus proche", () => {
  it("garde un code proposable, ramène les autres", () => {
    expect(natureLaPlusProche("STAND")).toBe("STAND");
    expect(natureLaPlusProche(" printing ")).toBe("PRINTING");
    expect(natureLaPlusProche("STOCK_MATERIAL")).toBe("PROMO_MATERIAL");
    expect(natureLaPlusProche("INDIRECT_SUPPORT")).toBe("OTHER");
  });
  it("reconnaît un libellé français et des mots", () => {
    expect(natureLaPlusProche("Location de salle")).toBe("VENUE");
    expect(natureLaPlusProche("Hébergement des orateurs")).toBe("ACCOMMODATION");
    expect(natureLaPlusProche("pause-café")).toBe("CATERING");
    expect(natureLaPlusProche("billets d'avion")).toBe("TICKETING");
  });
  it("à défaut, « Autre » — jamais une nature inconnue", () => {
    expect(natureLaPlusProche("XYZ")).toBe("OTHER");
    expect(natureLaPlusProche(42)).toBe("OTHER");
    expect(natureLaPlusProche("")).toBe("OTHER");
  });
  it("toutes les natures proposables ont un libellé à l'écran", () => {
    for (const k of NATURES_DU_FICHIER) expect(ITEM_KIND_LABELS[k]).toBeTruthy();
  });
});

describe("les nombres du document", () => {
  it("lit les écritures française et anglaise", () => {
    expect(lireNombre("1 250 000,00")).toBe(1_250_000);
    expect(lireNombre("1.250.000")).toBe(1_250_000);
    expect(lireNombre("1,250,000.50")).toBe(1_250_000.5);
    expect(lireNombre("12,5")).toBe(12.5);
    expect(lireNombre("250000")).toBe(250_000);
    expect(lireNombre("abc")).toBeNull();
    expect(lireNombre("")).toBeNull();
  });
  it("un montant ne se garde que s'il se lit tel quel", () => {
    expect(montantDansLeTexte(1_250_000, CAHIER)).toBe(true);
    expect(montantDansLeTexte(2_500_000, CAHIER)).toBe(true); // « 2,5 millions »
    expect(montantDansLeTexte(900, CAHIER)).toBe(true);
    expect(montantDansLeTexte(135_000, CAHIER)).toBe(false); // 150 × 900 : calculé, pas écrit
  });
});

describe("la relecture de la réponse du modèle", () => {
  const ligne = (o: Record<string, unknown>) => ({ nature: "OTHER", libelle: "", description: "", quantite: 0, montantDzd: 0, ...o });

  it("rien d'exploitable hors du contrat", () => {
    expect(lirePostesDuModele(null, CAHIER)).toBeNull();
    expect(lirePostesDuModele({ postes: "non" }, CAHIER)).toBeNull();
  });

  it("garde les postes, écarte les lignes vides, les doublons et les montants inventés — et le dit", () => {
    const r = lirePostesDuModele({
      postes: [
        ligne({ nature: "STAND", libelle: "Stand 12 m² — hall B", description: "Comptoir et deux tabourets.", montantDzd: 1_250_000 }),
        ligne({ nature: "STAND", libelle: "Stand 12 m² — hall B", description: "Comptoir et deux tabourets.", montantDzd: 1_250_000 }),
        ligne({ nature: "PRINTING", libelle: "Kakémonos 85 × 200 cm", quantite: 4 }),
        ligne({ nature: "CATERING", libelle: "Pause-café", description: "150 personnes le 12/12.", quantite: 150, montantDzd: 135_000 }),
        ligne({ nature: "BIDON", libelle: "", description: "" }),
        ligne({ nature: "salle", libelle: "", description: "Auditorium pour le symposium" }),
      ],
      remarques: ["Le nombre de flyers est à confirmer."],
    }, CAHIER)!;
    expect(r.postes).toHaveLength(4);
    expect(r.postes[0]).toEqual({ nature: "STAND", libelle: "Stand 12 m² — hall B", description: "Comptoir et deux tabourets.", quantite: null, montant: 1_250_000 });
    expect(r.postes[1]).toMatchObject({ nature: "PRINTING", quantite: 4, montant: null });
    expect(r.postes[2]).toMatchObject({ nature: "CATERING", quantite: 150, montant: null });
    // Sans libellé, le libellé de la nature ; la nature « salle » ramenée à la location de salle.
    expect(r.postes[3]).toMatchObject({ nature: "VENUE", libelle: ITEM_KIND_LABELS.VENUE, description: "Auditorium pour le symposium" });
    expect(r.remarques.some((x) => x.includes("Pause-café") && x.includes("écarté"))).toBe(true);
    expect(r.remarques).toContain("Le nombre de flyers est à confirmer.");
  });

  it("borne la liste, et le dit", () => {
    const postes = Array.from({ length: POSTES_MAX + 3 }, (_, i) => ligne({ libelle: `Poste ${i + 1}` }));
    const r = lirePostesDuModele({ postes, remarques: [] }, CAHIER)!;
    expect(r.postes).toHaveLength(POSTES_MAX);
    expect(r.remarques[0]).toContain(`plus de ${POSTES_MAX} postes`);
  });
});

describe("le fichier gardé et la phrase", () => {
  it("nomme le cahier des charges sans doubler ni perdre l'extension", () => {
    expect(nomDuCahier("CDC congrès SAHO.pdf")).toBe("Cahier des charges — CDC congrès SAHO.pdf");
    expect(nomDuCahier("Cahier des charges SAHO.docx")).toBe("Cahier des charges SAHO.docx");
    expect(nomDuCahier("scan")).toBe("Cahier des charges — scan");
    expect(nomDuCahier(`${"x".repeat(300)}.pdf`).length).toBeLessThanOrEqual(200);
    expect(nomDuCahier(`${"x".repeat(300)}.pdf`).endsWith(".pdf")).toBe(true);
  });
  it("dit ce qui a été lu, et que le fichier reste", () => {
    const p = phraseDeLaProposition({ nombre: 3, nomDocument: "Cahier des charges — a.pdf", coupe: false, scan: true });
    expect(p).toContain("propose 3 postes");
    expect(p).toContain("scan");
    expect(p).toContain("gardé dans les pièces de la demande");
    expect(phraseDeLaProposition({ nombre: 0, nomDocument: "x", coupe: true, scan: false })).toContain("aucun poste");
  });
});

describe("de la relecture au formulaire d'ajout ordinaire", () => {
  const poste: PosteDuFichier = { nature: "PRINTING", libelle: "Kakémonos 85 × 200 cm", description: "Pour le stand.", quantite: 4, montant: 48_000 };

  it("une ligne relue se relit à l'identique", () => {
    // La voie proposée d'office pour la nature s'y ajoute (recette 24/11/2026) : l'imprimerie passe par une agence.
    expect(posteDepuisLaSaisie(ligneDepuisPoste(poste))).toEqual({ ok: true, poste: { ...poste, voie: "AGENCE" } });
  });

  it("refuse ce que addAdProItem refuserait ou avalerait en silence", () => {
    expect(posteDepuisLaSaisie(LIGNE_VIDE)).toEqual({ ok: false, error: "Le libellé du poste est obligatoire." });
    expect(posteDepuisLaSaisie({ ...LIGNE_VIDE, libelle: "x", nature: "INDIRECT_SUPPORT" }).ok).toBe(false);
    expect(posteDepuisLaSaisie({ ...LIGNE_VIDE, libelle: "x", quantite: "2,5" }).ok).toBe(false);
    expect(posteDepuisLaSaisie({ ...LIGNE_VIDE, libelle: "x", montant: "beaucoup" }).ok).toBe(false);
    expect(posteDepuisLaSaisie({ ...LIGNE_VIDE, libelle: " x ", montant: "250 000" })).toEqual({
      ok: true, poste: { nature: "OTHER", libelle: "x", description: null, quantite: null, montant: 250_000, voie: LIGNE_VIDE.voie || null },
    });
  });

  it("compose le formulaire de l'écran « Ajouter un poste » — description et quantité en précisions", () => {
    expect(versFormulaireDuPoste(poste, "AD_PRO_OTHER", "d1")).toEqual([
      ["parent", "AD_PRO_OTHER"], ["parentId", "d1"], ["kind", "PRINTING"], ["label", "Kakémonos 85 × 200 cm"], ["budgetKind", "INCLUDED"],
      // Ni montant ni budget à la publication (recette 24/11/2026) : le montant lu reste dans les notes.
      ["notes", `Pour le stand.\nQuantité : 4\nMontant écrit dans le cahier des charges : ${(48000).toLocaleString("fr-FR")} DZD`],
    ]);
    const sansRien = versFormulaireDuPoste({ ...poste, description: null, quantite: null, montant: null }, "EVENT", "e1");
    expect(sansRien.map(([k]) => k)).toEqual(["parent", "parentId", "kind", "label", "budgetKind"]);
  });

  it("PAR UNE AGENCE : la voie, le cahier des charges et l'assistante partent avec le poste (recette 24/11/2026)", () => {
    const f = new Map(versFormulaireDuPoste({ ...poste, voie: "AGENCE" }, "SPONSORING", "s1", { assistanteId: "a1", fichier: "cahier.pdf" }));
    expect(f.get("voie")).toBe("AGENCE");
    expect(f.get("assistanteId")).toBe("a1");
    expect(f.get("cahierDesCharges")).toBe("Kakémonos 85 × 200 cm — Pour le stand.\nQuantité : 4\nVoir le cahier des charges joint à la demande : « cahier.pdf ».");
    const direct = new Map(versFormulaireDuPoste({ ...poste, voie: "DIRECT" }, "SPONSORING", "s1", { assistanteId: "a1" }));
    expect(direct.get("voie")).toBe("DIRECT");
    expect(direct.has("cahierDesCharges") || direct.has("assistanteId")).toBe(false);
  });
});
