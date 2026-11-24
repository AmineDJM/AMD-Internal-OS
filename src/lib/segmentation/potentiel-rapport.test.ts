import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { lirePotentielDuRapport } from "./potentiel-rapport";

/** §18, §77 — le potentiel se saisit dans le rapport de visite, une fois ; rien de ce que la visite sait n'est redemandé. */

const fd = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };

describe("potentiel dans le rapport de visite", () => {
  it("facultatif : rien saisi = rien écrit", () => {
    expect(lirePotentielDuRapport(fd({}))).toEqual({ ok: true, valeur: null });
    expect(lirePotentielDuRapport(fd({ potentielPatients: "  " }))).toEqual({ ok: true, valeur: null });
  });
  it("lit le fait (27 patients, 3 sur 10) et le produit concerné", () => {
    expect(lirePotentielDuRapport(fd({ potentielPatients: "27", potentielSur10: "3", potentielProduitId: "ral" }))).toEqual({ ok: true, valeur: { potentiel: 27, sur10: 3, productId: "ral" } });
    expect(lirePotentielDuRapport(fd({ potentielPatients: "12,5" }))).toMatchObject({ ok: true, valeur: { potentiel: 12.5, sur10: null } });
  });
  it("refuse l'illisible, le négatif et plus de 10 sur 10", () => {
    expect(lirePotentielDuRapport(fd({ potentielPatients: "beaucoup" })).ok).toBe(false);
    expect(lirePotentielDuRapport(fd({ potentielPatients: "-3" })).ok).toBe(false);
    expect(lirePotentielDuRapport(fd({ potentielSur10: "12" })).ok).toBe(false);
  });
  it("§77 — le formulaire ne redemande ni le praticien, ni l'établissement, ni la BU, ni le territoire", () => {
    const ecran = readFileSync("src/app/(app)/medical/ma-journee/formulaire-rapport.tsx", "utf8");
    const bloc = ecran.slice(ecran.indexOf("LE POTENTIEL (Segmentation Studio)"), ecran.indexOf("LE BESOIN ANNUEL DU SERVICE"));
    expect(bloc).toContain('name="potentielPatients"');
    for (const champ of ["doctorId", "institution", "businessUnit", "territoire", "zone"]) expect(bloc).not.toContain(`name="${champ}"`);
    const action = readFileSync("src/lib/actions/tour-visit-actions.ts", "utf8");
    expect(action).toContain("doctorId: visite.doctorId, productId: pot.valeur.productId");
  });
});
