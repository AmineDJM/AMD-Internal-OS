import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * LE CORPS D'UNE REQUÊTE N'EST JAMAIS TRONQUÉ PAR LE MIDDLEWARE (24/11/2026).
 *
 * Next recopie le corps de toute requête que voit le middleware et coupe la copie à
 * `experimental.middlewareClientMaxBodySize` (10 Mo par défaut). Du 08/11 au 24/11/2026, tout envoi de plus de 10 Mo
 * arrivait tronqué. Ce cliquet tient les deux protections : le plafond relevé, et les routes de dépôt hors du middleware.
 */
const racine = process.cwd();
const lire = (f: string) => readFileSync(path.join(racine, f), "utf8");

const ROUTES_DE_DEPOT = [
  "api/drive", "api/documents", "api/messaging", "api/meetings", "api/field-reports", "api/onlyoffice",
  "api/regulatory", "api/rh", "api/prises-en-charge", "api/donnees-marche",
];

describe("le middleware ne tronque aucun envoi de fichier", () => {
  it("le plafond de copie du corps est relevé au niveau des actions serveur", () => {
    const conf = lire("next.config.mjs");
    const plafond = /middlewareClientMaxBodySize:\s*"(\d+)mb"/.exec(conf);
    expect(plafond, "experimental.middlewareClientMaxBodySize absent de next.config.mjs").not.toBeNull();
    const actions = /serverActions:\s*\{\s*bodySizeLimit:\s*"(\d+)mb"/.exec(conf);
    expect(Number(plafond![1])).toBeGreaterThanOrEqual(Number(actions?.[1] ?? 0));
  });

  it("chaque route qui reçoit des fichiers est exclue du matcher", () => {
    const mw = lire("src/middleware.ts");
    const matcher = /matcher:\s*\[\s*"([^"]+)"/.exec(mw)?.[1] ?? "";
    for (const r of ROUTES_DE_DEPOT) expect(matcher, `${r} doit être exclue du middleware`).toContain(`|${r}|`);
  });

  it("toute nouvelle route d'API qui lit un corps de fichier est soit exclue, soit listée ici", () => {
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    const lignes = execSync(
      String.raw`grep -rlE "formData\(\)|request\.body|req\.body|arrayBuffer\(\)" src/app/api --include=route.ts || true`,
      { cwd: racine, encoding: "utf8" },
    ).split("\n").filter(Boolean);
    const groupes = new Set(lignes.map((l) => l.split("/")[3]).filter(Boolean).map((g) => `api/${g}`));
    // Les routes de l'assistant passent par le middleware (mode Adventum IA) : le plafond relevé les couvre.
    const couvertesParLePlafond = new Set(["api/assistant", "api/assistant-ia"]);
    for (const g of groupes) {
      if (couvertesParLePlafond.has(g)) continue;
      expect(ROUTES_DE_DEPOT, `nouvelle route de dépôt ${g} : l'exclure du middleware (src/middleware.ts)`).toContain(g);
    }
  });
});
