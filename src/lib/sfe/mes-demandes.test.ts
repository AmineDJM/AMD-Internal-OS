import { describe, expect, it } from "vitest";
import { demandeClose, etapesDemandeRh, etapesPriseEnCharge } from "./mes-demandes";

const T = "2026-11-20T08:00:00.000Z";
const rh = (o: Partial<Parameters<typeof etapesDemandeRh>[0]>) => etapesDemandeRh({
  type: "MISSION_ORDER", status: "PENDING", createdAt: T, managerGate: null, managerDecidedAt: null, originalsAckAt: null, handledAt: null, ...o,
});
const etats = (e: ReturnType<typeof rh>) => e.map((x) => `${x.libelle}:${x.etat}`);

describe("« où en est ma demande » — un ordre de mission", () => {
  it("chez le N+1, puis chez les RH, puis émis", () => {
    expect(etats(rh({ managerGate: "PENDING" }))).toEqual(["Envoyée:FAITE", "Accord du N+1:EN_COURS", "RH : émission de l'ordre:A_VENIR"]);
    expect(etats(rh({ managerGate: "APPROVED", managerDecidedAt: T, status: "IN_PROGRESS" }))).toEqual(["Envoyée:FAITE", "Accord du N+1:FAITE", "RH : émission de l'ordre:EN_COURS"]);
    const fini = rh({ managerGate: "APPROVED", managerDecidedAt: T, status: "READY", handledAt: T });
    expect(etats(fini)).toEqual(["Envoyée:FAITE", "Accord du N+1:FAITE", "RH : émission de l'ordre:FAITE"]);
    expect(demandeClose(fini, "READY")).toBe(true);
  });
  it("refusé par le N+1 : la ligne s'arrête là", () => {
    const e = rh({ managerGate: "REJECTED", managerDecidedAt: T });
    expect(etats(e)).toEqual(["Envoyée:FAITE", "Accord du N+1:REFUSEE", "RH : émission de l'ordre:A_VENIR"]);
    expect(demandeClose(e, "PENDING")).toBe(true);
  });
  it("sans porte du N+1 (ancienne demande) : directement chez les RH", () => {
    expect(etats(rh({}))).toEqual(["Envoyée:FAITE", "RH : émission de l'ordre:EN_COURS"]);
  });
});

describe("une note de frais — les originaux au secrétariat avant les RH", () => {
  it("accord du N+1, originaux attendus, puis traitement RH", () => {
    expect(etats(rh({ type: "EXPENSE_REPORT", managerGate: "APPROVED", managerDecidedAt: T })))
      .toEqual(["Envoyée:FAITE", "Accord du N+1:FAITE", "Originaux déposés au secrétariat:EN_COURS", "Traitement RH:A_VENIR"]);
    expect(etats(rh({ type: "EXPENSE_REPORT", managerGate: "APPROVED", originalsAckAt: T })))
      .toEqual(["Envoyée:FAITE", "Accord du N+1:FAITE", "Originaux déposés au secrétariat:FAITE", "Traitement RH:EN_COURS"]);
    expect(etats(rh({ type: "EXPENSE_REPORT", status: "REJECTED", originalsAckAt: T, handledAt: T })).at(-1)).toBe("Traitement RH:REFUSEE");
  });
});

describe("une prise en charge — National Sales d'abord", () => {
  it("les étapes suivent le statut de la demande", () => {
    expect(etapesPriseEnCharge("AWAITING_PRELIMINARY", T).map((e) => e.etat)).toEqual(["FAITE", "EN_COURS", "A_VENIR", "A_VENIR", "A_VENIR"]);
    expect(etapesPriseEnCharge("AWAITING_FINAL", T).map((e) => e.etat)).toEqual(["FAITE", "FAITE", "FAITE", "EN_COURS", "A_VENIR"]);
    expect(etapesPriseEnCharge("APPROVED", T).map((e) => e.etat)).toEqual(["FAITE", "FAITE", "FAITE", "FAITE", "FAITE"]);
    expect(etapesPriseEnCharge("AWAITING_PRELIMINARY", T)[1]!.libelle).toMatch(/National Sales/);
  });
  it("refusée ou renvoyée : on ne devine pas l'étape, la pastille d'état le dit", () => {
    expect(etapesPriseEnCharge("REJECTED", T).map((e) => e.etat)).toEqual(["FAITE", "A_VENIR", "A_VENIR", "A_VENIR", "A_VENIR"]);
    expect(demandeClose(etapesPriseEnCharge("REJECTED", T), "REJECTED")).toBe(true);
    expect(demandeClose(etapesPriseEnCharge("RETURNED", T), "RETURNED")).toBe(false);
  });
});
