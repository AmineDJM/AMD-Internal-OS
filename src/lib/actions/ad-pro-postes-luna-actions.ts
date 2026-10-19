"use server";

import { requireUser } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { fdStr } from "@/lib/actions/types";
import { proposerPostesParModele, type ResultatPostes } from "@/lib/postes-luna-ia";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LUNA PROPOSE LES POSTES D'UNE DEMANDE — l'action de l'écran. Elle n'écrit RIEN (hors du journal
 * d'usage de l'IA) : la proposition s'affiche sous la description, et les postes repris se créent
 * ensuite par `addAdProItem`, avec ses propres gardes.
 *
 * La porte est celle de la création d'un événement : qui ne peut pas créer la demande n'a rien à
 * se faire proposer. La description n'est lue que pour cette proposition.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export async function proposerPostesDepuisDescription(formData: FormData): Promise<ResultatPostes> {
  const user = await requireUser();
  if (!userCan(user, "EVENTS", "CREATE")) return { ok: false, raison: "DESACTIVEE", error: "Non autorisé." };
  const description = fdStr(formData, "description") ?? "";
  return proposerPostesParModele({ description, natureDemande: "événement", userId: user.id });
}
