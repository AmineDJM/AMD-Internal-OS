"use server";

import { revalidatePath } from "next/cache";
import bcrypt from "bcryptjs";
import type { UserRole } from "@prisma/client";
import { requireUser } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { refusAdministration } from "@/lib/admin/garde-comptes";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { ROLE_LABELS } from "@/lib/labels";
import { fdStr, type ActionResult } from "@/lib/actions/types";
import { REFUS_COMPTE_SYSTEME } from "@/lib/missions/agent/account";
import { relierALaPersonne } from "@/lib/referentiels/personnes/double-ecriture";

const AVATAR_COLORS = ["#2563eb", "#7c3aed", "#0891b2", "#059669", "#d97706", "#dc2626", "#db2777"];

export async function createUser(
  _prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const admin = await requireUser();
  if (!userCan(admin, "ADMIN", "CREATE")) return { ok: false, error: "Réservé aux administrateurs." };

  const email = fdStr(formData, "email")?.toLowerCase();
  const name = fdStr(formData, "name");
  const password = fdStr(formData, "password");
  const role = fdStr(formData, "role") as UserRole;
  if (!email || !name || !password || !role) {
    return { ok: false, error: "Tous les champs obligatoires doivent être remplis." };
  }
  if (password.length < 8) return { ok: false, error: "Mot de passe trop court (min. 8 caractères)." };
  // Seul un Super Admin crée un Super Admin (§118.184, audit 360° S9).
  const refus = refusAdministration(admin, null, "ROLE", role);
  if (refus) return { ok: false, error: refus };

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return { ok: false, error: "Un utilisateur avec cet email existe déjà." };

  // DOUBLE ÉCRITURE (refonte, lot V2-B) : la Personne dans la même transaction, derrière son interrupteur.
  const created = await prisma.$transaction(async (tx) => {
    const ligne = await tx.user.create({
      data: {
        email,
        name,
        passwordHash: await bcrypt.hash(password, 10),
        role,
        title: fdStr(formData, "title"),
        region: fdStr(formData, "region"),
        avatarColor: AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)],
        // New accounts must set their own password on first login, then go
        // through the guided onboarding (workspace tour + mailbox + profil).
        mustChangePassword: true,
        mustOnboard: true,
      },
    });
    await relierALaPersonne(tx, "User", ligne.id, admin.id);
    return ligne;
  });
  await recordAudit({
    actorId: admin.id, action: "CREATE", module: "Administration",
    summary: `Utilisateur créé: ${name} (${role})`,
  });
  revalidatePath("/admin");
  return { ok: true, id: created.id };
}

export async function toggleUserActive(formData: FormData): Promise<ActionResult> {
  const admin = await requireUser();
  if (!userCan(admin, "ADMIN", "UPDATE")) return { ok: false, error: "Non autorisé." };
  const id = fdStr(formData, "id");
  if (!id || id === admin.id) return { ok: false, error: "Action invalide." };

  const u = await prisma.user.findUnique({ where: { id } });
  if (!u) return { ok: false, error: "Introuvable." };
  // LE COMPTE SYSTÈME NE SE DÉSACTIVE PAS DEPUIS UN ÉCRAN. Le désactiver ne « mettrait pas Adam
  // en pause » : cela arrêterait le moteur qui tient les missions en cours, y compris celles
  // qui attendent une réponse humaine — sans que personne ne l'apprenne. La suspension d'Adam
  // passe par le débrayage prévu (`MISSIONS_SWEEP=off`), qui laisse l'état intact.
  if (u.isSystem) return { ok: false, error: REFUS_COMPTE_SYSTEME };
  const refus = refusAdministration(admin, { id: u.id, role: u.role }, "COMPTE");
  if (refus) return { ok: false, error: refus };
  await prisma.user.update({ where: { id }, data: { isActive: !u.isActive } });
  await recordAudit({
    actorId: admin.id, action: "UPDATE", module: "Administration",
    field: "isActive", oldValue: String(u.isActive), newValue: String(!u.isActive),
    summary: `${u.isActive ? "Désactivation" : "Activation"} de ${u.name}`,
  });
  revalidatePath("/admin");
  return { ok: true };
}

export async function updateUserRole(formData: FormData): Promise<ActionResult> {
  const admin = await requireUser();
  if (!userCan(admin, "ADMIN", "UPDATE")) return { ok: false, error: "Non autorisé." };
  const id = fdStr(formData, "id");
  const role = fdStr(formData, "role") as UserRole;
  if (!id || !role) return { ok: false, error: "Paramètres manquants." };

  const u = await prisma.user.findUnique({ where: { id } });
  if (!u) return { ok: false, error: "Introuvable." };
  const refus = refusAdministration(admin, { id: u.id, role: u.role }, "ROLE", role);
  if (refus) return { ok: false, error: refus };
  // LE RÔLE DU COMPTE SYSTÈME NE SE CHANGE PAS. Le baisser désarmerait silencieusement toutes
  // les missions en cours ; le laisser modifiable ouvrirait un chemin d'escalade qui contourne
  // `policy/guard.ts` — il suffirait de demander à quelqu'un d'autre de cliquer.
  if (u.isSystem) return { ok: false, error: REFUS_COMPTE_SYSTEME };
  await prisma.user.update({ where: { id }, data: { role } });
  await recordAudit({
    actorId: admin.id, action: "UPDATE", module: "Administration",
    field: "role", oldValue: u.role, newValue: role, summary: `Rôle de ${u.name} → ${role}`,
  });
  revalidatePath("/admin");
  return { ok: true };
}

/**
 * Règle l'« autre rôle » (fonction secondaire) d'un utilisateur — ex. un délégué qui
 * est AUSSI National Sales / Direction Marketing. L'utilisateur cumulera alors les
 * capacités des deux rôles. Chaîne vide = retirer le rôle secondaire.
 */
export async function setSecondaryRole(formData: FormData): Promise<ActionResult> {
  const admin = await requireUser();
  if (!userCan(admin, "ADMIN", "UPDATE")) return { ok: false, error: "Non autorisé." };
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Paramètres manquants." };
  const raw = fdStr(formData, "secondaryRole");
  if (raw && !(raw in ROLE_LABELS)) return { ok: false, error: "Rôle invalide." };
  // Le rôle secondaire ne peut pas conférer les pleins pouvoirs (anti-escalade).
  if (raw === "SUPER_ADMIN") return { ok: false, error: "Le rôle secondaire ne peut pas être Super Admin." };
  const secondaryRole = raw ? (raw as UserRole) : null;

  const u = await prisma.user.findUnique({ where: { id }, select: { id: true, role: true, name: true, secondaryRole: true } });
  if (!u) return { ok: false, error: "Introuvable." };
  const refus = refusAdministration(admin, { id: u.id, role: u.role }, "ROLE");
  if (refus) return { ok: false, error: refus };
  await prisma.user.update({ where: { id }, data: { secondaryRole } });
  await recordAudit({
    actorId: admin.id, action: "UPDATE", module: "Administration",
    field: "secondaryRole", oldValue: u.secondaryRole ?? "—", newValue: secondaryRole ?? "—",
    summary: `Autre rôle de ${u.name} → ${secondaryRole ? (ROLE_LABELS[secondaryRole] ?? secondaryRole) : "aucun"}`,
  });
  revalidatePath("/admin");
  return { ok: true };
}
