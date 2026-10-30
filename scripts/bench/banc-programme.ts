/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE BANC PROGRAMMÉ — le processus que le worker lance (J5, décision 0022). Il n'ouvre QUE la base d'essai.
 *
 *   (lancé par la tâche `qualite.banc` — `src/modules/assistant-ia/infra/qualite/banc.ts`)
 *   npm run banc:essai:semer          # UNE fois : déclare la base d'essai (marqueur) et la sème
 *
 * 1. GARDE : la base est une base de banc locale, ou la base d'essai DÉCLARÉE par le worker (`@/lib/prisma`), et elle
 *    porte le MARQUEUR d'une base d'essai (`BancBaseEssai`) — sinon refus, rien ne s'écrit.
 * 2. SEMIS : le jeu du banc Adam puis celui du banc Jarvis (synthétiques, retirables), dans des processus à part.
 * 3. BANCS, chacun dans son processus, chacun avec ce qui RESTE du plafond (`BANC_PLAFOND_USD`, 1 $ par défaut) :
 *    Jarvis (26 scénarios), Atelier (PowerPoint, Word), Travaux (un travail jusqu'au livrable), Bibliothèque
 *    (recherche par le contenu, faux embedder, 0 $). Un banc qui n'a plus de quoi payer n'est pas lancé : « NON JOUÉ ».
 * 4. SORTIE : le résultat NORMALISÉ (`BANC_SORTIE`), que le worker historise et compare.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prisma, estUneBaseDeBanc, estUneBaseDeBancOuDEssai } from "@/lib/prisma";

type Scenario = { scenario: string; famille: string; verdict: string; motifs: string[]; ms?: number | null; premierMotMs?: number | null; appels?: number; entree?: number; cache?: number; sortie?: number; coutUsd?: number };

const PLAFOND = Number(process.env.BANC_PLAFOND_USD) || 1;
/** Ce qu'un banc coûte au plus, mesuré (J3, J2) — en dessous, il n'est pas lancé. */
const COUT_MIN: Record<string, number> = { atelier: 0.15, travaux: 0.25 };
const debut = new Date();
/** Un passage RÉDUIT (fumée, mise au point) : `BANC_SEULEMENT=jarvis,bibliotheque` — le reste est « NON JOUÉ », dit. */
const SEULEMENT = (process.env.BANC_SEULEMENT ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const joue = (famille: string) => !SEULEMENT.length || SEULEMENT.includes(famille);
const exclu = (scenario: string, famille: string) => ({ scenario, famille, verdict: "NON JOUÉ", motifs: ["exclu de ce passage (BANC_SEULEMENT)"] });

async function depense(): Promise<number> {
  const r = await prisma.modelCallLog.aggregate({ where: { at: { gte: debut } }, _sum: { costUsd: true } });
  return Number(r._sum.costUsd ?? 0);
}

/** Un script de banc dans son processus ; rend ce qu'il a écrit dans `BANC_SORTIE` (ou null). */
function lancer(script: string, env: Record<string, string> = {}, args: string[] = []): { code: number | null; sortie: unknown; ms: number } {
  const fichier = path.join(os.tmpdir(), `banc-${path.basename(script, ".ts")}-${process.pid}.json`);
  fs.rmSync(fichier, { force: true });
  const t0 = Date.now();
  const r = spawnSync(path.join(process.cwd(), "node_modules", ".bin", "tsx"), [script, ...args], {
    env: { ...process.env, ...env, BANC_SORTIE: fichier }, stdio: ["ignore", "inherit", "inherit"], timeout: 45 * 60_000,
  });
  let sortie: unknown = null;
  try { sortie = JSON.parse(fs.readFileSync(fichier, "utf8")); } catch { /* aucun résultat */ }
  fs.rmSync(fichier, { force: true });
  return { code: r.status, sortie, ms: Date.now() - t0 };
}

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  if (!estUneBaseDeBancOuDEssai(url)) throw new Error("Refus : ni base de banc locale, ni base d'essai déclarée.");
  const declarer = process.argv.includes("--declarer");
  const marque = await prisma.bancBaseEssai.findUnique({ where: { id: "base-essai" } });
  if (!marque) {
    // Une base de banc LOCALE se déclare d'elle-même ; une base distante, seulement par le geste explicite (`--declarer`).
    if (!declarer && !estUneBaseDeBanc(url)) throw new Error("Refus : cette base ne porte pas le marqueur d'une base d'essai. Remède : npm run banc:essai:semer contre elle (une fois).");
    await prisma.bancBaseEssai.create({ data: { id: "base-essai", nom: new URL(url).pathname.slice(1) } });
  }

  const semis = [lancer("scripts/bench/seed-adam-bench.ts"), lancer("scripts/bench/seed-assistant-jarvis.ts")];
  if (semis.some((s) => s.code !== 0)) throw new Error("le semis de la base d'essai a échoué");
  if (declarer) { console.log("Base d'essai déclarée et semée."); return; }

  const scenarios: Scenario[] = [];
  let budgetAtteint = false;
  const reste = async () => Math.max(0, PLAFOND - (await depense()));

  // ── Jarvis ──
  const j = lancer("scripts/bench/assistant-jarvis-live.ts", { JARVIS_BUDGET_USD: String(await reste()) });
  const jr = j.sortie as { scenarios?: Scenario[]; budgetAtteint?: boolean } | null;
  if (jr?.scenarios) scenarios.push(...jr.scenarios);
  else scenarios.push({ scenario: "jarvis", famille: "jarvis", verdict: "ERREUR", motifs: [`le banc Jarvis n'a rendu aucun résultat (code ${j.code})`] });
  budgetAtteint ||= Boolean(jr?.budgetAtteint);

  // ── Atelier ──
  if (!joue("atelier")) scenarios.push(exclu("atelier-pptx", "atelier"), exclu("atelier-word", "atelier"));
  else if ((await reste()) < COUT_MIN.atelier!) {
    budgetAtteint = true;
    scenarios.push(...["atelier-pptx", "atelier-word"].map((s) => ({ scenario: s, famille: "atelier", verdict: "NON JOUÉ", motifs: ["plafond de dépense du passage atteint"] })));
  } else {
    const a = lancer("scripts/bench/atelier-live.ts");
    const ar = a.sortie as { pptx?: { reussi?: boolean; ms?: number; outils?: string[] }; word?: { reussi?: boolean; ms?: number }; coutUsd?: number; appels?: number } | null;
    const v = (ok?: boolean) => (ar ? (ok ? "OK" : "ÉCHEC") : "ERREUR");
    scenarios.push(
      { scenario: "atelier-pptx", famille: "atelier", verdict: v(ar?.pptx?.reussi), motifs: ar ? [] : [`code ${a.code}`], ms: ar?.pptx?.ms ?? null, coutUsd: (ar?.coutUsd ?? 0) / 2, appels: Math.ceil((ar?.appels ?? 0) / 2) },
      { scenario: "atelier-word", famille: "atelier", verdict: v(ar?.word?.reussi), motifs: [], ms: ar?.word?.ms ?? null, coutUsd: (ar?.coutUsd ?? 0) / 2, appels: Math.floor((ar?.appels ?? 0) / 2) },
    );
  }

  // ── Travaux ──
  const resteTravaux = await reste();
  if (!joue("travaux")) scenarios.push(exclu("travaux-rapport-annee", "travaux"));
  else if (resteTravaux < COUT_MIN.travaux!) {
    budgetAtteint = true;
    scenarios.push({ scenario: "travaux-rapport-annee", famille: "travaux", verdict: "NON JOUÉ", motifs: ["plafond de dépense du passage atteint"] });
  } else {
    const t = lancer("scripts/bench/travaux-live.ts", { BANC_BUDGET_USD: String(resteTravaux) });
    const tr = t.sortie as { statut?: string; proposeParLeModele?: boolean; coutTotalBancUsd?: number; appelsTotal?: number } | null;
    scenarios.push({
      scenario: "travaux-rapport-annee", famille: "travaux", verdict: !tr ? "ERREUR" : tr.statut === "COMPLETED" && tr.proposeParLeModele ? "OK" : "ÉCHEC",
      motifs: tr ? [`statut ${tr.statut}`, `proposé par le modèle : ${tr.proposeParLeModele ? "oui" : "non"}`] : [`code ${t.code}`],
      ms: t.ms, coutUsd: tr?.coutTotalBancUsd ?? 0, appels: tr?.appelsTotal ?? 0,
    });
  }

  // ── Bibliothèque (faux embedder : aucun appel payant) ──
  if (!joue("bibliotheque")) scenarios.push(exclu("bibliotheque-recherche", "bibliotheque"));
  else await bibliotheque(scenarios);

  const sortie = { scenarios, depenseUsd: await depense(), budgetAtteint };
  if (process.env.BANC_SORTIE) fs.writeFileSync(process.env.BANC_SORTIE, JSON.stringify(sortie));
  console.log(`Banc programmé : ${scenarios.filter((s) => s.verdict === "OK").length}/${scenarios.length} OK · ${sortie.depenseUsd.toFixed(3)} $ (plafond ${PLAFOND} $)${budgetAtteint ? " · plafond atteint" : ""}`);
}

async function bibliotheque(scenarios: Scenario[]) {
  const b = lancer("scripts/bench/bibliotheque.ts");
  const br = b.sortie as { p50?: number; p95?: number; rappel?: number; horsDroits?: number } | null;
  scenarios.push({
    scenario: "bibliotheque-recherche", famille: "bibliotheque", verdict: !br ? "ERREUR" : br.horsDroits === 0 && (br.p95 ?? 1e9) < 300 ? "OK" : "ÉCHEC",
    motifs: br ? [`p50 ${Math.round(br.p50 ?? 0)} ms · p95 ${Math.round(br.p95 ?? 0)} ms · rappel ${Math.round((br.rappel ?? 0) * 100)} % · hors droits ${br.horsDroits}`] : [`code ${b.code}`],
    ms: br?.p95 != null ? Math.round(br.p95) : null,
  });
  lancer("scripts/bench/bibliotheque.ts", {}, ["--nettoyer"]);
}

main()
  .catch((e) => {
    const erreur = e instanceof Error ? e.message : String(e);
    console.error(erreur);
    if (process.env.BANC_SORTIE) fs.writeFileSync(process.env.BANC_SORTIE, JSON.stringify({ scenarios: [], depenseUsd: 0, budgetAtteint: false, erreur }));
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
