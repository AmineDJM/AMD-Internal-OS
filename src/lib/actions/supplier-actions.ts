"use server";

import bcrypt from "bcryptjs";
import { revalidatePath } from "next/cache";
import type { ExternalRegulatoryStatus } from "@prisma/client";
import { requireUser } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { canAccessEntity } from "@/lib/entity-access";
import { prisma } from "@/lib/prisma";
import { reposerWilayaCode } from "@/modules/lieux/api";
import { recordAudit } from "@/lib/audit";
import { doubleEcrireOrganisation, relierALaPersonne } from "@/modules/referentiels/api";
import { fdStr, fdDate, fdBool, type ActionResult } from "@/lib/actions/types";

const EXTERNAL_STATUSES: ExternalRegulatoryStatus[] = [
  "IN_PREPARATION", "SUBMITTED", "UNDER_REVIEW", "INFO_REQUESTED", "APPROVED", "ON_HOLD", "CLOSED",
];
const SUPER_ONLY: ActionResult = { ok: false, error: "Réservé au Super Admin." };

// ───── Vue fournisseur d'un dossier (équipe Regulatory) ─────

export async function updateSupplierView(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const productId = fdStr(formData, "productId");
  if (!productId) return { ok: false, error: "Dossier manquant." };
  if (!userCan(user, "REGULATORY", "UPDATE")) return { ok: false, error: "Non autorisé." };
  if (!(await canAccessEntity(user, "REGULATORY_PRODUCT", productId, "UPDATE"))) return { ok: false, error: "Non autorisé." };

  const statusRaw = fdStr(formData, "externalStatus");
  const externalStatus = (statusRaw && EXTERNAL_STATUSES.includes(statusRaw as ExternalRegulatoryStatus) ? statusRaw : null) as ExternalRegulatoryStatus | null;
  const supplierId = fdStr(formData, "supplierId");

  await prisma.regulatoryProduct.update({
    where: { id: productId },
    data: {
      supplierId,
      portalVisible: fdBool(formData, "portalVisible"),
      externalStatus,
      externalComment: fdStr(formData, "externalComment"),
      externalNextStep: fdStr(formData, "externalNextStep"),
      externalActionExpected: fdStr(formData, "externalActionExpected"),
      externalDeadline: fdDate(formData, "externalDeadline"),
      externalNotify: fdBool(formData, "externalNotify"),
      externalUpdatedAt: new Date(),
      updatedById: user.id,
    },
  });
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Portail fournisseur",
    entityType: "REGULATORY_PRODUCT", entityId: productId, summary: "Vue fournisseur mise à jour",
  });
  revalidatePath(`/regulatory/${productId}`);
  return { ok: true };
}

// ───── Gestion des comptes fournisseurs (Super Admin) ─────

export async function createSupplier(
  _prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  if (user.role !== "SUPER_ADMIN") return SUPER_ONLY;
  const name = fdStr(formData, "name");
  if (!name) return { ok: false, error: "Le nom du fournisseur est obligatoire." };
  const created = await prisma.supplier.create({
    data: { name, country: fdStr(formData, "country"), contactEmail: fdStr(formData, "contactEmail")?.toLowerCase() ?? null, notes: fdStr(formData, "notes"), createdById: user.id },
  });
  await reposerWilayaCode("Supplier", created.id); // double écriture des lieux (refonte V2-D) : un pays étranger = pas de wilaya
  await recordAudit({ actorId: user.id, action: "CREATE", module: "Portail fournisseur", entityType: "SUPPLIER", entityId: created.id, summary: `Fournisseur « ${name} »` });
  await doubleEcrireOrganisation("SUPPLIER", created.id, user.id);
  revalidatePath("/admin/suppliers");
  return { ok: true, id: created.id };
}

export async function createSupplierUser(
  _prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  if (user.role !== "SUPER_ADMIN") return SUPER_ONLY;
  const supplierId = fdStr(formData, "supplierId");
  const name = fdStr(formData, "name");
  const email = fdStr(formData, "email")?.toLowerCase() ?? null;
  const password = fdStr(formData, "password");
  if (!supplierId || !name || !email || !password) return { ok: false, error: "Fournisseur, nom, email et mot de passe requis." };
  if (password.length < 8) return { ok: false, error: "Mot de passe : 8 caractères minimum." };

  const existing = await prisma.supplierUser.findUnique({ where: { email }, select: { id: true } });
  if (existing) return { ok: false, error: "Un compte existe déjà avec cet email." };

  // DOUBLE ÉCRITURE (refonte, lot V2-B) : la Personne dans la même transaction, derrière son interrupteur.
  const created = await prisma.$transaction(async (tx) => {
    const ligne = await tx.supplierUser.create({
      data: { supplierId, name, email, passwordHash: await bcrypt.hash(password, 10), createdById: user.id },
    });
    await relierALaPersonne(tx, "SupplierUser", ligne.id, user.id);
    return ligne;
  });
  await recordAudit({ actorId: user.id, action: "CREATE", module: "Portail fournisseur", entityType: "SUPPLIER", entityId: supplierId, summary: `Compte portail ${email}` });
  revalidatePath("/admin/suppliers");
  return { ok: true, id: created.id };
}

export async function toggleSupplier(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (user.role !== "SUPER_ADMIN") return SUPER_ONLY;
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Identifiant manquant." };
  const s = await prisma.supplier.findUnique({ where: { id }, select: { active: true } });
  if (!s) return { ok: false, error: "Fournisseur introuvable." };
  await prisma.supplier.update({ where: { id }, data: { active: !s.active } });
  revalidatePath("/admin/suppliers");
  return { ok: true };
}

export async function toggleSupplierUser(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (user.role !== "SUPER_ADMIN") return SUPER_ONLY;
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Identifiant manquant." };
  const su = await prisma.supplierUser.findUnique({ where: { id }, select: { active: true } });
  if (!su) return { ok: false, error: "Compte introuvable." };
  await prisma.supplierUser.update({ where: { id }, data: { active: !su.active } });
  revalidatePath("/admin/suppliers");
  return { ok: true };
}
