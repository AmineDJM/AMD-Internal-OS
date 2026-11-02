/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA COUCHE D'ACCEPTANCE DU RUN 4 — chaque capacité du produit, PROUVÉE dans le run lui-même.
 *
 * ── LA RÈGLE UNIQUE ──────────────────────────────────────────────────────────────────────
 *
 * « On raccourcit le temps. On simule l'extérieur quand c'est nécessaire. Mais on ne
 * raccourcit JAMAIS le chemin de production. » Concrètement :
 *
 *   • une mission naît par `lancerMission` / `lancerEnArrierePlan`, avance par
 *     `avancerMission`, se gouverne par `control.ts` — jamais par une écriture directe d'état ;
 *   • une attente se règle par le VRAI bus (`recordEvent` → conséquences du registre →
 *     `reveillerMissions`) ou par le VRAI balayage temporel à horloge INJECTÉE — jamais par
 *     `resumeMission()` à la main, jamais par `setTimeout` ;
 *   • un e-mail entre par la FRONTIÈRE exacte du fournisseur : `ingestMessage` reçoit un
 *     identifiant, appelle Gmail (ici un `fetch` scellé sur le SEUL hôte gmail.googleapis.com,
 *     qui sert la forme `format=full` réelle), normalise, déduplique, extrait la pièce, émet
 *     `EMAIL_RECEIVED` — la totalité du pipeline de production ;
 *   • ce qui remplace le réseau du MODÈLE est le raisonneur scripté, vérifié contre le schéma
 *     de production — et ce qui exige le fournisseur RÉEL (recherche web, cache de prompt,
 *     en-têtes de débit) est joué LIVE quand la clé existe, et marqué NOT_PROVEN_LIVE sinon.
 *     On ne triche pas sur le statut (§14).
 *
 * ── QUATRE STATUTS, PAS TROIS ────────────────────────────────────────────────────────────
 *
 *   PASS             la propriété est démontrée, mesures à l'appui ;
 *   FAIL             elle est contredite — le run doit le dire, pas le maquiller ;
 *   NOT_PROVEN_LIVE  elle exige le fournisseur réel, absent de cet environnement ;
 *   ECARTE           la base ne porte pas de quoi la jouer (dit, jamais simulé — §78).
 *
 * ── L'HYGIÈNE ────────────────────────────────────────────────────────────────────────────
 *
 * Tout ce que ce banc crée porte son jeton (utilisateur, salariés, connexion, rappels,
 * événements) et il ne supprime QUE cela. Les identités synthétiques sont taguées pour ne
 * jamais recouper une attente ou un rappel RÉEL par inclusion de texte (`designe` matche à
 * partir de 4 caractères : « sarah » réveillerait la vraie mission qui attend Sarah).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Découpé par responsabilité — voir le dossier `acceptance/` : `banc.ts` (statuts, résultats, outils
 * du banc, contexte d'un run), puis une famille de scénarios par fichier, jouée dans l'ordre d'origine :
 * `arriere-plan.ts` (§1), `attentes.ts` (§5, §2), `rappels.ts` (§4), `courriel.ts` (§3), `robustesse.ts`
 * (§9, §10-11), `plans.ts` (§15, §16, §25, §17), `live.ts` (les preuves qui exigent le fournisseur réel).
 * Ce fichier garde le run lui-même (compte du banc, nettoyage), son rendu texte et le verdict du Run 4.
 */
import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import { getAccess, type EffectiveAccess } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";
import { RaisonneurScripte, pour } from "@/platform/in-process/missions/fake-reasoner";
import { lancerMission } from "@/platform/in-process/missions/runtime";
import { carteDeScore, type ResultatDeep } from "@/platform/in-process/missions/deep-smoke";
import { etatPorte } from "@/lib/models/throttle";
import { sansBloquer } from "@/lib/journal";
import { attendre, type ContexteAcceptance, jugePour, type ResultatAcceptance, type ScenarioAcceptance, type StatutAcceptance } from "./acceptance/banc";
import { scenariosArrierePlan } from "./acceptance/arriere-plan";
import { scenariosAttentes } from "./acceptance/attentes";
import { scenariosRappels } from "./acceptance/rappels";
import { scenariosCourriel } from "./acceptance/courriel";
import { scenariosRobustesse } from "./acceptance/robustesse";
import { scenariosPlans } from "./acceptance/plans";
import { scenariosLive } from "./acceptance/live";

export type { StatutAcceptance, ScenarioAcceptance, ResultatAcceptance } from "./acceptance/banc";

/* ────────────────────────────── LE RUN D'ACCEPTANCE ────────────────────────────── */

export async function executerAcceptance(
  opts: { inclureLive?: boolean; onScenario?: (ligne: string) => void } = {},
): Promise<ResultatAcceptance> {
  const t0 = Date.now();
  const TAG = `acc${Date.now().toString(36)}${crypto.randomBytes(2).toString("hex")}`;
  const PREFIXE = `[ACC ${TAG}]`;
  const live = opts.inclureLive ?? Boolean((process.env.OPENAI_API_KEY ?? "").trim());
  const scenarios: ScenarioAcceptance[] = [];
  const missionsCreees = new Set<string>();

  /** L'ACTEUR DU BANC — un compte direction dédié : mêmes droits par le même RBAC, mais ses
   *  missions, rappels et notifications n'encombrent jamais l'écran du vrai PDG. */
  const compte = await prisma.user.create({
    data: { name: `${TAG} Direction`, email: `${TAG}@amd-acceptance.dz`, passwordHash: "x", role: "SUPER_ADMIN" },
    select: { id: true, name: true, email: true, role: true },
  });
  const acteur: CurrentUser = {
    id: compte.id, name: compte.name, email: compte.email, role: compte.role,
    access: (await getAccess(compte.id, compte.role)) as EffectiveAccess,
    mustChangePassword: false,
  };

  const jouerScenario = async (
    code: string, capacite: string, titre: string, exigeLive: boolean,
    corps: () => Promise<{ mesures: Record<string, unknown>; preuve: string; statut?: StatutAcceptance }>,
  ): Promise<void> => {
    const debut = Date.now();
    let statut: StatutAcceptance;
    let mesures: Record<string, unknown> = {};
    let preuve: string;
    if (exigeLive && !live) {
      statut = "NOT_PROVEN_LIVE";
      preuve = "OPENAI_API_KEY absente de cet environnement — le chemin exige le fournisseur réel.";
    } else {
      try {
        const r = await corps();
        statut = r.statut ?? "PASS";
        mesures = r.mesures;
        preuve = r.preuve;
      } catch (e) {
        statut = "FAIL";
        preuve = e instanceof Error ? e.message : String(e);
      }
    }
    const s: ScenarioAcceptance = { code, capacite, titre, live: exigeLive, statut, mesures, preuve, dureeMs: Date.now() - debut };
    scenarios.push(s);
    opts.onScenario?.(
      `[${code.padEnd(7)}] ${statut.padEnd(16)} ${capacite.padEnd(20)} ${((s.dureeMs) / 1000).toFixed(1)}s — ${preuve.slice(0, 110)}`,
    );
  };

  /** Lance une mission scriptée par le POINT D'ENTRÉE de production et l'enregistre au nettoyage. */
  const lancer = async (
    objectif: string, plan: Record<string, unknown>, criteres: string[],
    options: { demarrer?: boolean; titre?: string; cerveau?: RaisonneurScripte } = {},
  ): Promise<{ missionId: string; cerveau: RaisonneurScripte }> => {
    const cerveau = options.cerveau ?? new RaisonneurScripte([
      pour("mission.plan", () => ({ ok: true, data: plan })),
      jugePour(criteres),
    ]);
    const r = await lancerMission(acteur, objectif, {
      lectureSeule: true, demarrer: options.demarrer ?? false,
      reasoner: cerveau, titre: `${PREFIXE} ${options.titre ?? objectif.slice(0, 60)}`,
    });
    attendre(r.ok, `lancement refusé : ${r.ok ? "" : r.error}`);
    missionsCreees.add(r.missionId);
    return { missionId: r.missionId, cerveau };
  };

  try {
    const ctx: ContexteAcceptance = { TAG, PREFIXE, live, acteur, missionsCreees, jouerScenario, lancer };
    // Les familles de scénarios, dans l'ordre d'origine — une par fichier de `acceptance/`.
    await scenariosArrierePlan(ctx); // §1 — ARRIÈRE-PLAN : détacher, coexister, conclure
    await scenariosAttentes(ctx); // §5 — WAIT_FOR_TIME, puis §2 — WAIT_FOR_EVENT
    await scenariosRappels(ctx); // §4 — RAPPELS : l'échelle, l'extinction, par l'OUTIL de production
    await scenariosCourriel(ctx); // §3 — E-MAIL : la frontière EXACTE du fournisseur
    await scenariosRobustesse(ctx); // §9 — CRASH, puis §10-11 — MASSIF
    await scenariosPlans(ctx); // §15 — FORMES DE PLANS, §16 — SPÉCULATION, §25 — ANTI-TRICHE, §17 — COÛT
    await scenariosLive(ctx); // LES PREUVES QUI EXIGENT LE FOURNISSEUR RÉEL
  } finally {
    /* ═══════════════ LE NETTOYAGE — ce que CE run a créé, et rien d'autre ═══════════════ */
    try {
      const missions = await prisma.mission.findMany({
        where: { OR: [{ id: { in: [...missionsCreees] } }, { title: { startsWith: PREFIXE }, ownerId: compte.id }] },
        select: { id: true },
      });
      const ids = missions.map((m) => m.id);
      if (ids.length > 0) {
        const where = { missionId: { in: ids } };
        await prisma.missionPlanPattern.deleteMany({ where: { dernierMissionId: { in: ids } } }).catch(sansBloquer("acceptance.executerAcceptance.missionPlanPattern"));
        await prisma.missionWorkerRun.deleteMany({ where }).catch(sansBloquer("acceptance.executerAcceptance.missionWorkerRun"));
        await prisma.missionEvent.deleteMany({ where }).catch(sansBloquer("acceptance.executerAcceptance.missionEvent"));
        await prisma.missionApproval.deleteMany({ where }).catch(sansBloquer("acceptance.executerAcceptance.missionApproval"));
        await prisma.missionArtifact.deleteMany({ where }).catch(sansBloquer("acceptance.executerAcceptance.missionArtifact"));
        await prisma.missionParticipant.deleteMany({ where }).catch(sansBloquer("acceptance.executerAcceptance.missionParticipant"));
        await prisma.missionStep.deleteMany({ where }).catch(sansBloquer("acceptance.executerAcceptance.missionStep"));
        await prisma.mission.deleteMany({ where: { id: { in: ids } } }).catch(sansBloquer("acceptance.executerAcceptance.mission"));
      }
      await prisma.employee.deleteMany({ where: { department: `DEP-${TAG}` } }).catch(sansBloquer("acceptance.executerAcceptance.employee"));
      await prisma.assistantReminder.deleteMany({ where: { userId: compte.id } }).catch(sansBloquer("acceptance.executerAcceptance.assistantReminder"));
      await prisma.notification.deleteMany({ where: { userId: compte.id } }).catch(sansBloquer("acceptance.executerAcceptance.notification"));
      await prisma.businessEvent.deleteMany({ where: { payload: { path: ["marqueur"], equals: TAG } } }).catch(sansBloquer("acceptance.executerAcceptance.businessEvent"));
      // Les utilisateurs du banc — l'acteur ET la boîte Gmail : les cascades emportent la
      // connexion, les enregistrements de courrier et leurs pièces.
      await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(sansBloquer("acceptance.executerAcceptance.user"));
    } catch {
      // Le nettoyage est défensif : un reliquat taggé vaut mieux qu'un run qui échoue à la fin.
    }
  }

  const compteFinal = {
    pass: scenarios.filter((s) => s.statut === "PASS").length,
    fail: scenarios.filter((s) => s.statut === "FAIL").length,
    nonProuveLive: scenarios.filter((s) => s.statut === "NOT_PROVEN_LIVE").length,
    ecartes: scenarios.filter((s) => s.statut === "ECARTE").length,
  };
  return { jeton: TAG, liveDisponible: live, scenarios, compte: compteFinal, dureeMs: Date.now() - t0 };
}

/* ────────────────────────────── LE RENDU ────────────────────────────── */

export function rendreTexteAcceptance(r: ResultatAcceptance): string {
  const l: string[] = [];
  l.push("═══════════════ ACCEPTANCE RUN 4 — chaque capacité, prouvée dans le run ═══════════════");
  l.push("");
  l.push(`  scénarios                ${r.scenarios.length} · PASS ${r.compte.pass} · FAIL ${r.compte.fail} · NOT_PROVEN_LIVE ${r.compte.nonProuveLive} · ÉCARTÉS ${r.compte.ecartes}`);
  l.push(`  fournisseur réel         ${r.liveDisponible ? "DISPONIBLE — les preuves live ont été jouées" : "ABSENT — les preuves live sont dites NOT_PROVEN_LIVE, jamais simulées"}`);
  l.push(`  durée                    ${(r.dureeMs / 1000).toFixed(1)}s · jeton ${r.jeton}`);
  l.push("");
  for (const s of r.scenarios) {
    l.push(`  [${s.code.padEnd(7)}] ${s.statut.padEnd(16)} ${s.capacite}`);
    l.push(`            ${s.preuve}`);
  }
  l.push("");
  return l.join("\n");
}

/**
 * LE VERDICT AUTOMATIQUE DU RUN 4 (§29) — imprimé par le harnais, jamais écrit à la main.
 * Chaque ligne est un agrégat MESURÉ : les 54 missions historiques, la couche d'acceptance,
 * la porte de concurrence (jetons, cache, recherches web, coût exact-ou-inconnu).
 */
export function verdictRun4(deep: ResultatDeep, acc: ResultatAcceptance): string {
  const carte = carteDeScore(deep);
  const porte = etatPorte();
  const succes = deep.missions.filter((m) => m.verdict === "SUCCES").length;
  const defauts = deep.missions.filter((m) => m.verdict === "DEFAUT").length;
  const fauxSucces = deep.missions.filter((m) => m.verdict === "DEFAUT" && /COMPLETED sans objectif/.test(m.raisonVerdict)).length;
  const fauxBlocages = deep.missions.filter((m) => m.resultat.missionId === null).length;

  const statutDe = (codes: string[]): string => {
    const vises = acc.scenarios.filter((s) => codes.includes(s.code));
    if (vises.length === 0) return "NON JOUÉ";
    if (vises.some((s) => s.statut === "FAIL")) return "FAIL";
    if (vises.some((s) => s.statut === "NOT_PROVEN_LIVE")) return "NOT_PROVEN_LIVE";
    if (vises.every((s) => s.statut === "ECARTE")) return "ECARTE";
    return "PASS";
  };
  const capacites: [string, string[]][] = [
    ["BACKGROUND", ["BG-1", "BG-2", "BG-3"]],
    ["CONTROLS", ["BG-4"]],
    ["WAIT_FOR_TIME", ["TIME-1"]],
    ["WAIT_FOR_EVENT", ["EVT-1", "EVT-2"]],
    ["EMAIL_PIPELINE", ["MAIL-1"]],
    ["REMINDERS", ["REM-1", "REM-2"]],
    ["CRASH_RESTART", ["CRASH-1"]],
    ["MASSIVE_PROGRESS", ["MASS-1"]],
    ["PLAN_PATTERNS", ["PAT-1"]],
    ["SPECULATIVE", ["SPEC-1", "SPEC-2"]],
    ["COST_ACCOUNTING", ["COST-1"]],
    ["ANTI_CHEAT", ["CHEAT-1"]],
    ["WEB_RESEARCH", ["WEB-1"]],
    ["DEEP_RESEARCH", ["WEB-2"]],
    ["INTERNAL_EXTERNAL", ["WEB-3"]],
    ["ADAPTIVE_CONCURRENCY", ["CONC-1"]],
    ["TOKEN_RESERVATION", ["TOK-1"]],
    ["PROMPT_CACHE", ["CACHE-1"]],
  ];

  const sec = (ms: number | null): string => (ms === null ? "—" : `${(ms / 1000).toFixed(1)}s`);
  const joues = acc.compte.pass + acc.compte.fail;
  const dupliques = statutDe(["CRASH-1", "EVT-1", "EVT-2", "MAIL-1"]);
  const tauxCache = porte.conso.entree > 0 ? `${Math.round((porte.conso.caches / porte.conso.entree) * 1000) / 10}%` : "—";
  const cout = porte.conso.appels === 0
    ? "— (aucun appel fournisseur dans ce processus)"
    : porte.conso.appelsSansPrix > 0
      ? `INCONNU — ${porte.conso.appelsSansPrix} appel(s) sans tarif configuré (un total partiel serait un mensonge)`
      : `$${porte.conso.coutUsd.toFixed(4)}`;

  const l: string[] = [];
  l.push("═══════════════════ RUN 4 — VERDICT AUTOMATIQUE (imprimé par le harnais) ═══════════════════");
  l.push(`  HISTORICAL            ${succes}/${deep.missions.length} SUCCÈS (deep smoke, données réelles)`);
  l.push(`  NEW AUTONOMY          ${acc.compte.pass}/${joues} PASS · ${acc.compte.nonProuveLive} NOT_PROVEN_LIVE · ${acc.compte.ecartes} écarté(s)`);
  l.push(`  TOTAL                 ${succes + acc.compte.pass}/${deep.missions.length + joues}`);
  const directe = carte.parVoie.find((v) => v.voie === "DIRECTE");
  const modele = carte.parVoie.find((v) => v.voie === "MODELE");
  l.push(`  DIRECT                ${directe ? `${directe.succes.num}/${directe.succes.den}` : "—"} · MODEL ${modele ? `${modele.succes.num}/${modele.succes.den}` : "—"}`);
  for (const [nom, codes] of capacites) l.push(`  ${nom.padEnd(21)} ${statutDe(codes)}`);
  l.push(`  NO_DUPLICATE_EFFECT   ${dupliques === "PASS" ? "PASS" : dupliques}`);
  l.push(`  FALSE_SUCCESS         ${fauxSucces}`);
  l.push(`  FALSE_BLOCK           ${fauxBlocages}`);
  l.push(`  DEFECTS               ${defauts + acc.compte.fail} (deep ${defauts} · acceptance ${acc.compte.fail})`);
  l.push(`  REPLANS               ${carte.replans.total} (max ${carte.replans.max} par mission)`);
  l.push(`  MODEL_CALLS           ${porte.conso.appels > 0 ? `${porte.conso.appels} (porte, processus entier)` : `${deep.appelsModele} (instruments deep)`}`);
  l.push(`  LATENCE               P50 ${sec(carte.latence.p50Ms)} · P95 ${sec(carte.latence.p95Ms)}`);
  l.push(`  TOTAL_TOKENS          ${porte.conso.reels > 0 ? `${porte.conso.reels} (entrée ${porte.conso.entree} · sortie ${porte.conso.sortie})` : `${deep.jetonsEntree + deep.jetonsSortie} (entrée ${deep.jetonsEntree} · sortie ${deep.jetonsSortie})`}`);
  l.push(`  CACHED_TOKENS         ${porte.conso.caches} · CACHE_HIT_RATE ${tauxCache}`);
  l.push(`  WEB_SEARCH_CALLS      ${porte.conso.webSearch}`);
  l.push(`  TOTAL_COST            ${cout}`);
  l.push(`  WASTED_MODEL_CALLS    ${carte.appels.tauxGaspillePct === null ? "—" : `${carte.appels.tauxGaspillePct}%`} (${carte.appels.surNonSucces}/${carte.appels.total} payés hors succès)`);
  l.push("═════════════════════════════════════════════════════════════════════════════════════════════");
  return l.join("\n");
}
