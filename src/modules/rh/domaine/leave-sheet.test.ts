import { describe, it, expect } from "vitest";
import { buildLeaveSheet, leaveSheetText, splitFullName, resumeDate, describeStandIn } from "./leave-sheet";

describe("nom et prénom", () => {
  it("le premier mot est le nom, le reste le prénom (convention des formulaires RH)", () => {
    expect(splitFullName("BENALI Mohamed Amine")).toEqual({ nom: "BENALI", prenom: "Mohamed Amine" });
    expect(splitFullName("Djouamaii Amine")).toEqual({ nom: "Djouamaii", prenom: "Amine" });
  });

  it("un nom d'un seul mot ne s'invente pas de prénom", () => {
    expect(splitFullName("Redouane")).toEqual({ nom: "Redouane", prenom: "" });
    expect(splitFullName("   ")).toEqual({ nom: "", prenom: "" });
  });

  it("les espaces multiples ne créent pas de champ vide", () => {
    expect(splitFullName("  BOUZID   Sarah  ")).toEqual({ nom: "BOUZID", prenom: "Sarah" });
  });
});

describe("date de reprise", () => {
  it("c'est le LENDEMAIN du dernier jour de congé, pas le dernier jour", () => {
    expect(resumeDate("2026-08-30T00:00:00Z").toISOString()).toMatch(/^2026-08-31/);
  });

  it("elle franchit correctement une fin de mois", () => {
    expect(resumeDate("2026-08-31T00:00:00Z").toISOString()).toMatch(/^2026-09-01/);
  });
});

describe("intérim", () => {
  it("désigné n'est pas accepté — l'état est dit", () => {
    expect(describeStandIn("Karim", "PENDING")).toBe("Karim (en attente de validation RH)");
    expect(describeStandIn("Karim", "APPROVED")).toBe("Karim (validé par les RH)");
    expect(describeStandIn("Karim", "REJECTED")).toBe("Karim (refusé par les RH)");
    expect(describeStandIn(null, null)).toBe("Aucun intérimaire désigné");
  });
});

describe("la fiche complète", () => {
  const employee = {
    fullName: "BENALI Mohamed Amine",
    position: "Chef de produit",
    hireDate: "2021-03-15T00:00:00Z",
    department: "Direction Marketing",
    phone: "021 00 00 00",
  };
  const request = {
    createdAt: "2026-08-20T09:00:00Z",
    startDate: "2026-09-01T00:00:00Z",
    endDate: "2026-09-10T00:00:00Z",
    days: 10,
    phone: "0555 12 34 56",
    standInName: "Sarah BOUZID",
    standInStatus: "PENDING",
  };

  it("porte les onze lignes demandées, dans l'ordre du formulaire", () => {
    const sheet = buildLeaveSheet(employee, request);
    expect(sheet.map((l) => l.label)).toEqual([
      "Nom", "Prénom", "Fonction", "Date de recrutement", "Direction", "Date de la demande",
      "Nombre de jours demandés", "Date de départ", "Date de reprise", "N° de téléphone", "Intérim choisi",
    ]);
  });

  it("remplit chaque ligne depuis la fiche employé et la demande", () => {
    const v = Object.fromEntries(buildLeaveSheet(employee, request).map((l) => [l.label, l.value]));
    expect(v["Nom"]).toBe("BENALI");
    expect(v["Prénom"]).toBe("Mohamed Amine");
    expect(v["Fonction"]).toBe("Chef de produit");
    expect(v["Date de recrutement"]).toBe("15/03/2021");
    expect(v["Direction"]).toBe("Direction Marketing");
    expect(v["Date de la demande"]).toBe("20/08/2026");
    expect(v["Nombre de jours demandés"]).toBe("10");
    expect(v["Date de départ"]).toBe("01/09/2026");
    expect(v["Date de reprise"]).toBe("11/09/2026"); // le congé finit le 10
    expect(v["Intérim choisi"]).toBe("Sarah BOUZID (en attente de validation RH)");
  });

  it("le téléphone de la DEMANDE prime sur celui de la fiche — on ne part pas avec son poste", () => {
    const v = Object.fromEntries(buildLeaveSheet(employee, request).map((l) => [l.label, l.value]));
    expect(v["N° de téléphone"]).toBe("0555 12 34 56");
  });

  it("sans téléphone saisi, celui de la fiche employé prend le relais", () => {
    const v = Object.fromEntries(
      buildLeaveSheet(employee, { ...request, phone: null }).map((l) => [l.label, l.value]),
    );
    expect(v["N° de téléphone"]).toBe("021 00 00 00");
  });

  it("une donnée absente s'affiche « — » : un champ vide se voit, une ligne masquée ne se voit pas", () => {
    const nu = { fullName: "Redouane" };
    const sheet = buildLeaveSheet(nu, { createdAt: "2026-08-20", startDate: "2026-09-01", endDate: "2026-09-02", days: 2 });
    expect(sheet).toHaveLength(11);
    const v = Object.fromEntries(sheet.map((l) => [l.label, l.value]));
    expect(v["Prénom"]).toBe("—");
    expect(v["Fonction"]).toBe("—");
    expect(v["Date de recrutement"]).toBe("—");
    expect(v["Direction"]).toBe("—");
    expect(v["N° de téléphone"]).toBe("—");
    expect(v["Intérim choisi"]).toBe("Aucun intérimaire désigné");
  });

  it("la version texte porte les mêmes lignes (notification, export)", () => {
    const txt = leaveSheetText(employee, request);
    expect(txt).toMatch(/^Nom: BENALI$/m);
    expect(txt).toMatch(/^Date de reprise: 11\/09\/2026$/m);
    expect(txt.split("\n")).toHaveLength(11);
  });
});
