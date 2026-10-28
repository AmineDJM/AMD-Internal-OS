"use server";

import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { setSupplierSession, clearSupplierSession } from "@/lib/supplier-auth";
import { fdStr, type ActionResult } from "@/lib/actions/types";

/** Login du portail fournisseur (auth séparée, table SupplierUser). */
export async function supplierLogin(
  _prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const email = fdStr(formData, "email")?.toLowerCase() ?? null;
  const password = fdStr(formData, "password");
  if (!email || !password) return { ok: false, error: "Email et mot de passe requis." };

  const su = await prisma.supplierUser.findUnique({
    where: { email },
    include: { supplier: { select: { active: true } } },
  });
  // Comparaison systématique pour limiter l'oracle de timing.
  const hash = su?.passwordHash ?? "$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinva";
  const passwordOk = await bcrypt.compare(password, hash);
  if (!su || !su.active || !su.supplier.active || !passwordOk) {
    return { ok: false, error: "Identifiants invalides ou compte désactivé." };
  }

  await setSupplierSession(su.id, su.supplierId);
  await prisma.supplierUser.update({ where: { id: su.id }, data: { lastLoginAt: new Date() } });
  await recordAudit({
    actorId: null, action: "LOGIN", module: "Portail fournisseur",
    entityType: "SUPPLIER", entityId: su.supplierId, summary: `Connexion portail — ${su.email}`,
  });
  return { ok: true };
}

export async function supplierLogout(): Promise<ActionResult> {
  await clearSupplierSession();
  return { ok: true };
}
