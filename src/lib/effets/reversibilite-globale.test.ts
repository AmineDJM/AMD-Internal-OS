import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * CLIQUET GLOBAL DE LA RÉVERSIBILITÉ (Direction, 31/10/2026 : « toute action qui a été faite peut être réversible, dans
 * n'importe quelle action du registre »). Les cliquets K10a/b/c tiennent chacun leur périmètre ; celui-ci tient TOUT le
 * registre : une action qui ÉCRIT (risque ≠ R0) classée « aucune » annulation fait échouer la suite — c'est ainsi qu'une
 * action née après K10 (`reglerMaMemoireAuto`, lot M1) aurait été rattrapée. Une lecture (R0) n'a rien à défaire.
 * Remède : envelopper l'action (`actionReversible` / `gesteReversible`) et la déclarer (`src/lib/effets/declarations/`),
 * puis `npm run capacites:classement`.
 */
describe("réversibilité — tout le registre", () => {
  it("aucune action écrivante n'est sans annulation", () => {
    const classement = JSON.parse(readFileSync("src/platform/ia/capacites/classement.genere.json", "utf8")) as
      Record<string, { risque: string; annulation: string }>;
    const sansAnnulation = Object.entries(classement)
      .filter(([, c]) => c.annulation === "aucune" && c.risque !== "R0")
      .map(([id, c]) => `${id} (${c.risque})`);
    expect(sansAnnulation, "rendre réversibles (envelopper + déclarer), puis npm run capacites:classement").toEqual([]);
  });
});
