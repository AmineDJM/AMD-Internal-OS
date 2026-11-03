import { prisma } from "@/lib/prisma";
import { adopterSessionDuRelais, lireDossier } from "@/lib/missions/chantiers/dossier";
import { ecrireDossier } from "@/lib/missions/chantiers/conduite";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE RÉVEIL D'UN CHANTIER PAR UN FAIT (C1, décision 0042) — un webhook GitHub ou Render (C2, décision 0043) devient un
 * `BusinessEvent` `DEV_*` / `RENDER_*` (références `DEPOT:`, `BRANCHE:`, `SHA:`, `PR:`, `SERVICE:`, `DEPLOIEMENT:`). Ici, le
 * registre (`events/ledger.ts`) demande : quels chantiers VIVANTS ce fait concerne-t-il ? Un `DEV_SESSION` (ordre du relais
 * CLI conclu, références `ORDRE:` / `SESSION:`) réveille aussi, et donne au dossier la VRAIE session (`session_…`). Leurs étapes qui attendaient
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
    || d.deploiements.some((x) => set.has(`deploiement:${x.deployId.toLowerCase()}`))
    // C2 (décision 0043 § 3 bis) : un ordre du relais conclu (`DEV_SESSION`) — par l'ordre lancé, ou la session connue.
    || d.sessions.some((x) => set.has(`ordre:${x.sessionId.replace(/^ordre-/, "").toLowerCase()}`) || set.has(`session:${x.sessionId.toLowerCase()}`));
}

/** La charge d'un `DEV_SESSION` réussi : l'ordre, la VRAIE session et son lien ; `null` sinon. */
function sessionDuFait(type: string, payload: unknown): { ordreId: string; sessionId: string; url: string | null } | null {
  if (type !== "DEV_SESSION" || !payload || typeof payload !== "object") return null;
  const p = payload as { ordreId?: unknown; statut?: unknown; sessionId?: unknown; sessionUrl?: unknown };
  if (p.statut !== "FAIT" || typeof p.ordreId !== "string" || typeof p.sessionId !== "string") return null;
  return { ordreId: p.ordreId, sessionId: p.sessionId, url: typeof p.sessionUrl === "string" ? p.sessionUrl : null };
}

export async function reveillerChantiersSurFait(e: { type: string; relatedRefs: readonly string[]; payload?: unknown }, maintenant = new Date()): Promise<string[]> {
  if (!/^(DEV|RENDER)_/.test(e.type) || !e.relatedRefs.length) return [];
  const ms = await prisma.mission.findMany({ where: { kind: "CHANTIER", status: { in: VIVANTS as never[] }, planApprouveLe: { not: null } }, select: { id: true, carnet: true }, take: 50 });
  const reveilles: string[] = [];
  for (const m of ms) {
    const d = lireDossier(m.carnet);
    if (!d || !faitConcerne(e.relatedRefs, d)) continue;
    // LA SESSION CRÉÉE PAR LE RELAIS prend sa vraie identité dans le dossier : la correction pourra lui parler (même session).
    const s = sessionDuFait(e.type, e.payload);
    // Relu au moment d'écrire (`ecrireDossier`) : rien de ce que la conduite a écrit entre-temps n'est perdu.
    if (s && adopterSessionDuRelais(d, s.ordreId, s.sessionId, s.url)) await ecrireDossier(m.id, (x) => { adopterSessionDuRelais(x, s.ordreId, s.sessionId, s.url); });
    // Les étapes qui attendaient repartent MAINTENANT (le prochain passage relit GitHub / Render, qui font foi).
    await prisma.missionStep.updateMany({ where: { missionId: m.id, status: "WAITING", nodeType: "WORKER" }, data: { status: "READY", attempt: 0 } });
    await prisma.mission.updateMany({ where: { id: m.id }, data: { reveilDemandeLe: maintenant } });
    reveilles.push(m.id);
  }
  return reveilles;
}
