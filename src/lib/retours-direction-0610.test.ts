import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { refusTauxDuDevis, refusDepassement, reservesEncoreVraies } from "@/modules/ad-pro/partage";
import { montantLu } from "@/lib/pieces-lues/montants";

/** Retours de la Direction du 06/10 — gardes de comportement et de points d'appel. */
const lire = (rel: string) =>
  readFileSync(join(process.cwd(), rel), "utf8").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("devis : pas de TVA imprimée = pas de TVA", () => {
  it("le bon de commande se génère sans TVA (aucun refus), et le total est celui du papier", () => {
    expect(refusTauxDuDevis(null)).toBeNull();
    expect(refusDepassement(400_000, 400_000, 400_000, false)).toBeNull();
    expect(refusDepassement(450_000, 400_000, 450_000, false)).toMatch(/aucune TVA indiquée sur le devis/);
  });

  it("une réserve « DZD 300,000.00 : caractères inattendus » que le lecteur actuel lit n'est plus affichée", () => {
    const r = "« DZD 300,000.00 » : des caractères inattendus — attendu des chiffres, une virgule ou un point";
    expect(reservesEncoreVraies(r, montantLu)).toBeNull();
    expect(reservesEncoreVraies(`${r} ; remise de 5 % lue`, montantLu)).toBe("remise de 5 % lue");
    expect(reservesEncoreVraies("« 12 ab » : des caractères inattendus — attendu", montantLu)).not.toBeNull();
  });
});

describe("le bon de commande porte le fournisseur RECOPIÉ du devis", () => {
  it("sans fiche d'annuaire, l'identité lue sur le papier (ou relue dans le texte déjà lu) nomme le fournisseur", () => {
    const src = lire("src/modules/ad-pro/infra/bc-devis.ts");
    expect(src).toContain("d.fournisseurLu");
    expect(src).toContain("texteDeLaLecture(d.entete.lectureId)");
    expect(src).toContain("identiteEmetteurDuTexte(texte)");
  });
});

describe("l'écran ne double plus ses gestes", () => {
  it("« Générer le BC » n'apparaît qu'une fois : dans la case Bon de commande, pas en haut de la carte", () => {
    expect(lire("src/modules/ad-pro/ecrans/postes/poste-carte.tsx")).toContain('pas.geste?.cle !== "GENERER_BC"');
  });

  it("la confirmation d'un bouton-icône s'ouvre dans une bulle, sans réécrire le texte voisin", () => {
    const b = lire("src/components/ui/bouton-decisif.tsx");
    expect(b).toContain("iconeSeule");
    expect(b).toMatch(/absolute right-0 top-full z-50/);
  });
});

describe("Vue exacte : toute la page suit la personne visualisée", () => {
  it("entrer et sortir rechargent la page ENTIÈRE (la barre du haut n'est plus celle de l'administrateur)", () => {
    const actions = lire("src/lib/actions/impersonation-actions.ts");
    expect(actions).not.toMatch(/redirect\(/);
    expect(lire("src/app/(app)/admin/users/[id]/impersonate-button.tsx")).toContain("window.location.assign(");
    expect(lire("src/components/layout/quitter-vue-bouton.tsx")).toContain("window.location.assign(");
  });
});

describe("annuaire des médecins : seulement par spécialité, spécialités gérables sur place", () => {
  it("plus d'annuaires nommés ni d'« annuaire général » pour les médecins", () => {
    const f = lire("src/app/(app)/annuaires/feuille-praticiens.tsx");
    expect(f).toMatch(/\{!medecins && \(\s*<DirectoryBar/);
    expect(f).toContain("annuaire: medecins ? null : annuaire");
  });

  it("ajouter, renommer, supprimer une spécialité depuis la barre, par les actions du référentiel", () => {
    const b = lire("src/app/(app)/annuaires/barre-specialites.tsx");
    for (const a of ["createSpecialty(", "updateSpecialty(", "deleteSpecialty("]) expect(b, a).toContain(a);
  });
});
