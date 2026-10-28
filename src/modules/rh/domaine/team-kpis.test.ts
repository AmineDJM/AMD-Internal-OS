import { describe, it, expect } from "vitest";
import { jobOf, jobKpis, commonKpis, avecLiens, JOB_LABEL, NO_JOB_KPI_NOTE, type TeamKpi } from "./team-kpis";

describe("le métier retenu pour les indicateurs", () => {
  it("le TERRAIN rassemble ceux qui visitent, quel que soit leur grade", () => {
    expect(jobOf("MEDICAL_DELEGATE")).toBe("FIELD");
    expect(jobOf("NATIONAL_SALES")).toBe("FIELD");
    expect(jobOf("MEDICAL_PROMOTION_MANAGER")).toBe("FIELD");
  });

  it("les affaires réglementaires : le responsable ET l'assistante", () => {
    expect(jobOf("HEAD_OF_REGULATORY")).toBe("REGULATORY");
    expect(jobOf("REGULATORY_ASSISTANT")).toBe("REGULATORY");
  });

  it("UN MÉTIER SANS COMPTEUR PROPRE LE DIT — il n'affiche pas une colonne de zéros", () => {
    // Le nombre de visites médicales d'un comptable est zéro, et ce zéro ne veut rien dire.
    // Des zéros qui ne veulent rien dire abîment ceux qui veulent dire quelque chose.
    expect(jobOf("FINANCE_BUDGET_MANAGER")).toBe("GENERIC");
    expect(jobKpis({ job: "GENERIC" })).toEqual([]);
    // La phrase dit ce qui manque À CET ÉCRAN — pas « dans l'outil », qui serait faux pour les
    // Finances, le Marketing ou le secrétariat, dont l'outil porte l'activité (audit 360°, M11).
    expect(NO_JOB_KPI_NOTE).toMatch(/ne suit pas encore d'indicateur propre/);
    expect(NO_JOB_KPI_NOTE).not.toMatch(/dans l'outil/);
  });

  it("un compte sans rôle connu retombe sur le générique, il ne casse pas", () => {
    expect(jobOf(null)).toBe("GENERIC");
    expect(jobOf("ROLE_QUI_N_EXISTE_PAS")).toBe("GENERIC");
    expect(JOB_LABEL[jobOf(undefined)]).toBeTruthy();
  });
});

describe("ce que les chiffres disent", () => {
  it("LE RETARD S'ÉCRIT AVEC LE NOMBRE, pas à côté", () => {
    // « 12 tâches » rassure ; « 12 dont 5 en retard » appelle une conversation.
    const [taches] = commonKpis({ openTasks: 12, overdueTasks: 5, leaveDaysThisYear: 8, openRequests: 0 });
    expect(taches.value).toBe("12");
    expect(taches.hint).toContain("5 en retard");
    expect(taches.tone).toBe("warning");
  });

  it("sans retard, aucun ton d'alerte — une alerte permanente n'alerte plus", () => {
    const [taches] = commonKpis({ openTasks: 3, overdueTasks: 0, leaveDaysThisYear: 0, openRequests: 0 });
    expect(taches.hint).toBeUndefined();
    expect(taches.tone).toBe("default");
  });

  it("UN TAUX SANS SON DÉNOMINATEUR MENT — le hors-délai s'affiche en fraction", () => {
    // « 33 % de retard » sur trois courses n'est pas « 33 % » sur trente.
    const kpis = jobKpis({ job: "COORDINATION", counts: { runsDone30: 3, runsLate30: 1, runsOpen: 2 } });
    expect(kpis.find((k) => k.label === "Hors délai")!.value).toBe("1 / 3");
  });

  it("aucune course sur la période : on le DIT, au lieu d'un « 0 / 0 » muet", () => {
    const kpis = jobKpis({ job: "COORDINATION", counts: { runsDone30: 0, runsLate30: 0, runsOpen: 0 } });
    expect(kpis.find((k) => k.label === "Hors délai")!.hint).toMatch(/aucune course/);
  });

  it("UNE VISITE FAITE SANS COMPTE RENDU EST LE SEUL CHIFFRE QUI APPELLE UNE ACTION", () => {
    const avec = jobKpis({ job: "FIELD", counts: { visitsDone30: 20, visitsPlanned: 4, doctors: 60, visitsWithoutReport: 7 } });
    expect(avec.find((k) => k.label === "Comptes rendus manquants")!.tone).toBe("warning");
    const sans = jobKpis({ job: "FIELD", counts: { visitsDone30: 20, visitsPlanned: 4, doctors: 60, visitsWithoutReport: 0 } });
    expect(sans.find((k) => k.label === "Comptes rendus manquants")!.tone).toBe("success");
  });

  it("un dossier réglementaire en retard se voit — et zéro se félicite", () => {
    expect(jobKpis({ job: "REGULATORY", counts: { dossiers: 9, overdue: 2, stepsInProgress: 5 } })
      .find((k) => k.label === "Dossiers en retard")!.tone).toBe("danger");
    expect(jobKpis({ job: "REGULATORY", counts: { dossiers: 9, overdue: 0, stepsInProgress: 5 } })
      .find((k) => k.label === "Dossiers en retard")!.tone).toBe("success");
  });

  it("chaque métier rend AU PLUS quatre chiffres — « quelques KPI », pas un tableau de bord", () => {
    for (const j of [
      { job: "FIELD", counts: { visitsDone30: 1, visitsPlanned: 1, doctors: 1, visitsWithoutReport: 1 } },
      { job: "REGULATORY", counts: { dossiers: 1, overdue: 1, stepsInProgress: 1 } },
      { job: "MEDICAL_INFO", counts: { awaiting: 1, docsRequested: 1, validated30: 1 } },
      { job: "COORDINATION", counts: { runsDone30: 1, runsLate30: 1, runsOpen: 1 } },
    ] as const) {
      expect(jobKpis(j).length).toBeGreaterThan(0);
      expect(jobKpis(j).length).toBeLessThanOrEqual(4);
    }
  });
});

describe("un chiffre qui a un écran y mène (§118.196, lot E3 — M12)", () => {
  const tous = (): TeamKpi[] => [
    ...commonKpis({ openTasks: 1, overdueTasks: 0, leaveDaysThisYear: 1, openRequests: 1 }),
    ...jobKpis({ job: "FIELD", counts: { visitsDone30: 1, visitsPlanned: 1, doctors: 1, visitsWithoutReport: 1 } }),
    ...jobKpis({ job: "REGULATORY", counts: { dossiers: 1, overdue: 1, stepsInProgress: 1 } }),
    ...jobKpis({ job: "MEDICAL_INFO", counts: { awaiting: 1, docsRequested: 1, validated30: 1 } }),
    ...jobKpis({ job: "COORDINATION", counts: { runsDone30: 1, runsLate30: 1, runsOpen: 1 } }),
  ];

  it("CHAQUE CHIFFRE PORTE SA CLÉ — un lien s'accroche à la clé, jamais au libellé", () => {
    const cles = tous().map((k) => k.cle);
    expect(cles.every((c) => typeof c === "string" && c.length > 0)).toBe(true);
    // Une clé par chiffre : deux chiffres sous la même clé recevraient le même lien.
    expect(new Set(cles).size).toBe(cles.length);
    expect(cles).toHaveLength(16);
  });

  it("UN LIEN NE S'AJOUTE QU'AUX CHIFFRES QUI EN ONT UN", () => {
    const base = commonKpis({ openTasks: 4, overdueTasks: 1, leaveDaysThisYear: 3, openRequests: 0 });
    const lies = avecLiens(base, { leaveDaysThisYear: "/rh/emp-1" });
    expect(lies.find((k) => k.cle === "leaveDaysThisYear")?.href).toBe("/rh/emp-1");
    // Les autres ne reçoivent RIEN — pas même une clé `href` vide, qui ferait dessiner un lien mort.
    expect(lies.filter((k) => k.cle !== "leaveDaysThisYear").every((k) => !("href" in k))).toBe(true);
    // Sans lien du tout, la carte est rendue telle quelle.
    expect(avecLiens(base, {})).toEqual(base);
  });
});
