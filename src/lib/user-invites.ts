import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import type { UserRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { sansBloquer } from "@/lib/journal";

/**
 * CRÉATION DE COMPTE PAR LIEN D'INVITATION — le chemin SANS mot de passe.
 *
 * Règle absolue : un mot de passe ne transite JAMAIS par une conversation (ni chat, ni voix,
 * ni reçu). Le Chief of Staff (et demain n'importe quel écran) crée donc le COMPTE et un LIEN
 * à usage unique : la personne ouvre le lien et définit ELLE-MÊME son mot de passe. Tant que
 * le lien n'est pas utilisé, le compte est inconnectable (hash aléatoire jamais communiqué).
 *
 * Fonctions CŒUR sans session (testables) — les portes RBAC vivent chez les appelants
 * (op `create_account_invite` : Super Admin ; action admin éventuelle : ADMIN CREATE).
 */

const AVATAR_COLORS = ["#2563eb", "#7c3aed", "#0891b2", "#059669", "#d97706", "#dc2626", "#db2777"];
export const INVITE_TTL_HOURS = 72;

export interface CreatedInvite {
  userId: string;
  token: string;
  /** Chemin RELATIF du lien à transmettre (le domaine dépend du déploiement). */
  path: string;
  expiresAt: Date;
}

/** Crée le compte (inconnectable) + l'invitation. Erreur en texte FR si l'email existe déjà. */
export async function createAccountWithInvite(
  input: { name: string; email: string; role: UserRole; title?: string | null },
  createdById: string,
): Promise<CreatedInvite | { error: string }> {
  const email = input.email.trim().toLowerCase();
  const name = input.name.trim();
  if (!name || !email.includes("@")) return { error: "Nom et e-mail valides requis." };

  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (existing) return { error: `Un compte existe déjà avec l'e-mail ${email}.` };

  // Hash d'un secret aléatoire JAMAIS communiqué : personne ne peut se connecter avant
  // d'avoir défini son mot de passe par le lien. `mustChangePassword` reste false — le mot
  // de passe défini via l'invitation EST celui de la personne.
  const unknowable = randomBytes(32).toString("base64url");
  const user = await prisma.user.create({
    data: {
      email, name, role: input.role,
      title: input.title?.trim() || null,
      passwordHash: await bcrypt.hash(unknowable, 10),
      avatarColor: AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)],
      mustOnboard: true,
    },
    select: { id: true },
  });

  const invite = await issueInvite(user.id, createdById);
  await recordAudit({
    actorId: createdById, action: "CREATE", module: "Administration",
    summary: `Compte créé par invitation : ${name} (${input.role}) — lien valable ${INVITE_TTL_HOURS} h, aucun mot de passe transmis`,
  });
  return { userId: user.id, ...invite };
}

/** Émet un NOUVEAU lien pour un compte (l'ancien est invalidé) — compte jamais connecté ou lien périmé. */
export async function issueInvite(userId: string, createdById: string): Promise<{ token: string; path: string; expiresAt: Date }> {
  const token = randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + INVITE_TTL_HOURS * 3_600_000);
  // Un seul lien ACTIF par compte : réémettre invalide les précédents non utilisés.
  await prisma.userInvite.deleteMany({ where: { userId, usedAt: null } });
  await prisma.userInvite.create({ data: { token, userId, createdById, expiresAt } });
  return { token, path: `/invite/${token}`, expiresAt };
}

/** Ce que la page publique peut AFFICHER sans rien révéler d'exploitable. */
export async function inviteState(token: string): Promise<
  | { valid: true; name: string; email: string; expiresAt: Date }
  | { valid: false; reason: "unknown" | "used" | "expired" }
> {
  const invite = await prisma.userInvite.findUnique({
    where: { token },
    select: { usedAt: true, expiresAt: true, user: { select: { name: true, email: true, isActive: true } } },
  });
  if (!invite || !invite.user.isActive) return { valid: false, reason: "unknown" };
  if (invite.usedAt) return { valid: false, reason: "used" };
  if (invite.expiresAt < new Date()) return { valid: false, reason: "expired" };
  return { valid: true, name: invite.user.name, email: invite.user.email, expiresAt: invite.expiresAt };
}

/**
 * La personne définit SON mot de passe. Usage unique ATOMIQUE : la revendication
 * (`usedAt` null → maintenant) ne peut réussir qu'une fois, même sous double-clic.
 */
export async function redeemInvite(token: string, password: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (password.length < 8) return { ok: false, error: "Mot de passe trop court (min. 8 caractères)." };
  const invite = await prisma.userInvite.findUnique({ where: { token }, select: { id: true, userId: true, expiresAt: true, usedAt: true } });
  if (!invite || invite.usedAt) return { ok: false, error: "Ce lien d'invitation n'est plus valable. Demandez un nouveau lien à votre administrateur." };
  if (invite.expiresAt < new Date()) return { ok: false, error: "Ce lien d'invitation a expiré. Demandez un nouveau lien à votre administrateur." };

  const claimed = await prisma.userInvite.updateMany({
    where: { id: invite.id, usedAt: null },
    data: { usedAt: new Date() },
  });
  if (claimed.count === 0) return { ok: false, error: "Ce lien d'invitation vient d'être utilisé." };

  await prisma.user.update({
    where: { id: invite.userId },
    data: { passwordHash: await bcrypt.hash(password, 10), mustChangePassword: false },
  });
  await recordAudit({
    actorId: invite.userId, action: "UPDATE", module: "Administration",
    summary: "Mot de passe défini via le lien d'invitation (première activation du compte)",
  }).catch(sansBloquer("user-invites.redeemInvite.recordAudit"));
  return { ok: true };
}
