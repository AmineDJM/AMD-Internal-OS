import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * LA GARDE DE LA DOUBLE ÉCRITURE DES LIEUX (refonte V2-D) — sur le modèle de `client-bundle-guard.test.ts`.
 *
 * Toute écriture (`create`, `update`, `upsert`…) sur une des cinq fiches qui portent `wilayaCode` doit, dans le même
 * fichier, appeler `reposerWilayaCode` — sinon le texte change et le code reste celui d'avant, en silence, jusqu'au
 * prochain passage de la reprise. Un fichier qui n'écrit qu'un ÉTAT (dernière visite, délégué, e-mail, actif) figure
 * ci-dessous avec sa raison ; il ne doit alors pas même NOMMER une colonne de lieu. Un écrivain ajouté demain fait
 * échouer `npm test` en nommant le fichier.
 */

const RACINE = join(__dirname, "..", "..", "..");
const ECRITURE = /\.(medicalDoctor|medicalInstitution|companyContact|supplier|salesSector)\.(create|createMany|update|updateMany|upsert)\(/;
const COLONNE_DE_LIEU = /\b(wilaya|city|wilayaPivot|region|country)\b/;

/** Les écrivains qui ne touchent aucun lieu — chacun avec ce qu'il écrit. */
const EXCEPTIONS: Record<string, { raison: string; litLeLieu?: true }> = {
  "src/lib/actions/force-de-vente-actions.ts": { raison: "affecte un praticien à un délégué (delegateId)" },
  "src/lib/actions/medical-directory-crud-actions.ts": { raison: "déplace des fiches d'un annuaire à l'autre (directoryId)" },
  "src/lib/actions/tour-visit-actions.ts": { raison: "date de dernière visite (lastVisit)" },
  "src/lib/custom-fields.ts": { raison: "champs personnalisés (JSON custom)" },
  "src/lib/medical/profil-rapide.ts": { raison: "crée un profil praticien depuis un bénéficiaire : nom et établissement, aucun lieu" },
  "src/lib/medical/rattachement-auto.ts": { raison: "pose établissement et service ; LIT la wilaya sans l'écrire", litLeLieu: true },
  "src/lib/quality/fix.ts": { raison: "corrige un e-mail" },
};

function fichiers(dir: string): string[] {
  return readdirSync(dir).flatMap((nom) => {
    const chemin = join(dir, nom);
    if (statSync(chemin).isDirectory()) return nom === "node_modules" ? [] : fichiers(chemin);
    return /\.(ts|tsx)$/.test(nom) && !/\.test\.tsx?$/.test(nom) ? [chemin] : [];
  });
}

const ecrivains = fichiers(join(RACINE, "src"))
  .map((f) => ({ fichier: relative(RACINE, f).split("\\").join("/"), texte: readFileSync(f, "utf8") }))
  .filter((f) => ECRITURE.test(f.texte));

describe("double écriture des lieux — chaque écrivain des cinq fiches", () => {
  it("trouve des écrivains (la garde n'est pas désarmée)", () => {
    expect(ecrivains.length).toBeGreaterThan(10);
  });

  it("appelle reposerWilayaCode, ou figure dans les exceptions motivées", () => {
    const fautifs = ecrivains.filter((f) => !f.texte.includes("reposerWilayaCode(") && !EXCEPTIONS[f.fichier]).map((f) => f.fichier);
    expect(fautifs, "Écrit une fiche à wilayaCode sans appeler reposerWilayaCode (lib/lieux/rattachement-prisma.ts)").toEqual([]);
  });

  it("une exception n'écrit aucun lieu — elle n'en nomme même pas la colonne", () => {
    const suspects = ecrivains
      .filter((f) => EXCEPTIONS[f.fichier] && !EXCEPTIONS[f.fichier].litLeLieu && COLONNE_DE_LIEU.test(f.texte))
      .map((f) => f.fichier);
    expect(suspects).toEqual([]);
  });

  it("aucune exception périmée (fichier disparu, ou qui n'écrit plus ces fiches)", () => {
    const vivants = new Set(ecrivains.map((f) => f.fichier));
    expect(Object.keys(EXCEPTIONS).filter((f) => !vivants.has(f))).toEqual([]);
  });
});
