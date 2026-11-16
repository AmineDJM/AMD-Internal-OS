import type { AuditAction, EntityType, Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { vueExacteDeRequete } from "./vue-exacte-requete";
import { faitDepuisAudit, type AuditFait } from "./events/from-audit";
import { recordEvent } from "./events/ledger";

interface AuditInput {
  actorId?: string | null;
  action: AuditAction;
  module: string;
  entityType?: EntityType;
  entityId?: string;
  field?: string;
  oldValue?: string | null;
  newValue?: string | null;
  summary?: string;
  ipAddress?: string | null;
}

/**
 * Append an entry to the audit log. Best-effort: auditing must never break the
 * primary mutation, so failures are swallowed (and logged to the server).
 */
export async function recordAudit(input: AuditInput) {
  try {
    await prisma.auditLog.create({
      data: {
        actorId: input.actorId ?? null,
        action: input.action,
        module: input.module,
        entityType: input.entityType,
        entityId: input.entityId,
        field: input.field,
        oldValue: input.oldValue ?? null,
        newValue: input.newValue ?? null,
        summary: input.summary,
        ipAddress: input.ipAddress ?? null,
        // « Agir comme » : le geste est celui du Super Admin dans la peau de `actorId` — la trace le garde (lue par lui seul).
        parVueExacteId: vueExacteDeRequete()?.superAdminId ?? null,
      },
    });
  } catch (err) {
    console.error("[audit] failed to record entry", err);
  }

  await emettreFait(input);
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'AUDIT ALIMENTE LE REGISTRE D'ÉVÉNEMENTS — un point d'émission au lieu de cinq cents.
 *
 * Les ~500 endroits qui écrivent dans l'ERP passent déjà tous par ici. Y brancher le registre
 * les couvre tous d'un coup, sans toucher une seule ligne d'appel — et sans qu'un futur module
 * ait à se souvenir d'émettre quoi que ce soit.
 *
 * DEUX PROTECTIONS, et elles sont l'essentiel :
 *
 *   • TOUT N'EST PAS UN FAIT. `faitDepuisAudit` est une liste blanche stricte : sans elle, le
 *     registre deviendrait un miroir de l'audit et ne prouverait plus rien.
 *   • ÉMETTRE NE DOIT JAMAIS FAIRE ÉCHOUER L'ÉCRITURE MÉTIER. `recordEvent` ne lève déjà pas ;
 *     ce `catch` est la ceinture par-dessus la bretelle. Un registre qui fait tomber la
 *     validation d'un paiement est une régression, pas une observabilité.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
async function emettreFait(input: AuditInput): Promise<void> {
  try {
    const brut: AuditFait = {
      action: input.action, module: input.module,
      entityType: input.entityType ?? null, entityId: input.entityId ?? null,
      field: input.field ?? null, oldValue: input.oldValue ?? null, newValue: input.newValue ?? null,
      summary: input.summary ?? null,
    };
    const fait = faitDepuisAudit(brut);
    if (!fait) return;

    await recordEvent({
      type: fait.type,
      sourceDomain: input.module,
      actorId: input.actorId ?? null,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      payload: fait.payload,
    });
  } catch (err) {
    console.error("[audit] émission du fait métier impossible", input.action, err);
  }
}

/**
 * Diff two records and emit one UPDATE audit entry per changed field. Keeps the
 * "ancienne valeur / nouvelle valeur" history required by the spec.
 */
export async function recordFieldChanges(
  base: Omit<AuditInput, "action" | "field" | "oldValue" | "newValue">,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  fields: string[],
) {
  const entries: Prisma.AuditLogCreateManyInput[] = [];
  for (const field of fields) {
    const oldValue = before[field];
    const newValue = after[field];
    if (String(oldValue ?? "") !== String(newValue ?? "")) {
      entries.push({
        actorId: base.actorId ?? null,
        action: "UPDATE",
        module: base.module,
        entityType: base.entityType,
        entityId: base.entityId,
        field,
        oldValue: oldValue == null ? null : String(oldValue),
        newValue: newValue == null ? null : String(newValue),
        summary: base.summary,
      });
    }
  }
  if (entries.length) {
    await prisma.auditLog.createMany({ data: entries }).catch((err) => {
      console.error("[audit] failed to record field changes", err);
    });
    // CE CHEMIN-CI COMPTE AUTANT QUE L'AUTRE, et il est plus discret : c'est celui qui produit
    // les triplets champ / ancienne / nouvelle valeur, donc les CHANGEMENTS DE STATUT — un
    // dossier réglementaire qui avance, une vente qui passe à PAYÉE, une livraison faite.
    // Le brancher uniquement sur `recordAudit` aurait laissé ces faits-là invisibles, et le
    // registre aurait eu l'air alimenté tout en manquant l'essentiel.
    for (const e of entries) {
      await emettreFait({
        actorId: e.actorId, action: "UPDATE", module: e.module,
        entityType: e.entityType ?? undefined, entityId: e.entityId ?? undefined,
        field: e.field ?? undefined, oldValue: e.oldValue ?? null, newValue: e.newValue ?? null,
        summary: e.summary ?? undefined,
      });
    }
  }
}
