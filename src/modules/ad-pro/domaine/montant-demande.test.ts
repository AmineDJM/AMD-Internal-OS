import { describe, expect, it } from "vitest";
import { sourceDeLaCle } from "@/lib/actions/parc";
import fs from "node:fs";
import path from "node:path";
import { montantDeLaDemande, estRallongeAccordee } from "./montant-demande";

const lire = (f: string) => fs.readFileSync(path.join(process.cwd(), f), "utf8");
const poste = (budgetKind: string, status: string, amountGranted: number | null) => ({ budgetKind, status, amountGranted });

/**
 * « UNE FOIS BUDGET SUPPLÉMENTAIRE ACCORDÉ, IL DOIT ÊTRE MIS À JOUR DANS LA DEMANDE, LE
 * MONTANT » — §118.138. Chaque cas nomme ce qui le ferait tomber (§118.17).
 */
describe("le montant d'une demande suit ses RALLONGES accordées", () => {
  it("une rallonge accordée s'ajoute à la base", () => {
    expect(montantDeLaDemande(500_000, [poste("ADDITIONAL", "APPROVED", 120_000)])).toBe(620_000);
  });

  it("un poste INCLUS dans l'enveloppe ne s'ajoute PAS — sinon la dépense compte deux fois", () => {
    // Ce qui le ferait tomber : sommer tous les postes accordés. La fiche annoncerait un budget
    // que personne n'a accordé, et `budgetKind` existe précisément pour cette distinction.
    expect(montantDeLaDemande(500_000, [poste("INCLUDED", "APPROVED", 120_000)])).toBe(500_000);
  });

  it("une rallonge REFUSÉE ou À REVOIR ne compte pas", () => {
    expect(montantDeLaDemande(500_000, [poste("ADDITIONAL", "REJECTED", 120_000)])).toBe(500_000);
    expect(montantDeLaDemande(500_000, [poste("ADDITIONAL", "REVISION", 120_000)])).toBe(500_000);
    expect(montantDeLaDemande(500_000, [poste("ADDITIONAL", "DRAFT", 120_000)])).toBe(500_000);
  });

  it("LE CALCUL EST IDEMPOTENT — c'est ce qui le fait survivre à une RE-décision", () => {
    // Un poste se décide plusieurs fois (accordé → à revoir → accordé). Ce qui le ferait
    // tomber : incrémenter au fil de l'eau — la rallonge doublerait au second passage.
    const postes = [poste("ADDITIONAL", "APPROVED", 120_000)];
    expect(montantDeLaDemande(500_000, postes)).toBe(620_000);
    expect(montantDeLaDemande(500_000, postes), "deux fois de suite, le même total").toBe(620_000);
  });

  it("plusieurs rallonges s'additionnent, les autres postes sont ignorés", () => {
    expect(montantDeLaDemande(1_000_000, [
      poste("ADDITIONAL", "APPROVED", 200_000),
      poste("ADDITIONAL", "APPROVED", 50_000),
      poste("INCLUDED", "APPROVED", 900_000),
      poste("ADDITIONAL", "REJECTED", 999_999),
    ])).toBe(1_250_000);
  });

  it("BASE INCONNUE ⇒ `null` ⇒ l'appelant n'écrit RIEN", () => {
    // Ce qui le ferait tomber : rendre la somme des rallonges. Une opération sans circuit de
    // financement n'a pas de montant de demande, et en fabriquer un annoncerait un budget
    // accordé que personne n'a accordé (§118.16).
    expect(montantDeLaDemande(null, [poste("ADDITIONAL", "APPROVED", 120_000)])).toBeNull();
    expect(montantDeLaDemande(undefined, [])).toBeNull();
    expect(montantDeLaDemande(Number.NaN, [])).toBeNull();
  });

  it("sans aucune rallonge, c'est un NO-OP parfait — le cas de loin le plus fréquent", () => {
    expect(montantDeLaDemande(500_000, [])).toBe(500_000);
  });

  it("une rallonge accordée à ZÉRO n'est pas une rallonge", () => {
    expect(estRallongeAccordee(poste("ADDITIONAL", "APPROVED", 0))).toBe(false);
    expect(estRallongeAccordee(poste("ADDITIONAL", "APPROVED", null))).toBe(false);
    expect(estRallongeAccordee(poste("ADDITIONAL", "APPROVED", 1))).toBe(true);
  });
});

/**
 * LES QUATRE PORTES — décider, corriger, retirer, rendre son accord (§118.187). §118.71 : une porte
 * gardée à côté d'une porte ouverte, et c'est la même chose qui passe.
 */
describe("la reprojection a ses appelants de production (§118.49)", () => {
  // La clé `ad-pro-item-actions` et son socle commun (`reprojeterMontantDemande` y vit, privée au module).
  const src = (sourceDeLaCle("ad-pro-item-actions") + "\n" + lire("src/modules/ad-pro/infra/postes/commun.ts")).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

  it("elle est appelée par les QUATRE actions qui changent une rallonge — chacune dans son propre corps", () => {
    // decideAdProItem (accorder/refuser), updateAdProItem (corriger le montant ou la nature),
    // deleteAdProItem (retirer le poste), demanderRevisionPoste (le demandeur rend son accord, §118.187 :
    // le montant accordé s'efface). En oublier une laisserait la fiche porter pour toujours un budget
    // accordé à un poste qui n'existe plus — ou qui n'est plus accordé.
    const portes = ["decideAdProItem", "updateAdProItem", "deleteAdProItem", "demanderRevisionPoste"];
    expect([...src.matchAll(/reprojeterMontantDemande\(owner\.parent, owner\.id\)/g)].length).toBe(portes.length);
    // Compter sans localiser laisserait une action appeler deux fois pendant qu'une autre oublie (§118.175).
    for (const nom of portes) {
      const debut = src.indexOf(`export async function ${nom}(`);
      expect(debut, `${nom} existe`).toBeGreaterThan(-1);
      const fin = src.indexOf("export async function ", debut + 10);
      expect(src.slice(debut, fin === -1 ? undefined : fin), `${nom} reprojette le montant de la demande`).toMatch(/reprojeterMontantDemande\(owner\.parent, owner\.id\)/);
    }
  });

  it("la BASE vient de l'instance de circuit, jamais du champ affiché", () => {
    // Ce qui le ferait tomber : lire `finalAmount` comme base. Il grossirait à chaque passage.
    expect(src).toMatch(/workflowInstance\.findUnique[\s\S]{0,300}select: \{ amount: true \}/);
    expect(src).toMatch(/montantDeLaDemande\(/);
  });
});
