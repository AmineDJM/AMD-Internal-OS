/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'OBSERVABILITÉ PAR ACTION (mandat 4 §33) — ce que chaque étape d'une mission a RÉELLEMENT
 * fait, composé depuis les tables qui existent déjà. Aucune nouvelle table (§5 : ne rien recréer) :
 *
 *   MissionStep       outil, tentatives, statut, erreur, cause, reçu structuré (source, issue, dates, compte)
 *   MissionWorkerRun  le sous-agent (rôle, modèle, statut, coût) quand une étape a fait travailler un modèle
 *   ModelCallLog      les modèles appelés pour la mission, avec leur coût quand le tarif est connu
 *   MissionApproval   la décision de permission humaine (accord requis, accordé) par clé d'étape
 *   Mission.planMeta  la version du prompt du planificateur et les règles enseignées servies
 *
 * Les treize champs du mandat sont là, et ils sont CONSTATÉS : un champ que la mission n'a pas
 * produit vaut `null` — un modèle déduit, le journal ne déduit pas. La certitude d'une action est
 * celle que son reçu autorise, par une règle écrite : trouvé ou preuve d'absence → CERTAIN ;
 * dédoublonné → PROBABLE (l'effet existe, le reçu est ailleurs) ; indéterminé → HYPOTHESE ; échec →
 * MANQUANT.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
import { prisma } from "@/lib/prisma";
import type { ActionObservee, DecisionPermission, ObservabiliteMission } from "@/platform/contract";
import { sansBloquer } from "@/lib/journal";

/** Les treize champs du mandat — l'ordre est celui de l'énoncé. */
export const CHAMPS_ACTION = [
  "modele", "promptVersion", "outil", "latenceMs", "coutUsd", "tentatives", "source",
  "decisionPermission", "certitude", "reglesUtilisees", "sousAgent", "erreur", "issue",
] as const;

type Recu = { source?: string | null; issue?: string | null; startedAt?: string; completedAt?: string; resultCount?: number | null; deduplicated?: boolean } | null;

const lireRecu = (v: unknown): Recu => (v && typeof v === "object" && !Array.isArray(v) ? (v as Recu) : null);
const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
const chaines = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

function certitudeDe(step: { status: string; receipt: string | null }, recu: Recu): ActionObservee["certitude"] {
  if (step.status === "FAILED") return "MANQUANT";
  if (step.receipt === "DEDUPLIQUE" || recu?.deduplicated) return "PROBABLE";
  if (!recu) return null;
  if (recu.issue === "SUCCES" || recu.issue === "VIDE") return "CERTAIN";
  if (recu.issue === "ECHEC") return "MANQUANT";
  if (recu.issue === "INDETERMINE") return "HYPOTHESE";
  return null;
}

function decisionDe(step: { key: string; nodeType: string; errorKind: string | null }, approbations: { stepKeys: string[]; status: string }[]): DecisionPermission {
  if (step.errorKind === "MISSING_PERMISSION") return "REFUSEE";
  if (step.nodeType !== "CAPABILITY") return "SANS_OBJET";
  const cle = step.key.includes("#") ? step.key.slice(0, step.key.indexOf("#")) : step.key;
  const concernees = approbations.filter((a) => a.stepKeys.includes(step.key) || a.stepKeys.includes(cle));
  if (concernees.some((a) => a.status === "GRANTED")) return "ACCORDEE_PAR_HUMAIN";
  if (concernees.some((a) => a.status === "PENDING")) return "ACCORD_REQUIS";
  return "ACCORDEE";
}

/** LE JOURNAL D'UNE MISSION, action par action — cloisonné au propriétaire. */
export async function observabiliteMission(missionId: string, ownerId: string): Promise<ObservabiliteMission | null> {
  const m = await prisma.mission.findFirst({
    where: { id: missionId, ownerId },
    select: {
      id: true, planVersion: true, planMeta: true, modelCalls: true, toolCalls: true, costUsd: true,
      steps: {
        where: { supersededAt: null },
        select: { key: true, title: true, nodeType: true, status: true, capability: true, attempt: true, maxAttempts: true, error: true, errorKind: true, receipt: true, receiptData: true, startedAt: true, completedAt: true },
        orderBy: [{ createdAt: "asc" }, { key: "asc" }],
      },
      workerRuns: { select: { stepId: true, step: { select: { key: true } }, modelRole: true, modelUsed: true, status: true, costUsd: true }, orderBy: { startedAt: "desc" } },
      approvals: { select: { stepKeys: true, status: true } },
    },
  });
  if (!m) return null;
  const meta = (m.planMeta && typeof m.planMeta === "object" && !Array.isArray(m.planMeta) ? m.planMeta : {}) as Record<string, unknown>;
  const promptVersion = typeof meta.promptVersion === "string" ? meta.promptVersion : null;
  const reglesUtilisees = chaines(meta.politiques);

  const appels = await prisma.modelCallLog.groupBy({
    by: ["model"], where: { missionId: m.id }, _count: { _all: true }, _sum: { costUsd: true },
  }).catch(sansBloquer("observabilite.observabiliteMission.modelCallLog", [] as { model: string; _count: { _all: number }; _sum: { costUsd: unknown } }[]));
  const modeles = appels.map((a) => ({ modele: a.model, appels: a._count._all, coutUsd: a._sum.costUsd == null ? null : Number(a._sum.costUsd) }));

  const parEtape = new Map<string, (typeof m.workerRuns)[number]>();
  for (const w of m.workerRuns) { const k = w.step?.key; if (k && !parEtape.has(k)) parEtape.set(k, w); }

  const actions: ActionObservee[] = m.steps.map((s) => {
    const recu = lireRecu(s.receiptData);
    const debut = recu?.startedAt ?? iso(s.startedAt);
    const fin = recu?.completedAt ?? iso(s.completedAt);
    const latenceMs = debut && fin ? Math.max(0, Date.parse(fin) - Date.parse(debut)) : null;
    const w = parEtape.get(s.key) ?? null;
    return {
      etape: s.key,
      titre: s.title,
      nodeType: s.nodeType,
      statut: s.status,
      outil: s.capability ?? null,
      promptVersion,
      source: recu?.source ?? null,
      issue: recu?.issue ?? null,
      tentatives: s.attempt,
      maxTentatives: s.maxAttempts,
      latenceMs,
      debut,
      fin,
      decisionPermission: decisionDe(s, m.approvals),
      certitude: certitudeDe(s, recu),
      reglesUtilisees,
      sousAgent: w ? { role: w.modelRole, modele: w.modelUsed ?? null, statut: w.status, coutUsd: w.costUsd ?? null } : null,
      modele: w?.modelUsed ?? null,
      coutUsd: w?.costUsd ?? null,
      erreur: s.error ?? null,
      erreurKind: s.errorKind ?? null,
      resultats: typeof recu?.resultCount === "number" ? recu.resultCount : null,
    };
  });

  return {
    missionId: m.id,
    planVersion: m.planVersion,
    promptVersion,
    reglesUtilisees,
    modeles,
    appelsModele: m.modelCalls,
    appelsOutil: m.toolCalls,
    coutUsd: m.costUsd,
    actions,
    champs: CHAMPS_ACTION,
  };
}
