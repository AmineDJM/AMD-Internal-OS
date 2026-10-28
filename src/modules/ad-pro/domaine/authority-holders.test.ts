import { describe, it, expect } from "vitest";
import { authoritiesOf, orphanAuthorities, isNominative, isOrphan, type HolderConfig } from "./authority-holders";

/** La configuration de départ, telle que la migration la pose. */
const CONFIG: HolderConfig[] = [
  { authority: "NATIONAL_SUPERVISOR", roles: ["NATIONAL_SALES"], userIds: [] },
  { authority: "PRODUCT_MANAGER", roles: ["PRODUCT_MANAGER"], userIds: [] },
  { authority: "HR", roles: ["FINANCE_BUDGET_MANAGER"], userIds: [] },
  { authority: "OPERATIONS", roles: ["DIRECTION"], userIds: [] },
  { authority: "GENERAL_MANAGEMENT", roles: [], userIds: ["amine"] },
  { authority: "FINANCE", roles: ["FINANCE_BUDGET_MANAGER"], userIds: [] },
];

describe("l'autorité se rattache au RÔLE, pas à la personne", () => {
  it("le directeur des opérations exerce par son RÔLE — changer de personne ne casse rien", () => {
    expect(authoritiesOf({ id: "qui-que-ce-soit", role: "DIRECTION" }, CONFIG)).toContain("OPERATIONS");
    expect(authoritiesOf({ id: "son-successeur", role: "DIRECTION" }, CONFIG)).toContain("OPERATIONS");
  });

  it("chaque autorité métier suit son rôle", () => {
    expect(authoritiesOf({ id: "u", role: "NATIONAL_SALES" }, CONFIG)).toEqual(["NATIONAL_SUPERVISOR"]);
    expect(authoritiesOf({ id: "u", role: "PRODUCT_MANAGER" }, CONFIG)).toEqual(["PRODUCT_MANAGER"]);
  });

  it("le SECOND rôle vaut autant que le premier", () => {
    // Nommé Direction Marketing « en plus » de sa fonction : il exerce réellement cette autorité.
    const a = authoritiesOf({ id: "u", role: "SALES_USER", secondaryRole: "PRODUCT_MANAGER" }, CONFIG);
    expect(a).toContain("PRODUCT_MANAGER");
  });

  it("qui ne porte rien n'exerce rien", () => {
    expect(authoritiesOf({ id: "u", role: "VIEWER" }, CONFIG)).toEqual([]);
    expect(authoritiesOf({ id: "u", role: "MEDICAL_DELEGATE" }, CONFIG)).toEqual([]);
  });
});

describe("la direction générale est la seule autorité NOMINATIVE", () => {
  it("Amine l'exerce nommément, pas par un rôle", () => {
    expect(authoritiesOf({ id: "amine", role: "VIEWER" }, CONFIG)).toContain("GENERAL_MANAGEMENT");
  });

  it("personne d'autre ne l'exerce, quel que soit son rôle", () => {
    expect(authoritiesOf({ id: "autre", role: "DIRECTION" }, CONFIG)).not.toContain("GENERAL_MANAGEMENT");
    expect(authoritiesOf({ id: "autre", role: "SUPER_ADMIN" }, CONFIG)).not.toContain("GENERAL_MANAGEMENT");
  });

  it("elle est la seule que l'on puisse transférer — un rôle ne se transfère pas, il se réattribue", () => {
    expect(isNominative(CONFIG.find((c) => c.authority === "GENERAL_MANAGEMENT")!)).toBe(true);
    expect(isNominative(CONFIG.find((c) => c.authority === "OPERATIONS")!)).toBe(false);
  });
});

describe("transfert : Khaled exerce à la place d'Amine, le temps du transfert", () => {
  const transferred: HolderConfig[] = CONFIG.map((c) =>
    c.authority === "GENERAL_MANAGEMENT" ? { ...c, delegatedToUserId: "khaled" } : c);

  it("le destinataire du transfert exerce l'autorité", () => {
    expect(authoritiesOf({ id: "khaled", role: "VIEWER" }, transferred)).toContain("GENERAL_MANAGEMENT");
  });

  it("le titulaire la CONSERVE — transférer n'est pas se dessaisir", () => {
    expect(authoritiesOf({ id: "amine", role: "VIEWER" }, transferred)).toContain("GENERAL_MANAGEMENT");
  });

  it("le transfert ne profite à personne d'autre", () => {
    expect(authoritiesOf({ id: "tiers", role: "DIRECTION" }, transferred)).not.toContain("GENERAL_MANAGEMENT");
  });
});

describe("autorité sans titulaire — à signaler avant qu'un paiement ne se bloque", () => {
  it("repère une autorité que personne ne porte", () => {
    const broken: HolderConfig[] = [{ authority: "OPERATIONS", roles: [], userIds: [] }];
    expect(isOrphan(broken[0])).toBe(true);
    expect(orphanAuthorities(broken)).toEqual(["OPERATIONS"]);
  });

  it("la configuration de départ ne laisse aucune autorité orpheline", () => {
    expect(orphanAuthorities(CONFIG)).toEqual([]);
  });
});
