import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * GARDE-FOU DU BUNDLE CLIENT.
 *
 * Un composant `"use client"` est compilé POUR LE NAVIGATEUR. S'il importe — même
 * indirectement, à dix modules de distance — quelque chose qui lit des fichiers (`fs`, `zlib`,
 * `path`, `child_process`), la compilation de production échoue avec
 * « Module not found: Can't resolve 'fs' ».
 *
 * Ce n'est pas théorique : c'est exactement ce qui a cassé un déploiement. Le composant
 * `product-explorer.tsx` importait une constante depuis `market/molecule.ts`, qui importait
 * `market/data.ts`, qui lit les jeux IQVIA avec `fs`. Le typecheck passait, le build local aussi
 * (cache `.next`), et seul le serveur a dit non.
 *
 * Ce test refait le chemin d'import à la main. Il coûte quelques millisecondes et rend
 * l'erreur impossible à re-livrer.
 *
 * La marche s'arrête aux modules `"use server"` : Next.js ne les envoie PAS au navigateur, il
 * les remplace par un appel distant. Un composant client peut donc appeler une action serveur
 * qui lit des fichiers — c'est même le mode d'emploi normal. Seuls les imports ORDINAIRES
 * comptent.
 */

const SRC = path.join(process.cwd(), "src");
const NODE_ONLY = /^(node:)?(fs|fs\/promises|zlib|child_process|worker_threads|net|tls|dns|http|https|os|cluster|readline|async_hooks)$/;
/**
 * LES PAQUETS QUI N'EXISTENT QUE CÔTÉ NODE — la seconde façon d'atteindre `net`/`tls`.
 *
 * Le premier garde ne regardait que les modules natifs importés PAR NOTRE CODE. Or un paquet
 * externe peut les importer à notre place : `web-push` tire `https-proxy-agent`, donc `net` et
 * `tls`. Mesuré sur un build propre : `messaging.ts` → `events/messaging-events` → `ledger` →
 * `reminders` → `notify` → `push` → `web-push`, depuis un composant client qui voulait un
 * libellé de statut. Le test passait, le build tombait. Ces paquets sont donc des frontières au
 * même titre que `fs`.
 */
// `@prisma/client` et `bcryptjs` n'y sont PAS : le premier a un talon navigateur (le build passe,
// et des écrans l'atteignent déjà par `rbac`/`settings`), le second est du JavaScript pur.
const NODE_ONLY_PACKAGES = new Set([
  "web-push", "nodemailer", "imapflow", "mailparser", "sharp", "mupdf", "pdfkit", "pdf-parse", "yauzl", "@mastra/core",
]);
const estPaquetNode = (spec: string) => NODE_ONLY_PACKAGES.has(spec) || [...NODE_ONLY_PACKAGES].some((p) => spec.startsWith(`${p}/`));

/** Tous les fichiers `.ts`/`.tsx` sous `src/`, hors tests. */
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "node_modules" || name === "data") continue;
      walk(p, out);
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

const IMPORT_RE = /(?:^|\n)\s*import\s+(?:type\s+)?(?:[^'"]*?\sfrom\s+)?["']([^"']+)["']/g;

/**
 * LES IMPORTS DYNAMIQUES COMPTENT AUSSI. `await import("@/lib/assistant/reminders")` n'est pas
 * une frontière pour webpack : le module devient un morceau asynchrone du MÊME bundle, et ses
 * `net`/`tls` cassent le build exactement comme un import statique. Le premier garde ne suivait
 * que `import … from` ; un sabotage l'a montré — un composant client remis sur `messaging.ts`
 * passait le test, parce que la chaîne fautive traversait le `import()` du registre d'événements.
 */
const DYNAMIC_IMPORT_RE = /\bimport\(\s*["']([^"']+)["']\s*\)/g;

/** Spécificateurs importés par un fichier, en ignorant les imports de TYPE (effacés à la compilation). */
function importsOf(file: string): string[] {
  const src = readFileSync(file, "utf8");
  const out: string[] = [];
  for (const m of src.matchAll(IMPORT_RE)) {
    const stmt = m[0];
    // `import type { X } from "…"` et `import { type X } from "…"` seul → effacé, sans effet runtime.
    if (/^\s*import\s+type\s/.test(stmt)) continue;
    if (/\{\s*(?:type\s+[^,}]+,?\s*)+\}/.test(stmt) && !/\{\s*[^t}][^,}]*/.test(stmt.replace(/type\s+[^,}]+/g, ""))) continue;
    out.push(m[1]);
  }
  for (const m of src.matchAll(DYNAMIC_IMPORT_RE)) out.push(m[1]);
  return out;
}

/** Résout un spécificateur vers un fichier de `src/` (alias `@/`, chemins relatifs). */
function resolve(spec: string, fromFile: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = path.join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(fromFile), spec);
  else return null; // paquet externe : hors périmètre
  for (const cand of [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand;
  }
  return null;
}

/** Un module `"use server"` n'est jamais envoyé au navigateur : la marche s'y arrête. */
const isServerAction = (file: string) => /^\s*["']use server["']/.test(readFileSync(file, "utf8"));

/** Remonte la chaîne d'imports jusqu'à un module Node-only ; renvoie le chemin fautif. */
function nodeOnlyPath(entry: string): string[] | null {
  const seen = new Set<string>();
  const stack: { file: string; trail: string[] }[] = [{ file: entry, trail: [entry] }];
  while (stack.length) {
    const { file, trail } = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of importsOf(file)) {
      if (NODE_ONLY.test(spec) || estPaquetNode(spec)) return [...trail, spec];
      const next = resolve(spec, file);
      if (!next || seen.has(next)) continue;
      if (isServerAction(next)) continue; // frontière RPC : rien ne traverse
      stack.push({ file: next, trail: [...trail, next] });
    }
  }
  return null;
}

const rel = (p: string) => path.relative(process.cwd(), p);

describe("Bundle client — aucun composant « use client » ne doit atteindre fs/zlib", () => {
  const clientFiles = walk(SRC).filter((f) => /^\s*["']use client["']/.test(readFileSync(f, "utf8")));

  it("trouve bien des composants client à vérifier (le test lui-même n'est pas vide)", () => {
    expect(clientFiles.length).toBeGreaterThan(20);
  });

  it("aucun composant client n'importe, même indirectement, un module Node-only", () => {
    const offenders = clientFiles
      .map((f) => ({ file: f, trail: nodeOnlyPath(f) }))
      .filter((x) => x.trail !== null)
      .map((x) => `${rel(x.file)}\n     → ${x.trail!.slice(1).map((t) => (t.includes(path.sep) ? rel(t) : `« ${t} »`)).join("\n     → ")}`);

    expect(offenders, `Chaîne(s) d'import fautive(s) :\n\n  ${offenders.join("\n\n  ")}\n`).toEqual([]);
  });



  it("le module des normalisations pharma reste PUR (il est importé par l'explorateur)", () => {
    expect(nodeOnlyPath(path.join(SRC, "lib/market/galenic.ts"))).toBeNull();
    expect(nodeOnlyPath(path.join(SRC, "lib/market/text.ts"))).toBeNull();
  });

  it("la part pure de la messagerie reste PURE (les écrans de messagerie l'importent)", () => {
    expect(nodeOnlyPath(path.join(SRC, "lib/messaging-ui.ts"))).toBeNull();
  });
});
