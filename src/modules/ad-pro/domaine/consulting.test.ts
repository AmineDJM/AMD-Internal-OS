import { describe, it, expect } from "vitest";
import {
  nextConsultingStatus, isContractEditable, isAwaitingDecision, isOverdue,
  billingSuffix, totalCommitment,
} from "./consulting";

describe("Le cycle de vie d'un contrat", () => {
  it("le chemin normal : brouillon → validation → actif → expiré", () => {
    expect(nextConsultingStatus("DRAFT", "SUBMIT")).toBe("AWAITING_VALIDATION");
    expect(nextConsultingStatus("AWAITING_VALIDATION", "APPROVE")).toBe("ACTIVE");
    expect(nextConsultingStatus("ACTIVE", "EXPIRE")).toBe("EXPIRED");
  });

  it("un refus annule le contrat — la relation ne commence pas", () => {
    expect(nextConsultingStatus("AWAITING_VALIDATION", "REFUSE")).toBe("CANCELLED");
  });

  it("un RENVOI le rend à son porteur, en brouillon — et seul un contrat soumis se renvoie (audit 360°, lot C4a)", () => {
    expect(nextConsultingStatus("AWAITING_VALIDATION", "RETURN")).toBe("DRAFT");
    // Renvoyer un brouillon, un contrat actif ou clos n'a pas de sens : personne n'attend de décision.
    for (const s of ["DRAFT", "ACTIVE", "EXPIRED", "CANCELLED"]) expect(nextConsultingStatus(s, "RETURN"), s).toBeNull();
  });

  it("on n'active pas un contrat qui n'a pas été soumis", () => {
    // Sans cela, le bouton « Valider » d'un brouillon ferait entrer en vigueur un contrat que
    // personne n'a relu.
    expect(nextConsultingStatus("DRAFT", "APPROVE")).toBeNull();
  });

  it("un contrat en attente ne peut pas EXPIRER — rien n'a commencé", () => {
    expect(nextConsultingStatus("AWAITING_VALIDATION", "EXPIRE")).toBeNull();
    expect(nextConsultingStatus("DRAFT", "EXPIRE")).toBeNull();
  });

  it("le porteur peut retirer son contrat tant qu'il n'est pas clos", () => {
    expect(nextConsultingStatus("DRAFT", "CANCEL")).toBe("CANCELLED");
    expect(nextConsultingStatus("AWAITING_VALIDATION", "CANCEL")).toBe("CANCELLED");
    expect(nextConsultingStatus("ACTIVE", "CANCEL")).toBe("CANCELLED");
  });

  it("une fin est une fin — on ne rouvre pas un contrat clos", () => {
    // Rouvrir effacerait la date à laquelle la relation s'est terminée : celle qu'on cherche
    // justement quand on se demande jusqu'à quand on a travaillé ensemble.
    for (const move of ["SUBMIT", "APPROVE", "REFUSE", "EXPIRE", "CANCEL"] as const) {
      expect(nextConsultingStatus("EXPIRED", move), move).toBeNull();
      expect(nextConsultingStatus("CANCELLED", move), move).toBeNull();
    }
  });

  it("un statut inconnu ne fabrique pas de transition", () => {
    expect(nextConsultingStatus("N'IMPORTE_QUOI", "APPROVE")).toBeNull();
  });

  it("« expiré » et « annulé » restent deux fins DIFFÉRENTES", () => {
    expect(nextConsultingStatus("ACTIVE", "EXPIRE")).not.toBe(nextConsultingStatus("ACTIVE", "CANCEL"));
  });
});

describe("Ce qu'on peut encore toucher", () => {
  it("un contrat clos ne se modifie plus — ses termes font foi tels qu'ils étaient", () => {
    expect(isContractEditable("EXPIRED")).toBe(false);
    expect(isContractEditable("CANCELLED")).toBe(false);
  });

  it("un contrat vivant se modifie", () => {
    for (const s of ["DRAFT", "AWAITING_VALIDATION", "ACTIVE"]) expect(isContractEditable(s), s).toBe(true);
  });

  it("seul un contrat soumis attend une décision", () => {
    expect(isAwaitingDecision("AWAITING_VALIDATION")).toBe(true);
    expect(isAwaitingDecision("ACTIVE")).toBe(false);
    expect(isAwaitingDecision("DRAFT")).toBe(false);
  });
});

describe("Le terme dépassé se SIGNALE, il ne se décide pas tout seul", () => {
  const now = new Date("2026-08-17T10:00:00Z");

  it("un contrat actif dont la fin est passée est signalé", () => {
    expect(isOverdue({ status: "ACTIVE", endDate: new Date("2026-07-01") }, now)).toBe(true);
  });

  it("un contrat actif encore dans les temps ne l'est pas", () => {
    expect(isOverdue({ status: "ACTIVE", endDate: new Date("2026-12-31") }, now)).toBe(false);
  });

  it("un contrat sans terme ne périme jamais tout seul", () => {
    expect(isOverdue({ status: "ACTIVE", endDate: null }, now)).toBe(false);
  });

  it("un contrat déjà clos n'est pas « en retard »", () => {
    expect(isOverdue({ status: "EXPIRED", endDate: new Date("2020-01-01") }, now)).toBe(false);
    expect(isOverdue({ status: "CANCELLED", endDate: new Date("2020-01-01") }, now)).toBe(false);
  });

  it("une date illisible ne déclenche pas d'alerte", () => {
    expect(isOverdue({ status: "ACTIVE", endDate: "pas-une-date" }, now)).toBe(false);
  });
});

describe("Un montant se lit avec son rythme", () => {
  it("le suffixe dit ce que le chiffre signifie", () => {
    // 200 000 DZD par mois et 200 000 DZD pour la mission entière n'engagent pas la même somme.
    expect(billingSuffix("MONTHLY")).toBe(" / mois");
    expect(billingSuffix("YEARLY")).toBe(" / an");
    expect(billingSuffix("ONE_OFF")).toBe("");
  });

  it("un forfait vaut son montant, point", () => {
    expect(totalCommitment({ amount: 500_000, billing: "ONE_OFF", startDate: null, endDate: null })).toBe(500_000);
    expect(totalCommitment({ amount: 500_000, billing: "ON_DELIVERY", startDate: null, endDate: null })).toBe(500_000);
  });

  it("un mensuel sur six mois engage six fois le montant", () => {
    const total = totalCommitment({ amount: 100_000, billing: "MONTHLY", startDate: "2026-01-01", endDate: "2026-07-01" });
    expect(total).toBe(600_000);
  });

  it("un trimestriel sur un an engage quatre fois le montant", () => {
    const total = totalCommitment({ amount: 300_000, billing: "QUARTERLY", startDate: "2026-01-01", endDate: "2027-01-01" });
    expect(total).toBe(1_200_000);
  });

  it("sans terme connu, on ne devine PAS", () => {
    // Un chiffre inventé se retrouverait ensuite dans un tableau de budget, sans marque d'origine.
    expect(totalCommitment({ amount: 100_000, billing: "MONTHLY", startDate: "2026-01-01", endDate: null })).toBeNull();
    expect(totalCommitment({ amount: null, billing: "ONE_OFF", startDate: null, endDate: null })).toBeNull();
  });

  it("des dates à l'envers ne produisent pas un total négatif", () => {
    expect(totalCommitment({ amount: 100_000, billing: "MONTHLY", startDate: "2026-07-01", endDate: "2026-01-01" })).toBeNull();
  });

  it("une période plus courte qu'un cycle vaut au moins un cycle", () => {
    expect(totalCommitment({ amount: 100_000, billing: "YEARLY", startDate: "2026-01-01", endDate: "2026-03-01" })).toBe(100_000);
  });
});
