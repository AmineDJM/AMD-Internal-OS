import { describe, expect, it } from "vitest";
import { dateJuridique, datesDuTexte, dossierCanonique, FAMILLE_PAR_DEFAUT, familleDe, montantJuridique, niveauEcheance } from "./classement";
import { pagesDemandees } from "./pdf";

describe("T1 — la place d'une pièce juridique (pur)", () => {
  it("la famille : nature et dossier canoniques, l'avenant avant le contrat", () => {
    expect(familleDe("Avenant n°1 au contrat Pharmalliance")).toMatchObject({ nature: "AMENDMENT", dossier: "Avenants" });
    expect(familleDe("Décision AMM Daclavir 60 mg.pdf")).toMatchObject({ nature: "MARKETING_AUTHORIZATION", dossier: "Agréments et autorisations" });
    expect(familleDe("Agrément établissement pharmaceutique Blida.pdf")).toMatchObject({ nature: "APPROVAL", dossier: "Agréments et autorisations" });
    expect(familleDe("Licence d'importation 2026.pdf")).toMatchObject({ nature: "LICENSE", dossier: "Agréments et autorisations" });
    expect(familleDe("Statuts Adventum Pharma SPA 2024.pdf")).toMatchObject({ nature: "STATUTES", dossier: "Statuts et PV" });
    expect(familleDe("PV AGO 2025.pdf")).toMatchObject({ nature: "MINUTES", dossier: "Statuts et PV" });
    expect(familleDe("Bail entrepôt Rouiba.pdf")).toMatchObject({ nature: "LEASE", dossier: "Baux" });
    expect(familleDe("NDA BioSimilaire Lab.pdf")).toMatchObject({ nature: "NDA" });
    expect(familleDe("", null, "Contrat de maintenance froid Frigomed.pdf")).toMatchObject({ nature: "CONTRACT", dossier: "Contrats" });
    expect(familleDe("Scan.png")).toBeNull();
    expect(dossierCanonique("amm", FAMILLE_PAR_DEFAUT)).toBe("Agréments et autorisations");
    expect(dossierCanonique("AMM Hépatologie", FAMILLE_PAR_DEFAUT)).toBe("AMM Hépatologie");
    expect(dossierCanonique("", familleDe("bail")!)).toBe("Baux");
  });

  it("les dates : formats français, lues dans un texte, jamais inventées", () => {
    expect(dateJuridique("30/06/2027")).toBe("2027-06-30");
    expect(dateJuridique("1er janvier 2026")).toBe("2026-01-01");
    expect(dateJuridique("31/02/2026")).toBeNull();
    expect(datesDuTexte("Le présent contrat est conclu du 01/01/2026 au 31/12/2027.")).toMatchObject({ debut: "2026-01-01", fin: "2027-12-31" });
    expect(datesDuTexte("Décision délivrée le 15/03/2025. Valable jusqu'au 14/03/2030.")).toMatchObject({ debut: "2025-03-15", fin: "2030-03-14" });
    expect(datesDuTexte("Aucune date ici.")).toMatchObject({ debut: null, fin: null });
    expect(montantJuridique("1 200 000 DZD")).toBe(1_200_000);
    expect(montantJuridique("1.200.000,50")).toBe(1_200_000.5);
    expect(niveauEcheance(new Date(Date.now() + 10 * 86_400_000)).niveau).toBe("IMMINENT");
    expect(niveauEcheance(new Date(Date.now() - 86_400_000)).niveau).toBe("EXPIRE");
  });

  it("les pages d'un PDF : plages, ordre, et la page hors document dite", () => {
    expect(pagesDemandees("2-3", 4)).toEqual([1, 2]);
    expect(pagesDemandees("1, 3 et 4", 4)).toEqual([0, 2, 3]);
    expect(pagesDemandees("2 à dernière", 4)).toEqual([1, 2, 3]);
    expect(pagesDemandees("9", 4)).toEqual({ erreur: "page 9 demandée, le document en compte 4" });
  });
});
