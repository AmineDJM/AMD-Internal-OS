"use server";

import { revalidatePath } from "next/cache";
import type { CustomFieldType, EntityType } from "@prisma/client";
import { requireUser } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { canAccessEntity } from "@/lib/entity-access";
import { resolveDriveAccess, canViewDrive } from "@/lib/drive";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { readCustomValues, writeCustomValues, getFieldDefs, missingRequiredValues } from "@/lib/custom-fields";
import { fdStr, fdNum, type ActionResult } from "@/lib/actions/types";

function slug(s: string) {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || "champ";
}

/** Admin: create or update a custom field definition for a module. */
export async function upsertCustomFieldDef(formData: FormData): Promise<ActionResult> {
  const admin = await requireUser();
  if (!userCan(admin, "ADMIN", "UPDATE")) return { ok: false, error: "Réservé au Super Admin." };

  const id = fdStr(formData, "id");
  const entityType = fdStr(formData, "entityType") as EntityType | null;
  const label = fdStr(formData, "label");
  if (!entityType || !label) return { ok: false, error: "Module et libellé requis." };

  const type = (fdStr(formData, "type") as CustomFieldType) ?? "TEXT";
  const options = fdStr(formData, "options");
  const order = fdNum(formData, "order") ?? 0;
  // « Obligatoire » : décidé par l'administrateur, appliqué par le serveur à la saisie.
  const requiredRaw = formData.get("required");
  const required = requiredRaw === "on" || requiredRaw === "true";

  if (id) {
    await prisma.customFieldDef.update({ where: { id }, data: { label, type, options, order, required } });
  } else {
    const key = slug(label);
    const exists = await prisma.customFieldDef.findUnique({ where: { entityType_key: { entityType, key } } });
    await prisma.customFieldDef.create({
      data: { entityType, key: exists ? `${key}_${Date.now().toString(36)}` : key, label, type, options, order, required },
    });
  }
  await recordAudit({
    actorId: admin.id, action: id ? "UPDATE" : "CREATE", module: "Administration",
    entityType, summary: `Champ personnalisé « ${label} »`,
  });
  revalidatePath("/admin/fields");
  return { ok: true };
}

export async function deleteCustomFieldDef(formData: FormData): Promise<ActionResult> {
  const admin = await requireUser();
  if (!userCan(admin, "ADMIN", "UPDATE")) return { ok: false, error: "Réservé au Super Admin." };
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Champ introuvable." };
  await prisma.customFieldDef.delete({ where: { id } });
  revalidatePath("/admin/fields");
  return { ok: true };
}

/** Save custom field values on a record (merged into its `custom` JSON). */
export async function saveCustomValues(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const entityType = fdStr(formData, "entityType") as EntityType | null;
  const entityId = fdStr(formData, "entityId");
  const path = fdStr(formData, "path");
  if (!entityType || !entityId) return { ok: false, error: "Entité manquante." };
  if (!(await canAccessEntity(user, entityType, entityId, "UPDATE"))) {
    return { ok: false, error: "Modification non autorisée." };
  }

  const defs = await getFieldDefs(entityType);
  const current = await readCustomValues(entityType, entityId);
  const next = { ...current };
  for (const def of defs) {
    const lu = await valeurDuChamp(user, def, formData.get(`cf_${def.key}`));
    if ("erreur" in lu) return { ok: false, error: lu.erreur };
    next[def.key] = lu.valeur;
  }
  const manquants = refusObligatoires(defs, next);
  if (manquants) return { ok: false, error: manquants };
  await writeCustomValues(entityType, entityId, next);
  await recordAudit({ actorId: user.id, action: "UPDATE", module: "Champs personnalisés", entityType, entityId, summary: "Mise à jour des champs personnalisés" });
  if (path) revalidatePath(path);
  return { ok: true };
}

type Definition = Awaited<ReturnType<typeof getFieldDefs>>[number];

/** La valeur saisie d'UN champ, selon son type — la même lecture pour le formulaire entier et pour un seul champ. */
async function valeurDuChamp(
  user: Awaited<ReturnType<typeof requireUser>>, def: Definition, raw: FormDataEntryValue | null,
): Promise<{ valeur: unknown } | { erreur: string }> {
  if (def.type === "BOOLEAN") return { valeur: ["on", "true", "1", "oui", "vrai"].includes(String(raw ?? "").trim().toLowerCase()) };
  if (def.type === "NUMBER") {
    const n = raw ? Number(String(raw).replace(",", ".")) : null;
    return { valeur: n === null || Number.isNaN(n) ? null : n };
  }
  if (def.type === "FILE") {
    // FICHIER : une RÉFÉRENCE Drive (jamais une copie). Le nœud doit exister et être
    // accessible au demandeur — un id forgé ou hors de ses droits ne se stocke pas.
    const nodeId = raw ? String(raw) : "";
    if (!nodeId) return { valeur: null };
    const node = await prisma.driveNode.findUnique({ where: { id: nodeId }, select: { id: true, name: true, isTrashed: true } });
    if (!node || node.isTrashed) return { erreur: `${def.label} : document du Drive introuvable.` };
    if (!canViewDrive(await resolveDriveAccess(user, nodeId))) return { erreur: `${def.label} : vous n'avez pas accès à ce document du Drive.` };
    return { valeur: { nodeId: node.id, name: node.name } };
  }
  return { valeur: raw ? String(raw) : null };
}

/**
 * Les champs marqués OBLIGATOIRES par l'administrateur doivent être remplis — le serveur
 * fait foi (l'attribut `required` du navigateur n'est qu'un confort).
 */
function refusObligatoires(defs: Definition[], next: Record<string, unknown>): string | null {
  const missing = missingRequiredValues(defs, next);
  return missing.length > 0 ? `Champ(s) obligatoire(s) à remplir : ${missing.join(", ")}.` : null;
}

/**
 * UN CHAMP PERSONNALISÉ, UN SEUL (décision 0020) — « mets le n° de lot de cette fiche à L-204 ». Le formulaire de la
 * fiche réécrit tous les champs à la fois ; ce geste n'en change qu'UN, désigné par sa clé ou son libellé, et garde
 * les autres tels qu'ils sont. Même droit (modifier l'objet), même lecture des types, mêmes champs obligatoires.
 */
export async function modifierChampPersonnalise(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const entityType = fdStr(formData, "entityType") as EntityType | null;
  const entityId = fdStr(formData, "entityId");
  const champ = fdStr(formData, "field");
  if (!entityType || !entityId || !champ) return { ok: false, error: "Entité ou champ manquant." };
  if (!(await canAccessEntity(user, entityType, entityId, "UPDATE"))) {
    return { ok: false, error: "Modification non autorisée." };
  }
  const defs = await getFieldDefs(entityType);
  const def = defs.find((d) => d.key === champ || slug(d.label) === slug(champ));
  if (!def) {
    return { ok: false, error: `Aucun champ « ${champ} » sur cette fiche${defs.length ? ` — champs : ${defs.map((d) => d.label).join(", ")}` : ""}.` };
  }
  const lu = await valeurDuChamp(user, def, formData.get("value"));
  if ("erreur" in lu) return { ok: false, error: lu.erreur };
  const next = { ...(await readCustomValues(entityType, entityId)), [def.key]: lu.valeur };
  const manquants = refusObligatoires(defs, next);
  if (manquants) return { ok: false, error: manquants };
  await writeCustomValues(entityType, entityId, next);
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Champs personnalisés", entityType, entityId,
    field: def.key, summary: `Champ personnalisé « ${def.label} » mis à jour`,
  });
  return { ok: true, message: `« ${def.label} » mis à jour.` };
}
