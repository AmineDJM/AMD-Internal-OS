import { describe, expect, it } from "vitest";
import { scannerContrats } from "./contrat-scan";

/**
 * UNE ACTION QUI DÉLÈGUE À UN MODULE (`@/modules/<m>/api`) GARDE SES FAITS D'ÉCRITURE.
 *
 * Le module pilote `consommation` (audit 08) a déplacé les écrivains de `@/lib/consommation/service` vers
 * `@/modules/consommation/infra/imports`, réexportés par la porte `api.ts`. Le scanner ne suivait que `@/lib` et
 * `@/platform`, et ne lisait pas une réexportation : `importerFichierConsommation` aurait été déclarée n'écrire que
 * `auditLog` — un mensonge du contrat qu'Adam lit pour savoir ce qu'une action touche.
 */
describe("contrat — les écrivains d'un module sont suivis à travers sa porte", () => {
  const contrats = scannerContrats();
  const de = (id: string) => contrats.find((c) => c.id === id);

  it("importer un fichier de consommation écrit l'import et ses lignes", () => {
    expect(de("consommation-actions:importerFichierConsommation")?.modelesEcrits).toEqual(
      expect.arrayContaining(["consommationImport", "consommationLigne"]));
  });

  it("valider un import écrit l'import et la mémoire des correspondances", () => {
    expect(de("consommation-actions:validerImportConso")?.modelesEcrits).toEqual(
      expect.arrayContaining(["consommationImport", "consommationMemoire"]));
  });
});
