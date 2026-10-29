import { describe, it, expect } from "vitest";
import {
  dossierOriginOf, isCompanionDossier, needsCompanionDossier, companionStatusForOrder,
  companionPayee, companionNotice, canDecideFromDossier, nudgeKindOf, canNudge, nudgeMessage,
  NUDGE_COOLDOWN_MINUTES, NUDGE_LABEL, DOSSIER_ORIGINS,
} from "./dossier-auto";

describe("d'où vient un dossier de paiement", () => {
  it("DEUX ORIGINES, ET LA VALEUR INCONNUE VAUT L'HISTORIQUE", () => {
    // Se tromper dans l'autre sens retirerait « bon à payer » aux demandes natives d'avant.
    expect(DOSSIER_ORIGINS).toEqual(["REQUEST", "EXPENSE_ORDER"]);
    expect(dossierOriginOf("EXPENSE_ORDER")).toBe("EXPENSE_ORDER");
    expect(dossierOriginOf("REQUEST")).toBe("REQUEST");
    expect(dossierOriginOf(null)).toBe("REQUEST");
    expect(dossierOriginOf("n'importe quoi")).toBe("REQUEST");
  });

  it("le compagnon se reconnaît, et lui seul", () => {
    expect(isCompanionDossier("EXPENSE_ORDER")).toBe(true);
    expect(isCompanionDossier("REQUEST")).toBe(false);
    expect(isCompanionDossier(undefined)).toBe(false);
  });
});

describe("quels ordres reçoivent un dossier", () => {
  it("TOUS — matériel promo, bon de versement, sponsoring, avance, et même une source inconnue", () => {
    for (const s of [
      "PROMO_MATERIAL", "SPONSORING", "CONGRESS_NATIONAL", "CONGRESS_INTERNATIONAL",
      "MEDICAL_INFO_DECLARATION", "ADMIN_REQUEST", "REGULATORY_PRODUCT", "SALARY_ADVANCE",
      "AD_PRO_ITEM", "LEGAL_DOCUMENT", "EVENT", "CONSULTING_CONTRACT",
    ]) {
      expect(needsCompanionDossier(s), s).toBe(true);
    }
    // Une source absente ou inconnue en reçoit un AUSSI : une liste blanche se complète en
    // l'oubliant, et c'est exactement ce qui a produit le défaut d'origine.
    expect(needsCompanionDossier(null)).toBe(true);
    expect(needsCompanionDossier("UN_TYPE_QUI_N_EXISTE_PAS_ENCORE")).toBe(true);
  });

  it("SAUF la demande de paiement — elle EST déjà son dossier", () => {
    expect(needsCompanionDossier("PAYMENT_REQUEST")).toBe(false);
  });
});

describe("l'état du dossier compagnon suit l'ordre, il ne se saisit pas", () => {
  it("à régler → chez les Finances ; réglé → soldé ; annulé → annulé", () => {
    expect(companionStatusForOrder("PENDING")).toBe("SUBMITTED");
    expect(companionStatusForOrder("PAID")).toBe("APPROVED");
    expect(companionStatusForOrder("CANCELLED")).toBe("CANCELLED");
  });

  it("un état d'ordre inconnu reste « chez les Finances » — visible, pas soldé en silence", () => {
    expect(companionStatusForOrder(null)).toBe("SUBMITTED");
    expect(companionStatusForOrder("QUELQUE_CHOSE")).toBe("SUBMITTED");
  });
});

describe("le bénéficiaire, que le dossier exige", () => {
  it("le prend sur l'ordre quand il y en a un", () => {
    expect(companionPayee("Agence Zed", "Matériel promo")).toBe("Agence Zed");
    expect(companionPayee("  Agence Zed  ", "x")).toBe("Agence Zed");
  });

  it("À DÉFAUT, LE LIBELLÉ — pas un tiret, qui serait un faux", () => {
    // Une avance sur salaire, un versement à une autorité : il n'y a pas toujours de nom.
    expect(companionPayee(null, "Avance sur salaire — M. Benali")).toBe("Avance sur salaire — M. Benali");
    expect(companionPayee("   ", "Bon de versement")).toBe("Bon de versement");
    expect(companionPayee(null, "   ")).toBe("Bénéficiaire non précisé");
  });
});

describe("un compagnon ne se décide pas ici, et le dit", () => {
  it("LE REFUS NOMME L'ÉCRAN — un bouton absent sans explication se lit comme un droit manquant", () => {
    const r = canDecideFromDossier("EXPENSE_ORDER");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/centre de paiement/i);
    expect(r.reason).toMatch(/Finances/);
  });

  it("une demande native, elle, garde son bon à payer", () => {
    expect(canDecideFromDossier("REQUEST").ok).toBe(true);
    expect(canDecideFromDossier(null).ok).toBe(true);
  });

  it("la note d'en-tête cite l'ordre quand on le connaît", () => {
    expect(companionNotice("OD-2026-014")).toContain("OD-2026-014");
    expect(companionNotice(null)).toMatch(/centre de paiement/i);
  });
});

describe("relancer, ou signaler une urgence", () => {
  const base = { status: "SUBMITTED", kind: "REMINDER" as const, comment: null };

  it("DEUX GESTES DISTINCTS — les confondre ferait de chaque relance une urgence", () => {
    expect(nudgeKindOf("URGENT")).toBe("URGENT");
    expect(nudgeKindOf("REMINDER")).toBe("REMINDER");
    expect(nudgeKindOf(null)).toBe("REMINDER");
    expect(NUDGE_LABEL.URGENT).toMatch(/urgence/i);
  });

  it("seulement quand le dossier est CHEZ LES FINANCES", () => {
    for (const s of ["SUBMITTED", "UNDER_REVIEW", "ON_HOLD"]) {
      expect(canNudge({ ...base, status: s }).ok, s).toBe(true);
    }
    for (const s of ["DRAFT", "CHANGES_REQUESTED", "APPROVED", "REJECTED", "CANCELLED"]) {
      const r = canNudge({ ...base, status: s });
      expect(r.ok, s).toBe(false);
      expect(r.reason).toMatch(/Finances/);
    }
  });

  it("UNE URGENCE SANS MOTIF N'EST PAS UNE URGENCE — c'est une case cochée", () => {
    const r = canNudge({ ...base, kind: "URGENT", comment: "   " });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/pourquoi/i);
    expect(canNudge({ ...base, kind: "URGENT", comment: "La quittance expire vendredi." }).ok).toBe(true);
  });

  it("une relance ordinaire n'exige pas de commentaire — « où en est-on ? » se suffit", () => {
    expect(canNudge({ ...base, comment: null }).ok).toBe(true);
  });

  it("PAS DEUX FOIS DANS L'HEURE — sinon la notification devient du bruit et la vraie passe", () => {
    const now = new Date("2026-03-10T12:00:00Z");
    const recent = new Date("2026-03-10T11:30:00Z");
    const r = canNudge({ ...base, lastNudgeAt: recent, now });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/moins d'une heure/);
    expect(r.reason).toMatch(/30 min/);
    expect(NUDGE_COOLDOWN_MINUTES).toBe(60);
  });

  it("passé le délai, on relance de nouveau", () => {
    const now = new Date("2026-03-10T12:00:00Z");
    expect(canNudge({ ...base, lastNudgeAt: new Date("2026-03-10T10:30:00Z"), now }).ok).toBe(true);
    // Une date illisible ne bloque pas : on ne refuse pas un geste utile sur une donnée abîmée.
    expect(canNudge({ ...base, lastNudgeAt: "pas une date", now }).ok).toBe(true);
  });

  it("le message dit la nature ET le motif — c'est lui que les Finances liront", () => {
    expect(nudgeMessage("URGENT", "PAY-2026-007", "Pénalité de retard au 15."))
      .toBe("PAY-2026-007 — paiement signalé URGENT : Pénalité de retard au 15.");
    expect(nudgeMessage("REMINDER", "PAY-2026-007", null)).toBe("PAY-2026-007 — relance du demandeur");
  });
});
