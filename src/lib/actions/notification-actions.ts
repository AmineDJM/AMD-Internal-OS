"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { destinatairesDeLaDiffusion, type BroadcastAudience } from "@/lib/notify";
import { differerEffetSortant } from "@/lib/effets/fenetre";
import type { ChargeDiffusion } from "@/lib/notifications/diffusion-differee";
import { fdStr, type ActionResult } from "@/lib/actions/types";
import { actionReversible } from "@/lib/effets/reversible";

/**
 * Crée et diffuse une notification depuis l'Administration. **Super Admin uniquement.**
 * Audience : tous les comptes actifs / un rôle / des personnes précises.
 */
export async function sendBroadcast(formData: FormData): Promise<ActionResult> {
  return actionReversible("notification-actions:sendBroadcast", "Diffusion d'une notification", async () => {
    const admin = await requireUser();
    if (admin.role !== "SUPER_ADMIN") return { ok: false, error: "Réservé au Super Admin." };

    const title = fdStr(formData, "title");
    if (!title) return { ok: false, error: "Le titre est requis." };
    const body = fdStr(formData, "body") ?? undefined;
    const link = fdStr(formData, "link") ?? undefined;
    const audience = (fdStr(formData, "audience") ?? "ALL") as BroadcastAudience;
    const role = fdStr(formData, "role");
    const userIds = formData.getAll("userIds").map(String).filter(Boolean);
    const popup = fdStr(formData, "popup") === "on" || fdStr(formData, "popup") === "true";

    if (audience === "USERS" && userIds.length === 0) return { ok: false, error: "Sélectionnez au moins une personne." };
    if (audience === "ROLE" && !role) return { ok: false, error: "Sélectionnez un rôle." };

    // LA FENÊTRE D'ANNULATION (K10c) : la diffusion attend sa fenêtre — annulée dedans, rien ne part. Les destinataires
    // sont FIXÉS maintenant : le compte annoncé est celui qui partira.
    const destinataires = await destinatairesDeLaDiffusion({ audience, role, userIds });
    const count = destinataires.length;
    if (count === 0) return { ok: false, error: "Aucun destinataire trouvé pour cette audience." };
    const charge: ChargeDiffusion = { userIds: destinataires, title, body: body ?? null, link: link ?? null, popup };
    const envoi = await differerEffetSortant({
      type: "notification.diffusion", libelle: `Diffusion « ${title} »`, cible: `${count} personne·s`, principalId: admin.id, charge,
    });

    await recordAudit({ actorId: admin.id, action: "CREATE", module: "Administration", summary: `Notification${popup ? " (pop-up)" : ""} diffusée à ${count} personne·s — « ${title} »${envoi.secondes ? ` (départ dans ${envoi.secondes} s, annulable d'ici là)` : ""}` });
    revalidatePath("/admin/settings");
    const quand = envoi.secondes ? ` Elle part dans ${envoi.secondes >= 60 ? `${Math.round(envoi.secondes / 60)} min` : `${envoi.secondes} s`} : « Annuler » d'ici là, et rien ne sera parti.` : "";
    return { ok: true, message: `Notification pour ${count} personne·s.${quand}` };
  });
}

export async function markNotificationRead(id: string) {
  const user = await requireUser();
  // Scope the update to the owner so a user can only mark their own.
  await prisma.notification.updateMany({
    where: { id, userId: user.id },
    data: { isRead: true },
  });
  revalidatePath("/notifications");
}

export async function markAllNotificationsRead() {
  const user = await requireUser();
  await prisma.notification.updateMany({
    where: { userId: user.id, isRead: false },
    data: { isRead: true },
  });
  revalidatePath("/notifications");
}
