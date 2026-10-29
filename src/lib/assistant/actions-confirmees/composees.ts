/**
 * EXÉCUTION APRÈS CONFIRMATION — Actions composées : opération de domaine, lot et plan chaîné.
 * Des séries de branches de l'ancienne chaîne de `performAction` qui n'écrivent pas elles-mêmes en
 * base, recopiées telles quelles ; `actions-confirmees/executer.ts` appelle chacune à son rang, et
 * elle rend `undefined` quand l'action n'est pas la sienne.
 */

import { DOMAIN_TOOLS } from "@/lib/assistant/ops";
import type { AssistantActionPayload } from "@/lib/assistant/coeur/contrat-actions";
import { buildProposal } from "@/lib/assistant/propositions/construire";
import type { ExecuteResult, ContexteExecution } from "@/lib/assistant/actions-confirmees/aides";

/** Branches de `performAction` : opération de domaine, lot (`bulk_action`) et plan chaîné (`action_plan`). */
export async function executerComposees(c: ContexteExecution): Promise<ExecuteResult | undefined> {
  const { user, payload, performAction } = c;

  if (payload?.kind === "domain_op") {
    // MÉCANISME GÉNÉRIQUE : porte du catalogue revérifiée, puis l'implémentation rejoue les
    // args sur l'ACTION CANONIQUE de l'écran — qui revalide elle-même droits et existence.
    const entry = DOMAIN_TOOLS[payload.tool]?.ops[payload.op];
    if (!entry) return { ok: false, error: `Opération inconnue : ${payload.tool}/${payload.op}.` };
    if (!entry.meta.gate(user)) return { ok: false, error: "Non autorisé." };
    const r = await entry.impl.execute(payload.args, user);
    if (!r.ok) return { ok: false, error: r.error ?? `« ${payload.opLabel} » a été refusé.` };
    return {
      ok: true,
      message: r.message ?? payload.successMessage,
      link: r.link ?? payload.link,
      revalidate: r.revalidate ?? payload.revalidate,
      ...(r.createdId ? { createdId: r.createdId } : {}),
    };
  }

  if (payload?.kind === "bulk_action") {
    // EXÉCUTION SÉQUENTIELLE BEST-EFFORT : chaque item repasse par performAction (mêmes portes,
    // même kill-switch, mêmes actions canoniques) — un refus n'annule pas le reste, le reçu
    // dit cible par cible ce qui est passé et ce qui a été refusé.
    const receipts: string[] = [];
    const revalidate = new Set<string>();
    let done = 0;
    for (const item of payload.items) {
      const r = await performAction(user, item.payload);
      if (r.ok) {
        done += 1;
        receipts.push(`✓ ${item.display}`);
        for (const path of r.revalidate ?? []) revalidate.add(path);
      } else {
        receipts.push(`✗ ${item.display} — ${r.error ?? "refusé"}`);
      }
    }
    const detail = receipts.join("\n");
    if (done === 0) return { ok: false, error: `Aucune action du lot n'a abouti.\n${detail}` };
    return {
      ok: true,
      message: `Lot « ${payload.summary} » : ${done}/${payload.items.length} exécuté(s).\n${detail}`,
      revalidate: [...revalidate],
    };
  }

  if (payload?.kind === "action_plan") {
    // CHAÎNE : chaque étape passe par performAction ; une étape « différée » substitue d'abord
    // « $prev.x » (champs du payload précédent + id créé) puis repasse par buildProposal —
    // mêmes portes, même résolution que si elle avait été demandée seule. Un maillon refusé
    // ARRÊTE la chaîne : enchaîner sur un socle manquant fabriquerait du faux.
    const receipts: string[] = [];
    const revalidate = new Set<string>();
    let prevValues: Record<string, string> = {};
    let done = 0;
    let broke = false;

    const valuesOf = (p: AssistantActionPayload, createdId?: string): Record<string, string> => {
      const out: Record<string, string> = {};
      if (p.kind === "domain_op") {
        for (const [k, v] of Object.entries(p.args)) if (typeof v === "string" && v) out[k] = v;
      } else {
        for (const [k, v] of Object.entries(p as unknown as Record<string, unknown>)) {
          if (typeof v === "string" && v && k !== "kind") out[k] = v;
        }
      }
      if (createdId) out.id = createdId;
      return out;
    };

    for (let i = 0; i < payload.steps.length; i++) {
      const step = payload.steps[i];
      let stepPayload: AssistantActionPayload;
      let display = step.display;
      if (step.kind === "resolved") {
        stepPayload = step.payload;
      } else {
        const substituted: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(step.input)) {
          substituted[k] = v.replace(/\$prev\.([A-Za-z]+)/g, (_, key: string) => prevValues[key] ?? "");
        }
        const p = await buildProposal(step.tool, substituted, user);
        if ("error" in p) {
          receipts.push(`✗ Étape ${i + 1} — ${step.display} : ${p.error}`);
          broke = true;
          break;
        }
        stepPayload = p.payload;
        display = p.title;
      }
      const r = await performAction(user, stepPayload);
      if (!r.ok) {
        receipts.push(`✗ Étape ${i + 1} — ${display} : ${r.error ?? "refusée"}`);
        broke = true;
        break;
      }
      done += 1;
      receipts.push(`✓ Étape ${i + 1} — ${display}`);
      for (const path of r.revalidate ?? []) revalidate.add(path);
      prevValues = valuesOf(stepPayload, r.createdId);
    }
    if (broke && done + 1 < payload.steps.length) {
      receipts.push(`… ${payload.steps.length - done - 1} étape(s) non tentée(s) — la chaîne s'est arrêtée.`);
    }
    const detail = receipts.join("\n");
    if (done === 0) return { ok: false, error: `Le plan n'a pas démarré.\n${detail}` };
    return {
      ok: !broke,
      ...(broke ? { error: `Plan « ${payload.summary} » interrompu à l'étape ${done + 1} (${done}/${payload.steps.length} faites).\n${detail}` } : {}),
      message: broke ? undefined : `Plan « ${payload.summary} » exécuté (${done}/${payload.steps.length}).\n${detail}`,
      revalidate: [...revalidate],
    };
  }

  return undefined;
}
