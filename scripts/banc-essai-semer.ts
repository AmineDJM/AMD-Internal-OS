/**
 * DÉCLARER ET SEMER LA BASE D'ESSAI DU BANC PROGRAMMÉ (J5, décision 0022) — le geste d'exploitation, UNE fois.
 *
 *   BANC_ESSAI_DATABASE_URL=postgresql://…/amd_essai npm run banc:essai:semer
 *
 * Lancé là où `DATABASE_URL` désigne la production (le Shell du worker, par exemple) : l'empreinte de la production est
 * calculée ici et transmise au banc, qui refuse d'ouvrir une base de même empreinte. Le banc pose le MARQUEUR d'une base
 * d'essai (`BancBaseEssai`) puis sème les jeux synthétiques des bancs Adam et Jarvis.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { choisirBaseEssai, empreinteBase } from "@/modules/assistant-ia/partage";

const prod = process.env.DATABASE_URL ?? "";
const base = choisirBaseEssai({ production: true, baseProduction: prod, baseEssai: process.env.BANC_ESSAI_DATABASE_URL });
if (!base.ok) { console.error(base.raison); process.exit(1); }
const r = spawnSync(path.join(process.cwd(), "node_modules", ".bin", "tsx"), ["scripts/bench/banc-programme.ts", "--declarer"], {
  stdio: "inherit",
  env: { ...process.env, DATABASE_URL: base.url, BANC_ESSAI_DATABASE_URL: base.url, BANC_EMPREINTE_PRODUCTION: empreinteBase(prod) ?? "inconnue", BENCH_SEED_ALLOW: "1", TACHES_DE_FOND: "worker" },
});
process.exit(r.status ?? 1);
