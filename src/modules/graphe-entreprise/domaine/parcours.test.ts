import { describe, expect, it } from "vitest";
import type { AreteDatee } from "./noeuds";
import { cheminVers, noeudsRendus, parcourir, type PortsParcours } from "./parcours";

const a = (de: string, vers: string, relation = "lie_a", depuis: string | null = null, jusqua: string | null = null): AreteDatee => ({
  de, a: vers, relation, depuis: depuis ? new Date(depuis) : null, jusqua: jusqua ? new Date(jusqua) : null, source: { table: "T", id: `${de}>${vers}` },
});

function ports(aretes: AreteDatee[], interdits: string[] = [], vus: string[][] = []): PortsParcours {
  return {
    etendre: async (refs) => { vus.push(refs); const s = new Set(refs); return aretes.filter((x) => s.has(x.de) || s.has(x.a)); },
    autoriser: async (refs) => new Set(refs.filter((r) => !interdits.includes(r))),
  };
}

const G = [
  a("ORGANISATION:f", "DOSSIER:d1", "fourni_par"), a("DOSSIER:d1", "PRODUIT:p1", "concerne"),
  a("PERSONNE:k", "DOSSIER:d1", "responsable_de", "2025-01-01", "2026-03-01"), a("PERSONNE:s", "DOSSIER:d1", "responsable_de", "2026-03-01"),
  a("DOCUMENT:x", "PRODUIT:p1", "mentionne"), a("ORGANISATION:f", "DOSSIER:secret", "fourni_par"), a("DOSSIER:secret", "PRODUIT:cache", "concerne"),
];

describe("parcours borné", () => {
  it("suit les chemins jusqu'à la profondeur demandée et recompose le chemin", async () => {
    const r = await parcourir("ORGANISATION:f", ports(G), { profondeur: 3 });
    expect(noeudsRendus(r, ["DOCUMENT"])).toEqual(["DOCUMENT:x"]);
    expect(cheminVers(r, "DOCUMENT:x").map((e) => e.relation)).toEqual(["fourni_par", "concerne", "mentionne"]);
  });

  it("ne rend ni ne TRAVERSE un nœud hors droits (jugé avant d'étendre)", async () => {
    const vus: string[][] = [];
    const r = await parcourir("ORGANISATION:f", ports(G, ["DOSSIER:secret"], vus), { profondeur: 3 });
    expect([...r.noeuds.keys()]).not.toContain("DOSSIER:secret");
    expect([...r.noeuds.keys()]).not.toContain("PRODUIT:cache");
    expect(vus.flat()).not.toContain("DOSSIER:secret");
  });

  it("un départ hors droits est refusé sans rien lire", async () => {
    const vus: string[][] = [];
    const r = await parcourir("DOSSIER:secret", ports(G, ["DOSSIER:secret"], vus));
    expect(r.refuse).toBe(true);
    expect(vus).toEqual([]);
  });

  it("à une date, seules les arêtes valides ce jour-là", async () => {
    const avant = await parcourir("DOSSIER:d1", ports(G), { profondeur: 1, relations: ["responsable_de"], aLaDate: new Date("2025-06-01") });
    expect(noeudsRendus(avant)).toEqual(["PERSONNE:k"]);
    const apres = await parcourir("DOSSIER:d1", ports(G), { profondeur: 1, relations: ["responsable_de"], aLaDate: new Date("2026-06-01") });
    expect(noeudsRendus(apres)).toEqual(["PERSONNE:s"]);
  });

  it("borne la largeur et le dit", async () => {
    const etoile = Array.from({ length: 50 }, (_, i) => a("ORGANISATION:c", `PERSONNE:${i}`));
    const r = await parcourir("ORGANISATION:c", ports(etoile), { profondeur: 1, noeudsParSaut: 10 });
    expect(r.noeuds.size).toBe(11);
    expect(r.tronque).toBe(true);
  });
});
