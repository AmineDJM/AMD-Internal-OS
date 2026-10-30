import { prisma } from "@/lib/prisma";
import { systemClock, type Clock } from "@/lib/missions/ports";
import type { LecteurInterrupteur } from "@/lib/interrupteurs/missions";
import type { PersonaTravail } from "@/lib/missions/travaux/plan";
import type { PersonaTravaux } from "@/lib/missions/travaux/persona";
import { conduireTravail, type BilanConduite } from "@/lib/missions/travaux/conduite";
import { webDoitSAbstenir } from "@/lib/missions/travaux/balayage";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE RÉVEIL RAPIDE DES TRAVAUX (J8, décision 0023) — « reprise en moins de 90 s après l'événement ».
 *
 * Le battement des tâches de fond passe toutes les minutes, et chaque tâche au plus toutes les 45 s : un
 * travail réveillé par un fait juste après un passage attendait jusqu'à ~105 s. Désormais, ce qui règle une
 * attente d'un travail (un fait métier, une réponse à une demande, une minuterie échue) le SIGNALE
 * (`Mission.reveilDemandeLe`, `signaux.ts`) ; une boucle courte (`armerReveilsTravaux`, `scheduled.ts`) prend les signalés et
 * les conduit tout de suite. La requête est un index (`kind`, `reveilDemandeLe`) : à vide, elle ne coûte rien.
 *
 * SÛRETÉ : le signal est EFFACÉ avant la conduite, conditionné à sa valeur (un signal posé pendant la conduite
 * survit et sera repris). La conduite prend le bail du travail : la boucle du web et celle du worker peuvent
 * battre ensemble, un seul conduit. Le web s'abstient dès que le worker bat (`webDoitSAbstenir`).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const PAR_PASSAGE = 6;

export interface BilanReveils { pris: number; conduits: BilanConduite[]; abstenu: boolean }

export async function reveillerTravauxSignales(o: {
  personas: Partial<Record<PersonaTravail, PersonaTravaux>>;
  mode?: string;
  executeur?: "web" | "worker";
  clock?: Clock;
  interrupteur?: LecteurInterrupteur;
  /** BANC SEULEMENT : borne le passage à ces travaux (la suite partage une base). */
  seulement?: readonly string[];
}): Promise<BilanReveils> {
  const opts = o; // le passe-plat de l'interrupteur (cliquet `suspension.test.ts`)
  const clock = o.clock ?? systemClock;
  const out: BilanReveils = { pris: 0, conduits: [], abstenu: false };
  if (await webDoitSAbstenir(o.mode ?? "web", o.executeur ?? "web", clock.now())) return { ...out, abstenu: true };
  const signales = await prisma.mission.findMany({
    where: { kind: "TRAVAIL", reveilDemandeLe: { not: null }, ...(o.seulement ? { id: { in: [...o.seulement] } } : {}) },
    select: { id: true, persona: true, reveilDemandeLe: true },
    orderBy: [{ priority: "desc" }, { reveilDemandeLe: "asc" }],
    take: PAR_PASSAGE,
  });
  for (const t of signales) {
    // EFFACER AVANT DE CONDUIRE, à sa valeur : un second signal arrivé entre-temps reste posé.
    const pris = await prisma.mission.updateMany({ where: { id: t.id, reveilDemandeLe: t.reveilDemandeLe }, data: { reveilDemandeLe: null } });
    if (pris.count !== 1) continue;
    const persona = t.persona ? o.personas[t.persona as PersonaTravail] : undefined;
    if (!persona) continue;
    out.pris += 1;
    try {
      out.conduits.push(await conduireTravail(t.id, { persona, clock, ...(opts.interrupteur ? { interrupteur: opts.interrupteur } : {}) }));
    } catch (e) {
      console.error("[travaux] réveil", t.id, e);
    }
  }
  return out;
}
