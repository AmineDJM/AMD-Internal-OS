import fs from "node:fs";
import { describe, it, expect } from "vitest";
import { MODULES } from "@/lib/rbac/modules";
import { MODELES_SENSIBLES } from "@/modules/coffre/partage";
import { FAMILLES_IA } from "@/platform/ia/capacites/familles";

/**
 * LE CLIQUET DU CATALOGUE DES « BASES » (lot D1, `docs/architecture/BASES-DE-DONNEES.md`).
 *
 * Chaque modèle de `prisma/schema.prisma` est rangé dans EXACTEMENT une base. Une table neuve non rangée fait
 * échouer la suite : la ranger dans `scripts/bases-de-donnees/*.ts` (base, libellé français, sensibilité),
 * puis `npm run bases:generer` (régénère le JSON et le document). Une table supprimée se retire de même.
 *
 * Le test lit le JSON GÉNÉRÉ — c'est lui que la Direction, la console et un futur « accès par base » liront.
 */

interface TableJson { modele: string; libelle: string; sensibilite: string; ecritePar: string[] }
interface BaseJson {
  cle: string; nom: string; nature: string; raison: string; sensibilite: string; sensibiliteMax: string;
  acces: { modules: { cle: string }[]; famillesIa: string[] };
  nombreTables: number; tables: TableJson[];
}

const catalogue = JSON.parse(fs.readFileSync("docs/architecture/bases-de-donnees.json", "utf8")) as { schemaModeles: number; bases: BaseJson[] };
const schema = [...fs.readFileSync("prisma/schema.prisma", "utf8").matchAll(/^model (\w+) \{/gm)].map((m) => m[1]);
const NIVEAUX = ["public-interne", "restreint", "confidentiel", "secret"];
const toutes = catalogue.bases.flatMap((b) => b.tables.map((t) => ({ ...t, base: b.cle })));
const REMEDE = "→ ranger la table dans scripts/bases-de-donnees/*.ts puis `npm run bases:generer`";

describe("catalogue des bases — chaque table rangée exactement une fois", () => {
  it("toute table du schéma est rangée", () => {
    const rangees = new Set(toutes.map((t) => t.modele));
    const orphelines = schema.filter((m) => !rangees.has(m));
    expect(orphelines, `tables non rangées ${REMEDE}`).toEqual([]);
  });

  it("aucune table n'est rangée deux fois, aucune table rangée n'a disparu du schéma", () => {
    const vues = new Map<string, string>();
    const doublons: string[] = [];
    for (const t of toutes) {
      if (vues.has(t.modele)) doublons.push(`${t.modele} (${vues.get(t.modele)} + ${t.base})`);
      vues.set(t.modele, t.base);
    }
    expect(doublons).toEqual([]);
    expect(toutes.map((t) => t.modele).filter((m) => !schema.includes(m)), `tables disparues ${REMEDE}`).toEqual([]);
    expect(catalogue.schemaModeles).toBe(schema.length);
  });

  it("chaque base et chaque table sont décrites (libellé, raison, sensibilité connue, modules et familles réels)", () => {
    const cles = catalogue.bases.map((b) => b.cle);
    expect(new Set(cles).size).toBe(cles.length);
    for (const b of catalogue.bases) {
      expect(b.raison.length, b.cle).toBeGreaterThan(20);
      expect(["metier", "technique"]).toContain(b.nature);
      expect(NIVEAUX).toContain(b.sensibilite);
      expect(b.nombreTables).toBe(b.tables.length);
      for (const m of b.acces.modules) expect(MODULES as readonly string[], `${b.cle} : module ${m.cle}`).toContain(m.cle);
      for (const f of b.acces.famillesIa) expect(FAMILLES_IA as readonly string[], `${b.cle} : famille ${f}`).toContain(f);
      for (const t of b.tables) {
        expect(t.libelle.trim().length, t.modele).toBeGreaterThan(2);
        expect(NIVEAUX).toContain(t.sensibilite);
        // Une table ne descend sous sa base que pour une donnée publique (wilayas, communes).
        if (t.sensibilite !== "public-interne") expect(NIVEAUX.indexOf(t.sensibilite), `${t.modele} moins sensible que sa base`).toBeGreaterThanOrEqual(NIVEAUX.indexOf(b.sensibilite));
      }
    }
  });
});

describe("catalogue des bases — la sensibilité ne ment pas", () => {
  const niveau = (m: string) => toutes.find((t) => t.modele === m)?.sensibilite;

  it("une table dont une colonne est copiée au coffre (IBAN, RIB, NIN, salaire) est « secret »", () => {
    for (const m of MODELES_SENSIBLES) expect(niveau(m), m).toBe("secret");
  });

  it("la paie, le coffre et les comptes sont « secret » de bout en bout", () => {
    for (const cle of ["paie", "coffre", "comptes-et-droits"]) {
      const b = catalogue.bases.find((x) => x.cle === cle)!;
      expect(b.tables.every((t) => t.sensibilite === "secret"), cle).toBe(true);
    }
  });

  it("les tables des familles sensibles de l'assistant (SALAIRES, CONTRATS_RH) vivent dans une base qui monte à « secret »", () => {
    for (const b of catalogue.bases.filter((x) => x.acces.famillesIa.some((f) => f === "SALAIRES" || f === "CONTRATS_RH"))) {
      expect(b.sensibiliteMax, b.cle).toBe("secret");
    }
  });
});
