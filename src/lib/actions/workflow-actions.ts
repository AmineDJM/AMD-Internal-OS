"use server";

import { revalidatePath } from "next/cache";
import type { EntityType } from "@prisma/client";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { attachFiles, validateAttachments } from "@/lib/attach-files";
import { ROLE_LABELS } from "@/lib/labels";
import { advanceWorkflowInstance, reopenInstance, resubmitWorkflowInstance, retirerDemande } from "@/lib/workflow/engine";
import { lienDemandeAdPro } from "@/lib/chemins/ad-pro";
import { canAccessEntity } from "@/lib/entity-access";
import { supprimerReversible } from "@/lib/suppression/coeur";
import { DELETE_REGISTRY, isDeletableKind } from "@/lib/admin-delete-registry";
import { hasGlobalView, userCan, type Module } from "@/lib/rbac";
import {
  ACTOR_SCOPES, WORKFLOW_POWERS, WORKFLOW_CATEGORIES, CATEGORY_PATH,
  isWorkflowCategory, type ActorScope, type StepInput, type WorkflowPower,
} from "@/lib/workflow/types";
import { fdStr, fdNum, type ActionResult } from "@/lib/actions/types";
import { sansBloquer } from "@/lib/journal";

// La demande « autre » (`AD_PRO_OTHER`) suit le même circuit depuis le 27/10/2026 (décision #17).
const WORKFLOW_ENTITIES: EntityType[] = ["SPONSORING", "CONGRESS_INTERNATIONAL", "CONGRESS_NATIONAL", "EVENT", "AD_PRO_OTHER"];

// ───────────────────────────── Progression (runtime) ─────────────────────────────

/** Action générique : fait avancer une demande dans son circuit. Le moteur gère le gating. */
export async function advanceWorkflow(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const entityType = fdStr(formData, "entityType") as EntityType | null;
  const entityId = fdStr(formData, "entityId");
  const action = fdStr(formData, "action"); // APPROVE | REJECT | COMMENT | SKIP | RETURN
  if (!entityType || !WORKFLOW_ENTITIES.includes(entityType) || !entityId) return { ok: false, error: "Paramètres manquants." };
  if (action !== "APPROVE" && action !== "REJECT" && action !== "COMMENT" && action !== "SKIP" && action !== "RETURN") return { ok: false, error: "Action invalide." };
  // LA PORTE DE LA FICHE avant le moteur (ADPRO-06) — comme la resoumission et le retrait : le rôle d'une
  // étape ne suffit pas à trancher une demande qu'on ne peut pas ouvrir. Hors d'elle, la demande est
  // introuvable, la même phrase que son absence. (Le superviseur de la gamme et qui tranche le module
  // y entrent quelle que soit la société : c'est la lecture de `adProStakeholders`.)
  if (!(await canAccessEntity(user, entityType, entityId, "VIEW"))) return { ok: false, error: "Demande introuvable." };

  // PIÈCES JOINTES À L'AVIS : la Direction Marketing, le National Sales ou la Direction peuvent
  // appuyer leur décision sur un document (devis comparatif, note, courrier).
  //
  // Deux précautions dans l'ordre des opérations :
  //   • on CONTRÔLE les fichiers AVANT de faire avancer le circuit — enregistrer l'avis puis
  //     refuser la pièce laisserait la décision prise et sa justification perdue ;
  //   • on lit l'étape COURANTE avant l'avancement, sinon la pièce serait rattachée à l'étape
  //     suivante, c'est-à-dire à quelqu'un d'autre.
  const files = formData.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  if (files.length > 0) {
    const invalid = await validateAttachments(files);
    if (invalid) return { ok: false, error: invalid };
  }
  const stepKey = files.length > 0
    ? (await prisma.workflowInstance.findUnique({
        where: { entityType_entityId: { entityType, entityId } },
        select: { currentSlug: true },
      }))?.currentSlug ?? null
    : null;

  const res = await advanceWorkflowInstance({
    viewer: { id: user.id, role: user.role, secondaryRole: user.secondaryRole ?? null, name: user.name },
    entityType,
    entityId,
    action,
    note: fdStr(formData, "note"),
    amount: fdNum(formData, "amount"),
    budgetCategoryId: fdStr(formData, "budgetCategoryId"),
    assigneeId: fdStr(formData, "assigneeId"),
  });
  if (!res.ok) return { ok: false, error: res.error };

  // L'action a été autorisée par le moteur : on peut joindre les pièces. Elles rejoignent les
  // documents de la demande (mêmes droits de consultation), marquées de l'étape d'origine.
  if (files.length > 0) {
    const attached = await attachFiles({
      files, entityType, entityId, uploadedById: user.id,
      category: "SUPPORTING_DOC", stepKey,
    });
    if (attached.saved > 0) {
      await recordAudit({
        actorId: user.id, action: "UPLOAD", module: "Ad & Pro", entityType, entityId,
        summary: `${attached.saved} pièce(s) jointe(s) à l'avis${stepKey ? ` (étape ${stepKey})` : ""}`,
      });
    }
  }

  const base = CHEMIN[entityType] ?? "/events";
  revalidatePath(`${base}/${entityId}`);
  revalidatePath(base);
  revalidatePath("/ad-pro");
  revalidatePath("/information-medicale");
  revalidatePath("/finances/paiements-a-faire");
  revalidatePath("/finances");
  revalidatePath("/mon-espace");
  return { ok: true };
}

/** Le module de chaque demande à circuit — c'est lui que « trancher » (VALIDATE) désigne. */
const MODULE_DE: Record<string, Module> = {
  SPONSORING: "SPONSORING", CONGRESS_INTERNATIONAL: "CONGRESS_INTERNATIONAL", CONGRESS_NATIONAL: "CONGRESS_NATIONAL", EVENT: "EVENTS",
  AD_PRO_OTHER: "AD_PRO_OTHER",
};

const CHEMIN: Record<string, string> = {
  SPONSORING: "/sponsoring", CONGRESS_INTERNATIONAL: "/congress-international", CONGRESS_NATIONAL: "/congress-national", EVENT: "/events",
  AD_PRO_OTHER: "/ad-pro/autres",
};

function revaliderLaDemande(entityType: EntityType, entityId: string) {
  const base = CHEMIN[entityType] ?? "/ad-pro";
  revalidatePath(`${base}/${entityId}`);
  revalidatePath(base);
  revalidatePath("/ad-pro");
  revalidatePath("/mon-espace");
}

/**
 * RESOUMETTRE une demande renvoyée pour correction (audit 360°, R02 — §118.186). Le moteur décide
 * qui peut (le demandeur, la vue globale) et où elle reprend ; la porte de la FICHE passe d'abord —
 * hors d'elle, la demande est introuvable, la même phrase que son absence.
 */
export async function resoumettreDemande(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const entityType = fdStr(formData, "entityType") as EntityType | null;
  const entityId = fdStr(formData, "entityId");
  if (!entityType || !WORKFLOW_ENTITIES.includes(entityType) || !entityId) return { ok: false, error: "Paramètres manquants." };
  if (!(await canAccessEntity(user, entityType, entityId, "VIEW"))) return { ok: false, error: "Demande introuvable." };
  const r = await resubmitWorkflowInstance({
    viewer: { id: user.id, role: user.role, secondaryRole: user.secondaryRole ?? null, name: user.name },
    entityType, entityId, note: fdStr(formData, "note"),
  });
  if (!r.ok) return { ok: false, error: r.error };
  revaliderLaDemande(entityType, entityId);
  return { ok: true, message: `Demande resoumise — elle attend de nouveau « ${r.etape} ».` };
}

/**
 * RETIRER une demande non tranchée (audit 360°, R24 — §118.186). Le demandeur la retire ; qui
 * TRANCHE le module, ou la vue globale, peut l'annuler — les mêmes que l'annulation d'un congrès.
 * Motif obligatoire, poste engagé bloquant : le moteur le vérifie.
 *
 * RETIRER, C'EST SUPPRIMER (Direction, 05/10) : « quand je retire une demande Ad&Pro, elle doit être
 * TOTALEMENT supprimée — évidemment toujours récupérable depuis la corbeille par le Super Admin ». La
 * demande part par le cœur réversible de la corbeille, au même titre que `supprimerDemandeAdPro` : UN lot,
 * UNE transaction, avec son circuit, ses validations, ses ordres de dépense non réglés, ses postes, ses
 * pièces — et elle revient intacte à la restauration. Ce qui a quitté l'ERP (un règlement parti, une
 * pièce signée) la garde, et le refus nomme ce qui l'y oblige. La porte reste celle du RETRAIT (le
 * demandeur, qui tranche, la vue globale) : retirer sa propre demande n'est pas le pouvoir de supprimer
 * celle d'un autre, qui reste à `supprimerDemandeAdPro`.
 */
export async function retirerDemandeAdPro(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const entityType = fdStr(formData, "entityType") as EntityType | null;
  const entityId = fdStr(formData, "entityId");
  const motif = fdStr(formData, "motif");
  if (!entityType || !WORKFLOW_ENTITIES.includes(entityType) || !entityId) return { ok: false, error: "Paramètres manquants." };
  if (!motif) return { ok: false, error: "Dites pourquoi vous retirez la demande : le motif reste au journal." };
  if (!(await canAccessEntity(user, entityType, entityId, "VIEW"))) return { ok: false, error: "Demande introuvable." };
  const demandeurId = await demandeurDe(entityType, entityId);
  const module = MODULE_DE[entityType];
  const autorise = demandeurId === user.id || hasGlobalView(user) || (module !== undefined && userCan(user, module, "VALIDATE"));
  if (!autorise) return { ok: false, error: "Seuls le demandeur et qui tranche ce module retirent une demande." };
  const kind = entityType as string;
  if (!isDeletableKind(kind)) return { ok: false, error: "Paramètres manquants." };
  const r = await retirerDemande({
    viewer: { id: user.id, role: user.role, secondaryRole: user.secondaryRole ?? null, name: user.name },
    entityType, entityId, motif,
    supprimer: (nom) => supprimerReversible(
      kind, entityId, user.id,
      `Demande retirée par ${user.id === demandeurId ? "son demandeur" : "un validateur"} — ${DELETE_REGISTRY[kind].label} « ${nom} » : ${motif} (restaurable depuis la corbeille)`,
    ),
  });
  if (!r.ok) return { ok: false, error: r.error };
  revaliderLaDemande(entityType, entityId);
  return { ok: true, message: "Demande retirée et supprimée — elle reste récupérable depuis la corbeille par le Super Admin.", redirect: r.redirect ?? CHEMIN[entityType] ?? "/ad-pro" };
}

async function demandeurDe(entityType: EntityType, entityId: string): Promise<string | null> {
  const sel = { select: { requesterId: true } } as const;
  const ligne =
    entityType === "SPONSORING" ? await prisma.sponsoringRequest.findUnique({ where: { id: entityId }, ...sel })
      : entityType === "CONGRESS_INTERNATIONAL" ? await prisma.congressInternational.findUnique({ where: { id: entityId }, ...sel })
        : entityType === "CONGRESS_NATIONAL" ? await prisma.congressNational.findUnique({ where: { id: entityId }, ...sel })
          : entityType === "AD_PRO_OTHER" ? await prisma.adProOtherRequest.findUnique({ where: { id: entityId }, ...sel })
            : await prisma.event.findUnique({ where: { id: entityId }, ...sel });
  return ligne?.requesterId ?? null;
}

// ───────────────────────────── Builder no-code (Super Admin) ─────────────────────────────

interface DefinitionPayload {
  category: string;
  name: string;
  description?: string | null;
  isActive?: boolean;
  steps: unknown[];
}

const ROLE_KEYS = new Set(Object.keys(ROLE_LABELS));

function sanitizeStep(raw: unknown, index: number, usedSlugs: Set<string>): StepInput | { error: string } {
  if (typeof raw !== "object" || raw === null) return { error: `Étape ${index + 1} invalide.` };
  const r = raw as Record<string, unknown>;
  const title = typeof r.title === "string" ? r.title.trim() : "";
  if (!title) return { error: `Le titre de l'étape ${index + 1} est obligatoire.` };

  let slug = typeof r.slug === "string" && r.slug.trim() ? r.slug.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-") : "";
  if (!slug || usedSlugs.has(slug)) slug = `custom-${index + 1}-${Math.random().toString(36).slice(2, 7)}`;
  usedSlugs.add(slug);

  const actorScope = (typeof r.actorScope === "string" && (ACTOR_SCOPES as readonly string[]).includes(r.actorScope) ? r.actorScope : "ROLE") as ActorScope;
  const actorRoles = Array.isArray(r.actorRoles) ? (r.actorRoles as unknown[]).filter((x): x is string => typeof x === "string" && ROLE_KEYS.has(x)) : [];
  const powers = Array.isArray(r.powers) ? (r.powers as unknown[]).filter((x): x is WorkflowPower => typeof x === "string" && (WORKFLOW_POWERS as readonly string[]).includes(x)) : [];
  const assignRole = typeof r.assignRole === "string" && ROLE_KEYS.has(r.assignRole) ? r.assignRole : null;
  const notifyRoles = Array.isArray(r.notifyRoles) ? (r.notifyRoles as unknown[]).filter((x): x is string => typeof x === "string" && ROLE_KEYS.has(x)) : [];

  if (actorScope === "ROLE" && actorRoles.length === 0) return { error: `L'étape « ${title} » (portée « Rôles listés ») doit lister au moins un rôle.` };
  if (powers.length === 0) return { error: `L'étape « ${title} » doit accorder au moins un pouvoir.` };

  const rawSkip = typeof r.autoSkipMaxAmount === "number" ? r.autoSkipMaxAmount : typeof r.autoSkipMaxAmount === "string" ? Number(r.autoSkipMaxAmount) : NaN;
  const autoSkipMaxAmount = Number.isFinite(rawSkip) && rawSkip > 0 ? rawSkip : null;

  return {
    slug, title,
    description: typeof r.description === "string" ? r.description.trim() || null : null,
    actorRoles, actorScope, powers, assignRole, notifyRoles,
    requireAmount: r.requireAmount === true,
    autoSkipMaxAmount,
    autoApproveIfRequester: r.autoApproveIfRequester === true,
    requireCategory: r.requireCategory === true,
    requireNote: r.requireNote === true,
    emitDeclaration: r.emitDeclaration === true,
    emitExpenseOrder: r.emitExpenseOrder === true,
    optional: r.optional === true,
    confidential: r.confidential === true,
    legacyStatus: typeof r.legacyStatus === "string" && r.legacyStatus.trim() ? r.legacyStatus.trim() : null,
  };
}

/**
 * FAIRE APPEL D'UN REFUS — prise en charge nationale ou internationale, événement, demande « autre »
 * (décisions #12 et #17, Direction 27/10/2026 : « l'appel ne vivait que pour le sponsoring »). Le demandeur — ou la vue globale — conteste
 * le refus définitif, motif exigé : le circuit se rouvre sur l'étape qui a tranché (la Direction Marketing,
 * `reopenInstance`), qui est prévenue ; la demande repasse « en attente de décision ».
 */
export async function faireAppelAdPro(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const entityType = fdStr(formData, "entityType");
  const entityId = fdStr(formData, "entityId");
  const motif = fdStr(formData, "motif");
  if (!entityId || (entityType !== "CONGRESS_NATIONAL" && entityType !== "CONGRESS_INTERNATIONAL" && entityType !== "EVENT" && entityType !== "AD_PRO_OTHER")) {
    return { ok: false, error: "Demande non précisée." };
  }
  if (!motif) return { ok: false, error: "Dites pourquoi vous faites appel : le motif est transmis à l'étape qui réexamine." };
  if (!(await canAccessEntity(user, entityType, entityId, "VIEW"))) return { ok: false, error: "Demande introuvable." };
  const sel = { select: { requesterId: true, requestStatus: true, name: true } } as const;
  // LA DEMANDE « AUTRE » n'a ni `requestStatus` ni `name` : son statut est l'énumération courte (`REFUSED`
  // après un refus définitif du circuit), son nom est son objet.
  const ligne = entityType === "AD_PRO_OTHER"
    ? await prisma.adProOtherRequest.findUnique({ where: { id: entityId }, select: { requesterId: true, status: true, title: true } })
      .then((o) => (o ? { requesterId: o.requesterId, requestStatus: o.status === "REFUSED" ? "REJECTED" : o.status, name: o.title } : null))
    : entityType === "CONGRESS_NATIONAL" ? await prisma.congressNational.findUnique({ where: { id: entityId }, ...sel })
      : entityType === "CONGRESS_INTERNATIONAL" ? await prisma.congressInternational.findUnique({ where: { id: entityId }, ...sel })
        : await prisma.event.findUnique({ where: { id: entityId }, ...sel });
  if (!ligne) return { ok: false, error: "Demande introuvable." };
  if (ligne.requesterId !== user.id && !hasGlobalView(user) && user.role !== "SUPER_ADMIN") return { ok: false, error: "Seul le demandeur peut faire appel." };
  if (ligne.requestStatus !== "REJECTED") return { ok: false, error: "L'appel n'est possible qu'après un refus définitif." };
  const viewer = { id: user.id, role: user.role, secondaryRole: user.secondaryRole ?? null, name: user.name };
  const { etape } = await reopenInstance(entityType, entityId, viewer, motif);
  if (!etape) return { ok: false, error: "Le circuit n'a pas pu être rouvert (un appel vient peut-être d'être déposé) : rouvrez la fiche." };
  const data = { requestStatus: "AWAITING_FINAL" as const, rejectionReason: null };
  if (entityType === "AD_PRO_OTHER") {
    // De nouveau EN CIRCUIT ; la décision d'hier quitte la ligne (elle reste au journal du circuit).
    await prisma.adProOtherRequest.update({
      where: { id: entityId },
      data: { status: "AWAITING_DECISION", decidedById: null, decidedAt: null, decisionNote: null, updatedById: user.id },
    });
  } else if (entityType === "CONGRESS_NATIONAL") await prisma.congressNational.update({ where: { id: entityId }, data });
  else if (entityType === "CONGRESS_INTERNATIONAL") await prisma.congressInternational.update({ where: { id: entityId }, data });
  else await prisma.event.update({ where: { id: entityId }, data });
  await recordAudit({ actorId: user.id, action: "UPDATE", module: "Ad & Pro", entityType, entityId, summary: `Appel du demandeur — ${ligne.name} (réexamen : ${etape}) : ${motif}` });
  revalidatePath(lienDemandeAdPro(entityType, entityId));
  return { ok: true, message: `Appel envoyé — « ${etape} » réexamine la demande.` };
}

/**
 * Enregistre (remplace) la définition d'une catégorie. Réservé au **Super Admin** :
 * reconfigure le circuit de validation Ad & Pro « à la no-code ». Remplace intégralement
 * les étapes ; les instances en cours conservent leur `currentSlug` (les étapes portant
 * les mêmes slugs restent valides).
 */
export async function saveWorkflowDefinition(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (user.role !== "SUPER_ADMIN") return { ok: false, error: "Réservé au Super Admin." };

  const rawPayload = fdStr(formData, "payload");
  if (!rawPayload) return { ok: false, error: "Données manquantes." };
  let payload: DefinitionPayload;
  try {
    payload = JSON.parse(rawPayload) as DefinitionPayload;
  } catch {
    return { ok: false, error: "Format de données invalide." };
  }

  if (!isWorkflowCategory(payload.category)) return { ok: false, error: "Catégorie inconnue." };
  const name = (payload.name ?? "").trim();
  if (!name) return { ok: false, error: "Le nom du circuit est obligatoire." };
  if (!Array.isArray(payload.steps) || payload.steps.length === 0) return { ok: false, error: "Le circuit doit comporter au moins une étape." };

  const used = new Set<string>();
  const steps: StepInput[] = [];
  for (let i = 0; i < payload.steps.length; i++) {
    const s = sanitizeStep(payload.steps[i], i, used);
    if ("error" in s) return { ok: false, error: s.error };
    steps.push(s);
  }
  if (!steps.some((s) => s.powers.includes("APPROVE"))) return { ok: false, error: "Au moins une étape doit permettre d'approuver (sinon le circuit ne peut jamais aboutir)." };

  const def = await prisma.workflowDefinition.upsert({
    where: { category: payload.category },
    update: { name, description: payload.description?.trim() || null, isActive: payload.isActive !== false, updatedById: user.id },
    create: { category: payload.category, name, description: payload.description?.trim() || null, isActive: payload.isActive !== false, updatedById: user.id },
  });

  // Remplacement intégral des étapes.
  await prisma.$transaction([
    prisma.workflowStep.deleteMany({ where: { definitionId: def.id } }),
    prisma.workflowStep.createMany({
      data: steps.map((s, i) => ({
        definitionId: def.id, position: i, slug: s.slug, title: s.title, description: s.description ?? null,
        actorRoles: s.actorRoles, actorScope: s.actorScope, powers: s.powers, assignRole: s.assignRole ?? null,
        requireAmount: s.requireAmount ?? false, autoSkipMaxAmount: s.autoSkipMaxAmount ?? null,
        autoApproveIfRequester: s.autoApproveIfRequester ?? false,
        requireCategory: s.requireCategory ?? false, requireNote: s.requireNote ?? false,
        emitDeclaration: s.emitDeclaration ?? false, emitExpenseOrder: s.emitExpenseOrder ?? false,
        notifyRoles: s.notifyRoles ?? [], optional: s.optional ?? false, confidential: s.confidential ?? false, legacyStatus: s.legacyStatus ?? null,
      })),
    }),
  ]);

  // VERSION : chaque enregistrement laisse un INSTANTANÉ rejouable (le rollback repasse par ce
  // même chemin validé). L'échec du snapshot ne bloque pas l'enregistrement — il se journalise.
  const lastVersion = await prisma.workflowDefinitionVersion
    .findFirst({ where: { category: payload.category }, orderBy: { version: "desc" }, select: { version: true } })
    .catch(sansBloquer("workflow-actions.saveWorkflowDefinition.workflowDefinitionVersion", null));
  await prisma.workflowDefinitionVersion.create({
    data: {
      category: payload.category,
      version: (lastVersion?.version ?? 0) + 1,
      name,
      snapshot: {
        category: payload.category, name, description: payload.description?.trim() || null,
        isActive: payload.isActive !== false, steps,
      } as object,
      savedById: user.id,
    },
  }).catch((err) => console.error("[workflow] snapshot de version impossible", err));

  await recordAudit({ actorId: user.id, action: "UPDATE", module: "Administration", entityType: "BUDGET", entityId: def.id, summary: `Circuit workflow « ${name} » (${payload.category}) reconfiguré — ${steps.length} étape·s` });
  for (const c of WORKFLOW_CATEGORIES) revalidatePath(CATEGORY_PATH[c]);
  revalidatePath("/admin/workflows");
  return { ok: true };
}

/**
 * RESTAURE un circuit à une version antérieure : l'instantané repasse INTÉGRALEMENT par
 * `saveWorkflowDefinition` (mêmes validations, mêmes invariants — au moins une étape APPROVE…),
 * et laisse À SON TOUR une nouvelle version : l'historique avance, il ne se réécrit jamais.
 */
export async function rollbackWorkflowDefinition(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (user.role !== "SUPER_ADMIN") return { ok: false, error: "Réservé au Super Admin." };
  const category = fdStr(formData, "category");
  const version = fdNum(formData, "version");
  if (!category || !isWorkflowCategory(category) || !version || version < 1) {
    return { ok: false, error: "Version introuvable." };
  }
  const row = await prisma.workflowDefinitionVersion.findUnique({
    where: { category_version: { category, version } },
    select: { snapshot: true, name: true },
  });
  if (!row) return { ok: false, error: `Aucune version ${version} pour ce circuit.` };

  const fd = new FormData();
  fd.set("payload", JSON.stringify(row.snapshot));
  const r = await saveWorkflowDefinition(fd);
  if (!r.ok) return r;
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Administration", entityType: "BUDGET", entityId: category,
    summary: `Circuit ${category} RESTAURÉ à la version ${version} (« ${row.name} »)`,
  });
  return { ok: true };
}

/** Réinitialise une catégorie au circuit par défaut (supprime la définition → re-seed lazy). */
export async function resetWorkflowDefinition(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (user.role !== "SUPER_ADMIN") return { ok: false, error: "Réservé au Super Admin." };
  const category = fdStr(formData, "category");
  if (!category || !isWorkflowCategory(category)) return { ok: false, error: "Catégorie inconnue." };
  const def = await prisma.workflowDefinition.findUnique({ where: { category }, select: { id: true, _count: { select: { instances: true } } } });
  if (def && def._count.instances > 0) {
    // Des demandes sont en cours : on ne supprime pas (FK), on réécrit les étapes par défaut.
    return { ok: false, error: "Des demandes utilisent ce circuit — modifiez les étapes plutôt que de réinitialiser." };
  }
  if (def) await prisma.workflowDefinition.delete({ where: { id: def.id } });
  await recordAudit({ actorId: user.id, action: "UPDATE", module: "Administration", entityType: "BUDGET", entityId: category, summary: `Circuit workflow ${category} réinitialisé (défaut)` });
  revalidatePath("/admin/workflows");
  return { ok: true };
}
