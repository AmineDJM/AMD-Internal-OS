import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { userCan } from "@/lib/rbac";
import { ROLE_LABELS } from "@/lib/labels";
import { createAccountWithInvite, issueInvite, INVITE_TTL_HOURS } from "@/lib/user-invites";
import { alignerSurLaFiche } from "@/lib/org/source-unique";
import { decisionCompteSalarie, emailDeConnexion, roleDuCompteSalarie } from "../domaine/compte-salarie";
import type { UserRole } from "@prisma/client";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE COMPTE APPLICATIF NAÎT AVEC LA FICHE (Super Admin, 24/11/2026 — lot rhdepart).
 *
 * Appelé par la création d'une fiche (RH, intégration d'une recrue) et par le bouton « Créer son compte » de la fiche.
 * Réutilise l'invitation (`lib/user-invites.ts`) : un compte inconnectable et un lien à usage unique, valable
 * 72 h — la personne y définit elle-même son mot de passe ; aucun mot de passe ne transite. Le département suit la fiche
 * (`alignerSurLaFiche`), la société d'appartenance et le N+1 se lisent sur la fiche (rien à recopier sur le compte).
 *
 * Idempotent : une fiche déjà reliée ne reçoit rien ; un compte qui existe sous la même adresse est relié, pas doublé.
 * La liaison est CONDITIONNELLE (la fiche encore sans compte) : deux créations simultanées n'en relient qu'une, et le
 * compte né en trop est retiré aussitôt.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type IssueCompte =
  | { ok: true; cree: boolean; phrase: string | null; lien: string | null }
  | { ok: false; error: string };

export async function creerCompteDuSalarie(
  acteur: Parameters<typeof userCan>[0] & { id: string },
  employeeId: string,
  opts: { role?: string | null } = {},
): Promise<IssueCompte> {
  const fiche = await prisma.employee.findUnique({
    where: { id: employeeId }, select: { id: true, fullName: true, email: true, userId: true, isActive: true, position: true },
  });
  if (!fiche) return { ok: false, error: "Fiche salarié introuvable." };
  const email = emailDeConnexion(fiche.email);
  const meme = email
    ? await prisma.user.findUnique({ where: { email }, select: { id: true, employee: { select: { id: true } } } })
    : null;
  const d = decisionCompteSalarie(fiche, meme ? { id: meme.id, ficheId: meme.employee?.id ?? null } : null);

  switch (d.geste) {
    case "DEJA_LIE": return { ok: true, cree: false, phrase: null, lien: null };
    case "INACTIVE": case "SANS_EMAIL": case "EMAIL_PRIS": return { ok: true, cree: false, phrase: d.phrase, lien: null };
    case "RELIER": {
      const lie = await prisma.employee.updateMany({ where: { id: fiche.id, userId: null }, data: { userId: d.userId } });
      if (lie.count === 0) return { ok: true, cree: false, phrase: null, lien: null };
      await alignerSurLaFiche(fiche.id);
      await recordAudit({
        actorId: acteur.id, action: "UPDATE", module: "Ressources humaines", entityType: "EMPLOYEE", entityId: fiche.id,
        field: "userId", newValue: d.userId, summary: `Compte applicatif existant (${email}) relié à la fiche de ${fiche.fullName}`,
      });
      return { ok: true, cree: false, phrase: `Le compte applicatif existant (${email}) est relié à la fiche de ${fiche.fullName}.`, lien: null };
    }
    case "CREER": {
      const role = roleDuCompteSalarie(opts.role, userCan(acteur, "ADMIN", "CREATE"), Object.keys(ROLE_LABELS));
      const r = await createAccountWithInvite({ name: fiche.fullName, email: d.email, role: role as UserRole, title: fiche.position }, acteur.id);
      if ("error" in r) return { ok: true, cree: false, phrase: r.error, lien: null };
      const lie = await prisma.employee.updateMany({ where: { id: fiche.id, userId: null }, data: { userId: r.userId } });
      if (lie.count === 0) {
        // Une autre création a relié la fiche entre-temps : le compte né ici n'a jamais servi, il se retire.
        await prisma.user.delete({ where: { id: r.userId } }).catch(() => undefined);
        return { ok: true, cree: false, phrase: null, lien: null };
      }
      await alignerSurLaFiche(fiche.id);
      await recordAudit({
        actorId: acteur.id, action: "CREATE", module: "Ressources humaines", entityType: "EMPLOYEE", entityId: fiche.id,
        field: "userId", newValue: r.userId,
        summary: `Compte applicatif créé avec la fiche de ${fiche.fullName} (${ROLE_LABELS[role] ?? role}) — invitation à usage unique, aucun mot de passe transmis`,
      });
      const roleDemande = (opts.role ?? "").trim();
      const roleNonRetenu = roleDemande && roleDemande !== role
        ? ` Le rôle « ${ROLE_LABELS[roleDemande] ?? roleDemande} » se règle dans Administration › Comptes.` : "";
      return {
        ok: true, cree: true, lien: r.path,
        phrase: `Compte applicatif créé (${ROLE_LABELS[role] ?? role}) : transmettez à ${fiche.fullName} son lien d'invitation, valable ${INVITE_TTL_HOURS} h — il y définira lui-même son mot de passe.${roleNonRetenu}`,
      };
    }
  }
}

/** L'état du compte d'une fiche, pour la carte « Compte applicatif » (lecture seule). */
export async function etatCompteSalarie(employeeId: string): Promise<{
  userId: string; email: string; role: string; isActive: boolean; jamaisConnecte: boolean;
  invitation: { lien: string; expire: Date; perimee: boolean } | null;
} | null> {
  const e = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: { user: { select: { id: true, email: true, role: true, isActive: true, lastLoginAt: true } } },
  });
  const u = e?.user;
  if (!u) return null;
  const inv = await prisma.userInvite.findFirst({ where: { userId: u.id, usedAt: null }, orderBy: { createdAt: "desc" }, select: { token: true, expiresAt: true } });
  const jamaisConnecte = !u.lastLoginAt && !(await prisma.userInvite.count({ where: { userId: u.id, usedAt: { not: null } } }));
  return {
    userId: u.id, email: u.email, role: String(u.role), isActive: u.isActive, jamaisConnecte,
    invitation: jamaisConnecte && inv ? { lien: `/invite/${inv.token}`, expire: inv.expiresAt, perimee: inv.expiresAt < new Date() } : null,
  };
}

/** Un NOUVEAU lien pour un compte jamais activé (l'ancien est invalidé). */
export async function renouvelerInvitationSalarie(acteurId: string, employeeId: string): Promise<{ ok: true; lien: string; phrase: string } | { ok: false; error: string }> {
  const etat = await etatCompteSalarie(employeeId);
  if (!etat) return { ok: false, error: "Cette fiche n'a pas de compte applicatif : créez-le d'abord." };
  if (!etat.isActive) return { ok: false, error: "Le compte de cette fiche est fermé : sa réouverture se décide dans Administration › Comptes." };
  if (!etat.jamaisConnecte) return { ok: false, error: "Ce compte a déjà été activé : un oubli de mot de passe se traite dans Administration › Comptes." };
  const r = await issueInvite(etat.userId, acteurId);
  await recordAudit({
    actorId: acteurId, action: "UPDATE", module: "Ressources humaines", entityType: "EMPLOYEE", entityId: employeeId,
    summary: `Nouveau lien d'invitation pour ${etat.email} (valable ${INVITE_TTL_HOURS} h, l'ancien est invalidé)`,
  });
  return { ok: true, lien: r.path, phrase: `Nouveau lien d'invitation, valable ${INVITE_TTL_HOURS} h : l'ancien ne fonctionne plus.` };
}
