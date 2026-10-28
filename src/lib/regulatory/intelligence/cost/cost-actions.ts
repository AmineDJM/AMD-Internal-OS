"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { regCan, resolveRegCompanyIdFor } from "../access";
import { regAudit } from "../audit";

/**
 * BUDGET IA D'UN DOSSIER.
 *
 * Un plafond n'est utile que s'il ARRÊTE réellement la dépense : le registre refuse un appel
 * quand le dossier a atteint son plafond, et le dit. Ce fichier ne fait que régler ce plafond,
 * sous garde `regulatory.dossier.analyse` (qui déclenche les analyses paie ce qu'elles coûtent)
 * et avec une trace : un plafond relevé est une décision, elle doit être attribuable.
 *
 * Vider le champ = revenir au plafond global (`CTD_BUDGET_USD_DEFAULT`). Mettre 0 est refusé :
 * un plafond nul bloquerait toute analyse sans le dire clairement — mieux vaut désactiver
 * l'analyse que la laisser échouer en silence.
 */

interface Result { ok: boolean; error?: string; message?: string }

const MAX_BUDGET_USD = 10_000;

export async function setDossierBudget(formData: FormData): Promise<Result> {
  const user = await requireUser();
  if (!regCan(user, "regulatory.dossier.analyse") && user.role !== "SUPER_ADMIN") return { ok: false, error: "Non autorisé." };
  const companyId = await resolveRegCompanyIdFor(user.id);
  if (!companyId) return { ok: false, error: "Module non activé pour cette entité." };

  const dossierId = String(formData.get("dossierId") ?? "").trim();
  if (!dossierId) return { ok: false, error: "Dossier non précisé." };

  const dossier = await prisma.regulatoryDossier.findFirst({
    where: { id: dossierId, companyId },
    select: { id: true, reference: true, aiBudgetUsd: true },
  });
  if (!dossier) return { ok: false, error: "Dossier introuvable." };

  const raw = String(formData.get("budgetUsd") ?? "").trim().replace(",", ".");
  let value: number | null = null;
  if (raw.length > 0) {
    const n = Number(raw);
    if (!Number.isFinite(n)) return { ok: false, error: "Montant illisible." };
    if (n <= 0) return { ok: false, error: "Un plafond doit être strictement positif. Laissez le champ vide pour revenir au plafond global." };
    if (n > MAX_BUDGET_USD) return { ok: false, error: `Plafond trop élevé (maximum ${MAX_BUDGET_USD} $).` };
    value = Math.round(n * 10_000) / 10_000;
  }

  await prisma.regulatoryDossier.update({ where: { id: dossier.id }, data: { aiBudgetUsd: value } });
  await regAudit({
    companyId, actorId: user.id, dossierId: dossier.id, action: "AI_BUDGET_SET",
    detail: value == null
      ? `Plafond IA propre au dossier retiré : le plafond global s'applique de nouveau.`
      : `Plafond IA du dossier fixé à ${value.toFixed(2)} $.`,
  });
  revalidatePath(`/regulatory/enregistrement/analyse/${dossier.id}`);

  return {
    ok: true,
    message: value == null ? "Plafond propre au dossier retiré — le plafond global s'applique." : `Plafond fixé à ${value.toFixed(2)} $.`,
  };
}
