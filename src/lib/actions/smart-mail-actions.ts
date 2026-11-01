"use server";

import { gesteReversible } from "@/lib/effets/ecran";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { featureEnabled, FEATURES } from "@/lib/features";
import { sendSmartEmail, smartMailConfigured, smartMailMissing, mailProvider, mailFrom, cleanRecipients } from "@/lib/mail-smart";

export interface SmartMailStatus {
  configured: boolean;
  provider: string | null;
  from: string;
  missing: string[];
  webhookPath: string;
  recent: { id: string; to: string; subject: string; status: string; error: string | null; createdAt: string }[];
}

/** État de la configuration du courrier + les derniers envois (Administration). */
export async function smartMailStatus(): Promise<SmartMailStatus> {
  const user = await requireUser();
  const recent = user.role === "SUPER_ADMIN"
    ? await prisma.outboundEmail.findMany({
        orderBy: { createdAt: "desc" }, take: 20,
        select: { id: true, toAddress: true, subject: true, status: true, error: true, createdAt: true },
      })
    : [];
  return {
    configured: smartMailConfigured(),
    provider: mailProvider(),
    from: mailFrom(),
    missing: smartMailMissing(),
    webhookPath: "/api/mail/inbound",
    recent: recent.map((r) => ({
      id: r.id, to: r.toAddress, subject: r.subject, status: r.status,
      error: r.error, createdAt: r.createdAt.toISOString(),
    })),
  };
}

export interface SendResult { ok: boolean; message?: string; error?: string }

/**
 * Envoie un e-mail depuis la plateforme, par API HTTPS. Chaque tentative est journalisée
 * (`OutboundEmail`) : on sait toujours ce qui est parti, et pourquoi le reste ne l'est pas.
 * Ne lève jamais.
 */
export async function sendMail(input: { to: string; cc?: string; subject: string; body: string }): Promise<SendResult> {
  try {
    const user = await requireUser();
    return await gesteReversible(user, { capaciteId: "smart-mail-actions:sendMail", libelle: "Courriel envoyé" }, async () => {
      if (!(await featureEnabled(FEATURES.MAIL_SMART.key, user.id))) {
        return { ok: false, error: "Le courrier n'est pas encore activé pour votre compte." };
      }
      const to = cleanRecipients((input.to ?? "").split(/[,;]/));
      const cc = cleanRecipients((input.cc ?? "").split(/[,;]/));
      const subject = (input.subject ?? "").trim();
      const body = (input.body ?? "").trim();
      if (to.length === 0) return { ok: false, error: "Indiquez au moins un destinataire valide." };
      if (!subject) return { ok: false, error: "L'objet est obligatoire." };
      if (!body) return { ok: false, error: "Le message est vide." };

      const row = await prisma.outboundEmail.create({
        data: {
          userId: user.id, toAddress: to.join(", "), ccAddress: cc.length ? cc.join(", ") : null,
          subject, body, provider: mailProvider(), attempts: 1,
        },
        select: { id: true },
      });

      const res = await sendSmartEmail({ to, cc, subject, text: body, replyTo: user.email ?? undefined });

      await prisma.outboundEmail.update({
        where: { id: row.id },
        data: res.ok
          // Différé (fenêtre d'annulation) : la ligne reste « en file » ; l'exécuteur la passe à SENT quand il part.
          ? res.providerId?.startsWith("differe:") ? { status: "QUEUED", providerId: res.providerId, error: null } : { status: "SENT", providerId: res.providerId ?? null, sentAt: new Date(), error: null }
          : { status: "FAILED", error: (res.error ?? "Échec inconnu").slice(0, 1000) },
      });

      const differe = res.ok && res.providerId?.startsWith("differe:");
      return res.ok
        ? { ok: true, message: differe ? `Message à ${to.join(", ")} : il part dans quelques instants — « Annuler l'envoi » d'ici là.` : `Message envoyé à ${to.join(", ")}.` }
        : { ok: false, error: res.error ?? "Envoi impossible." };
    });
  } catch (err) {
    console.error("[mail-smart] sendMail failed", err);
    return { ok: false, error: "Envoi impossible." };
  }
}
