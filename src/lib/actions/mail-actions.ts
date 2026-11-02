"use server";

import { gesteReversible } from "@/lib/effets/ecran";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { encryptSecret, getMailAccount, testImap, sendMail, closeMailConnection, type MailAttachment } from "@/lib/mail";
import { validateUpload } from "@/lib/storage";
import { getAppSettings } from "@/lib/settings";
import { fdStr, fdNum, type ActionResult } from "@/lib/actions/types";

/** Connecte (ou met à jour) la boîte mail Infomaniak de l'utilisateur. Teste IMAP avant d'enregistrer. */
export async function connectMailbox(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  return gesteReversible(user, { capaciteId: "mail-actions:connectMailbox", libelle: "Boîte mail connectée" }, async () => {
    const email = fdStr(formData, "email");
    const password = fdStr(formData, "password");
    if (!email || !password) return { ok: false, error: "Adresse e-mail et mot de passe d'application requis." };

    const imapHost = fdStr(formData, "imapHost") ?? "mail.infomaniak.com";
    const imapPort = fdNum(formData, "imapPort") ?? 993;
    const smtpHost = fdStr(formData, "smtpHost") ?? "mail.infomaniak.com";
    const smtpPort = fdNum(formData, "smtpPort") ?? 465;
    const passwordEnc = encryptSecret(password);

    // Vérifie la connexion IMAP avant d'enregistrer (sinon message clair).
    const err = await testImap({ email, passwordEnc, imapHost, imapPort });
    if (err) return { ok: false, error: `Connexion impossible : ${err}. Vérifiez l'adresse et le mot de passe d'application Infomaniak.` };

    await prisma.mailAccount.upsert({
      where: { userId: user.id },
      update: { email, displayName: fdStr(formData, "displayName") ?? user.name, imapHost, imapPort, smtpHost, smtpPort, passwordEnc },
      create: { userId: user.id, email, displayName: fdStr(formData, "displayName") ?? user.name, imapHost, imapPort, smtpHost, smtpPort, passwordEnc },
    });
    closeMailConnection(email); // au cas où une connexion chaude tournait avec l'ancien mot de passe
    await recordAudit({ actorId: user.id, action: "CREATE", module: "Courrier", summary: `Boîte mail connectée (${email})` });
    revalidatePath("/courrier");
    return { ok: true };
  });
}

/** Met à jour la signature e-mail de l'utilisateur (ajoutée en bas des nouveaux messages). */
export async function updateMailSignature(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const account = await getMailAccount(user.id);
  if (!account) return { ok: false, error: "Aucune boîte connectée." };
  // On borne la longueur (garde-fou) ; vide → on retire la signature.
  const signature = (fdStr(formData, "signature") ?? "").slice(0, 5000).trimEnd();
  await prisma.mailAccount.update({ where: { userId: user.id }, data: { signature: signature || null } });
  await recordAudit({ actorId: user.id, action: "UPDATE", module: "Courrier", summary: "Signature e-mail mise à jour" });
  revalidatePath("/courrier");
  return { ok: true };
}

export async function disconnectMailbox(): Promise<ActionResult> {
  const user = await requireUser();
  return gesteReversible(user, { capaciteId: "mail-actions:disconnectMailbox", libelle: "Boîte mail déconnectée" }, async () => {
    const account = await getMailAccount(user.id);
    if (account) closeMailConnection(account.email);
    await prisma.mailAccount.deleteMany({ where: { userId: user.id } });
    await recordAudit({ actorId: user.id, action: "DELETE", module: "Courrier", summary: "Boîte mail déconnectée" });
    revalidatePath("/courrier");
    return { ok: true };
  });
}

export async function sendMailAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  return gesteReversible(user, { capaciteId: "mail-actions:sendMailAction", libelle: "Courriel envoyé" }, async () => {
    const account = await getMailAccount(user.id);
    if (!account) return { ok: false, error: "Aucune boîte connectée." };
    const to = fdStr(formData, "to");
    const subject = fdStr(formData, "subject") ?? "(sans objet)";
    if (!to) return { ok: false, error: "Destinataire requis." };

    // Pièces jointes (fichiers de l'appareil) : validées comme les autres téléversements.
    const rawFiles = formData.getAll("attachments").filter((f): f is File => f instanceof File && f.size > 0);
    const attachments: MailAttachment[] = [];
    if (rawFiles.length) {
      const maxMb = (await getAppSettings()).maxUploadMb;
      for (const f of rawFiles) {
        const invalid = validateUpload(f.name, f.size, maxMb);
        if (invalid) return { ok: false, error: `Pièce jointe « ${f.name} » : ${invalid}` };
        attachments.push({ filename: f.name, content: Buffer.from(await f.arrayBuffer()), contentType: f.type || undefined });
      }
    }

    try {
      await sendMail(account, { to, cc: fdStr(formData, "cc") ?? undefined, subject, text: fdStr(formData, "body") ?? "", attachments });
    } catch (e) {
      return { ok: false, error: `Envoi impossible : ${(e as Error)?.message ?? "erreur SMTP"}.` };
    }
    await recordAudit({
      actorId: user.id, action: "CREATE", module: "Courrier",
      summary: `E-mail envoyé à ${to}${attachments.length ? ` (${attachments.length} pièce·s jointe·s)` : ""}`,
    });
    return { ok: true };
  });
}
