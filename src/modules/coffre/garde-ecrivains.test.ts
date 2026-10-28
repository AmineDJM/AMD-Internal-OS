import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CHAMPS_SENSIBLES, MODELES_SENSIBLES } from "./domaine/champs";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA GARDE DES ÉCRIVAINS DU COFFRE (refonte V2-E ; `refonte-p3-inventaire.md` §5.3).
 *
 * Tout fichier qui ÉCRIT l'une des tables du coffre (`employee`, `companyContact`, `companyLegalIdentity`
 * : create / update / upsert…) ET nomme l'une de ses colonnes sensibles doit appeler la double écriture
 * (`doubleEcrireCoffre`) — ou figurer ci-dessous avec sa raison. Un écrivain ajouté demain qui oublie le
 * coffre fait échouer `npm test` au lieu de laisser une copie périmée.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const EXCEPTIONS: Record<string, string> = {
  "src/lib/actions/payroll-hr-actions.ts":
    "Écrit `PayrollEntry.employerCost` (le coût d'un bulletin, pas la fiche) ; sur `Employee`, seulement `companyId`.",
};

const SRC = path.join(process.cwd(), "src");
const DELEGUE = (m: string) => m.charAt(0).toLowerCase() + m.slice(1);
const ECRIT = new RegExp(`\\.(${MODELES_SENSIBLES.map(DELEGUE).join("|")})\\.(create|createMany|update|updateMany|upsert)\\(`, "g");
const COLONNES: Record<string, RegExp> = Object.fromEntries(MODELES_SENSIBLES.map((m) => [
  DELEGUE(m),
  new RegExp(`\\b(${CHAMPS_SENSIBLES.filter((c) => c.modele === m).map((c) => c.champ).join("|")})\\b${m === "CompanyLegalIdentity" ? "|identityFieldKeys" : ""}`),
]));

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== "node_modules") walk(p, out); }
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const rel = (p: string) => path.relative(process.cwd(), p).split(path.sep).join("/");

describe("Garde des écrivains du coffre", () => {
  const ecrivains = walk(SRC).flatMap((f) => {
    const src = readFileSync(f, "utf8");
    const tables = new Set([...src.matchAll(ECRIT)].map((m) => m[1]));
    return [...tables].some((t) => COLONNES[t].test(src)) ? [{ fichier: rel(f), src }] : [];
  });

  it("trouve les écrivains connus (le banc n'est pas vide)", () => {
    expect(ecrivains.map((e) => e.fichier)).toEqual(expect.arrayContaining([
      "src/lib/actions/hr-actions.ts", "src/lib/actions/company-contact-actions.ts", "src/lib/actions/company-identity-actions.ts",
    ]));
  });

  it("chaque écrivain d'une colonne sensible appelle la double écriture, ou dit pourquoi pas", () => {
    const oublis = ecrivains.filter((e) => !e.src.includes("doubleEcrireCoffre(") && !EXCEPTIONS[e.fichier]).map((e) => e.fichier);
    expect(oublis).toEqual([]);
  });

  it("aucune exception périmée", () => {
    const presents = new Set(ecrivains.map((e) => e.fichier));
    for (const f of Object.keys(EXCEPTIONS)) expect(presents.has(f), `${f} n'écrit plus : retirer l'exception`).toBe(true);
  });
});
