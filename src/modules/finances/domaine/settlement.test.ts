import { describe, it, expect } from "vitest";
import {
  settlementState, deferralIsActive, checkDeferral, deferralNote, sortForSettlement,
  SETTLEMENT_LABEL, type SettlementLike,
} from "./settlement";

const NOW = new Date("2026-09-01T10:00:00Z");
const ordre = (o: Partial<SettlementLike> = {}): SettlementLike => ({ status: "PENDING", deferredUntil: null, ...o });

describe("les trois états du décaissement — et il n'y en a pas un quatrième", () => {
  it("non payé par DÉFAUT : rien n'a été fait, l'argent doit sortir", () => {
    expect(settlementState(ordre(), NOW)).toBe("UNPAID");
  });

  it("payé quand l'ordre est réglé", () => {
    expect(settlementState(ordre({ status: "PAID" }), NOW)).toBe("PAID");
  });

  it("reporté tant que la date de report est à venir", () => {
    expect(settlementState(ordre({ deferredUntil: "2026-09-20" }), NOW)).toBe("DEFERRED");
    expect(deferralIsActive(ordre({ deferredUntil: "2026-09-20" }), NOW)).toBe(true);
  });

  it("UN REPORT ÉCHU N'EST PLUS UN REPORT — l'ordre redevient dû tout seul", () => {
    // C'est la raison d'être du modèle : si « reporté » était un statut, quelqu'un devrait
    // penser à le remettre à « non payé » le jour venu. Personne ne le ferait.
    expect(settlementState(ordre({ deferredUntil: "2026-08-20" }), NOW)).toBe("UNPAID");
    expect(deferralIsActive(ordre({ deferredUntil: "2026-08-20" }), NOW)).toBe(false);
  });

  it("un ordre PAYÉ reste payé, même s'il portait un report", () => {
    expect(settlementState(ordre({ status: "PAID", deferredUntil: "2026-12-01" }), NOW)).toBe("PAID");
  });

  it("une date illisible ne fait pas croire à un report", () => {
    expect(settlementState(ordre({ deferredUntil: "pas une date" }), NOW)).toBe("UNPAID");
  });

  it("les trois libellés sont ceux qu'on a demandés", () => {
    expect(SETTLEMENT_LABEL.UNPAID).toBe("Non payé");
    expect(SETTLEMENT_LABEL.DEFERRED).toBe("Paiement reporté");
    expect(SETTLEMENT_LABEL.PAID).toBe("Payé");
  });
});

describe("poser un report", () => {
  it("exige une date", () => {
    const r = checkDeferral({ order: ordre(), until: null, reason: null, deadlineNature: "MODERATE" }, NOW);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/date/i);
  });

  it("REFUSE une date passée — sinon l'écran dirait « reporté » puis « non payé » dans la seconde", () => {
    const r = checkDeferral({ order: ordre(), until: "2026-08-01", reason: null, deadlineNature: "MODERATE" }, NOW);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/à venir/i);
  });

  it("accepte une date à venir, sans motif, sur une échéance moyenne", () => {
    const r = checkDeferral({ order: ordre(), until: "2026-09-30", reason: null, deadlineNature: "MODERATE" }, NOW);
    expect(r.ok).toBe(true);
    expect(r.until?.toISOString().slice(0, 10)).toBe("2026-09-30");
  });

  it("EXIGE UN MOTIF quand le demandeur a déclaré l'échéance fixe non négociable", () => {
    const sans = checkDeferral({ order: ordre(), until: "2026-09-30", reason: "   ", deadlineNature: "FIXED" }, NOW);
    expect(sans.ok).toBe(false);
    expect(sans.reason).toMatch(/non négociable/i);

    const avec = checkDeferral({ order: ordre(), until: "2026-09-30", reason: "Trésorerie insuffisante avant le 25.", deadlineNature: "FIXED" }, NOW);
    expect(avec.ok).toBe(true);
  });

  it("un motif n'est PAS exigé sur une échéance importante — le report s'y discute, il ne s'interdit pas", () => {
    expect(checkDeferral({ order: ordre(), until: "2026-09-30", reason: null, deadlineNature: "IMPORTANT" }, NOW).ok).toBe(true);
  });

  it("un ordre déjà réglé ne se reporte pas", () => {
    const r = checkDeferral({ order: ordre({ status: "PAID" }), until: "2026-09-30", reason: null, deadlineNature: "MODERATE" }, NOW);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/déjà réglé/i);
  });
});

describe("ce que l'écran écrit sur un ordre reporté", () => {
  const fmt = (d: Date) => d.toISOString().slice(0, 10);

  it("nomme la date, et le motif quand il y en a un", () => {
    const n = deferralNote({ status: "PENDING", deferredUntil: "2026-09-20", deferredReason: "Trésorerie" }, fmt, NOW);
    expect(n).toContain("2026-09-20");
    expect(n).toContain("Trésorerie");
  });

  it("DIT qu'un report est échu — c'est ce silence qui fait qu'on ne paie jamais", () => {
    const n = deferralNote({ status: "PENDING", deferredUntil: "2026-08-20", deferredReason: null }, fmt, NOW);
    expect(n).toMatch(/de nouveau dû/i);
  });

  it("rien à écrire sans report, ni sur un ordre payé", () => {
    expect(deferralNote({ status: "PENDING", deferredUntil: null }, fmt, NOW)).toBeNull();
    expect(deferralNote({ status: "PAID", deferredUntil: "2026-09-20" }, fmt, NOW)).toBeNull();
  });
});

describe("l'ordre de la file à régler", () => {
  const row = (id: string, o: Partial<{ status: string; deferredUntil: string | null; dueDate: string | null; deadlineNature: string | null; createdAt: string }> = {}) => ({
    id, status: "PENDING", deferredUntil: null, dueDate: null, deadlineNature: null, createdAt: "2026-01-01", ...o,
  });

  it("ce qui est DÛ passe avant ce qui est reporté", () => {
    const rows = [row("reporte", { deferredUntil: "2026-09-05", dueDate: "2026-09-02" }), row("du", { dueDate: "2026-09-30" })];
    expect(sortForSettlement(rows, NOW).map((r) => r.id)).toEqual(["du", "reporte"]);
  });

  it("un report ÉCHU retombe dans la file des ordres dus, à sa date d'échéance", () => {
    const rows = [row("tard", { dueDate: "2026-12-01" }), row("echu", { deferredUntil: "2026-08-01", dueDate: "2026-09-02" })];
    expect(sortForSettlement(rows, NOW).map((r) => r.id)).toEqual(["echu", "tard"]);
  });

  it("à date égale, l'échéance FIXE non négociable passe devant", () => {
    const rows = [
      row("moyenne", { dueDate: "2026-09-10", deadlineNature: "MODERATE" }),
      row("fixe", { dueDate: "2026-09-10", deadlineNature: "FIXED" }),
      row("importante", { dueDate: "2026-09-10", deadlineNature: "IMPORTANT" }),
    ];
    expect(sortForSettlement(rows, NOW).map((r) => r.id)).toEqual(["fixe", "importante", "moyenne"]);
  });

  it("un ordre SANS échéance ne double pas ceux qui en ont une", () => {
    const rows = [row("sans"), row("avec", { dueDate: "2026-11-01" })];
    expect(sortForSettlement(rows, NOW).map((r) => r.id)).toEqual(["avec", "sans"]);
  });

  it("à tout égal, l'ancienneté tranche — et l'ordre reste stable", () => {
    const rows = [row("recent", { createdAt: "2026-06-01" }), row("ancien", { createdAt: "2026-02-01" })];
    expect(sortForSettlement(rows, NOW).map((r) => r.id)).toEqual(["ancien", "recent"]);
  });

  it("ne modifie pas le tableau reçu", () => {
    const rows = [row("b", { dueDate: "2026-12-01" }), row("a", { dueDate: "2026-09-01" })];
    sortForSettlement(rows, NOW);
    expect(rows.map((r) => r.id)).toEqual(["b", "a"]);
  });
});
