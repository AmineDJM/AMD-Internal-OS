import { describe, expect, it } from "vitest";
import {
  demandeBvBloquante, demandeQuiDitLEtat, estObjetBv, etapeDeDemandeSelonLaDecision, etatDeLaDemandeBv, natureDeLObjetBv,
  OBJET_BV_REGULATORY, OBJETS_BV_REGULATORY, paiementBvDeverrouille, refusPaiementVerrouille, uneEtapeParDemandeBv,
} from "./bv-validation";
import { unSeulSuffit } from "@/lib/validations/decision";
import { libelleNatureValidation, ETAT_DEMANDE_BV } from "@/lib/labels";
import { statusFromWorkflow } from "./process-status";

/**
 * LE BV D'UN DOSSIER PAR LE CENTRE DE VALIDATIONS — les règles pures (Super Admin, 24/11/2026) : l'état lu sur les
 * demandes, le verrou du paiement (nouveau et ancien circuit), l'étape qui suit la décision et le niveau de process.
 */
describe("BV au Centre de validations — règles pures", () => {
  it("deux natures, reconnues sans deviner ; une seule décision suffit ; libellées en clair", () => {
    expect(natureDeLObjetBv(OBJET_BV_REGULATORY["25"])).toBe("25");
    expect(natureDeLObjetBv(OBJET_BV_REGULATORY["75"])).toBe("75");
    expect(natureDeLObjetBv("INFO_MED_DIRECTEUR_OPS")).toBeNull();
    expect(estObjetBv(null)).toBe(false);
    for (const o of OBJETS_BV_REGULATORY) {
      // `decision.ts` écrit ces natures en clair (module au socle) : l'égalité est tenue ici.
      expect(unSeulSuffit(o), o).toBe(true);
      expect(libelleNatureValidation(o)).toMatch(/^Autorisation du BV (25|75) %/);
    }
    expect(Object.keys(ETAT_DEMANDE_BV).sort()).toEqual(["ACCEPTE", "EN_ATTENTE", "REFUSE"]);
  });

  it("l'état se lit sur le statut ; « à corriger » vaut un refus ; une demande retirée ne dit plus rien", () => {
    expect(etatDeLaDemandeBv("PENDING")).toBe("EN_ATTENTE");
    expect(etatDeLaDemandeBv("APPROVED")).toBe("ACCEPTE");
    expect(etatDeLaDemandeBv("REJECTED")).toBe("REFUSE");
    expect(etatDeLaDemandeBv("CHANGES_REQUESTED")).toBe("REFUSE");
    expect(etatDeLaDemandeBv("CANCELLED")).toBeNull();
    expect(demandeBvBloquante({ status: "PENDING" })).toBe(true);
    expect(demandeBvBloquante({ status: "APPROVED" })).toBe(true);
    expect(demandeBvBloquante({ status: "REJECTED" })).toBe(false);
  });

  it("la demande qui dit l'état : la vivante la plus récente, sinon le dernier refus", () => {
    const d = (status: string, jour: number) => ({ status, createdAt: new Date(Date.UTC(2026, 10, jour)) });
    expect(demandeQuiDitLEtat([])).toBeNull();
    expect(demandeQuiDitLEtat([d("REJECTED", 1), d("REJECTED", 3)])?.demande.createdAt.getUTCDate()).toBe(3);
    const lu = demandeQuiDitLEtat([d("REJECTED", 5), d("PENDING", 2)]);
    expect(lu?.etat, "une demande vivante l'emporte sur un refus plus récent").toBe("EN_ATTENTE");
    expect(demandeQuiDitLEtat([d("CANCELLED", 9)])).toBeNull();
  });

  it("verrou du paiement : seule une demande ACCEPTÉE (ou un ancien ordre autorisé / payé) le lève", () => {
    const v = (status: string, n: "25" | "75" = "25") => ({ objectType: OBJET_BV_REGULATORY[n], status });
    const o = (status: string, centralStatus: string, label = "BV 25 % — REG X") => ({ label, status, centralStatus });
    expect(paiementBvDeverrouille("25", { demandes: [], ordres: [] })).toBe(false);
    expect(paiementBvDeverrouille("25", { demandes: [v("PENDING")], ordres: [] })).toBe(false);
    expect(paiementBvDeverrouille("25", { demandes: [v("REJECTED")], ordres: [] })).toBe(false);
    expect(paiementBvDeverrouille("25", { demandes: [v("APPROVED", "75")], ordres: [] }), "l'autre part ne compte pas").toBe(false);
    expect(paiementBvDeverrouille("25", { demandes: [v("REJECTED"), v("APPROVED")], ordres: [] })).toBe(true);
    // L'ANCIEN CIRCUIT : un ordre autorisé par le centre de paiement (ou payé) vaut acceptation.
    expect(paiementBvDeverrouille("25", { demandes: [], ordres: [o("PENDING", "AWAITING")] })).toBe(false);
    expect(paiementBvDeverrouille("25", { demandes: [], ordres: [o("PENDING", "REFUSED")] })).toBe(false);
    expect(paiementBvDeverrouille("25", { demandes: [], ordres: [o("PENDING", "APPROVED")] })).toBe(true);
    expect(paiementBvDeverrouille("25", { demandes: [], ordres: [o("PAID", "APPROVED")] })).toBe(true);
    expect(paiementBvDeverrouille("75", { demandes: [], ordres: [o("PAID", "APPROVED")] })).toBe(false);
    expect(refusPaiementVerrouille("75")).toMatch(/Centre de validations/);
  });

  it("l'étape « Demande du BV » suit la décision ; « Attente paiement BV » n'arrive qu'à l'acceptation", () => {
    expect(etapeDeDemandeSelonLaDecision("PENDING")).toBe("DOING");
    expect(etapeDeDemandeSelonLaDecision("APPROVED")).toBe("DONE");
    expect(etapeDeDemandeSelonLaDecision("REJECTED")).toBe("TODO");
    expect(etapeDeDemandeSelonLaDecision("CHANGES_REQUESTED")).toBe("TODO");
    const base = { presub_ans: { status: "DONE" as const, outcome: "FAVORABLE" as const }, modules345: { status: "DONE" as const } };
    expect(statusFromWorkflow({ ...base, bv75_req: { status: etapeDeDemandeSelonLaDecision("PENDING") } }), "demandé, pas accepté").toBe("IN_PREPARATION");
    expect(statusFromWorkflow({ ...base, bv75_req: { status: etapeDeDemandeSelonLaDecision("APPROVED") } }), "accepté, pas payé").toBe("AWAITING_BV_PAYMENT");
    expect(statusFromWorkflow({ ...base, bv75_req: { status: "DONE" }, bv75_pay: { status: "DONE" } })).toBe("IN_PREPARATION");
  });

  it("la file d'un membre du centre : une demande de BV une seule fois, par son étape s'il en a une ; sans accès, aucune", () => {
    const e = (id: string, validatorId: string, requestId: string, objectType: string | null) => ({ id, validatorId, request: { id: requestId, objectType } });
    const etapes = [
      e("s1", "autre", "bv1", OBJET_BV_REGULATORY["25"]),
      e("s2", "moi", "bv1", OBJET_BV_REGULATORY["25"]),
      e("s3", "autre", "bv2", OBJET_BV_REGULATORY["75"]),
      e("s4", "x", "bv2", OBJET_BV_REGULATORY["75"]),
      e("s5", "moi", "contrat", null),
    ];
    expect(uneEtapeParDemandeBv(etapes, "moi", true).map((s) => s.id)).toEqual(["s2", "s3", "s5"]);
    expect(uneEtapeParDemandeBv(etapes, "moi", false).map((s) => s.id), "l'accès retiré retire les BV de la file").toEqual(["s5"]);
  });
});
