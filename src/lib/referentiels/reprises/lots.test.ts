import { describe, expect, it } from "vitest";
import { ERREURS_MAX, executerParLots, lireCurseur, sommer, type SourceDeReprise } from "./lots";
import { bilanVide } from "./types";

/** Une source en mémoire : des ids triés, un traitement qui retient ce qui a été traité. */
function source(nom: string, ids: string[], traiter: (id: string) => "CREEE" | "LIEE" | "IGNOREE" | Error = () => "CREEE") {
  const traites: string[] = [];
  const s: SourceDeReprise = {
    nom,
    lire: async (apresId, taille) => ids.filter((id) => !apresId || id > apresId).slice(0, taille).map((id) => ({ id })),
    traiter: async ({ id }) => {
      traites.push(id);
      const r = traiter(id);
      if (r instanceof Error) throw r;
      return { issue: r, doublons: id.endsWith("d") ? 1 : 0 };
    },
  };
  return { s, traites };
}

describe("le parcours par lots", () => {
  it("traverse les sources dans l'ordre, sans sauter ni doubler une ligne, curseur après curseur", async () => {
    const a = source("A", ["a1", "a2", "a3"]);
    const b = source("B", ["b1", "b2d"]);
    const lots: string[][] = [];
    let suite: string | null = null;
    let tours = 0;
    do {
      const avant = [...a.traites, ...b.traites].length;
      const r = await executerParLots([a.s, b.s], { taille: 2, apresId: suite });
      lots.push([...a.traites, ...b.traites].slice(avant));
      suite = r.suite;
    } while (suite && ++tours < 10);
    expect([...a.traites, ...b.traites]).toEqual(["a1", "a2", "a3", "b1", "b2d"]);
    expect(lots).toEqual([["a1", "a2"], ["a3", "b1"], ["b2d"]]);
  });

  it("compte les issues et les doublons proposés", async () => {
    const a = source("A", ["x", "yd", "z"], (id) => (id === "x" ? "LIEE" : id === "z" ? "IGNOREE" : "CREEE"));
    const r = await executerParLots([a.s], { taille: 10 });
    expect(r).toMatchObject({ lues: 3, creees: 1, liees: 1, ignorees: 1, doublonsProposes: 1, suite: null });
  });

  it("une ligne en échec est dite et n'arrête pas le lot", async () => {
    const a = source("A", ["1", "2", "3"], (id) => (id === "2" ? new Error("NIF illisible") : "CREEE"));
    const r = await executerParLots([a.s], { taille: 10 });
    expect(r.creees).toBe(2);
    expect(r.erreurs).toEqual(["A 2 : NIF illisible"]);
  });

  it("les erreurs d'un lot sont plafonnées, et le plafond est dit", async () => {
    const ids = Array.from({ length: ERREURS_MAX + 5 }, (_, i) => String(i).padStart(3, "0"));
    const a = source("A", ids, () => new Error("ko"));
    const r = await executerParLots([a.s], { taille: 100 });
    expect(r.erreurs).toHaveLength(ERREURS_MAX + 1);
    expect(r.erreurs.at(-1)).toMatch(/non détaillées/);
  });

  it("un curseur inconnu est refusé plutôt que de tout reprendre au début", () => {
    expect(lireCurseur(null, ["A"])).toEqual({ index: 0, apresId: null });
    expect(lireCurseur("B:", ["A", "B"])).toEqual({ index: 1, apresId: null });
    expect(lireCurseur("B:x:y", ["A", "B"])).toEqual({ index: 1, apresId: "x:y" });
    expect(() => lireCurseur("Z:1", ["A"])).toThrow(/inconnu/);
  });

  it("l'aperçu additionne les sources", () => {
    const x = { ...bilanVide(), lues: 2, creees: 1, erreurs: ["e1"] };
    const y = { ...bilanVide(), lues: 3, ignorees: 3 };
    expect(sommer([x, y])).toEqual({ lues: 5, creees: 1, liees: 0, doublonsProposes: 0, ignorees: 3, erreurs: ["e1"] });
  });
});
