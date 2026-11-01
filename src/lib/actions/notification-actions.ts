"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { destinatairesDeLaDiffusion, type BroadcastAudience } from "@/lib/notify";
import { differerSiFenetre } from "@/lib/effets/fenetre";
import { noterEffetExterne } from "@/lib/effets/magasin";
import { executeurDiffusion, type ChargeDiffusion } from "@/lib/notifications/diffusion-differee";
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
    const notificationIds = destinataires.map(() => `c${globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`);
    const charge: ChargeDiffusion = { userIds: destinataires, notificationIds, title, body: body ?? null, link: link ?? null, popup };
    const demande = { type: "notification.diffusion", acte: "NOTIFICATION_PUSH" as const, cible: `${count} personne·s`, apercu: `« ${title} »`, charge };
    // Noté au geste (simulation : neutralisé), puis différé par le port de la fenêtre ; hors geste réversible, il part.
    const neutralise = noterEffetExterne({ acte: demande.acte, cible: demande.cible, apercu: demande.apercu, origine: "notification-actions:sendBroadcast" });
    const envoi = neutralise ? null : await differerSiFenetre(demande);
    if (!neutralise && !envoi) await executeurDiffusion.executer(charge, null as never);

    await recordAudit({ actorId: admin.id, action: "CREATE", module: "Administration", summary: `Notification${popup ? " (pop-up)" : ""} diffusée à ${count} personne·s — « ${title} »${envoi ? ` (départ dans ${envoi.delaiSecondes} s, annulable d'ici là)` : ""}` });
    revalidatePath("/admin/settings");
    const s = envoi?.delaiSecondes ?? 0;
    const quand = s ? ` Elle part dans ${s >= 60 ? `${Math.round(s / 60)} min` : `${s} s`} : « Annuler » d'ici là, et rien ne sera parti.` : "";
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
