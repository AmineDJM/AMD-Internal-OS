import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { sansBloquer } from "@/lib/journal";
import { reveillerAttentesTemporelles } from "@/lib/missions/events/router";
import { systemClock, type Clock } from "@/lib/missions/ports";
import type { LecteurInterrupteur } from "@/lib/interrupteurs/missions";
import type { PersonaTravail } from "@/lib/missions/travaux/plan";
import type { PersonaTravaux } from "@/lib/missions/travaux/persona";
import { conduireTravail, type BilanConduite, type DepsTravaux } from "@/lib/missions/travaux/conduite";
import { signalerUneFois } from "@/lib/missions/travaux/signaux";
import { listerTravaux } from "@/lib/missions/travaux/service";
import { MOTIF_BUDGET } from "@/lib/missions/travaux/regles";
import { traiterJalons, type BilanJalons } from "@/lib/missions/travaux/jalons";
import { enParallele } from "@/lib/missions/runtime/engine/ordonnancement";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE BATTEMENT DES TRAVAUX (J2) — tâche de fond `travaux.balayage`, sous bail (`taches-de-fond/`).
 *
 * Il tourne là où l'interrupteur `TACHES_DE_FOND` le met : le web (`web`, défaut d'aujourd'hui), le
 * worker (`worker`), ou les deux pendant la bascule (`les-deux`). Dans ce dernier cas, LE WEB
 * S'ABSTIENT dès que le worker est vivant (`webDoitSAbstenir`) : un travail long ne tourne jamais
 * dans le processus qui sert les pages quand un processus fait pour durer est là.
 *
 * Un passage, borné (travaux par passage, vagues par travail, durée) :
 *   1. les minuteries échues se règlent (`reveillerAttentesTemporelles` — le même réveil que les
 *      missions d'Adam ; les faits métier, eux, réveillent par `recordEvent`, sans attendre ici) ;
 *   2. les travaux qui ont quelque chose à faire avancent (et ceux qui dorment sur un plafond se
 *      réveillent seuls quand il le permet de nouveau) ;
 *   3. un travail de plus d'un jour reçoit son POINT QUOTIDIEN (une notification par jour) ;
 *   4. J8 : les JALONS des attentes et des demandes (relance, escalade, abandon — `jalons.ts`).
 *
 * J8 — PLUSIEURS TRAVAUX PAR PERSONNE : les candidats se servent À TOUR DE RÔLE par personne (le premier
 * travail de chacun, puis le deuxième…), et par priorité au sein des travaux d'une même personne — dix travaux
 * de l'une n'affament pas l'unique travail de l'autre.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** K3 (décision 0033) : combien de travaux un passage conduit À LA FOIS — borne opérationnelle, réglable. */
export function travauxEnParallele(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const n = Number(env.TRAVAUX_EN_PARALLELE);
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), 12) : 4;
}

export const TRAVAUX_PAR_PASSAGE = 6;
const POINT_QUOTIDIEN_MS = 24 * 3600_000;
/** Le worker est « vivant » s'il a pris une tâche dans les cinq dernières minutes (même seuil que sa sonde). */
const WORKER_VIVANT_MS = 5 * 60_000;

/** Le web doit-il laisser les travaux au worker ? Oui quand le mode le permet aux deux ET que le worker bat. */
export async function webDoitSAbstenir(mode: string, executeur: "web" | "worker", maintenant = new Date()): Promise<boolean> {
  if (executeur !== "web" || mode !== "les-deux") return false;
  const vivant = await prisma.tacheDeFond.count({
    where: { executeur: "worker", dernierDebutA: { gte: new Date(maintenant.getTime() - WORKER_VIVANT_MS) } },
  });
  return vivant > 0;
}

/**
 * LES TRAVAUX QUI PEUVENT AVANCER MAINTENANT — et seulement eux. Un travail qui DORT sur une attente (un BC
 * à signer dans dix jours) n'est pas chargé à chaque battement : il n'est candidat que s'il porte une étape
 * prête, une étape réparable, une étape en file dont les dépendances sont réglées, ou s'il dort sur un
 * plafond à réexaminer. Sans ce tri, dix travaux en attente affameraient le onzième qui a du travail.
 */
export async function travauxAFaireAvancer(
  limite = TRAVAUX_PAR_PASSAGE,
  /** BANC SEULEMENT (J8) : borne la question aux travaux de ces personnes (la suite partage une base). */
  parmi?: readonly string[],
): Promise<{ id: string; persona: string | null }[]> {
  const personnes = parmi ? Prisma.sql`AND m."principalId" IN (${Prisma.join([...parmi])})` : Prisma.empty;
  return prisma.$queryRaw<{ id: string; persona: string | null }[]>`
    SELECT c."id", c."persona" FROM (
    SELECT m."id", m."persona", m."priority", m."updatedAt",
      ROW_NUMBER() OVER (PARTITION BY m."principalId" ORDER BY m."priority" DESC, m."updatedAt" ASC) AS "tour"
    FROM "Mission" m
    WHERE m."kind" = 'TRAVAIL' AND m."planApprouveLe" IS NOT NULL ${personnes} AND (
      (m."status" = 'PAUSED' AND m."pausedReason" LIKE ${`${MOTIF_BUDGET}%`})
      OR (m."status" IN ('READY', 'RUNNING', 'RETRYING'))
      OR (m."status" IN ('WAITING_EVENT', 'WAITING_INPUT', 'WAITING_DEPENDENCY') AND EXISTS (
        SELECT 1 FROM "MissionStep" s WHERE s."missionId" = m."id" AND s."supersededAt" IS NULL AND (
          s."status" = 'READY'
          OR (s."status" = 'FAILED' AND s."attempt" < s."maxAttempts")
          OR (s."status" = 'PENDING' AND NOT EXISTS (
            SELECT 1 FROM "MissionStepDep" d JOIN "MissionStep" p ON p."id" = d."dependsOnId"
            WHERE d."stepId" = s."id" AND p."status" NOT IN ('DONE', 'SKIPPED', 'CANCELLED', 'FAILED')))
        )))
    )) c
    ORDER BY c."tour" ASC, c."priority" DESC, c."updatedAt" ASC
    LIMIT ${limite}`;
}

export interface BilanBalayageTravaux {
  examines: number;
  conduits: BilanConduite[];
  reveils: number;
  points: number;
  abstenu: boolean;
  jalons: BilanJalons;
}

export async function balayerTravaux(o: {
  personas: Partial<Record<PersonaTravail, PersonaTravaux>>;
  mode?: string;
  executeur?: "web" | "worker";
  clock?: Clock;
  interrupteur?: LecteurInterrupteur;
  /** BANC SEULEMENT : borne le passage à ces travaux (la suite partage une base). */
  seulement?: readonly string[];
  /** BANC SEULEMENT (J8) : les points d'arrêt du banc de robustesse (processus abattu après un geste, un dépôt). */
  sondes?: DepsTravaux["sondes"];
}): Promise<BilanBalayageTravaux> {
  const opts = o; // le passe-plat de l'interrupteur (cliquet `suspension.test.ts`)
  const clock = o.clock ?? systemClock;
  const out: BilanBalayageTravaux = { examines: 0, conduits: [], reveils: 0, points: 0, abstenu: false, jalons: { relances: 0, escalades: 0, abandons: 0 } };
  if (await webDoitSAbstenir(o.mode ?? "web", o.executeur ?? "web", clock.now())) return { ...out, abstenu: true };

  out.reveils = (await reveillerAttentesTemporelles(clock.now(), o.seulement).catch(sansBloquer("travaux.balayer.reveils", []))).length;
  // Les jalons AVANT la conduite : une demande abandonnée règle son étape, et le travail repart dans ce passage.
  out.jalons = await traiterJalons({ persona: o.personas.ASSISTANT_IA, maintenant: clock.now(), ...(o.seulement ? { seulement: o.seulement } : {}) })
    .catch(sansBloquer("travaux.balayer.jalons", out.jalons));
  const candidats = o.seulement
    ? await prisma.mission.findMany({ where: { id: { in: [...o.seulement] }, kind: "TRAVAIL" }, select: { id: true, persona: true } })
    : await travauxAFaireAvancer();
  // K3 (décision 0033) : les SOUS-MISSIONS d'une personne avancent ENSEMBLE — plusieurs travaux conduits en parallèle,
  // sous une concurrence bornée (`TRAVAUX_EN_PARALLELE`) ; chaque conduite garde le bail de SON travail.
  await enParallele(candidats, travauxEnParallele(), async (t) => {
    const persona = t.persona ? o.personas[t.persona as PersonaTravail] : undefined;
    if (!persona) return; // une persona non branchée ici (Adam, tant qu'il garde son propre moteur) ne conduit rien
    out.examines += 1;
    try {
      out.conduits.push(await conduireTravail(t.id, { persona, clock, ...(opts.interrupteur ? { interrupteur: opts.interrupteur } : {}), ...(o.sondes ? { sondes: o.sondes } : {}) }));
    } catch (e) {
      console.error("[travaux] conduite", t.id, e);
    }
  });
  if (!o.seulement) out.points = await pointsQuotidiens(clock.now()).catch(sansBloquer("travaux.balayer.points", 0));
  return out;
}

/**
 * LE POINT QUOTIDIEN — un travail vivant de plus d'un jour dit, une fois par jour, où il en est :
 * étapes faites, attente en cours, coût. Une seule notification par travail et par 24 h.
 */
export async function pointsQuotidiens(maintenant = new Date(), limite = 20): Promise<number> {
  const seuil = new Date(maintenant.getTime() - POINT_QUOTIDIEN_MS);
  const dus = await prisma.mission.findMany({
    where: {
      kind: "TRAVAIL", planApprouveLe: { not: null, lt: seuil },
      status: { notIn: ["COMPLETED", "CANCELLED", "FAILED", "AWAITING_APPROVAL"] },
      OR: [{ pointQuotidienLe: null }, { pointQuotidienLe: { lt: seuil } }],
    },
    select: { id: true, principalId: true, title: true },
    take: limite,
  });
  let n = 0;
  for (const d of dus) {
    if (!d.principalId) continue;
    // RÉSERVER le point avant de l'envoyer : deux exécutants pendant la bascule n'en envoient qu'un.
    const pris = await prisma.mission.updateMany({
      where: { id: d.id, OR: [{ pointQuotidienLe: null }, { pointQuotidienLe: { lt: seuil } }] },
      data: { pointQuotidienLe: maintenant },
    });
    if (!pris.count) continue;
    const [v] = (await listerTravaux(d.principalId, 100, maintenant)).filter((t) => t.id === d.id);
    if (!v) continue;
    const corps = [
      `${v.etapes.faites}/${v.etapes.total} étapes faites`,
      v.attente ?? (v.etat === "BUDGET_HOLD" ? "en sommeil : plafond atteint" : v.etat === "EN_PAUSE" ? "en pause" : "en cours"),
      `coût ${v.coutUsd.toFixed(2).replace(".", ",")} $`,
    ].join(" · ");
    await signalerUneFois(d.id, d.principalId, `point:${maintenant.toISOString().slice(0, 10)}`, `Point du jour — « ${d.title} »`, corps);
    n += 1;
  }
  return n;
}

