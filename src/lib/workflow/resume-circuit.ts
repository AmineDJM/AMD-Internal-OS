import type { WorkflowView } from "@/lib/queries/workflow";

/**
 * LE CIRCUIT EN UNE LIGNE (Direction, 17/11/2026 — fiches en sections repliables) : ce que la section « Circuit de
 * validation » dit quand elle est fermée. Module PUR (un import de type seulement) : la page serveur l'appelle.
 */
export function resumeDuCircuit(w: Pick<WorkflowView, "status" | "steps" | "assigneeName"> | null, soumise = true): string {
  if (!soumise) return "Non soumise";
  if (!w) return "Circuit indisponible";
  switch (w.status) {
    case "APPROVED": return "Approuvée";
    case "REJECTED": return "Refusée";
    case "RETURNED": return "Renvoyée pour correction";
    case "CANCELLED": return "Retirée";
  }
  const etape = w.steps.find((s) => s.state === "current");
  if (!etape) return "En cours";
  return `En cours — ${etape.title}${w.assigneeName ? ` · chez ${w.assigneeName}` : ""}`;
}
