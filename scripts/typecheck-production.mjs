#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE TYPECHECK DE LA PRODUCTION, PAR TRANCHES — lot M2, marge mémoire du build (02/11/2026).
 *
 *   node scripts/typecheck-production.mjs          # = `npm run typecheck:production`
 *   TYPECHECK_TAS_MO=4500 node scripts/…           # tas de chaque tranche (défaut 4300 Mo)
 *   TYPECHECK_RACINES_PAR_TRANCHE=500 node …       # taille des tranches (défaut 650 fichiers)
 *
 * POURQUOI. `tsc --noEmit -p tsconfig.build.json` d'un seul tenant est mort en « heap out of
 * memory » au déploiement (tas 5 120 Mo, pic ≈ 5 027). Mesuré (TS API, ramasse-miettes forcé) :
 *   programme analysé (AST)         2 390 Mo  — dont Prisma seul ≈ 1 250 Mo (514 modèles, index.d.ts
 *                                               de 55 Mo / 1,19 M lignes : rien dans NOTRE code)
 *   + liaison (binder)               3 006 Mo
 *   + vérification de tout          ≈ 5 500 Mo  — 2,02 M types, 8,3 M instanciations
 * Le coût FIXE (3 Go) ne dépend d'aucune ligne qu'on puisse réécrire ; la vérification est une
 * LONGUE TRAÎNE (≈ 1 000 fichiers de requêtes Prisma, 2 à 10 k types chacun ; les cinq pires
 * réunis ≈ 6 %, déjà corrigés à la source). Aucun lot d'annotations ne rend 1,3 Go. Ce qu'on peut
 * changer, c'est de ne jamais garder EN MÊME TEMPS les types de toute l'application.
 *
 * COMMENT. Les fichiers de production (hors `.d.ts`), triés par chemin, sont coupés en tranches
 * contiguës (les voisins partagent leurs types : peu de travail refait). Chaque tranche tourne dans
 * SON processus, à tas borné, l'une après l'autre (le pic = une tranche, jamais la somme). Le
 * programme d'une tranche = ses fichiers + TOUTES les déclarations du projet (`.d.ts`, fichiers à
 * `declare global` / `declare module`) ; tsc y ajoute la fermeture de leurs imports. Le type d'un
 * fichier ne dépend que de ce qu'il importe et des déclarations globales : chaque fichier est donc
 * vérifié EXACTEMENT comme par tsc d'un seul tenant (même tsconfig, mêmes options) — c'est le
 * principe des références de projets, sans l'émission de déclarations ni `composite`.
 * Vérifié : une erreur injectée dans chaque tranche sort à l'identique ici et chez tsc.
 *
 * DURABLE. Le nombre de tranches suit le nombre de fichiers (`RACINES_PAR_TRANCHE`) : le code qui
 * grossit ajoute des tranches, pas de la mémoire par tranche. Une tranche qui ne tient plus dans
 * son tas ÉCHOUE (code ≠ 0) au lieu de passer au rejeu — c'est le garde-fou ; `MARGE_ALERTE_MO`
 * prévient avant (le tas vivant le plus haut est affiché à chaque passage).
 * Doctrine : docs/claude-md/08-versionnement-graphify-p06.md §208, knowledge-base 10 §4.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const RACINE = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CONFIG = join(RACINE, "tsconfig.build.json");
/** Tas de chaque tranche. La cible : tenir sous 4,2 Go de pic avec ce plafond. */
export const TAS_MO = Number(process.env.TYPECHECK_TAS_MO) || 4300;
/** Fichiers vérifiés par tranche. 650 → tas vivant ≈ 3,2 Go au 02/11/2026 (3 856 fichiers, 6 tranches). */
export const RACINES_PAR_TRANCHE = Number(process.env.TYPECHECK_RACINES_PAR_TRANCHE) || 650;
/** Au-delà, la marge est entamée : on le dit (sans échouer) — réduire RACINES_PAR_TRANCHE. */
const MARGE_ALERTE_MO = 3700;

/** Lit tsconfig.build.json exactement comme tsc. */
export function lireConfig(chemin = CONFIG) {
  const cfg = ts.getParsedCommandLineOfConfigFile(chemin, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => {
      throw new Error(ts.flattenDiagnosticMessageText(d.messageText, "\n"));
    },
  });
  if (!cfg) throw new Error(`Configuration illisible : ${chemin}`);
  return cfg;
}

const AUGMENTATION = /^\s*declare\s+(global|module)\b/m;

/**
 * LE DÉCOUPAGE — pur, testé (`typecheck-production.test.ts`). `lire` rend le texte d'un fichier.
 * Rend les déclarations communes à toutes les tranches et les tranches elles-mêmes.
 */
export function decouper(fichiers, lire, parTranche = RACINES_PAR_TRANCHE) {
  const tries = [...fichiers].sort();
  const declarations = tries.filter((f) => f.endsWith(".d.ts") || (/\.[cm]?[jt]sx?$/.test(f) && AUGMENTATION.test(lire(f))));
  const communs = new Set(declarations);
  const aVerifier = tries.filter((f) => !f.endsWith(".d.ts"));
  const n = Math.max(1, Math.ceil(aVerifier.length / parTranche));
  const taille = Math.ceil(aVerifier.length / n);
  const tranches = [];
  for (let i = 0; i < n; i++) tranches.push(aVerifier.slice(i * taille, (i + 1) * taille));
  return { declarations: [...communs], tranches: tranches.filter((t) => t.length > 0) };
}

const formater = (diags) => diags.map((d) => ts.formatDiagnostic(d, {
  getCanonicalFileName: (f) => f,
  getCurrentDirectory: () => RACINE,
  getNewLine: () => "\n",
}).trimEnd());

/** UNE tranche, dans ce processus. Écrit son bilan (JSON) dans `sortie`. */
function verifierTranche(i, n, sortie) {
  const debut = Date.now();
  const cfg = lireConfig();
  const { declarations, tranches } = decouper(cfg.fileNames, (f) => readFileSync(f, "utf8"));
  const miens = tranches[i] ?? [];
  const programme = ts.createProgram({ rootNames: [...declarations, ...miens], options: cfg.options, configFileParsingDiagnostics: cfg.errors });
  const verificateur = programme.getTypeChecker();
  const diags = [...programme.getConfigFileParsingDiagnostics(), ...programme.getOptionsDiagnostics()];
  for (const f of miens) {
    const sf = programme.getSourceFile(f);
    if (!sf) { diags.push({ category: ts.DiagnosticCategory.Error, code: 0, file: undefined, start: undefined, length: undefined, messageText: `Fichier absent du programme : ${f}` }); continue; }
    diags.push(...programme.getSyntacticDiagnostics(sf), ...programme.getSemanticDiagnostics(sf));
  }
  diags.push(...programme.getGlobalDiagnostics());
  const erreurs = diags.filter((d) => d.category === ts.DiagnosticCategory.Error);
  const bilan = {
    tranche: i, n,
    premier: relative(RACINE, miens[0] ?? ""), dernier: relative(RACINE, miens.at(-1) ?? ""),
    racines: miens.length, fichiers: programme.getSourceFiles().length,
    types: verificateur.getTypeCount(), instanciations: verificateur.getInstantiationCount(),
    tasVivantMo: Math.round(process.memoryUsage().heapUsed / 1048576),
    picRssMo: Math.round(process.resourceUsage().maxRSS / 1024),
    dureeS: Math.round((Date.now() - debut) / 1000),
    erreurs: formater(erreurs),
  };
  writeFileSync(sortie, JSON.stringify(bilan));
}

/** L'orchestrateur : léger (aucun programme chargé ici), lance les tranches une à une. */
function orchestrer() {
  const debut = Date.now();
  const cfg = lireConfig();
  const { declarations, tranches } = decouper(cfg.fileNames, (f) => readFileSync(f, "utf8"));
  const n = tranches.length;
  console.log(`[typecheck] Production (tsconfig.build.json) : ${cfg.fileNames.length} fichiers, ${n} tranches de ≤ ${RACINES_PAR_TRANCHE}, ${declarations.length} déclarations communes, tas ${TAS_MO} Mo par tranche.`);
  const dossier = mkdtempSync(join(tmpdir(), "typecheck-"));
  const erreurs = new Set();
  const bilans = [];
  let morte = null;
  try {
    for (let i = 0; i < n; i++) {
      const sortie = join(dossier, `${i}.json`);
      const r = spawnSync(process.execPath, [`--max-old-space-size=${TAS_MO}`, fileURLToPath(import.meta.url), "--tranche", String(i), String(n), sortie], {
        stdio: ["ignore", "inherit", "inherit"],
        env: { ...process.env, NODE_OPTIONS: "" },
      });
      let bilan = null;
      try { bilan = JSON.parse(readFileSync(sortie, "utf8")); } catch { /* tranche morte avant son bilan */ }
      if (r.status !== 0 || !bilan) {
        morte = { i, statut: r.status, signal: r.signal };
        break;
      }
      bilans.push(bilan);
      for (const e of bilan.erreurs) erreurs.add(e);
      console.log(`[typecheck] tranche ${i + 1}/${n} : ${bilan.racines} fichiers (programme ${bilan.fichiers}), ${bilan.types} types, tas vivant ${bilan.tasVivantMo} Mo, pic RSS ${bilan.picRssMo} Mo, ${bilan.dureeS} s — ${bilan.premier} … ${bilan.dernier}`);
    }
  } finally {
    rmSync(dossier, { recursive: true, force: true });
  }
  if (morte) {
    console.error(`[typecheck] ÉCHEC : la tranche ${morte.i + 1}/${n} est morte (code ${morte.statut}, signal ${morte.signal}) — très probablement le tas de ${TAS_MO} Mo épuisé. La marge est consommée : réduire TYPECHECK_RACINES_PAR_TRANCHE (valeur par défaut dans ce script) ou trouver le fichier qui a fait grossir la tranche ; ne PAS relever le tas à l'aveugle.`);
    process.exit(2);
  }
  for (const e of erreurs) console.error(e);
  const pic = Math.max(...bilans.map((b) => b.tasVivantMo));
  const picRss = Math.max(...bilans.map((b) => b.picRssMo));
  console.log(`[typecheck] ${erreurs.size} erreur(s) — tas vivant max ${pic} Mo, pic RSS max ${picRss} Mo, ${Math.round((Date.now() - debut) / 1000)} s.`);
  if (pic > MARGE_ALERTE_MO) console.warn(`[typecheck] ⚠️ Marge entamée : une tranche dépasse ${MARGE_ALERTE_MO} Mo de tas vivant. Réduire RACINES_PAR_TRANCHE avant que le déploiement ne meure.`);
  process.exit(erreurs.size > 0 ? 1 : 0);
}

const estLance = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (estLance) {
  if (process.argv[2] === "--tranche") verifierTranche(Number(process.argv[3]), Number(process.argv[4]), process.argv[5]);
  else orchestrer();
}
