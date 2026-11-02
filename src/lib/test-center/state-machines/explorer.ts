import { prisma } from "@/lib/prisma";
import type { FindingInput } from "../types";
import { STATE_MACHINES } from "./registry";
import { declaredTransitionKeys, type StateMachine } from "./types";
import { sansBloquer } from "@/lib/journal";

/**
 * Explorateur de machines à états (§29). Confronte les machines DÉCLARÉES aux données RÉELLES :
 * distribution vivante des états, violations de couplage structurel (état ↔ champ, prouvable),
 * et **couverture des transitions métier** observées dans le journal d'audit (field="status",
 * ancienne → nouvelle valeur). Aucune écriture — lecture seule.
 */

type Delegate = {
  count: (a: unknown) => Promise<number>;
  findMany: (a: unknown) => Promise<Record<string, unknown>[]>;
};
function delegate(model: string): Delegate | null {
  const d = (prisma as unknown as Record<string, Delegate>)[model];
  return d && typeof d.count === "function" ? d : null;
}

export interface MachineReport {
  id: string; label: string; module: string; model: string;
  liveCount: number;
  distribution: Record<string, number>;
  couplingField: string | null;
  couplingViolations: number;
  couplingSample: { id: string; status: string; value: unknown }[];
  declaredTransitions: number;
  observedTransitions: number;
  transitionCoverage: number; // 0..1
  uncoveredTransitions: string[];
}

export interface StateExploreResult {
  machines: MachineReport[];
  undeclaredObserved: string[];
  overallTransitionCoverage: number;
  findings: FindingInput[];
}

async function observedStatusPairs(): Promise<Set<string>> {
  const rows = await prisma.auditLog.findMany({
    where: { field: "status", NOT: { oldValue: null } },
    select: { oldValue: true, newValue: true },
    orderBy: { createdAt: "desc" },
    take: 8000,
  });
  const set = new Set<string>();
  for (const r of rows) if (r.oldValue && r.newValue) set.add(`${r.oldValue}→${r.newValue}`);
  return set;
}

async function exploreOne(m: StateMachine, observed: Set<string>): Promise<{ report: MachineReport; findings: FindingInput[] }> {
  const findings: FindingInput[] = [];
  const del = delegate(m.model);
  const distribution: Record<string, number> = {};
  let liveCount = 0;

  if (del) {
    for (const s of m.states) {
      const n = await del.count({ where: { [m.statusField]: s } }).catch(sansBloquer("explorer.exploreOne.count", 0));
      if (n > 0) { distribution[s] = n; liveCount += n; }
    }
  }

  // Violations de couplage structurel (prouvable) sur données vivantes.
  let couplingViolations = 0;
  const couplingSample: { id: string; status: string; value: unknown }[] = [];
  if (del && m.coupling) {
    const rows = await del
      .findMany({ select: { id: true, [m.statusField]: true, [m.coupling.field]: true }, take: 5000 })
      .catch(sansBloquer("explorer.exploreOne.findMany", [] as Record<string, unknown>[]));
    for (const r of rows) {
      const row = { status: r[m.statusField], [m.coupling.field]: r[m.coupling.field] };
      if (!m.coupling.holds(row)) {
        couplingViolations++;
        if (couplingSample.length < 5) couplingSample.push({ id: String(r.id), status: String(r[m.statusField]), value: r[m.coupling.field] ?? null });
      }
    }
    if (couplingViolations > 0) {
      findings.push({
        severity: "HIGH", category: "state-machine", module: m.module,
        title: `Couplage état ↔ ${m.coupling.field} rompu (${m.label})`,
        detail: `${couplingViolations} enregistrement(s) « ${m.model} » violent l'invariant : ${m.coupling.expect}`,
        evidence: couplingSample, suggestion: "Corriger la transition qui laisse l'objet dans un état incohérent (l'étape courante ou l'horodatage de décision doivent suivre le statut).",
        confidence: "high",
      });
    }
  }

  // Couverture des transitions déclarées, d'après les transitions réellement observées.
  const declared = declaredTransitionKeys(m);
  const covered = declared.filter((k) => observed.has(k));
  const uncovered = declared.filter((k) => !observed.has(k));
  const coverage = declared.length ? covered.length / declared.length : 1;

  return {
    report: {
      id: m.id, label: m.label, module: m.module, model: m.model,
      liveCount, distribution,
      couplingField: m.coupling?.field ?? null, couplingViolations, couplingSample,
      declaredTransitions: declared.length, observedTransitions: covered.length,
      transitionCoverage: coverage, uncoveredTransitions: uncovered,
    },
    findings,
  };
}

export async function exploreStateMachines(): Promise<StateExploreResult> {
  const observed = await observedStatusPairs();
  const machines: MachineReport[] = [];
  const findings: FindingInput[] = [];

  for (const m of STATE_MACHINES) {
    const { report, findings: f } = await exploreOne(m, observed);
    machines.push(report);
    findings.push(...f);
  }

  // Transitions observées déclarées par AUCUNE machine (états connus des deux côtés) : candidates
  // à une transition illégale ou à une déclaration incomplète — signalées en info, jamais bloquantes.
  const allStates = new Set(STATE_MACHINES.flatMap((m) => m.states));
  const allDeclared = new Set(STATE_MACHINES.flatMap((m) => declaredTransitionKeys(m)));
  const undeclaredObserved: string[] = [];
  for (const pair of observed) {
    const [a, b] = pair.split("→");
    // Une auto-boucle (a→a) est une ré-écriture du même statut (no-op), pas une transition : on l'ignore.
    if (a !== b && allStates.has(a) && allStates.has(b) && !allDeclared.has(pair)) undeclaredObserved.push(pair);
  }
  if (undeclaredObserved.length > 0) {
    findings.push({
      severity: "INFO", category: "state-machine", module: "ADMIN",
      title: `Transitions non déclarées observées (${undeclaredObserved.length})`,
      detail: `Des changements de statut réels ne figurent dans aucune machine déclarée : ${undeclaredObserved.slice(0, 12).join(", ")}. À qualifier (transition légitime à déclarer, ou anomalie).`,
      evidence: undeclaredObserved.slice(0, 40), confidence: "medium",
    });
  }

  const totalDeclared = machines.reduce((s, m) => s + m.declaredTransitions, 0);
  const totalObserved = machines.reduce((s, m) => s + m.observedTransitions, 0);
  const overallTransitionCoverage = totalDeclared ? totalObserved / totalDeclared : 1;

  return { machines, undeclaredObserved, overallTransitionCoverage, findings };
}
