import { describe, it, expect } from "vitest";
import {
  resolveMoneyEntity, checkMoneyEntity, canOverrideEntity, groupByEntity, unassignedWarning,
} from "./money-entity";

const LABELS = { adv: "Adventum Pharma", pha: "Pharmagène" };

describe("l'entité d'un mouvement d'argent", () => {
  it("UN CHOIX EXPLICITE L'EMPORTE SUR TOUT — c'est une décision, pas une déduction", () => {
    expect(resolveMoneyEntity({ explicit: "pha", source: "adv", requester: "adv", department: "adv" })).toBe("pha");
  });

  it("puis le dossier SOURCE — un fait —, puis le demandeur, puis son département", () => {
    expect(resolveMoneyEntity({ source: "pha", requester: "adv", department: "adv" })).toBe("pha");
    expect(resolveMoneyEntity({ requester: "adv", department: "pha" })).toBe("adv");
    expect(resolveMoneyEntity({ department: "pha" })).toBe("pha");
  });

  it("REND `null` QUAND ON NE SAIT PAS — plutôt qu'une entité inventée", () => {
    expect(resolveMoneyEntity({})).toBeNull();
    expect(resolveMoneyEntity({ explicit: "", requester: null, department: undefined })).toBeNull();
  });

  it("une chaîne d'espaces n'est pas une entité", () => {
    expect(resolveMoneyEntity({ explicit: "   ", requester: "adv" })).toBe("adv");
  });
});

describe("l'entité doit être renseignée, et permise", () => {
  it("REFUSE UNE DEMANDE SANS ENTITÉ, et dit pourquoi ça compte", () => {
    const r = checkMoneyEntity(null, ["adv"]);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/entité concernée/i);
  });

  it("REFUSE UNE ENTITÉ QU'ON N'A PAS — et le motif envoie à la bonne porte", () => {
    // Deux refus distincts : « aucune entité » se répare en en choisissant une, « pas la vôtre »
    // en s'adressant à quelqu'un d'autre. Un message unique enverrait la moitié des gens ailleurs.
    const r = checkMoneyEntity("pha", ["adv"]);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/ne vous est pas ouverte/i);
  });

  it("accepte l'entité permise", () => {
    expect(checkMoneyEntity("adv", ["adv", "pha"])).toEqual({ ok: true, companyId: "adv" });
  });

  it("LA VUE GLOBALE ÉCRIT SUR TOUTES LES ENTITÉS, mais doit quand même en nommer une", () => {
    expect(checkMoneyEntity("pha", [], { hasGlobalView: true }).ok).toBe(true);
    expect(checkMoneyEntity(null, [], { hasGlobalView: true }).ok).toBe(false);
  });

  it("UNE LISTE DE DROITS VIDE N'EST PAS LA LISTE DE TOUS LES DROITS", () => {
    expect(checkMoneyEntity("adv", []).ok).toBe(false);
  });
});

describe("corriger l'entité", () => {
  it("LA DIRECTION CORRIGE AU MOMENT OÙ ELLE VALIDE — elle seule a le dossier entier", () => {
    expect(canOverrideEntity({ hasGlobalView: true }, { settled: false })).toBe(true);
    expect(canOverrideEntity({ hasGlobalView: false }, { settled: false })).toBe(false);
  });

  it("PLUS APRÈS LE RÈGLEMENT : déplacer un décaissement déjà inscrit demande une écriture", () => {
    expect(canOverrideEntity({ hasGlobalView: true }, { settled: true })).toBe(false);
  });
});

describe("ranger l'argent par entité", () => {
  const rows = [
    { id: "a", companyId: "adv", amount: 10_000 },
    { id: "b", companyId: "pha", amount: 5_000 },
    { id: "c", companyId: "adv", amount: 2_000 },
    { id: "d", companyId: null, amount: 700 },
  ];
  const read = (r: (typeof rows)[number]) => ({ companyId: r.companyId, amount: r.amount });

  it("CHAQUE SOCIÉTÉ SON TOTAL — un total mélangé n'appartient à personne", () => {
    const g = groupByEntity(rows, read, LABELS);
    expect(g.map((b) => b.label)).toEqual(["Adventum Pharma", "Pharmagène", "Sans entité — à rattacher"]);
    expect(g[0].total).toBe(12_000);
    expect(g[0].rows.map((r) => r.id)).toEqual(["a", "c"]);
    expect(g[1].total).toBe(5_000);
  });

  it("LES MOUVEMENTS SANS ENTITÉ FORMENT LEUR PROPRE GROUPE, en dernier, et il est NOMMÉ", () => {
    // Les noyer dans une société les ferait disparaître, alors que ce sont précisément ceux
    // qu'il faut rattacher.
    const g = groupByEntity(rows, read, LABELS);
    expect(g[g.length - 1].companyId).toBeNull();
    expect(g[g.length - 1].total).toBe(700);
  });

  it("une entité inconnue du référentiel se nomme quand même", () => {
    const g = groupByEntity([{ companyId: "zzz", amount: 1 }], (r) => r, LABELS);
    expect(g[0].label).toBe("Entité inconnue");
  });

  it("une liste vide ne fabrique aucun groupe", () => {
    expect(groupByEntity([], read, LABELS)).toEqual([]);
  });
});

describe("ce que l'écran dit des orphelins", () => {
  it("SE TAIT quand tout est rattaché", () => {
    const g = groupByEntity([{ companyId: "adv", amount: 1 }], (r) => r, LABELS);
    expect(unassignedWarning(g)).toBeNull();
  });

  it("chiffre ce qui n'entre dans la comptabilité de personne", () => {
    const g = groupByEntity([{ companyId: null, amount: 1 }, { companyId: null, amount: 2 }], (r) => r, LABELS);
    expect(unassignedWarning(g)).toMatch(/2 mouvement/);
  });
});
