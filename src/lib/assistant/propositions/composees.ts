/**
 * PROPOSITIONS — Propositions composées : opérations de domaine (catalogue `ops`), lots
 * (`bulk_action`) et plans chaînés (`action_plan`).
 * Une famille de l'ancienne chaîne de `buildProposal`, recopiée telle quelle et appelée à son rang
 * (voir `propositions/construire.ts`) ; elle rend `undefined` quand l'outil n'est pas le sien.
 */

import type { Module } from "@/lib/assistant/coeur/erp";
import { DOMAIN_TOOLS } from "@/lib/assistant/ops";
import { type AssistantActionPayload, deferredStepLevel, type ProposedAction } from "@/lib/assistant/coeur/contrat-actions";
import { WRITE_TOOL_NAMES } from "@/lib/assistant/outils/catalogue-ecriture";
import { asStr } from "@/lib/assistant/outils/arguments";
import { BULKABLE, type ContexteProposition } from "@/lib/assistant/propositions/aides";

/** La famille « composees » de `buildProposal` : rend `undefined` quand l'outil n'est pas le sien. */
export async function proposerComposees(c: ContexteProposition): Promise<ProposedAction | { error: string } | undefined> {
  const { toolName, input, user, warnings, buildProposal } = c;

  // ── OUTILS DE DOMAINE (drive_operation, task_operation…) — mécanisme GÉNÉRIQUE. ──
  // La porte du catalogue se vérifie ICI (refus dit à la proposition) ; l'implémentation
  // résout les entrées humaines ; l'action canonique revalidera tout à l'exécution.
  if (DOMAIN_TOOLS[toolName]) {
    const domain = DOMAIN_TOOLS[toolName];
    const opName = asStr(input, "op");
    const entry = domain.ops[opName];
    if (!entry) {
      return { error: `Op « ${opName || "(vide)"} » inconnue pour ${toolName}. Ops disponibles : ${Object.keys(domain.ops).join(", ")}.` };
    }
    if (!entry.meta.gate(user)) {
      return { error: `Vous n'avez pas le droit de faire « ${entry.meta.uiLabel} »${entry.meta.gateNote ? ` (${entry.meta.gateNote})` : ""} — la même règle que l'écran.` };
    }
    const draft = await entry.impl.propose(input, user);
    if ("error" in draft) return { error: draft.error };
    const level = entry.meta.risk === "CRITICAL" ? "CRITICAL" as const : entry.meta.risk === "SENSITIVE" ? "SENSITIVE" as const : undefined;
    return {
      kind: "domain_op",
      module: domain.module,
      title: draft.title,
      fields: draft.fields,
      warnings: [...(draft.warnings ?? []), ...warnings],
      ...(level ? { level } : {}),
      ...(draft.confirmText ? { confirmText: draft.confirmText } : {}),
      payload: {
        kind: "domain_op",
        tool: toolName,
        op: opName,
        opLabel: entry.meta.uiLabel,
        args: draft.args,
        successMessage: draft.successMessage,
        ...(draft.link ? { link: draft.link } : {}),
        ...(draft.revalidate ? { revalidate: draft.revalidate } : {}),
      },
    };
  }

  if (toolName === "bulk_action") {
    const innerTool = asStr(input, "tool");
    const spec = BULKABLE[innerTool];
    if (!spec) {
      return { error: `bulk_action ne prend pas en charge « ${innerTool || "(vide)"} ». Outils groupables : ${Object.keys(BULKABLE).join(", ")}.` };
    }
    const rawTargets = input.targets;
    const targets = Array.isArray(rawTargets)
      ? rawTargets.map((t) => String(t).trim()).filter(Boolean)
      : typeof rawTargets === "string"
        ? rawTargets.split(/[;,\n]/).map((t) => t.trim()).filter(Boolean)
        : [];
    if (targets.length < 2) return { error: "Donnez au moins DEUX cibles (targets) — pour une seule, utiliser l'outil directement." };
    if (targets.length > 20) return { error: "Lot limité à 20 cibles à la fois — découper la demande." };
    const params = input.params && typeof input.params === "object" && !Array.isArray(input.params)
      ? (input.params as Record<string, unknown>)
      : {};

    // RÉCURSION : chaque cible passe par buildProposal de l'outil interne — MÊME résolution,
    // MÊMES portes, MÊMES validations que l'action unitaire. Zéro deuxième logique.
    const prepared: ProposedAction[] = [];
    const failures: string[] = [];
    for (const target of targets) {
      const p = await buildProposal(innerTool, { ...params, [spec.targetKey]: target }, user);
      if ("error" in p) failures.push(`${target} : ${p.error}`);
      else prepared.push(p);
    }
    if (prepared.length === 0) {
      return { error: `Aucune cible du lot n'a pu être préparée.\n${failures.join("\n")}` };
    }

    const maxLevel = prepared.some((p) => p.level === "CRITICAL") ? "CRITICAL" as const
      : prepared.some((p) => p.level === "SENSITIVE") ? "SENSITIVE" as const : undefined;
    const itemWarnings = [...new Set(prepared.flatMap((p) => p.warnings))];
    const summary = `${spec.label} — ${prepared.length} cible(s)`;
    return {
      kind: "bulk_action",
      module: prepared[0].module,
      title: `LOT : ${spec.label} sur ${prepared.length} cible(s)`,
      fields: prepared.map((p, i) => ({ label: `${i + 1}.`, value: p.title })),
      warnings: [
        "Exécution cible par cible : un refus n'annule pas le reste — le reçu détaille chaque cible.",
        ...(maxLevel === "CRITICAL" ? [`NIVEAU CRITIQUE : la confirmation exige de RESSAISIR « LOT ${prepared.length} ».`] : []),
        ...itemWarnings,
        ...failures.map((f) => `Non préparé : ${f}`),
        ...warnings,
      ],
      ...(maxLevel ? { level: maxLevel } : {}),
      ...(maxLevel === "CRITICAL" ? { confirmText: `LOT ${prepared.length}` } : {}),
      payload: {
        kind: "bulk_action",
        innerTool,
        summary,
        items: prepared.map((p) => ({ payload: p.payload, display: p.title })),
      },
    };
  }

  if (toolName === "action_plan") {
    const rawSteps = Array.isArray(input.steps) ? input.steps : [];
    if (rawSteps.length < 2) return { error: "Un plan enchaîne au moins DEUX étapes — pour une seule, utiliser l'outil directement." };
    if (rawSteps.length > 8) return { error: "Plan limité à 8 étapes — découper la demande." };

    const steps: Extract<AssistantActionPayload, { kind: "action_plan" }>["steps"] = [];
    const fields: { label: string; value: string }[] = [];
    let maxLevel: "SENSITIVE" | "CRITICAL" | undefined;
    let module: Module | null = null;

    for (let i = 0; i < rawSteps.length; i++) {
      const raw = rawSteps[i] as { tool?: unknown; input?: unknown };
      const stepTool = typeof raw?.tool === "string" ? raw.tool : "";
      const stepInput = raw?.input && typeof raw.input === "object" && !Array.isArray(raw.input)
        ? (raw.input as Record<string, unknown>) : {};
      if (!stepTool || stepTool === "action_plan" || stepTool === "bulk_action") {
        return { error: `Étape ${i + 1} : outil « ${stepTool || "(vide)"} » invalide dans un plan.` };
      }
      if (!WRITE_TOOL_NAMES.has(stepTool)) {
        return { error: `Étape ${i + 1} : « ${stepTool} » n'est pas un outil d'écriture connu.` };
      }
      const deferred = Object.values(stepInput).some((v) => typeof v === "string" && v.includes("$prev"));
      if (deferred && i === 0) return { error: "La 1re étape d'un plan ne peut pas dépendre de « $prev »." };

      if (deferred) {
        // RÉSOLUE À L'EXÉCUTION : après l'étape précédente, « $prev.x » est substitué puis
        // l'étape repasse par buildProposal (mêmes portes, même résolution) avant d'agir.
        const inputStr: Record<string, string> = {};
        for (const [k, v] of Object.entries(stepInput)) if (typeof v === "string") inputStr[k] = v;
        // Le NIVEAU d'une étape différée se connaît dès la carte (outil + op) : une suppression
        // sur « $prev » rend le plan CRITIQUE maintenant, pas au moment où il s'exécute.
        const stepLevel = deferredStepLevel(stepTool, inputStr.op);
        if (stepLevel === "CRITICAL") maxLevel = "CRITICAL";
        else if (stepLevel === "SENSITIVE" && maxLevel !== "CRITICAL") maxLevel = "SENSITIVE";
        const display = `${stepTool}${inputStr.op ? ` (${inputStr.op})` : ""} — dépend de l'étape ${i}`;
        steps.push({ kind: "deferred", tool: stepTool, input: inputStr, display });
        fields.push({ label: `${i + 1}.`, value: `${display} : ${Object.entries(inputStr).filter(([k]) => k !== "op").map(([k, v]) => `${k}=${v}`).join(", ").slice(0, 140)}` });
        continue;
      }

      const p = await buildProposal(stepTool, stepInput, user);
      if ("error" in p) return { error: `Étape ${i + 1} (${stepTool}) : ${p.error}` };
      if (p.level === "CRITICAL") maxLevel = "CRITICAL";
      else if (p.level === "SENSITIVE" && maxLevel !== "CRITICAL") maxLevel = "SENSITIVE";
      if (!module) module = p.module;
      for (const w of p.warnings) if (!warnings.includes(w)) warnings.push(w);
      steps.push({ kind: "resolved", payload: p.payload, display: p.title });
      fields.push({ label: `${i + 1}.`, value: p.title });
    }

    const summary = asStr(input, "summary") || `${steps.length} étapes enchaînées`;
    return {
      kind: "action_plan",
      module: module ?? "WORKSPACE",
      title: `PLAN : ${summary}`,
      fields,
      warnings: [
        "Exécution DANS L'ORDRE : un maillon refusé ARRÊTE la chaîne (le reçu dit où).",
        ...(steps.some((s) => s.kind === "deferred")
          ? ["Les étapes « dépend de » sont résolues À L'EXÉCUTION, après l'étape dont elles dépendent — mêmes portes, même résolution."]
          : []),
        ...(maxLevel === "CRITICAL" ? [`NIVEAU CRITIQUE : la confirmation exige de RESSAISIR « PLAN ${steps.length} ».`] : []),
        ...warnings,
      ],
      ...(maxLevel ? { level: maxLevel } : {}),
      ...(maxLevel === "CRITICAL" ? { confirmText: `PLAN ${steps.length}` } : {}),
      payload: { kind: "action_plan", summary, steps },
    };
  }

  return undefined;
}
