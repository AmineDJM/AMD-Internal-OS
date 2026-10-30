import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { sansBloquer } from "@/lib/journal";
import { envDesModeles, type RoleModele } from "@/platform/ia/modeles-roles";
import { normaliserReglageBanc, passageDu, REGLAGE_BANC_DEFAUT, type ReglageBanc } from "../../domaine/qualite/calendrier";
import { choisirBaseEssai, empreinteBase } from "../../domaine/qualite/base-essai";
import { estVert, phraseRegression, regressions, type MesuresPassage } from "../../domaine/qualite/regression";
import { agreger, lireResultatBanc, type ResultatBanc } from "../../domaine/qualite/resultat";
import { lireCandidat, type Candidat } from "../../domaine/qualite/ab-modele";
import { avertirSuperAdmins } from "../consommation";
import { modelesEnService, type ModeleEnService } from "./modeles";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE BANC PROGRAMMÉ (J5, décision 0022) — le banc « Jarvis » (et les bancs Atelier, Bibliothèque, Travaux) rejoué
 * selon le calendrier du Super Admin, SUR LE WORKER, contre une base d'essai séparée semée synthétiquement.
 *
 *   1. la tâche de fond `qualite.banc` bat sur le worker : un passage demandé (écran, A/B) ou dû (calendrier) part ;
 *   2. la base d'essai est vérifiée (`domaine/qualite/base-essai.ts` ; marqueur absent de la production) — sinon le
 *      passage est REFUSÉ, raison dite, et rien ne tourne ;
 *   3. le banc tourne dans un PROCESSUS À PART (`scripts/bench/banc-programme.ts`) qui n'ouvre QUE la base d'essai :
 *      il sème, joue les scénarios par le chemin du produit, s'arrête au plafond de dépense du passage ;
 *   4. le worker relit son résultat, l'HISTORISE (passage + scénarios), le compare à la référence, et prévient le
 *      Super Admin d'une régression (réussite en baisse, latence ou coût +30 %).
 * Le battement ne tient jamais le passage : le processus de banc tourne à côté, le battement continue.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const DUREE_MAX_PASSAGE_MS = 2 * 60 * 60 * 1000;

export interface DemandeLancement {
  passageId: string;
  baseEssai: string;
  empreinteProduction: string;
  plafondUsd: number;
  envModeles: Record<string, string>;
}

/** Lance le processus de banc et rend son résultat. Remplaçable par les tests (aucun processus, aucun réseau). */
export type Lanceur = (d: DemandeLancement) => Promise<ResultatBanc>;

let lanceurDeTest: Lanceur | null = null;
export function remplacerLanceurBancPourTests(l: Lanceur | null): void { lanceurDeTest = l; }

/** Les passages qui tournent DANS CE PROCESSUS — un passage « en cours » qui n'y est pas a été interrompu. */
const enVol = new Map<string, Promise<void>>();

export async function lireReglageBanc(): Promise<ReglageBanc> {
  const r = await prisma.assistantIaBancReglage.findUnique({ where: { id: "global" } }).catch(sansBloquer("qualite.banc.lireReglage", null));
  return r ? normaliserReglageBanc(r) : REGLAGE_BANC_DEFAUT;
}

export async function enregistrerReglageBanc(e: Partial<Record<keyof ReglageBanc, unknown>>, parId: string): Promise<ReglageBanc> {
  const r = normaliserReglageBanc(e);
  await prisma.assistantIaBancReglage.upsert({ where: { id: "global" }, create: { id: "global", ...r, updatedById: parId }, update: { ...r, updatedById: parId } });
  return r;
}

/** Une demande de passage (écran : « lancer maintenant », ou A/B d'un candidat). Une seule à la fois. */
export async function demanderPassage(d: { declencheur: "MANUEL" | "AB"; parId: string; candidat?: Candidat }): Promise<{ ok: true; id: string } | { ok: false; raison: string }> {
  const ouvert = await prisma.assistantIaBancPassage.findFirst({ where: { statut: { in: ["DEMANDE", "EN_COURS"] } }, select: { id: true, declencheur: true } });
  if (ouvert) return { ok: false, raison: "Un passage du banc est déjà demandé ou en cours : attendez sa fin." };
  const reglage = await lireReglageBanc();
  const p = await prisma.assistantIaBancPassage.create({
    data: { declencheur: d.declencheur, demandeParId: d.parId, plafondUsd: reglage.plafondUsd, ...(d.candidat ? { candidat: d.candidat as unknown as Prisma.InputJsonValue } : {}) },
  });
  return { ok: true, id: p.id };
}

/** Une issue de la tâche : rien à faire, refusé (dit), ou lancé (la fin se lit sur `fin`). */
export type IssueBanc = { issue: "rien" | "refuse" | "lance"; raison?: string; passageId?: string; fin?: Promise<void> };

/**
 * LA TÂCHE DE FOND `qualite.banc`. `executeur` : qui bat (le banc ne tourne que sur le worker). Ne lève pas pour un
 * refus : le refus est un passage enregistré, que l'écran montre.
 */
export async function tacheBancProgramme(o: { executeur: string; maintenant?: Date; env?: NodeJS.ProcessEnv }): Promise<IssueBanc> {
  const env = o.env ?? process.env;
  const maintenant = o.maintenant ?? new Date();
  await clorePassagesInterrompus(maintenant);
  if (o.executeur !== "worker") return { issue: "rien", raison: "le banc programmé tourne sur le worker" };
  if (enVol.size) return { issue: "rien", raison: "un passage tourne déjà" };

  let passage = await prisma.assistantIaBancPassage.findFirst({ where: { statut: "DEMANDE" }, orderBy: { demandeLe: "asc" } });
  if (!passage) {
    const reglage = await lireReglageBanc();
    const dernier = await prisma.assistantIaBancPassage.findFirst({ where: { declencheur: "PROGRAMME" }, orderBy: { demandeLe: "desc" }, select: { demandeLe: true } });
    if (!passageDu(reglage, dernier?.demandeLe ?? null, maintenant)) return { issue: "rien" };
    passage = await prisma.assistantIaBancPassage.create({ data: { declencheur: "PROGRAMME", plafondUsd: reglage.plafondUsd, demandeLe: maintenant } });
  }

  const refuser = async (raison: string): Promise<IssueBanc> => {
    await prisma.assistantIaBancPassage.update({ where: { id: passage!.id }, data: { statut: "REFUSE", raison, finLe: maintenant } });
    return { issue: "refuse", raison, passageId: passage!.id };
  };

  const base = choisirBaseEssai({ production: env.NODE_ENV === "production", baseProduction: env.DATABASE_URL ?? "", baseEssai: env.BANC_ESSAI_DATABASE_URL, baseBancLocale: env.BENCH_DATABASE_URL });
  if (!base.ok) return refuser(base.raison);
  // Le marqueur d'une base d'essai, posé par le semis : la PRODUCTION ne doit pas le porter (sinon c'est elle qu'on vise).
  const marqueurs = await prisma.bancBaseEssai.count().catch(sansBloquer("qualite.banc.marqueurProduction", -1));
  if (marqueurs < 0) return refuser("Le marqueur de base d'essai est illisible dans la base de production (migration appliquée ?) : refus par prudence.");
  if (marqueurs > 0) return refuser("La base de production porte le marqueur d'une base d'essai : refus (vérifier BANC_ESSAI_DATABASE_URL et DATABASE_URL).");

  const service = await modelesEnService(env);
  const candidat = lireCandidat(passage.candidat);
  const modeles: Record<RoleModele, ModeleEnService> = candidat
    ? { ...service, [candidat.role]: { modelId: candidat.modelId, effort: candidat.effort as ModeleEnService["effort"], source: "écran" } }
    : service;
  await prisma.assistantIaBancPassage.update({ where: { id: passage.id }, data: { statut: "EN_COURS", debutLe: maintenant, modeles: modeles as unknown as Prisma.InputJsonValue, raison: null } });

  const lancer = lanceurDeTest ?? lanceurProcessus;
  const id = passage.id;
  const fin = lancer({ passageId: id, baseEssai: base.url, empreinteProduction: empreinteBase(env.DATABASE_URL ?? "") ?? "inconnue", plafondUsd: passage.plafondUsd, envModeles: envDesModeles(modeles) })
    .then((r) => enregistrerResultat(id, r))
    .catch(async (e) => {
      await prisma.assistantIaBancPassage.update({ where: { id }, data: { statut: "ECHEC", raison: (e instanceof Error ? e.message : String(e)).slice(0, 500), finLe: new Date() } }).catch(sansBloquer("qualite.banc.echec"));
    })
    .finally(() => { enVol.delete(id); });
  enVol.set(id, fin);
  return { issue: "lance", passageId: id, fin };
}

/** Un passage « en cours » qui ne tourne dans aucun processus vivant (redémarrage) ou depuis trop longtemps : échoué, dit. */
async function clorePassagesInterrompus(maintenant: Date): Promise<void> {
  const ouverts = await prisma.assistantIaBancPassage.findMany({ where: { statut: "EN_COURS" }, select: { id: true, debutLe: true } });
  for (const p of ouverts) {
    const vieux = !p.debutLe || maintenant.getTime() - p.debutLe.getTime() > DUREE_MAX_PASSAGE_MS;
    if (enVol.has(p.id) && !vieux) continue;
    await prisma.assistantIaBancPassage.update({ where: { id: p.id }, data: { statut: "ECHEC", raison: vieux ? "passage trop long : arrêté" : "interrompu (le worker a redémarré pendant le passage)", finLe: maintenant } });
  }
}


/** Le résultat relu, historisé, comparé à la référence ; l'avis au Super Admin si quelque chose a reculé. */
export async function enregistrerResultat(passageId: string, brut: ResultatBanc): Promise<void> {
  const r = lireResultatBanc(brut);
  const m = agreger(r);
  const passage = await prisma.assistantIaBancPassage.findUniqueOrThrow({ where: { id: passageId } });
  // LA RÉFÉRENCE : le dernier passage complet (non arrêté par son plafond) qui n'est pas un essai A/B — la configuration en service.
  const ref = await prisma.assistantIaBancPassage.findFirst({
    where: { id: { not: passageId }, statut: "TERMINE", budgetAtteint: false, declencheur: { not: "AB" } },
    orderBy: { finLe: "desc" }, include: { scenarios: { select: { scenario: true, verdict: true } } },
  });
  const mesRef: MesuresPassage | null = ref;
  const rs = regressions(m, mesRef);
  const vert = estVert(m, mesRef);
  await prisma.$transaction([
    prisma.assistantIaBancScenario.deleteMany({ where: { passageId } }),
    prisma.assistantIaBancScenario.createMany({ data: r.scenarios.map((s) => ({ passageId, scenario: s.scenario, famille: s.famille, verdict: s.verdict, motifs: s.motifs, ms: s.ms, premierMotMs: s.premierMotMs, appels: s.appels, jetonsEntree: s.entree, jetonsCache: s.cache, jetonsSortie: s.sortie, coutUsd: s.coutUsd })) }),
    prisma.assistantIaBancPassage.update({
      where: { id: passageId },
      data: {
        statut: r.scenarios.length ? "TERMINE" : "ECHEC", raison: r.erreur ?? (r.scenarios.length ? null : "le banc n'a rendu aucun scénario"), finLe: new Date(),
        reussis: m.reussis, total: m.total, erreurs: m.erreurs, ecrituresSansCarte: m.ecrituresSansCarte,
        latenceP50Ms: m.latenceP50Ms, latenceP95Ms: m.latenceP95Ms, premierMotP50Ms: m.premierMotP50Ms, premierMotP95Ms: m.premierMotP95Ms,
        jetonsEntree: m.jetonsEntree, jetonsCache: m.jetonsCache, jetonsSortie: m.jetonsSortie, coutUsd: m.coutUsd, budgetAtteint: m.budgetAtteint,
        referenceId: ref?.id ?? null, regressions: rs as unknown as Prisma.InputJsonValue, vert,
      },
    }),
  ]);

  const candidat = lireCandidat(passage.candidat);
  const avis = rs.length
    ? { title: `Banc Assistant IA : régression${candidat ? ` (A/B ${candidat.modelId})` : ""}`, body: `${m.reussis}/${m.total} OK. ${phraseRegression(rs)}.` }
    : candidat
      ? { title: `Banc A/B Assistant IA : ${vert ? "vert" : "non concluant"} pour ${candidat.modelId}`, body: `${m.reussis}/${m.total} OK, ${m.coutUsd.toFixed(3)} $.${vert ? " Le changement de modèle peut être appliqué." : m.budgetAtteint ? " Le plafond du passage a été atteint." : ""}` }
      : null;
  if (avis) {
    await avertirSuperAdmins({ ...avis, link: "/admin/ai/qualite" });
    await prisma.assistantIaBancPassage.update({ where: { id: passageId }, data: { notifieLe: new Date() } });
  }
}

// ─────────────────────────────── Le processus de banc ───────────────────────────────

/** Le lanceur réel : `tsx scripts/bench/banc-programme.ts`, n'ouvrant QUE la base d'essai, borné en durée. */
const lanceurProcessus: Lanceur = (d) => new Promise((ok, ko) => {
  const sortie = path.join(os.tmpdir(), `banc-${d.passageId}.json`);
  const enfant = spawn(path.join(process.cwd(), "node_modules", ".bin", "tsx"), ["scripts/bench/banc-programme.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env, ...d.envModeles,
      DATABASE_URL: d.baseEssai, BANC_ESSAI_DATABASE_URL: d.baseEssai, BANC_EMPREINTE_PRODUCTION: d.empreinteProduction,
      // `TACHES_DE_FOND=worker` : le processus de banc ne bat jamais lui-même (il n'est pas le worker).
      BANC_PLAFOND_USD: String(d.plafondUsd), BANC_SORTIE: sortie, BENCH_SEED_ALLOW: "1", TACHES_DE_FOND: "worker",
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  const minuterie = setTimeout(() => enfant.kill("SIGTERM"), DUREE_MAX_PASSAGE_MS);
  enfant.on("error", (e) => { clearTimeout(minuterie); ko(e); });
  enfant.on("exit", (code) => {
    clearTimeout(minuterie);
    try {
      const r = JSON.parse(fs.readFileSync(sortie, "utf8")) as ResultatBanc;
      fs.rmSync(sortie, { force: true });
      ok(r);
    } catch {
      ko(new Error(`le processus de banc s'est arrêté (code ${code}) sans rendre de résultat`));
    }
  });
});

/** Pour l'écran : l'état de la base d'essai, sans rien lancer. */
export function etatBaseEssai(env: NodeJS.ProcessEnv = process.env): { configuree: boolean; raison: string | null } {
  const b = choisirBaseEssai({ production: env.NODE_ENV === "production", baseProduction: env.DATABASE_URL ?? "", baseEssai: env.BANC_ESSAI_DATABASE_URL, baseBancLocale: env.BENCH_DATABASE_URL });
  return b.ok ? { configuree: true, raison: null } : { configuree: false, raison: b.raison };
}
