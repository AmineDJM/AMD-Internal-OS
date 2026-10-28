import { prisma } from "@/lib/prisma";
import { agentsForSections } from "./registry";
import { runAgentOnVersion } from "./orchestrator";
import { regAudit } from "../audit";
import { sansBloquer } from "@/lib/journal";

/**
 * ESCALADE ÉCO → QUALITÉ : là où le balayage a trouvé du CRITIQUE, l'agent SPÉCIALISTE repasse.
 *
 * Le balayage économique lit tout mais juge vite ; les 14 agents jugent en profondeur mais
 * coûtent cher. Jusqu'ici, le lien entre les deux était UN HUMAIN qui pense à cliquer. Or c'est
 * précisément quand une section 3.2.P.8 sort avec du critique qu'on veut l'avis de l'agent
 * Stabilité — c'est le geste d'un vrai évaluateur : insister là où ça fait mal.
 *
 * Garde-fous, dans l'ordre où ils s'appliquent :
 *   • seules les sections portant un constat CRITICAL déclenchent — pas les majeures : l'escalade
 *     doit rester un événement, pas un doublement systématique du coût ;
 *   • un agent déjà passé sur cette version ne repasse pas (ses constats `AGENT:<clé>` en font foi) ;
 *   • quatre agents au plus par version — au-delà, c'est une réanalyse complète déguisée, et cette
 *     décision appartient à un humain ;
 *   • désactivable d'un geste (`REG_AGENT_AUTO=0`).
 *
 * Ne lève jamais : une escalade ratée laisse l'analyse de base intacte.
 */
const MAX_AUTO_AGENTS = 4;

export function agentAutoEnabled(): boolean {
  return (process.env.REG_AGENT_AUTO ?? "1").trim() !== "0";
}

export async function escalateCriticalSections(
  versionId: string,
  ctx: { companyId?: string | null; dossierId?: string | null },
): Promise<number> {
  if (!agentAutoEnabled()) return 0;
  try {
    const critical = await prisma.regulatoryFinding.findMany({
      where: { dossierVersionId: versionId, severity: "CRITICAL", source: "AI", sectionCode: { not: null } },
      select: { sectionCode: true },
      distinct: ["sectionCode"],
    });
    const sections = critical.map((f) => f.sectionCode!).filter(Boolean);
    if (sections.length === 0) return 0;

    // Les agents dont le périmètre couvre ces sections — moins ceux déjà passés.
    const candidates = agentsForSections(sections).filter((a) => a.key !== "CHALLENGER");
    const already = await prisma.regulatoryFinding.findMany({
      where: { dossierVersionId: versionId, code: { in: candidates.map((a) => `AGENT:${a.key}`) } },
      select: { code: true },
      distinct: ["code"],
    });
    const done = new Set(already.map((f) => f.code));
    const toRun = candidates.filter((a) => !done.has(`AGENT:${a.key}`)).slice(0, MAX_AUTO_AGENTS);
    if (toRun.length === 0) return 0;

    let ran = 0;
    for (const agent of toRun) {
      try {
        const r = await runAgentOnVersion(versionId, agent.key);
        if (r.ok) ran++;
      } catch (e) {
        console.error("[reg-escalate] agent en échec (les autres continuent)", agent.key, e);
      }
    }

    if (ran > 0) {
      await regAudit({
        companyId: ctx.companyId, actorId: "system", dossierId: ctx.dossierId, dossierVersionId: versionId,
        action: "AGENTS_ESCALATED",
        detail: `Escalade automatique : ${ran} agent(s) spécialiste(s) passé(s) sur les sections critiques (${sections.slice(0, 6).join(", ")}). Constats PROJET — revue humaine requise.`,
      }).catch(sansBloquer("escalate.escalateCriticalSections.regAudit"));
    }
    return ran;
  } catch (e) {
    console.error("[reg-escalate] escalade impossible (analyse de base intacte)", e);
    return 0;
  }
}
