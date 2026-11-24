"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { fdStr, type ActionResult } from "@/lib/actions/types";

/**
 * DÉSIGNER LE SERVICE DES MOYENS GÉNÉRAUX — un seul, pour toute la société.
 *
 * Chacun arrivait sur les moyens généraux DE SON DÉPARTEMENT : autant de caisses que de
 * directions, alors qu'il n'y a qu'un service qui achète et qui décaisse. Ce réglage dit lequel,
 * et c'est celui-là que tout le monde ouvre.
 *
 * Il se règle dans Administration › Réglages (`admin/settings/service-moyens-generaux.tsx`) — plus sur
 * l'écran des Moyens généraux, qui montre la caisse sans la déplacer (Super Admin, 24/11/2026).
 *
 * Il appartient au SUPER ADMIN, et à lui seul : déplacer la caisse de toute l'entreprise n'est
 * pas un geste de service. Ce n'est pas un droit de module qu'on peut se voir accorder — c'est le
 * rôle, vérifié ici, et le rôle secondaire ne l'étend pas non plus par surprise : il est traité
 * comme le principal, ni plus ni moins.
 */
export async function setGeneralMeansDepartment(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (user.role !== "SUPER_ADMIN" && user.secondaryRole !== "SUPER_ADMIN") {
    return { ok: false, error: "Seul le Super Admin désigne le service des moyens généraux." };
  }
  const departmentId = fdStr(formData, "departmentId");
  if (!departmentId) return { ok: false, error: "Aucun département indiqué." };

  const dept = await prisma.department.findUnique({ where: { id: departmentId }, select: { name: true } });
  if (!dept) return { ok: false, error: "Ce département n'existe plus." };

  await prisma.appSetting.upsert({
    where: { id: "global" },
    create: { id: "global", generalMeansDepartmentId: departmentId, updatedById: user.id },
    update: { generalMeansDepartmentId: departmentId, updatedById: user.id },
  });
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Moyens généraux",
    field: "generalMeansDepartmentId", newValue: departmentId,
    summary: `« ${dept.name} » devient le service des moyens généraux de la société`,
  });
  revalidatePath("/moyens-generaux");
  revalidatePath("/admin/settings");
  return { ok: true, message: `« ${dept.name} » est désormais le service des moyens généraux — c'est cette caisse que tout le monde ouvre.` };
}
