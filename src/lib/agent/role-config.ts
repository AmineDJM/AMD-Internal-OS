import type { AssistantRoleConfig, UserRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";
import type { PowerTool } from "@/platform/ia/outil";
import { userCan } from "@/lib/rbac";

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
