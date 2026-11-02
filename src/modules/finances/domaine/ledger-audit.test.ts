import { describe, it, expect } from "vitest";
import {
  missingEntries, missingCashEntries, doubleSettledSources, duplicateEntries, auditLedger, auditSummary,
  type LedgerEntry, type SettledOrder,
} from "./ledger-audit";

const order = (o: Partial<SettledOrder> & { reference: string }): SettledOrder => ({
  id: o.id ?? o.reference,
  label: o.label ?? "Fourniture",
  amount: o.amount ?? 100000,
  transactionId: o.transactionId ?? "tx-1",
  sourceType: o.sourceType ?? null,
  sourceId: o.sourceId ?? null,
  paidDate: o.paidDate ?? "2026-03-12T00:00:00.000Z",
  ...o,
});

const entry = (o: Partial<LedgerEntry> & { id: string }): LedgerEntry => ({
  reference: o.reference ?? o.id,
  direction: o.direction ?? "OUT",
  amount: o.amount ?? 100000,
  label: o.label ?? "Règlement",
  counterparty: o.counterparty ?? "Papeterie du Centre",
  date: o.date ?? "2026-03-12T00:00:00.000Z",
  ...o,
});

describe("un paiement sans écriture — le contrôle le plus grave", () => {
  it("UN ORDRE RÉGLÉ SANS ÉCRITURE EST SIGNALÉ : l'argent est sorti, le livre l'ignore", () => {
    const f = missingEntries([order({ reference: "OD-2026-014", transactionId: null })], new Set(["tx-1"]));
    expect(f).toHaveLength(1);
    expect(f[0].kind).toBe("MISSING_ENTRY");
    expect(f[0].severity).toBe("HIGH");
    expect(f[0].references).toEqual(["OD-2026-014"]);
    expect(f[0].detail).toMatch(/12\/03\/2026/);
  });

  it("UNE RÉFÉRENCE QUI POINTE UNE ÉCRITURE DISPARUE COMPTE PAREIL — et c'est plus trompeur", () => {
    // Tout a l'air en ordre : le champ est rempli. L'écriture, elle, n'existe plus.
    const f = missingEntries([order({ reference: "OD-2026-015", transactionId: "tx-effacee" })], new Set(["tx-1"]));
    expect(f).toHaveLength(1);
  });

  it("un ordre correctement comptabilisé ne dit rien", () => {
    expect(missingEntries([order({ reference: "OD-2026-016", transactionId: "tx-1" })], new Set(["tx-1"]))).toEqual([]);
  });
});

describe("une caisse remise sans écriture — le même défaut, par une autre porte", () => {
  it("LA SORTIE QUI FAIT EXISTER LE FOND EST SIGNALÉE quand elle manque au livre", () => {
    // Les dépenses de la caisse étaient suivies ; la remise initiale, non. Le solde comptable et
    // le solde bancaire divergeaient d'autant.
    const f = missingCashEntries(
      [{ id: "c1", label: "Caisse d'avance — Logistique", amount: 80000, transactionId: null, date: "2026-03-01T00:00:00.000Z" }],
      new Set(["tx-1"]),
    );
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe("HIGH");
    expect(f[0].detail).toMatch(/quitté la banque/);
    expect(f[0].detail).toMatch(/01\/03\/2026/);
  });

  it("une remise comptabilisée ne dit rien", () => {
    expect(missingCashEntries(
      [{ id: "c1", label: "Caisse", amount: 80000, transactionId: "tx-1", date: null }],
      new Set(["tx-1"]),
    )).toEqual([]);
  });
});

describe("une même dépense réglée par deux ordres", () => {
  it("LE SOUPÇON LE PLUS SÛR — on DÉSIGNE la dépense, on ne devine pas d'après des montants", () => {
    // Cas réel : le matériel promotionnel émet un ordre au bordereau, puis un au règlement final.
    const f = doubleSettledSources([
      order({ reference: "OD-2026-020", sourceType: "PROMO_MATERIAL", sourceId: "pm-1", amount: 300000 }),
      order({ reference: "OD-2026-031", sourceType: "PROMO_MATERIAL", sourceId: "pm-1", amount: 300000 }),
    ]);
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe("HIGH");
    expect(f[0].references).toEqual(["OD-2026-020", "OD-2026-031"]);
    expect(f[0].amount).toBe(600000);
    // Il n'ACCUSE pas : acompte puis solde reste une lecture possible, et c'est dit.
    expect(f[0].detail).toMatch(/Acompte puis solde/i);
  });

  it("deux dépenses DIFFÉRENTES du même module ne se ressemblent pas", () => {
    expect(doubleSettledSources([
      order({ reference: "A", sourceType: "PROMO_MATERIAL", sourceId: "pm-1" }),
      order({ reference: "B", sourceType: "PROMO_MATERIAL", sourceId: "pm-2" }),
    ])).toEqual([]);
  });

  it("un ordre SANS origine n'est rapproché de rien — deux inconnues ne font pas une paire", () => {
    expect(doubleSettledSources([
      order({ reference: "A", sourceType: null, sourceId: null }),
      order({ reference: "B", sourceType: null, sourceId: null }),
    ])).toEqual([]);
  });
});

describe("deux écritures identiques le même jour", () => {
  it("MÊME SENS, MÊME MONTANT, MÊME TIERS, MÊME JOUR — et rien de plus large", () => {
    const f = duplicateEntries([
      entry({ id: "1", reference: "FIN-2026-101" }),
      entry({ id: "2", reference: "FIN-2026-118" }),
    ]);
    expect(f).toHaveLength(1);
    expect(f[0].kind).toBe("DUPLICATE_ENTRY");
    // INFO, pas HIGH : deux factures du même montant le même jour, cela arrive.
    expect(f[0].severity).toBe("INFO");
    expect(f[0].references).toEqual(["FIN-2026-101", "FIN-2026-118"]);
    // Le montant EN JEU est celui du surplus, pas la somme des deux.
    expect(f[0].amount).toBe(100000);
    expect(f[0].detail).toMatch(/à vérifier, pas à supprimer/);
  });

  it("UN JOUR D'ÉCART SUFFIT À NE PLUS RAPPROCHER — sinon le contrôle crie tous les jours", () => {
    expect(duplicateEntries([
      entry({ id: "1", date: "2026-03-12T00:00:00.000Z" }),
      entry({ id: "2", date: "2026-03-13T00:00:00.000Z" }),
    ])).toEqual([]);
  });

  it("un encaissement et un décaissement du même montant ne se rapprochent pas", () => {
    expect(duplicateEntries([
      entry({ id: "1", direction: "OUT" }),
      entry({ id: "2", direction: "IN" }),
    ])).toEqual([]);
  });

  it("DEUX ÉCRITURES ANONYMES NE PROUVENT RIEN — la contrepartie vide n'est pas rapprochée", () => {
    expect(duplicateEntries([
      entry({ id: "1", counterparty: null }),
      entry({ id: "2", counterparty: "  " }),
    ])).toEqual([]);
  });
});

describe("le contrôle complet", () => {
  it("SE LIT DANS L'ORDRE : ce qui manque, la double dépense, puis les ressemblances", () => {
    const a = auditLedger(
      [
        order({ reference: "OD-1", transactionId: null, amount: 50000 }),
        order({ reference: "OD-2", sourceType: "SPONSORING", sourceId: "s-1", amount: 200000 }),
        order({ reference: "OD-3", sourceType: "SPONSORING", sourceId: "s-1", amount: 200000 }),
      ],
      [entry({ id: "tx-1", reference: "FIN-1" }), entry({ id: "tx-2", reference: "FIN-2" })],
    );
    expect(a.findings.map((f) => f.kind)).toEqual(["MISSING_ENTRY", "DOUBLE_ORDER", "DUPLICATE_ENTRY"]);
    // « En jeu » ne compte QUE les soupçons graves : la ressemblance n'est pas une perte.
    expect(a.atRisk).toBe(50000 + 400000);
    expect(a.clean).toBe(false);
    expect(auditSummary(a)).toMatch(/2 écarts à traiter/);
    expect(auditSummary(a)).toMatch(/1 ressemblance à vérifier/);
  });

  it("UN LIVRE SAIN LE DIT — un écran muet se lit comme un écran en panne", () => {
    const a = auditLedger([order({ reference: "OD-1", transactionId: "tx-1" })], [entry({ id: "tx-1" })]);
    expect(a.clean).toBe(true);
    expect(a.atRisk).toBe(0);
    expect(auditSummary(a)).toMatch(/Aucun écart/);
  });
});
