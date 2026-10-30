import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * CODE MORT ET DOUBLONS — mesurés par des OUTILS, tenus par des CLIQUETS (audit 08, ARCH-06).
 *
 * « Pas de doublons, pas de gaspillage, pas de code inutile, pas de fichier inutile » (Direction).
 * Deux outils standard, configurés pour ce dépôt, remplacent les relevés faits à la main :
 *
 *   • knip (`knip.json`) — fichiers, exports, types et dépendances que rien n'atteint depuis une
 *     entrée réelle : pages / layouts / routes de l'App Router, `middleware.ts`, les fichiers
 *     d'actions (`src/lib/actions/*-actions.ts`, `src/modules/*\/actions*.ts` — l'aiguillage les
 *     importe par spécificateur littéral), les ponts `src/platform/in-process/**`, `scripts/`,
 *     `prisma/`, les tests et l'e2e. Deux passes :
 *       - normale (tests compris) : ZÉRO, sans exception ;
 *       - production (`--production`, tests exclus) : les fichiers que SEULS des tests atteignent.
 *         L'outillage de test légitime (fakes, fixtures, gardes de structure) est déclaré dans
 *         `knip.json` ; ce qui reste est du code de production jamais branché, nommé ci-dessous.
 *   • jscpd (`.jscpd.json`) — blocs dupliqués du code de production (`src/`, tests exclus),
 *     réglages par défaut de l'outil (50 jetons, 5 lignes).
 *
 * Les plafonds sont la mesure APRÈS le lot qui les a posés. Ils ne se relèvent JAMAIS : un
 * chiffre qui baisse grâce à vous, abaissez le plafond dans le même commit.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/**
 * Code de production que seuls des tests atteignent — chaque entrée « à brancher ou supprimer »,
 * avec sa raison. La liste ne peut que rétrécir.
 */
export const ATTEINTS_PAR_LES_TESTS_SEULS: Readonly<Record<string, string>> = {
  "src/lib/scheduler/manage.ts":
    "gestion des planifications (créer, suspendre, supprimer) : le moteur tourne (`scheduled.ts`), aucun écran ni action ne l'expose encore ; `runner.test.ts` s'en sert pour semer",
  "src/modules/coffre/infra/depot-prisma.ts":
    "premier dépôt du coffre, écrit contre des colonnes prévues ; remplacé par `depot-referentiel.ts`, gardé comme support du test du service (`service.test.ts`)",
};

export const PLAFONDS = {
  /** jscpd : nombre de clones dans `src/` (hors tests). Avant le lot : 1 506. Mesuré au lot J0 (30/10) : 1 438. */
  clones: 1438,
  /** jscpd : lignes dupliquées dans `src/` (hors tests). Avant le lot : 13 719. Mesuré au lot J0 (30/10, phase B) : 12 969. */
  lignesDupliquees: 12969,
} as const;

const RACINE = process.cwd();

export interface MesureCodeMort {
  /** Passe normale : chaque problème signalé, « catégorie fichier:symbole ». */
  problemes: string[];
  /** Passe production : les fichiers que seuls des tests atteignent. */
  fichiersTestsSeuls: string[];
}

function knip(args: string[]): { issues: Record<string, unknown>[] } {
  const bin = join(RACINE, "node_modules", "knip", "bin", "knip.js");
  let sortie: string;
  try {
    sortie = execFileSync(process.execPath, [bin, "--reporter", "json", "--no-progress", ...args], {
      cwd: RACINE, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
      // `playwright.live.config.ts` refuse de se charger hors d'une base locale.
      env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://amd:amd@localhost:5432/amd_internal_os" },
    });
  } catch (e) {
    // knip sort en code 1 quand il trouve quelque chose : le rapport est quand même sur stdout.
    const err = e as { stdout?: string; stderr?: string; status?: number };
    if (err.status !== 1 || !err.stdout) throw new Error(`knip a échoué : ${err.stderr ?? e}`);
    sortie = err.stdout;
  }
  return JSON.parse(sortie) as { issues: Record<string, unknown>[] };
}

export function mesurerCodeMort(): MesureCodeMort {
  const problemes: string[] = [];
  for (const issue of knip([]).issues) {
    const fichier = String(issue.file);
    for (const [categorie, valeur] of Object.entries(issue)) {
      if (categorie === "file" || categorie === "owners") continue;
      const elements = Array.isArray(valeur) ? valeur : valeur && typeof valeur === "object" ? Object.values(valeur) : [];
      for (const el of elements) {
        const nom = el && typeof el === "object" && "name" in el ? String((el as { name: unknown }).name) : "";
        problemes.push(`${categorie} ${fichier}${nom ? `:${nom}` : ""}`);
      }
    }
  }
  const fichiersTestsSeuls = knip(["--production", "--include", "files"]).issues
    .filter((i) => Array.isArray(i.files) ? i.files.length > 0 : Boolean(i.files))
    .map((i) => String(i.file))
    .sort();
  return { problemes: problemes.sort(), fichiersTestsSeuls };
}

export interface MesureDoublons {
  clones: number;
  lignesDupliquees: number;
  pourcentage: number;
  /** Les plus longs, pour savoir par où commencer. */
  pires: { lignes: number; a: string; b: string }[];
}

export function mesurerDoublons(): MesureDoublons {
  const bin = join(RACINE, "node_modules", "jscpd", "run-jscpd.js");
  const sortie = mkdtempSync(join(tmpdir(), "jscpd-"));
  try {
    execFileSync(process.execPath, [bin, "--reporters", "json", "--output", sortie, "--silent"], { cwd: RACINE, stdio: "pipe", maxBuffer: 64 * 1024 * 1024 });
    const rapport = JSON.parse(readFileSync(join(sortie, "jscpd-report.json"), "utf8")) as {
      statistics: { total: { clones: number; duplicatedLines: number; percentage: number } };
      duplicates: { lines: number; firstFile: { name: string; start: number }; secondFile: { name: string; start: number } }[];
    };
    const t = rapport.statistics.total;
    const pires = [...rapport.duplicates].sort((x, y) => y.lines - x.lines).slice(0, 15)
      .map((d) => ({ lignes: d.lines, a: `${d.firstFile.name}:${d.firstFile.start}`, b: `${d.secondFile.name}:${d.secondFile.start}` }));
    return { clones: t.clones, lignesDupliquees: t.duplicatedLines, pourcentage: t.percentage, pires };
  } finally {
    rmSync(sortie, { recursive: true, force: true });
  }
}
