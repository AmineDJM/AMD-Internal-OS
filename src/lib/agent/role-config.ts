import type { AssistantRoleConfig, UserRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";
import type { PowerTool } from "@/platform/ia/outil";
import { getAccess, userCan } from "@/lib/rbac";
import { voitLesSalaires } from "@/lib/hr/confidentialite";
import { normaliserReglageFamilles, resoudreAccesIa, type AccesIa, type FamilleIa, type ReglageFamilles } from "@/lib/agent/acces-regles";

/**
 * CONFIGURATION DE L'ASSISTANT PAR RÔLE — Jalon 4 (Décisions Q4 & Q12).
 *
 * Permet au Super Admin de personnaliser le comportement de l'assistant selon le rôle :
 * 1. Nom personnalisé et ton (ex. formel, pédagogique, direct)
 * 2. Consignes spécifiques (≤ 2 000 caractères)
 * 3. Outils autorisés — RESTRICTION SEULEMENT (le RBAC reste le plafond indépassable)
 * 4. Niveau de confirmation ("CRITIQUE" ou "TOUJOURS")
 * 5. Modèle imposé optionnel
 *
 * Toute modification est obligatoirement tracée (AssistantRoleConfigAudit).
 */

export interface SauvegarderRoleConfigEntree {
  role: UserRole;
  assistantName?: string | null;
  tone?: string | null;
  customInstructions?: string | null;
  allowedTools?: string[];
  confirmationLevel?: "CRITIQUE" | "TOUJOURS";
  enforcedModel?: string | null;
}

export interface ResultatSauvegardeConfig {
  ok: boolean;
  error?: string;
  config?: AssistantRoleConfig;
}

/**
 * Récupère la configuration personnalisée d'un rôle.
 */
export async function getRoleConfig(role: UserRole): Promise<AssistantRoleConfig | null> {
  try {
    return await prisma.assistantRoleConfig.findUnique({
      where: { role },
    });
  } catch {
    return null;
  }
}

/**
 * Sauvegarde ou met à jour la configuration d'un rôle avec traçabilité complète.
 */
export async function sauvegarderRoleConfig(
  entree: SauvegarderRoleConfigEntree,
  acteur: CurrentUser
): Promise<ResultatSauvegardeConfig> {
  // 1. Contrôle des droits : Super Admin ou droit de modification ADMIN
  if (acteur.role !== "SUPER_ADMIN" && !userCan(acteur, "ADMIN" as never, "UPDATE")) {
    return {
      ok: false,
      error: "Seul un administrateur peut modifier la configuration de l'assistant par rôle.",
    };
  }

  // 2. Validation des consignes (≤ 2 000 caractères)
  if (entree.customInstructions && entree.customInstructions.length > 2000) {
    return {
      ok: false,
      error: "Les consignes personnalisées ne doivent pas dépasser 2 000 caractères.",
    };
  }

  try {
    // 3. Récupération de l'ancienne configuration pour l'audit
    const ancienneConfig = await prisma.assistantRoleConfig.findUnique({
      where: { role: entree.role },
    });

    // 4. Upsert de la configuration
    const nouvelleConfig = await prisma.assistantRoleConfig.upsert({
      where: { role: entree.role },
      create: {
        role: entree.role,
        assistantName: entree.assistantName?.trim() || null,
        tone: entree.tone?.trim() || null,
        customInstructions: entree.customInstructions?.trim() || null,
        allowedTools: entree.allowedTools ?? [],
        confirmationLevel: entree.confirmationLevel ?? "CRITIQUE",
        enforcedModel: entree.enforcedModel?.trim() || null,
        updatedById: acteur.id,
      },
      update: {
        assistantName: entree.assistantName?.trim() || null,
        tone: entree.tone?.trim() || null,
        customInstructions: entree.customInstructions?.trim() || null,
        allowedTools: entree.allowedTools ?? [],
        confirmationLevel: entree.confirmationLevel ?? "CRITIQUE",
        enforcedModel: entree.enforcedModel?.trim() || null,
        updatedById: acteur.id,
      },
    });

    // 5. Enregistrement de l'audit (qui, quand, ancienne valeur, nouvelle valeur)
    await prisma.assistantRoleConfigAudit.create({
      data: {
        role: entree.role,
        actorId: acteur.id,
        previousData: ancienneConfig ? JSON.parse(JSON.stringify(ancienneConfig)) : undefined,
        newData: JSON.parse(JSON.stringify(nouvelleConfig)),
      },
    });

    return { ok: true, config: nouvelleConfig };
  } catch (err) {
    return {
      ok: false,
      error: `Erreur lors de l'enregistrement : ${err instanceof Error ? err.message : "inconnue"}`,
    };
  }
}

/**
 * Applique la restriction d'outils par rôle.
 *
 * Le RBAC reste le plafond : un outil interdit par le RBAC n'est JAMAIS accordé.
 * Si une restriction est définie pour le rôle, seuls les outils listés et autorisés par le RBAC sont gardés.
 */
export function filtrerOutilsParRole(
  outilsPermisParRbac: PowerTool[],
  config: { allowedTools?: string[] } | null | undefined
): PowerTool[] {
  if (!config?.allowedTools || config.allowedTools.length === 0) {
    return outilsPermisParRbac;
  }

  const autorises = new Set(config.allowedTools);
  return outilsPermisParRbac.filter((o) => autorises.has(o.def.name));
}

/**
 * Résout le texte des consignes du rôle à injecter dans le contexte.
 */
export function resoudreConsignesRole(config: AssistantRoleConfig | null | undefined): string | undefined {
  if (!config) return undefined;

  const parties: string[] = [];
  if (config.assistantName) {
    parties.push(`Ton nom d'assistant pour ce profil est : ${config.assistantName}.`);
  }
  if (config.tone) {
    parties.push(`Ton de communication attendu : ${config.tone}.`);
  }
  if (config.customInstructions) {
    parties.push(config.customInstructions);
  }

  return parties.length > 0 ? parties.join("\n") : undefined;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES ACCÈS DE L'ASSISTANT IA D'UNE PERSONNE (décision 0012) — relus À CHAQUE TOUR, sans cache : un
 * réglage changé dans la console vaut dès la demande suivante. Les droits applicatifs posent le défaut de
 * chaque famille (la règle est dans `acces-regles.ts`, pure) ; le réglage du rôle, puis celui de la
 * personne, ouvrent ou ferment.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export function droitsApplicatifsIa(user: CurrentUser): Record<FamilleIa, boolean> {
  const voit = (...modules: string[]) => modules.some((m) => userCan(user, m as never, "VIEW"));
  return {
    SALAIRES: voitLesSalaires(user),
    CONTRATS_RH: voitLesSalaires(user),
    FICHES: voit("RH"),
    BUDGETS: voit("BUDGETS", "FINANCES"),
    DRIVE: voit("DRIVE", "DOCUMENTS"),
    REGLEMENTAIRE: voit("REGULATORY", "REGULATORY_PIPELINE"),
    AD_PRO: voit("SPONSORING", "AD_PRO_CENTRE", "EVENTS", "CONGRESS_INTERNATIONAL", "CONGRESS_NATIONAL", "PROMO_MATERIAL", "AD_PRO_OTHER"),
    ECRITURES: true,
  };
}

export async function accesAssistantIa(user: CurrentUser): Promise<AccesIa> {
  if (user.role === "SUPER_ADMIN") return resoudreAccesIa({ superAdmin: true, droits: droitsApplicatifsIa(user) });
  const lignes = await prisma.assistantIaAcces.findMany({ where: { OR: [{ userId: user.id }, { role: user.role as UserRole }] } });
  const reglage = (l?: { ouvertes: string[]; fermees: string[] }) => (l ? normaliserReglageFamilles(l.ouvertes, l.fermees) : null);
  return resoudreAccesIa({
    superAdmin: false,
    droits: droitsApplicatifsIa(user),
    role: reglage(lignes.find((l) => l.role === user.role && !l.userId)),
    personne: reglage(lignes.find((l) => l.userId === user.id)),
  });
}

/**
 * CE QUE LA CONSOLE MONTRE (`/admin/ai/acces`) : les réglages par rôle, et chaque personne active (hors Super Admin)
 * avec ses droits applicatifs par famille, le réglage de son rôle et le sien — l'écran recalcule l'accès effectif
 * avec la même règle pure que le moteur (`resoudreAccesIa`).
 */
export async function chargerConsoleAccesIa(): Promise<{
  parRole: Map<UserRole, ReglageFamilles>;
  personnes: { id: string; nom: string; email: string; role: UserRole; droits: Record<FamilleIa, boolean>; reglageRole: ReglageFamilles; reglage: ReglageFamilles }[];
}> {
  const [reglages, comptes] = await Promise.all([
    prisma.assistantIaAcces.findMany(),
    prisma.user.findMany({ where: { isActive: true, role: { not: "SUPER_ADMIN" } }, select: { id: true, name: true, email: true, role: true }, orderBy: { name: "asc" } }),
  ]);
  const vide: ReglageFamilles = { ouvertes: [], fermees: [] };
  const parRole = new Map(reglages.filter((r) => r.role && !r.userId).map((r) => [r.role!, normaliserReglageFamilles(r.ouvertes, r.fermees)]));
  const parPersonne = new Map(reglages.filter((r) => r.userId).map((r) => [r.userId!, normaliserReglageFamilles(r.ouvertes, r.fermees)]));
  const personnes = await Promise.all(comptes.map(async (c) => {
    const access = await getAccess(c.id, c.role);
    const session = { id: c.id, name: c.name, email: c.email, role: access.role ?? c.role, secondaryRole: access.secondaryRole, access, mustChangePassword: false } as CurrentUser;
    return {
      id: c.id, nom: c.name, email: c.email, role: c.role, droits: droitsApplicatifsIa(session),
      reglageRole: parRole.get(c.role) ?? vide, reglage: parPersonne.get(c.id) ?? vide,
    };
  }));
  return { parRole, personnes };
}
