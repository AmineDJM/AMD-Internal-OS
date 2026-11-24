import { describe, expect, it } from "vitest";
import { buildRef } from "@/lib/refs";
import { PERMISSIONS, defaultScope } from "@/lib/rbac";
import { NAVIGATION } from "@/lib/labels";
import {
  CONTEXTE_PV_VIERGE, PREFIXE_REFERENCE_PV, STATUTS_PV, STATUT_PV, estStatutPv, lecteurDuCasPv, lireAgePv, peutJoindreAuCasPv, refusEnquetePv,
  refusTransitionPv, statutApresDemandeInfosPv, statutDeReouverturePv, statutsSuivantsPv, type ContexteCasPv,
} from "./regles";

/** PHARMACOVIGILANCE (Direction, 06/10) — les règles pures du module, et ses droits par défaut. */

describe("statuts d'un cas — le circuit de déclaration (24/11/2026)", () => {
  const ctx = (o: Partial<ContexteCasPv> = {}): ContexteCasPv => ({ ...CONTEXTE_PV_VIERGE, ...o });

  it("le circuit : Reçu, Enquête, Évalué, Déclaré, Suivi, Clos — « En analyse » n'en est plus une étape, mais reste lisible", () => {
    expect([...STATUTS_PV]).toEqual(["RECU", "ENQUETE", "EVALUE", "DECLARE", "SUIVI", "CLOS"]);
    expect(estStatutPv("EN_ANALYSE")).toBe(true);
    expect(STATUT_PV.EN_ANALYSE.label).toBe("En analyse");
    expect(STATUT_PV.DECLARE.label).toBe("Déclaré à l'autorité");
  });

  it("le sélecteur ne propose que suivi (après déclaration), clôture et réouverture — jamais un retour à « Reçu »", () => {
    expect(statutsSuivantsPv("RECU")).toEqual(["CLOS"]);
    expect(statutsSuivantsPv("EVALUE")).toEqual(["CLOS"]);
    expect(statutsSuivantsPv("DECLARE")).toEqual(["SUIVI", "CLOS"]);
    expect(statutsSuivantsPv("SUIVI")).toEqual(["CLOS"]);
    for (const s of STATUTS_PV) if (s !== "CLOS") expect(statutsSuivantsPv(s)).not.toContain("RECU");
    expect(refusTransitionPv("RECU", "DECLARE", null)).toMatch(/ne passe pas/);
  });

  it("un cas clos se rouvre là où il en était : suivi s'il est déclaré, à déclarer s'il est évalué, sinon reçu", () => {
    expect(statutDeReouverturePv({ declare: true, evalue: true })).toBe("SUIVI");
    expect(statutDeReouverturePv({ declare: false, evalue: true })).toBe("EVALUE");
    expect(statutDeReouverturePv({ declare: false, evalue: false })).toBe("RECU");
    expect(statutsSuivantsPv("CLOS", ctx({ evalue: true }))).toEqual(["EVALUE"]);
    expect(refusTransitionPv("CLOS", "EVALUE", null, ctx({ evalue: true }))).toBeNull();
    expect(refusTransitionPv("CLOS", "SUIVI", null, ctx({ evalue: true }))).toMatch(/ne passe pas/);
  });

  it("clore exige une note de clôture", () => {
    expect(refusTransitionPv("RECU", "CLOS", "  ")).toMatch(/note de clôture/);
    expect(refusTransitionPv("RECU", "CLOS", "Doublon du cas PV-2026-003.")).toBeNull();
  });

  it("un cas évalué grave ne se clôt pas sans déclaration ; un cas non grave le peut, en disant pourquoi", () => {
    expect(refusTransitionPv("EVALUE", "CLOS", "Fini.", ctx({ evalue: true, evalGrave: true }))).toMatch(/grave se déclare/);
    expect(refusTransitionPv("EVALUE", "CLOS", "Non-cas.", ctx({ evalue: true, evalGrave: false }))).toBeNull();
  });

  it("un cas déclaré attend le visa du pharmacien responsable désigné avant sa clôture", () => {
    expect(refusTransitionPv("DECLARE", "CLOS", "Conclu.", ctx({ declare: true, evalue: true, visaRequis: true }))).toMatch(/visa/);
    expect(refusTransitionPv("DECLARE", "CLOS", "Conclu.", ctx({ declare: true, evalue: true, visaRequis: true, vise: true }))).toBeNull();
    expect(refusTransitionPv("SUIVI", "CLOS", "Conclu.", ctx({ declare: true, evalue: true }))).toBeNull();
  });

  it("un statut identique est refusé, en le disant", () => {
    expect(refusTransitionPv("DECLARE", "DECLARE", null)).toMatch(/déjà/);
  });

  it("demander des informations : enquête avant l'évaluation, le cas évalué reste à déclarer, suivi après la déclaration", () => {
    expect(refusEnquetePv("RECU", "")).toMatch(/informations/);
    expect(refusEnquetePv("CLOS", "Numéro de lot ?")).toMatch(/clos/);
    expect(refusEnquetePv("ENQUETE", "Évolution à J7 ?")).toBeNull();
    expect(statutApresDemandeInfosPv("RECU")).toBe("ENQUETE");
    expect(statutApresDemandeInfosPv("EN_ANALYSE")).toBe("ENQUETE");
    expect(statutApresDemandeInfosPv("EVALUE")).toBe("EVALUE");
    expect(statutApresDemandeInfosPv("DECLARE")).toBe("SUIVI");
    expect(statutApresDemandeInfosPv("SUIVI")).toBe("SUIVI");
  });
});

describe("qui lit un cas", () => {
  const cas = { reporterId: "kam", status: "ENQUETE", participants: [{ userId: "medecin" }] };
  it("le déclarant, les participants, qui reçoit les cas — personne d'autre", () => {
    expect(lecteurDuCasPv({ userId: "kam", voitTout: false }, cas)).toBe(true);
    expect(lecteurDuCasPv({ userId: "medecin", voitTout: false }, cas)).toBe(true);
    expect(lecteurDuCasPv({ userId: "reg", voitTout: true }, cas)).toBe(true);
    expect(lecteurDuCasPv({ userId: "autre-kam", voitTout: false }, cas)).toBe(false);
    expect(lecteurDuCasPv({ userId: "admin", voitTout: false, superAdmin: true }, cas)).toBe(true);
  });

  it("joindre une pièce : le KAM tant que le cas est ouvert, qui instruit toujours", () => {
    const kam = { userId: "kam", voitTout: false, instruit: false };
    expect(peutJoindreAuCasPv(kam, cas)).toBe(true);
    expect(peutJoindreAuCasPv(kam, { ...cas, status: "CLOS" })).toBe(false);
    expect(peutJoindreAuCasPv({ userId: "reg", voitTout: true, instruit: true }, { ...cas, status: "CLOS" })).toBe(true);
    expect(peutJoindreAuCasPv({ userId: "autre", voitTout: false, instruit: false }, cas)).toBe(false);
  });
});

describe("référence et saisie", () => {
  it("la référence suit PV-AAAA-NNN, au maximum présent", () => {
    expect(buildRef(PREFIXE_REFERENCE_PV, 2026, [])).toBe("PV-2026-001");
    expect(buildRef(PREFIXE_REFERENCE_PV, 2026, ["PV-2026-001", "PV-2026-007"])).toBe("PV-2026-008");
  });

  it("l'âge du patient : un entier plausible, sinon rien", () => {
    expect(lireAgePv("42")).toBe(42);
    expect(lireAgePv("")).toBeNull();
    expect(lireAgePv("4.5")).toBeNull();
    expect(lireAgePv("300")).toBeNull();
  });
});

describe("droits par défaut", () => {
  it("Regulatory reçoit les cas avec ses gestes de Regulatory, en portée TOUT", () => {
    expect(PERMISSIONS.HEAD_OF_REGULATORY.PHARMACOVIGILANCE).toEqual(PERMISSIONS.HEAD_OF_REGULATORY.REGULATORY);
    expect(PERMISSIONS.REGULATORY_ASSISTANT.PHARMACOVIGILANCE).toEqual(PERMISSIONS.REGULATORY_ASSISTANT.REGULATORY);
    expect(defaultScope("HEAD_OF_REGULATORY", "PHARMACOVIGILANCE")).toBe("ALL");
    expect(defaultScope("REGULATORY_ASSISTANT", "PHARMACOVIGILANCE")).toBe("ALL");
  });

  it("le KAM signale (Voir, Créer, Téléverser) et ne lit que ses cas", () => {
    expect(PERMISSIONS.MEDICAL_DELEGATE.PHARMACOVIGILANCE).toEqual(["VIEW", "CREATE", "UPLOAD"]);
    expect(defaultScope("MEDICAL_DELEGATE", "PHARMACOVIGILANCE")).toBe("ASSIGNED");
  });

  it("qui n'a ni Regulatory ni les rapports terrain n'a rien", () => {
    expect(PERMISSIONS.COORDINATOR.PHARMACOVIGILANCE).toBeUndefined();
  });

  it("l'entrée de menu est au pôle Regulatory, gardée : le KAM n'y voit pas la boîte", () => {
    const entree = NAVIGATION.find((n) => n.module === "PHARMACOVIGILANCE");
    expect(entree?.href).toBe("/regulatory/pharmacovigilance");
    expect(entree?.pole).toBe("REGULATORY");
    expect(entree?.gate).toBe("pharmacovigilance");
  });
});
