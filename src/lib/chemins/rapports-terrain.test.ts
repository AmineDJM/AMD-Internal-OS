import { describe, it, expect, vi } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  CHEMIN_APERCU_RAPPORTS, CHEMIN_PV_KAM, CHEMIN_RAPPORTS_TERRAIN, lienCasPvKam, lienRapportTerrain, lienSignalerPv,
} from "./rapports-terrain";
import { MEDICAL_TABS, NAVIGATION } from "@/lib/labels";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES RAPPORTS TERRAIN, ONGLET DE LA PROMOTION MÉDICALE (Direction, 07/10) — leur adresse, leurs
 * anciennes adresses, le menu.
 *
 *   1. UNE ancienne adresse ne meurt pas : chaque page d'escale de `/field-reports…` redirige vers la
 *      même chose sous `/medical/rapports` (des notifications en base portent encore les anciennes).
 *   2. AUCUN fichier de production ne réécrit l'ancienne adresse (hors l'alias de surlignage du menu).
 *   3. LE MENU n'a plus d'entrée « Rapports terrain » ; l'onglet « Rapports » de la Promotion médicale
 *      porte le module `FIELD_REPORTS` — la console règle toujours qui le voit.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

class Redirection extends Error {
  constructor(readonly vers: string) { super(`redirect ${vers}`); }
}
vi.mock("next/navigation", () => ({ redirect: (vers: string) => { throw new Redirection(vers); } }));

async function destination(appel: () => unknown): Promise<string> {
  try {
    await appel();
  } catch (e) {
    if (e instanceof Redirection) return e.vers;
    throw e;
  }
  throw new Error("la page n'a pas redirigé");
}

describe("les anciennes adresses mènent au même écran", () => {
  it("la liste, la fiche, l'analyse", async () => {
    const { default: Liste } = await import("@/app/(app)/field-reports/page");
    expect(await destination(() => Liste())).toBe(CHEMIN_RAPPORTS_TERRAIN);
    const { default: Fiche } = await import("@/app/(app)/field-reports/[id]/page");
    expect(await destination(() => Fiche({ params: Promise.resolve({ id: "abc123" }) }))).toBe(`${CHEMIN_RAPPORTS_TERRAIN}/abc123`);
    const { default: Apercu } = await import("@/app/(app)/field-reports/overview/page");
    expect(await destination(() => Apercu())).toBe(CHEMIN_APERCU_RAPPORTS);
  });

  it("la pharmacovigilance du KAM : ses signalements, le formulaire, la fiche d'un cas", async () => {
    const { default: Mes } = await import("@/app/(app)/field-reports/pharmacovigilance/page");
    expect(await destination(() => Mes())).toBe(CHEMIN_PV_KAM);
    const { default: Nouveau } = await import("@/app/(app)/field-reports/pharmacovigilance/nouveau/page");
    expect(await destination(() => Nouveau())).toBe(`${CHEMIN_PV_KAM}/nouveau`);
    const { default: Cas } = await import("@/app/(app)/field-reports/pharmacovigilance/[id]/page");
    expect(await destination(() => Cas({ params: Promise.resolve({ id: "cas1" }) }))).toBe(`${CHEMIN_PV_KAM}/cas1`);
  });

  it("les destinations existent — une escale vers une page absente serait un 404 de plus", () => {
    const app = join(process.cwd(), "src/app/(app)/medical/rapports");
    for (const p of ["page.tsx", "[id]/page.tsx", "overview/page.tsx", "pharmacovigilance/page.tsx", "pharmacovigilance/nouveau/page.tsx", "pharmacovigilance/[id]/page.tsx"]) {
      expect(existsSync(join(app, p)), p).toBe(true);
    }
  });

  it("les liens fabriqués — un identifiant est encodé, jamais recopié tel quel dans l'adresse", () => {
    expect(lienRapportTerrain("a/b")).toBe(`${CHEMIN_RAPPORTS_TERRAIN}/a%2Fb`);
    expect(lienCasPvKam("x")).toBe(`${CHEMIN_PV_KAM}/x`);
    expect(lienSignalerPv()).toBe(`${CHEMIN_PV_KAM}/nouveau`);
    expect(lienSignalerPv("doc 1")).toBe(`${CHEMIN_PV_KAM}/nouveau?praticien=doc%201`);
  });
});

const SRC = join(process.cwd(), "src");
function fichiers(dir: string, acc: string[] = []): string[] {
  for (const nom of readdirSync(dir)) {
    const chemin = join(dir, nom);
    if (statSync(chemin).isDirectory()) fichiers(chemin, acc);
    else if (/\.tsx?$/.test(nom) && !/\.test\.tsx?$/.test(nom)) acc.push(chemin);
  }
  return acc;
}
const sansCommentaires = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\n]*$/gm, "");

/** `"/field-reports…"` — pas `/api/field-reports` (les routes de fichiers n'ont pas bougé). */
export function citationsAnciennes(src: string): string[] {
  return sansCommentaires(src).match(/["'`]\/field-reports(?=["'`/?$])/g) ?? [];
}

describe("personne ne réécrit l'ancienne adresse", () => {
  it("le détecteur lui-même — dans les deux sens", () => {
    expect(citationsAnciennes(`revalidatePath("/field-reports");`)).toHaveLength(1);
    expect(citationsAnciennes("href: `/field-reports/${id}`")).toHaveLength(1);
    expect(citationsAnciennes(`fetch(\`/api/field-reports/\${id}/upload\`)`)).toEqual([]);
    expect(citationsAnciennes(`// "/field-reports"`)).toEqual([]);
  });

  it("aucun fichier de production ne cite l'ancienne adresse (hors l'alias de surlignage du menu)", () => {
    const tous = fichiers(SRC);
    expect(tous.length, "PRÉMISSE : le parcours lit bien le dépôt").toBeGreaterThan(1000);
    const fautes = tous
      .filter((f) => !f.endsWith(join("lib", "labels.ts")))
      .flatMap((f) => citationsAnciennes(readFileSync(f, "utf8")).map((c) => `${relative(process.cwd(), f)} : ${c}`));
    expect(fautes, fautes.join("\n")).toEqual([]);
  });
});

describe("le menu : un onglet de la Promotion médicale, plus une entrée à part", () => {
  it("l'onglet « Rapports » porte le module FIELD_REPORTS et vise la liste", () => {
    expect(MEDICAL_TABS.find((t) => t.href === CHEMIN_RAPPORTS_TERRAIN)).toMatchObject({ module: "FIELD_REPORTS", label: "Rapports" });
  });

  it("aucune entrée de menu « Rapports terrain » — ni au premier niveau, ni en sous-module", () => {
    const toutes = NAVIGATION.flatMap((n) => [n, ...(n.children ?? [])]);
    expect(toutes.filter((n) => n.module === "FIELD_REPORTS" || n.href.startsWith("/field-reports"))).toEqual([]);
    // Et l'entrée médicale surligne encore une ancienne adresse ouverte avant la redirection.
    expect(NAVIGATION.find((n) => n.tabs === MEDICAL_TABS)?.match).toContain("/field-reports");
  });
});
