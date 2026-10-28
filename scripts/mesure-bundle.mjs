#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE JS QUE PAIE CHAQUE PAGE — mesuré sur le build de production (audit performance PERF-05, §4.7).
 *
 * À lancer APRÈS un build propre (`rm -rf .next && npm run build:render`) :
 *
 *   node scripts/mesure-bundle.mjs                  # tableau : coque, médiane, pages les plus lourdes
 *   COQUE_MAX_KB=220 node scripts/mesure-bundle.mjs # sortie non nulle si la coque dépasse 220 kB gzip
 *
 * Méthode (celle du rapport 07) : `app-build-manifest.json` donne les chunks de chaque entrée (page,
 * layouts). Le « First Load JS » d'une page = l'union des chunks de la page ET de tous ses layouts
 * parents ; chaque chunk est compté UNE fois, en gzip (niveau 9, comme un CDN). La « coque » = le
 * layout racine + `(app)/layout` — ce que paie toute page de l'ERP.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const NEXT = join(process.cwd(), ".next");
const manifeste = JSON.parse(readFileSync(join(NEXT, "app-build-manifest.json"), "utf8")).pages;

const tailles = new Map();
function gzipKo(fichier) {
  if (!tailles.has(fichier)) tailles.set(fichier, gzipSync(readFileSync(join(NEXT, fichier)), { level: 9 }).length);
  return tailles.get(fichier);
}
const js = (entree) => (manifeste[entree] ?? []).filter((f) => f.endsWith(".js"));
const ko = (fichiers) => [...new Set(fichiers)].reduce((t, f) => t + gzipKo(f), 0) / 1024;

/** Les layouts parents d'une page : « /(app)/finances/page » → « /layout », « /(app)/layout », « /(app)/finances/layout ». */
function layoutsDe(page) {
  const segments = page.split("/").slice(1, -1);
  const out = ["/layout"];
  for (let i = 1; i <= segments.length; i++) out.push(`/${segments.slice(0, i).join("/")}/layout`);
  return out.filter((l) => manifeste[l]);
}

const pages = Object.keys(manifeste).filter((p) => p.endsWith("/page"));
const parPage = pages
  .map((p) => ({ page: p, ko: ko([...js(p), ...layoutsDe(p).flatMap(js)]) }))
  .sort((a, b) => a.ko - b.ko);
const coque = ko([...js("/layout"), ...js("/(app)/layout")]);
const mediane = parPage[Math.floor(parPage.length / 2)]?.ko ?? 0;
const appPages = parPage.filter((p) => p.page.startsWith("/(app)/"));

const f = (n) => `${n.toFixed(1)} kB`;
console.log(`Pages                          : ${parPage.length}`);
console.log(`Coque (layout racine + (app))  : ${f(coque)} gzip`);
console.log(`Page ERP la plus légère        : ${f(appPages[0]?.ko ?? 0)} (${appPages[0]?.page})`);
console.log(`Médiane par page               : ${f(mediane)}`);
console.log("Les 5 plus lourdes            :");
for (const p of parPage.slice(-5).reverse()) console.log(`   ${f(p.ko).padStart(9)}  ${p.page}`);

const plafond = Number(process.env.COQUE_MAX_KB);
if (Number.isFinite(plafond) && plafond > 0 && coque > plafond) {
  console.error(`✗ La coque pèse ${f(coque)} gzip, au-dessus du plafond de ${f(plafond)}.`);
  process.exit(1);
}
