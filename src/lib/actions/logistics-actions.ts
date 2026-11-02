"use server";

import { revalidatePath } from "next/cache";
import type { LogisticsStatus } from "@prisma/client";
import { requireUser } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { referenceDeSerie } from "@/lib/refs";
import { recordAudit } from "@/lib/audit";
import { fdStr, fdNum, fdDate, type ActionResult } from "@/lib/actions/types";

export async function createLogistics(
  _prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, "LOGISTICS", "CREATE")) return { ok: false, error: "Non autorisé." };

  const product = fdStr(formData, "product");
  if (!product) return { ok: false, error: "Le produit est obligatoire." };

  const year = new Date().getFullYear();
  const reference = await referenceDeSerie({
    modele: "LogisticsOrder", prefixe: "CMD", annee: year,
    existantes: async () => (await prisma.logisticsOrder.findMany({ where: { reference: { startsWith: `CMD-${year}-` } }, select: { reference: true } })).map((r) => r.reference),
  });

  const created = await prisma.logisticsOrder.create({
    data: {
      reference,
      product,
      dci: fdStr(formData, "dci"),
      dosage: fdStr(formData, "dosage"),
      supplier: fdStr(formData, "supplier"),
      country: fdStr(formData, "country"),
      quantityOrdered: fdNum(formData, "quantityOrdered") ?? 0,
      orderDate: fdDate(formData, "orderDate") ?? new Date(),
      estimatedDeparture: fdDate(formData, "estimatedDeparture"),
      estimatedArrival: fdDate(formData, "estimatedArrival"),
      status: (fdStr(formData, "status") as LogisticsStatus) ?? "ORDERED",
      carrier: fdStr(formData, "carrier"),
      incoterm: fdStr(formData, "incoterm"),
      orderValue: fdNum(formData, "orderValue"),
      currency: fdStr(formData, "currency") ?? "EUR",
      companyId: fdStr(formData, "companyId") || null,
      ownerId: user.id,
      createdById: user.id,
    },
  });

  await recordAudit({
    actorId: user.id, action: "CREATE", module: "Logistique PCH",
    entityType: "LOGISTICS", entityId: created.id, summary: `Commande ${reference} — ${product}`,
  });

  revalidatePath("/logistics");
  return { ok: true, id: created.id };
}

export async function updateLogisticsStatus(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, "LOGISTICS", "UPDATE")) return { ok: false, error: "Non autorisé." };

  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Commande introuvable." };
  const before = await prisma.logisticsOrder.findUnique({ where: { id } });
  if (!before) return { ok: false, error: "Commande introuvable." };

  const status = (fdStr(formData, "status") as LogisticsStatus) ?? before.status;

  await prisma.logisticsOrder.update({
    where: { id },
    data: {
      status,
      actualDeparture: fdDate(formData, "actualDeparture") ?? before.actualDeparture,
      actualArrival: fdDate(formData, "actualArrival") ?? before.actualArrival,
      customsDate: fdDate(formData, "customsDate") ?? before.customsDate,
      pchDeliveryDate: fdDate(formData, "pchDeliveryDate") ?? before.pchDeliveryDate,
      quantityReceived: fdNum(formData, "quantityReceived") ?? before.quantityReceived,
      updatedById: user.id,
    },
  });

  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Logistique PCH",
    entityType: "LOGISTICS", entityId: id, field: "status",
    oldValue: before.status, newValue: status, summary: `Statut commande ${before.reference} → ${status}`,
  });

  revalidatePath(`/logistics/${id}`);
  revalidatePath("/logistics");
  return { ok: true };
}
