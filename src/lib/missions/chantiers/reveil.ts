import { prisma } from "@/lib/prisma";
import { lireDossier } from "@/lib/missions/chantiers/dossier";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE RÉVEIL D'UN CHANTIER PAR UN FAIT (C1, décision 0042) — un webhook GitHub ou Render (C2, décision 0043) devient un
 * `BusinessEvent` `DEV_*` / `RENDER_*` (références `DEPOT:`, `BRANCHE:`, `SHA:`, `PR:`, `SERVICE:`, `DEPLOIEMENT:`). Ici, le
 * registre (`events/ledger.ts`) demande : quels chantiers VIVANTS ce fait concerne-t-il ? Leurs étapes qui attendaient
 * (commit, checks, déploiement, CI de la base) repartent en file tout de suite, et la boucle courte les conduit en
 * secondes. Le sondage à pas croissant reste en SECOURS (un webhook perdu ne fige rien).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const VIVANTS = ["READY", "RUNNING", "RETRYING", "WAITING_EVENT", "WAITING_INPUT", "WAITING_DEPENDENCY", "PAUSED"];

/** Le fait concerne-t-il ce dossier ? Pur : les références du fait face au dépôt, aux branches, SHA, PR et services. */
export function faitConcerne(refs: readonly string[], d: NonNullable<ReturnType<typeof lireDossier>>): boolean {
  const depot = `${d.plan.depot.proprietaire}/${d.plan.depot.nom}`.toLowerCase();
  const set = new Set(refs.map((r) => r.toLowerCase()));
  const shas = [d.shaVu, d.vert?.sha, d.fusion?.sha].filter((x): x is string => !!x).map((x) => x.toLowerCase());
  return set.has(`branche:${depot}:${d.plan.branche.toLowerCase()}`)
    || (!!d.fusion && set.has(`branche:${depot}:${d.plan.brancheBase.toLowerCase()}`))
    || shas.some((x) => set.has(`sha:${x}`))
    || (!!d.pr && set.has(`pr:${depot}#${d.pr.numero}`))
    || d.plan.services.some((s) => set.has(`service:${s.id.toLowerCase()}`))
    || d.deploiements.some((x) => set.has(`deploiement:${x.deployId.toLowerCase()}`));
}

export async function reveillerChantiersSurFait(e: { type: string; relatedRefs: readonly string[] }, maintenant = new Date()): Promise<string[]> {
  if (!/^(DEV|RENDER)_/.test(e.type) || !e.relatedRefs.length) return [];
  const ms = await prisma.mission.findMany({ where: { kind: "CHANTIER", status: { in: VIVANTS as never[] }, planApprouveLe: { not: null } }, select: { id: true, carnet: true }, take: 50 });
  const reveilles: string[] = [];
  for (const m of ms) {
    const d = lireDossier(m.carnet);
    if (!d || !faitConcerne(e.relatedRefs, d)) continue;
    // Les étapes qui attendaient repartent MAINTENANT (le prochain passage relit GitHub / Render, qui font foi).
    await prisma.missionStep.updateMany({ where: { missionId: m.id, status: "WAITING", nodeType: "WORKER" }, data: { status: "READY", attempt: 0 } });
    await prisma.mission.updateMany({ where: { id: m.id }, data: { reveilDemandeLe: maintenant } });
    reveilles.push(m.id);
  }
  return reveilles;
}
