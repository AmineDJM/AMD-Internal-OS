import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { demenagements } from "./demenagements";
import { cheminActuel, fichierDuSymbole, lireSource, sourceDuSymbole } from "./source";

/**
 * Un test de structure ne s'enchaîne plus à l'adresse d'un fichier (rapport d'audit 08, ARCH-05).
 * Les exemples sont réels : le coffre et les lieux ont déménagé dans `src/modules/` (lot V3-G).
 */
describe("lire le source sans chemin figé", () => {
  it("les adresses de réexpédition viennent de tsconfig.json, et chacune mène à un fichier", () => {
    const d = demenagements();
    expect(d.length).toBeGreaterThan(0);
    expect(d.find((x) => x.ancien === "@/lib/coffre/cle")?.nouveauChemin).toBe("src/modules/coffre/infra/cle");
  });

  it("un ancien chemin se lit à la nouvelle place", () => {
    expect(cheminActuel("src/lib/coffre/cle.ts")).toBe("src/modules/coffre/infra/cle.ts");
    expect(cheminActuel("src/lib/lieux/normaliser")).toBe("src/modules/lieux/domaine/normaliser.ts");
    expect(lireSource("src/lib/coffre/cle.ts")).toBe(fs.readFileSync("src/modules/coffre/infra/cle.ts", "utf8"));
  });

  it("un chemin qui n'a pas bougé reste tel quel", () => {
    expect(cheminActuel("src/lib/prisma.ts")).toBe("src/lib/prisma.ts");
  });

  it("un symbole désigne le fichier qui le déclare", () => {
    expect(fichierDuSymbole("reposerWilayaCode")).toBe("src/modules/lieux/infra/rattachement-prisma.ts");
    expect(sourceDuSymbole("doubleEcrireCoffre")).toContain("export async function doubleEcrireCoffre");
  });

  it("un symbole ambigu ou absent est refusé (un test vise une règle sans ambiguïté)", () => {
    // `lireJournal` est déclaré par le coffre ET par les reprises du référentiel.
    expect(() => fichierDuSymbole("lireJournal")).toThrow(/2 déclarations/);
    expect(() => fichierDuSymbole("symboleQuiNExistePas")).toThrow(/aucune/);
  });
});
