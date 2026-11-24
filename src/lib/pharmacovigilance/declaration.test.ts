import { describe, expect, it } from "vitest";
import {
  DELAIS_PV_DEFAUT, ajouterJoursPv, attendDeclarationPv, echeanceDeclarationPv, ecartJoursPv, etatEcheancePv, graviteDuDelaiPv, jourAlgerPv,
  lireDesignationsPv, palierAAlerterPv, palierPv, refusAccusePv, refusDeclarationPv, refusDelaisPv, refusEvaluationPv, refusVisaPv,
  statutApresEvaluationPv, viseursDuCasPv,
} from "./declaration";

/** LA DÉCLARATION À L'AUTORITÉ (Super Admin, 24/11/2026) — l'échéance, les paliers d'alerte, les refus. Règles pures. */

const D = (iso: string) => new Date(iso);

describe("l'échéance selon la gravité", () => {
  it("les délais par défaut : 15 jours pour un cas grave, 90 pour un non grave (à confirmer, réglables)", () => {
    expect(DELAIS_PV_DEFAUT).toEqual({ graveJours: 15, nonGraveJours: 90 });
  });

  it("un cas grave connu le 01/12 se déclare au plus tard le 16/12 (J+15, jours calendaires d'Alger)", () => {
    const e = echeanceDeclarationPv({ dateConnaissance: D("2026-12-01T09:00:00Z"), evalGrave: true, severity: null }, DELAIS_PV_DEFAUT);
    expect(e).toEqual({ jour: "2026-12-16", grave: true, source: "EVALUATION", delaiJours: 15 });
  });

  it("le jour civil est celui d'Alger : 23 h 30 UTC le 30/11 est déjà le 01/12 à Alger", () => {
    expect(jourAlgerPv(D("2026-11-30T23:30:00Z"))).toBe("2026-12-01");
  });

  it("un cas non grave : 90 jours, et les mois se franchissent", () => {
    expect(echeanceDeclarationPv({ dateConnaissance: D("2026-12-01T09:00:00Z"), evalGrave: false, severity: "GRAVE" }, DELAIS_PV_DEFAUT).jour).toBe("2027-03-01");
  });

  it("avant l'évaluation, la gravité signalée ; inconnue, le délai le plus court", () => {
    expect(graviteDuDelaiPv({ evalGrave: null, severity: "DECES" })).toEqual({ grave: true, source: "SIGNALEMENT" });
    expect(graviteDuDelaiPv({ evalGrave: null, severity: "NON_GRAVE" })).toEqual({ grave: false, source: "SIGNALEMENT" });
    expect(graviteDuDelaiPv({ evalGrave: null, severity: "INCONNU" })).toEqual({ grave: true, source: "PRUDENCE" });
    expect(graviteDuDelaiPv({ evalGrave: null, severity: null })).toEqual({ grave: true, source: "PRUDENCE" });
    // L'évaluation prime sur le signalement.
    expect(graviteDuDelaiPv({ evalGrave: false, severity: "GRAVE" })).toEqual({ grave: false, source: "EVALUATION" });
  });

  it("des délais réglés autrement s'appliquent", () => {
    expect(echeanceDeclarationPv({ dateConnaissance: D("2026-12-01T09:00:00Z"), evalGrave: true, severity: null }, { graveJours: 7, nonGraveJours: 60 }).jour).toBe("2026-12-08");
  });

  it("arithmétique des jours", () => {
    expect(ajouterJoursPv("2026-12-31", 1)).toBe("2027-01-01");
    expect(ecartJoursPv("2026-12-01", "2026-12-16")).toBe(15);
    expect(ecartJoursPv("2026-12-16", "2026-12-14")).toBe(-2);
  });

  it("le délai ne court plus une fois la déclaration enregistrée ou le cas clos", () => {
    expect(attendDeclarationPv({ status: "EVALUE", declareLe: null })).toBe(true);
    expect(attendDeclarationPv({ status: "EN_ANALYSE", declareLe: null })).toBe(true);
    expect(attendDeclarationPv({ status: "DECLARE", declareLe: D("2026-12-03") })).toBe(false);
    expect(attendDeclarationPv({ status: "CLOS", declareLe: null })).toBe(false);
  });
});

describe("les paliers d'alerte", () => {
  it("rien avant J-5 ; J-5, J-2, le jour J, puis le dépassement", () => {
    expect(palierPv(6)).toBeNull();
    expect(palierPv(5)).toBe("J5");
    expect(palierPv(3)).toBe("J5");
    expect(palierPv(2)).toBe("J2");
    expect(palierPv(1)).toBe("J2");
    expect(palierPv(0)).toBe("J0");
    expect(palierPv(-1)).toBe("DEPASSE");
  });

  it("une alerte par palier : en entrant dans un palier plus avancé que le dernier annoncé, jamais deux fois", () => {
    expect(palierAAlerterPv("J5", null)).toBe("J5");
    expect(palierAAlerterPv("J5", "J5")).toBeNull();
    expect(palierAAlerterPv("J2", "J5")).toBe("J2");
    expect(palierAAlerterPv("J0", "J2")).toBe("J0");
    expect(palierAAlerterPv("DEPASSE", "J0")).toBe("DEPASSE");
    expect(palierAAlerterPv("DEPASSE", "DEPASSE")).toBeNull();
    expect(palierAAlerterPv(null, null)).toBeNull();
    // Un cas découvert en retard : une seule alerte, le dépassement.
    expect(palierAAlerterPv("DEPASSE", null)).toBe("DEPASSE");
    // Un délai repoussé (réévalué non grave) ne réannonce pas un palier moins avancé.
    expect(palierAAlerterPv("J5", "J2")).toBeNull();
  });

  it("l'état du délai : libellé et ton (rouge le jour J et au-delà)", () => {
    const cas = { status: "EVALUE", declareLe: null, dateConnaissance: D("2026-12-01T09:00:00Z"), evalGrave: true, severity: null };
    expect(etatEcheancePv(cas, DELAIS_PV_DEFAUT, D("2026-12-02T10:00:00Z"))).toMatchObject({ joursRestants: 14, palier: null, ton: "neutral" });
    expect(etatEcheancePv(cas, DELAIS_PV_DEFAUT, D("2026-12-11T10:00:00Z"))).toMatchObject({ joursRestants: 5, palier: "J5", ton: "warning", libelle: "À déclarer avant le 16/12/2026 (5 j)" });
    expect(etatEcheancePv(cas, DELAIS_PV_DEFAUT, D("2026-12-16T10:00:00Z"))).toMatchObject({ palier: "J0", ton: "danger", libelle: "À déclarer aujourd'hui (16/12/2026)" });
    expect(etatEcheancePv(cas, DELAIS_PV_DEFAUT, D("2026-12-19T10:00:00Z"))).toMatchObject({ palier: "DEPASSE", ton: "danger", libelle: "Déclaration en retard de 3 j (échéance 16/12/2026)" });
    expect(etatEcheancePv({ ...cas, status: "DECLARE", declareLe: D("2026-12-10") }, DELAIS_PV_DEFAUT, D("2026-12-19T10:00:00Z"))).toBeNull();
  });
});

describe("évaluer, déclarer, accuser, viser", () => {
  const maintenant = D("2026-12-10T10:00:00Z");

  it("l'évaluation exige les trois jugements ; elle fait passer un cas reçu à « Évalué »", () => {
    const ok = { grave: true, attendu: false, imputabilite: "PROBABLE", dateConnaissance: null };
    expect(refusEvaluationPv("RECU", ok, maintenant)).toBeNull();
    expect(refusEvaluationPv("RECU", { ...ok, grave: null }, maintenant)).toMatch(/grave/);
    expect(refusEvaluationPv("RECU", { ...ok, attendu: null }, maintenant)).toMatch(/attendu/);
    expect(refusEvaluationPv("RECU", { ...ok, imputabilite: "PEUT-ETRE" }, maintenant)).toMatch(/imputabilité/);
    expect(refusEvaluationPv("RECU", { ...ok, dateConnaissance: D("2026-12-20") }, maintenant)).toMatch(/futur/);
    expect(refusEvaluationPv("CLOS", ok, maintenant)).toMatch(/rouvrez/);
    expect(statutApresEvaluationPv("RECU")).toBe("EVALUE");
    expect(statutApresEvaluationPv("ENQUETE")).toBe("EVALUE");
    expect(statutApresEvaluationPv("DECLARE")).toBe("DECLARE");
  });

  it("la déclaration : un cas évalué, une date ni future ni antérieure à la connaissance, une référence, une pièce", () => {
    const cas = { status: "EVALUE" as const, evalue: true, dateConnaissance: D("2026-12-01T09:00:00Z") };
    const d = { declareLe: D("2026-12-09"), reference: "CNPM-2026-118", piece: true, accuseLe: null };
    expect(refusDeclarationPv(cas, d, maintenant)).toBeNull();
    expect(refusDeclarationPv({ ...cas, evalue: false, status: "RECU" }, d, maintenant)).toMatch(/Évaluez/);
    expect(refusDeclarationPv({ ...cas, status: "DECLARE" }, d, maintenant)).toMatch(/déjà enregistrée/);
    expect(refusDeclarationPv(cas, { ...d, declareLe: null }, maintenant)).toMatch(/date/);
    expect(refusDeclarationPv(cas, { ...d, declareLe: D("2026-12-12") }, maintenant)).toMatch(/futur/);
    expect(refusDeclarationPv(cas, { ...d, declareLe: D("2026-11-20") }, maintenant)).toMatch(/précède/);
    expect(refusDeclarationPv(cas, { ...d, reference: " " }, maintenant)).toMatch(/référence/);
    expect(refusDeclarationPv(cas, { ...d, piece: false }, maintenant)).toMatch(/pièce/);
    expect(refusDeclarationPv(cas, { ...d, accuseLe: D("2026-12-05") }, maintenant)).toMatch(/précéder/);
  });

  it("l'accusé suit une déclaration enregistrée", () => {
    expect(refusAccusePv({ status: "EVALUE", declareLe: null }, D("2026-12-09"), maintenant)).toMatch(/d'abord/);
    expect(refusAccusePv({ status: "DECLARE", declareLe: D("2026-12-05") }, null, maintenant)).toMatch(/date/);
    expect(refusAccusePv({ status: "SUIVI", declareLe: D("2026-12-05") }, D("2026-12-09"), maintenant)).toBeNull();
  });

  it("le visa : le pharmacien désigné pour la société, après la déclaration, une fois", () => {
    const designations = lireDesignationsPv({ socA: "ph-a", socB: "ph-b", vide: "", nombre: 3 });
    expect(designations).toEqual({ socA: "ph-a", socB: "ph-b" });
    expect(viseursDuCasPv(designations, "socA")).toEqual(["ph-a"]);
    expect(viseursDuCasPv(designations, "socC")).toEqual([]);
    expect(viseursDuCasPv(designations, null)).toEqual(["ph-a", "ph-b"]);
    const cas = { status: "DECLARE" as const, declareLe: D("2026-12-05"), visaPharmacienLe: null };
    expect(refusVisaPv(cas, ["ph-a"], "ph-a")).toBeNull();
    expect(refusVisaPv(cas, ["ph-a"], "ph-b")).toMatch(/désigné/);
    expect(refusVisaPv({ ...cas, status: "EVALUE", declareLe: null }, ["ph-a"], "ph-a")).toMatch(/pas encore enregistrée/);
    expect(refusVisaPv({ ...cas, visaPharmacienLe: D("2026-12-06") }, ["ph-a"], "ph-a")).toMatch(/déjà visée/);
  });

  it("les délais réglés : entiers, bornés, le grave pas plus long que le non grave", () => {
    expect(refusDelaisPv({ graveJours: 15, nonGraveJours: 90 })).toBeNull();
    expect(refusDelaisPv({ graveJours: 0, nonGraveJours: 90 })).toMatch(/entier/);
    expect(refusDelaisPv({ graveJours: null, nonGraveJours: 90 })).toMatch(/entier/);
    expect(refusDelaisPv({ graveJours: 30, nonGraveJours: 15 })).toMatch(/dépasser/);
  });
});
