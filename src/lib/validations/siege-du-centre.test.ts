import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Un cliquet juge le CODE, pas la prose qui le décrit (§118.79d). */
const sans = (p: string) => readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/**
 * QUI SIÈGE AU CENTRE — LE PLUS ANCIEN, ET JAMAIS LE DEMANDEUR (§118.148h, vague « restes »).
 *
 * `centreValidatorFrom` prend le PREMIER Directeur Général de la liste qu'on lui donne : l'ordre de cette liste
 * EST la règle. Sans `orderBy`, Postgres la rendait dans l'ordre physique de la table — un compte neuf logé avant
 * le siège désigné devenait le centre (mesuré par le banc des signataires : ctid (7,44) contre (8,51)), et s'il
 * était le demandeur la chaîne perdait sa marche en annonçant qu'aucun siège n'existait. La règle se vérifie à
 * chaque POINT D'APPEL (§118.49) : le corps de `centreValidatorFrom` est juste, c'est la liste qu'on lui passait
 * qui ne l'était pas. Un cas en base ne la départagerait pas : le siège stable de la suite est le plus ancien, donc
 * l'ordre physique et l'ordre de création coïncident presque toujours — un banc qui ne tombe que certains jours
 * n'est pas une garde (§118.17).
 */
describe("le siège du centre de validations", () => {
  // L'information médicale n'en est plus (Direction, 10/2026) : ce que le pharmacien fait valider va au
  // Directeur des Opérations (`medical-info/decideur.ts`), plus au centre.
  const appelants = [
    "src/lib/bons-de-commande/aiguillage.ts",
  ];

  it("chaque appelant lit les sièges du plus ancien au plus récent", () => {
    for (const f of appelants) {
      const src = sans(f);
      const requete = src.match(/role: \{ in: \["GENERAL_MANAGER", "SUPER_ADMIN"\] \}[\s\S]{0,200}?\}\)/);
      expect(requete, `${f} : la lecture des sièges est introuvable`).not.toBeNull();
      expect(requete![0], `${f} lit les sièges sans les ordonner`).toMatch(/orderBy: \{ createdAt: "asc" \}/);
    }
  });

  it("chaque appelant écarte le demandeur AVANT de choisir", () => {
    // Le bon de commande a une issue de plus, écrite exprès : seul siège, le demandeur valide en conscience.
    expect(sans(appelants[0]!)).toMatch(/centreValidatorFrom\(sieges\.filter\(\(s\) => s\.id !== demandeurId\)\) \?\? centreValidatorFrom\(sieges\)/);
  });

  it("aucun autre fichier de production ne choisit un siège à côté de ces deux-là", async () => {
    const { readdirSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const trouves: string[] = [];
    const parcourir = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n).replace(/\\/g, "/");
        if (statSync(p).isDirectory()) parcourir(p);
        else if (/\.tsx?$/.test(n) && !/\.test\.tsx?$/.test(n) && /centreValidatorFrom\(/.test(sans(p)) && !p.endsWith("validations/centre.ts")) trouves.push(p);
      }
    };
    parcourir("src");
    expect(trouves.sort(), "un nouvel appelant de centreValidatorFrom doit rejoindre ce banc").toEqual([...appelants].sort());
  });
});
