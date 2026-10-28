import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * ═══════════════════════════════════════════════════════════
 * UNE ÉCRITURE PAR IDENTIFIANT PASSE PAR UNE PORTE (audit 27/10/2026, rapport 01 §4.1).
 *
 * Le défaut dominant de l'audit sécurité n'était pas l'absence de garde, c'était la garde à
 * moitié : l'action relit le droit du MODULE, puis écrit `prisma.x.update({ where: { id } })` sur
 * l'objet que le formulaire désigne — sans vérifier que la personne a le droit sur CET objet
 * (sa société, sa portée, son cercle). Neuf corrections sur dix étaient cette faute.
 *
 * Ce cliquet lit chaque fichier `"use server"` et, dans chaque fonction, chaque
 * `prisma.<modèle>.(update|delete|updateMany|deleteMany)({ where: { id`. L'écriture est GARDÉE si,
 * plus haut dans la même fonction, on trouve l'une des portes de la maison :
 *   - `ouvrirPourEcrire(…)` (`src/lib/acces/objet.ts`) — LA porte, à préférer ;
 *   - une porte locale NOMMÉE `porte…(` (`porteDuRapport`) qui rend une `PorteEcriture` ;
 *   - `canAccessEntity(…)`, `entitePermisePourFiche(…)`, `predicatEntitePermise(…)` ;
 *   - une clause de portée (`scope…(`, `ficheScopedWhere(`, `companyScopedWhere(`, `clause…Visible…(`) ;
 *   - ou une garde locale DÉCLARÉE par le commentaire `// porte d'écriture : <pourquoi>` — l'objet
 *     n'a pas de société, ou sa règle est ailleurs (propriétaire relu, siège nommé…). Le commentaire
 *     se lit en revue : c'est voulu.
 *
 * Deux règles :
 *   1. les fichiers des domaines migrés (l'argent d'abord) sont à ZÉRO, strictement ;
 *   2. le parc ne grandit plus — CLIQUET au chiffre MESURÉ (§118.79c), il ne peut que baisser.
 *      Migrer un domaine vers `ouvrirPourEcrire` le fait baisser : abaisser le plafond au chiffre mesuré.
 * ═══════════════════════════════════════════════════════════
 */

const SRC = join(process.cwd(), "src");

function fichiers(dir: string, acc: string[] = []): string[] {
  for (const nom of readdirSync(dir)) {
    const chemin = join(dir, nom);
    if (statSync(chemin).isDirectory()) fichiers(chemin, acc);
    else if (/\.ts$/.test(nom) && !/\.test\.ts$/.test(nom)) acc.push(chemin);
  }
  return acc;
}

const PORTE = /\b(ouvrirPourEcrire|porte[A-Z]\w*|canAccessEntity|entitePermisePourFiche|predicatEntitePermise|ficheScopedWhere|companyScopedWhere|scope[A-Z]\w*|clause[A-Z]\w*Visible\w*)\(|\/\/ porte d'écriture :/;
const ECRITURE = /prisma\.(\w+)\.(update|delete|updateMany|deleteMany)\(\{\s*where:\s*\{\s*id\b/g;
const FONCTION = /^(?:export )?async function (\w+)/gm;

/** Les écritures par identifiant sans porte d'un fichier serveur, au format `chemin › fonction › modèle`. */
export function ecrituresSansPorte(chemin: string, src: string): string[] {
  if (!/^\s*["']use server["']/.test(src)) return [];
  const debuts = [...src.matchAll(FONCTION)].map((m) => ({ i: m.index ?? 0, nom: m[1] }));
  const hits: string[] = [];
  debuts.forEach((d, k) => {
    const corps = src.slice(d.i, debuts[k + 1]?.i ?? src.length);
    for (const m of corps.matchAll(ECRITURE)) {
      if (!PORTE.test(corps.slice(0, m.index))) hits.push(`${relative(process.cwd(), chemin)} › ${d.nom} › ${m[1]}`);
    }
  });
  return hits;
}

/**
 * Mesuré le 28/10/2026 (lot V3-F) : 589 écritures sans porte avant ce lot ; 586 après la migration du livre
 * comptable vers `ouvrirPourEcrire`. Il ne peut que baisser.
 */
const PLAFOND_ECRITURES_SANS_PORTE = 586;

/** Les domaines migrés : aucune écriture par identifiant sans porte, jamais. */
const FICHIERS_A_ZERO = [
  "src/lib/actions/finance-actions.ts",
];

describe("l'écriture par identifiant passe par une porte", () => {
  const parc = fichiers(SRC).map((f) => ({ f, src: readFileSync(f, "utf8") }));

  it("le cliquet lit bien le parc (plancher de fichiers serveur)", () => {
    expect(parc.filter(({ src }) => /^\s*["']use server["']/.test(src)).length).toBeGreaterThan(200);
  });

  it("le détecteur reconnaît le patron, et laisse passer la version gardée", () => {
    const nu = `"use server";\nexport async function regler(fd) {\n  if (!userCan(user, "FINANCES", "UPDATE")) return;\n  await prisma.expenseOrder.update({ where: { id }, data: {} });\n}`;
    const garde = `"use server";\nexport async function regler(fd) {\n  const porte = await ouvrirPourEcrire(user, "EXPENSE_ORDER", id, "UPDATE");\n  await prisma.expenseOrder.update({ where: { id }, data: {} });\n}`;
    const declare = `"use server";\nexport async function regler(fd) {\n  // porte d'écriture : l'auteur relu plus haut\n  await prisma.note.delete({ where: { id } });\n}`;
    expect(ecrituresSansPorte(join(SRC, "x.ts"), nu)).toHaveLength(1);
    expect(ecrituresSansPorte(join(SRC, "x.ts"), garde)).toHaveLength(0);
    expect(ecrituresSansPorte(join(SRC, "x.ts"), declare)).toHaveLength(0);
  });

  it("les fichiers de l'argent et des domaines migrés sont à zéro", () => {
    for (const f of FICHIERS_A_ZERO) {
      const chemin = join(process.cwd(), f);
      expect(ecrituresSansPorte(chemin, readFileSync(chemin, "utf8")), `${f} écrit encore par identifiant sans porte`).toEqual([]);
    }
  });

  it("le parc ne grandit plus en écritures sans porte (cliquet)", () => {
    const tous = parc.flatMap(({ f, src }) => ecrituresSansPorte(f, src));
    expect(tous.length, `écritures sans porte :\n${tous.slice(0, 40).join("\n")}`).toBeLessThanOrEqual(PLAFOND_ECRITURES_SANS_PORTE);
  });
});
