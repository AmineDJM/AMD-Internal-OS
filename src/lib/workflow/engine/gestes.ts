/**
 * Moteur de workflow — LES GESTES D'AVANCE détachables : la forme d'une demande d'avance, son
 * résultat, le contexte validé d'un geste, et le RENVOI POUR CORRECTION. Les autres gestes
 * (refus, saut, approbation) restent dans `engine.ts`, liés aux franchissements automatiques.
 */
import type { EntityType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { notifyUser } from "@/lib/notify";
import { recordAudit } from "@/lib/audit";
import { refusDuRenvoi } from "../renvoi";
import { CATEGORY_LABELS, type WorkflowCategory } from "../types";
import type { LoadedDefinition, LoadedInstance, LoadedStep, Viewer } from "./definitions";
import { auditModule, entityPath, type EntitySummary, recordEvent } from "./entites";
import { projectReturn } from "./projections";

// ───────────────────────────── Progression ─────────────────────────────

export interface AdvanceInput {
  viewer: Viewer;
  entityType: EntityType;
  entityId: string;
  /**
   * `RETURN` : RENVOYER POUR CORRECTION (audit 360°, R02 — §118.186). Un refus adouci, ouvert là où le
   * refus l'est : la demande revient au demandeur, motif à l'appui, sans être tranchée.
   */
  action: "APPROVE" | "REJECT" | "COMMENT" | "SKIP" | "RETURN";
  note?: string | null;
  amount?: number | null;
  budgetCategoryId?: string | null;
  assigneeId?: string | null;
}

export type AdvanceResult = { ok: true; category: WorkflowCategory } | { ok: false; error: string };

/** Ce que les gestes d'avance lisent — validé par `advanceWorkflowInstance`, sous prise. */
export interface ContexteGeste {
  input: AdvanceInput;
  action: AdvanceInput["action"];
  viewer: Viewer;
  entityType: EntityType;
  entityId: string;
  category: WorkflowCategory;
  instance: LoadedInstance;
  def: LoadedDefinition;
  step: LoadedStep;
  summary: EntitySummary;
  note: string | null;
  borne: string | null;
  ignorees: string[];
}

// ═══════════════════════════════════════════════════════════════════════════════════════
// RENVOYER POUR CORRECTION (audit 360°, R02 — §118.186).
//
// Ni accord, ni refus : la demande retourne à son DEMANDEUR, avec ce qu'il doit corriger, et
// revient À CETTE ÉTAPE quand il la resoumet. C'est le geste qui manquait entre « laisser passer
// une demande fausse » et « la tuer pour un montant mal tapé ».
//
// Trois gardes, chacune avec son cas, écrites dans `refusDuRenvoi` (pur, éprouvé sans base) :
// ouvert là où le REFUS l'est, motif OBLIGATOIRE, un DEMANDEUR à qui renvoyer.
// L'écriture est CONDITIONNELLE : un renvoi et un accord donnés en même temps sur la même étape ne
// s'appliquent pas tous les deux — le second trouve l'étape déjà quittée et le dit.
// ═══════════════════════════════════════════════════════════════════════════════════════
export async function renvoyerPourCorrection(ctx: ContexteGeste): Promise<AdvanceResult> {
  const { viewer, entityType, entityId, category, instance, step, summary, note } = ctx;
  const refus = refusDuRenvoi({ pouvoirs: step.powers, motif: note, demandeurId: summary.requesterId });
  if (refus) return { ok: false, error: refus };
  const demandeurId = summary.requesterId as string; // garanti par `refusDuRenvoi`
  const pris = await prisma.workflowInstance.updateMany({
    where: { id: instance.id, status: "IN_PROGRESS", currentSlug: step.slug },
    data: { status: "RETURNED" },
  });
  if (pris.count === 0) return { ok: false, error: "La demande vient de changer d'étape : rouvrez-la pour voir où elle en est." };
  await projectReturn(entityType, entityId, viewer);
  await recordEvent(instance.id, step, "RETURN", viewer, note, null);
  // LE MOTIF VOYAGE AVEC LA NOTIFICATION : le demandeur sait quoi corriger sans ouvrir la fiche.
  await notifyUser({
    userId: demandeurId, type: "ASSIGNMENT",
    title: `${CATEGORY_LABELS[category]} — à corriger`,
    body: `${summary.name} — ${step.title} : ${note}`,
    link: entityPath(entityType, entityId),
  });
  await recordAudit({ actorId: viewer.id, action: "UPDATE", module: auditModule(entityType), entityType, entityId, summary: `Renvoyée pour correction (${step.title}) — ${summary.name} : ${note}` });
  return { ok: true, category };
}
