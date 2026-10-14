import { describe, it, expect } from "vitest";
import {
  decideursInfoMed, estDecideurInfoMed, confirmationDemande, noteDecideurs, chezDecideur, OBJET_DECISION_INFO_MED,
} from "./decideur";
import { issueDeLaDecision, unSeulSuffit } from "@/lib/validations/decision";
import { parcoursOf, libellePastille } from "./parcours";

describe("qui tranche ce que le PRIM fait valider — le Directeur des Opérations", () => {
  it("le Directeur des Opérations (principal ou secondaire) et le Super Admin souverain — personne d'autre", () => {
    expect(estDecideurInfoMed({ role: "OPERATIONS_DIRECTOR" })).toBe(true);
    expect(estDecideurInfoMed({ role: "SALES_USER", secondaryRole: "OPERATIONS_DIRECTOR" })).toBe(true);
    expect(estDecideurInfoMed({ role: "SUPER_ADMIN" })).toBe(true);
    // La Direction des opérations est un SERVICE, pas la personne que le métier a nommée (§118.112a).
    for (const role of ["DIRECTION", "GENERAL_MANAGER", "MEDICAL_INFO_PHARMACIST", "PRODUCT_MANAGER"]) {
      expect(estDecideurInfoMed({ role }), role).toBe(false);
    }
  });

  it("tous les directeurs actifs sont saisis, jamais le demandeur", () => {
    const d = decideursInfoMed({ directeurs: ["od1", "od2", "prim"], superAdmins: ["sa"], requesterId: "prim" });
    expect(d).toEqual({ validatorIds: ["od1", "od2"], repli: false });
    expect(confirmationDemande(d, "Votre lecture est envoyée")).toMatch(/au Directeur des Opérations \(2 comptes notifiés/);
    expect(noteDecideurs(d)).toMatch(/le premier qui tranche décide pour tous/);
  });

  it("aucun directeur (ou le seul est le demandeur) : le Super Admin, et la confirmation le DIT", () => {
    const d = decideursInfoMed({ directeurs: ["prim"], superAdmins: ["sa1", "sa2"], requesterId: "prim" });
    expect(d).toEqual({ validatorIds: ["sa1", "sa2"], repli: true });
    expect(confirmationDemande(d, "Le dossier est transmis")).toBe("Le dossier est transmis au Super Admin : aucun Directeur des Opérations n'est actif dans l'ERP.");
    expect(chezDecideur(d)).toBe("le Super Admin");
    expect(decideursInfoMed({ directeurs: [], superAdmins: [], requesterId: "x" }).validatorIds).toEqual([]);
  });

  it("le moteur commun lit la nature : l'accord d'UN directeur clôt la demande", () => {
    expect(unSeulSuffit(OBJET_DECISION_INFO_MED), "la même valeur des deux côtés").toBe(true);
    expect(unSeulSuffit("PREVALIDATION_BC")).toBe(false);
    expect(unSeulSuffit(null)).toBe(false);
    const demande = { mode: "PARALLEL", currentOrder: 1, steps: [{ id: "a", order: 1, status: "APPROVED" }, { id: "b", order: 1, status: "PENDING" }] };
    expect(issueDeLaDecision(demande, "a", "APPROVED").status, "sans la nature : tous doivent accorder").toBe("PENDING");
    expect(issueDeLaDecision({ ...demande, unSeulSuffit: true }, "a", "APPROVED").status).toBe("APPROVED");
    expect(issueDeLaDecision({ ...demande, unSeulSuffit: true }, "a", "REJECTED").status).toBe("REJECTED");
  });

  it("la pastille nomme le Super Admin quand c'est lui qui tranche", () => {
    const p = parcoursOf({
      circuit: "EVENT", status: "AWAITING_DIRECTION", createdAt: new Date(), updatedAt: new Date(),
      declare: { validationId: null, validationStatus: null, intent: "SKIP", grantedAt: new Date() },
      declareRequestedAt: null, authorityRef: null, lot: "A_DEMANDER", slips: [],
      summary: { count: 0, announced: 0, delivered: 0, allDelivered: false, toRequest: 0 } as never,
      skipped: false, bvRequestedAt: null, requests: [], pharmacistValidatedAt: new Date(), validatedAt: null, pharmacistName: "Amel Amarni",
      chezDecideur: "le Super Admin",
    });
    expect(libellePastille(p)).toBe("À valider — chez le Super Admin");
  });
});
