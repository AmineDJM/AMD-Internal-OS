import { describe, expect, it } from "vitest";
import { classerRappels, ongletInitial, rappelsActifs, type RappelVue } from "./vue";

const NOW = new Date("2026-11-23T10:00:00Z").getTime();
const r = (over: Partial<RappelVue> & { key: string; source: RappelVue["source"]; statut: string; quand: string }): RappelVue => ({
  id: over.key, titre: over.key, note: null, lien: null, recurrence: null, ...over,
});

describe("« Mes rappels » — toutes les sources, quatre onglets (recette du 23/11/2026)", () => {
  const rappels = [
    r({ key: "futur", source: "perso", statut: "PENDING", quand: "2026-11-25T09:00:00Z" }),
    r({ key: "bientot", source: "perso", statut: "PENDING", quand: "2026-11-23T15:00:00Z" }),
    r({ key: "echu", source: "perso", statut: "SENT", quand: "2026-11-22T09:00:00Z" }),
    r({ key: "passe-non-envoye", source: "perso", statut: "PENDING", quand: "2026-11-23T09:00:00Z" }),
    r({ key: "fait", source: "perso", statut: "DONE", quand: "2026-11-20T09:00:00Z" }),
    r({ key: "assistant", source: "assistant", statut: "ACTIVE", quand: "2026-11-24T08:00:00Z", recurrence: "toutes les semaines" }),
    r({ key: "assistant-arrete", source: "assistant", statut: "INACTIVE", quand: "2026-11-01T08:00:00Z" }),
    r({ key: "recu-lu", source: "recu", statut: "LU", quand: "2026-11-22T08:00:00Z" }),
    r({ key: "recu-non-lu", source: "recu", statut: "NON_LU", quand: "2026-11-21T08:00:00Z" }),
  ];
  const c = classerRappels(rappels, NOW);

  it("range chaque rappel dans son onglet, dans l'ordre utile", () => {
    expect(c.a_venir.map((x) => x.key)).toEqual(["bientot", "assistant", "futur"]);
    expect(c.echus.map((x) => x.key)).toEqual(["echu", "passe-non-envoye"]);
    expect(c.recus.map((x) => x.key)).toEqual(["recu-non-lu", "recu-lu"]);
    expect(c.termines.map((x) => x.key)).toEqual(["fait", "assistant-arrete"]);
  });

  it("ouvre sur les échus d'abord, et compte ce qui reste à traiter", () => {
    expect(ongletInitial(c)).toBe("echus");
    expect(rappelsActifs(c)).toBe(5);
  });
});
