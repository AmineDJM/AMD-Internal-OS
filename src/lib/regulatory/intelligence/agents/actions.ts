"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { aiConfigured, cleModeleRequise } from "@/lib/ai";
import { courtIaNonConfiguree } from "@/lib/ia/cle-manquante";
import { regCan, resolveRegCompanyIdFor } from "../access";
import { runAgentOnVersion, type AgentRunSummary } from "./orchestrator";

/**
 * Actions des agents spécialisés (G6) — exécution À LA DEMANDE par un humain habilité.
 * Vérifie le rôle (regCan) ET l'appartenance du dossier au périmètre de l'organisation.
 * L'IA n'est appelée que si configurée ; sinon abstention honnête (aucune simulation).
 */

const str = (fd: FormData, k: string) => { const v = fd.get(k); return v ? String(v).trim() : null; };

async function scopeCompanyId(userId: string): Promise<string | null> {
  return resolveRegCompanyIdFor(userId);
}

export async function runAgentAction(formData: FormData): Promise<AgentRunSummary & { ok: boolean; error?: string }> {
  const user = await requireUser();
  if (!regCan(user, "regulatory.dossier.analyse") && !regCan(user, "regulatory.rules.view") && user.role !== "SUPER_ADMIN") {
    return { ok: false, agentKey: "", agentName: "", configured: false, abstained: false, findings: 0, error: "Non autorisé." };
  }
  const dossierId = str(formData, "dossierId");
  const agentKey = str(formData, "agentKey");
  if (!dossierId || !agentKey) return { ok: false, agentKey: agentKey ?? "", agentName: "", configured: false, abstained: false, findings: 0, error: "Paramètres manquants." };

  const companyId = await scopeCompanyId(user.id);
  if (!companyId) return { ok: false, agentKey, agentName: "", configured: false, abstained: false, findings: 0, error: "Module non activé." };

  const version = await prisma.regulatoryDossierVersion.findFirst({
    where: { dossierId, dossier: { companyId } }, orderBy: { versionNo: "desc" }, select: { id: true },
  });
  if (!version) return { ok: false, agentKey, agentName: "", configured: false, abstained: false, findings: 0, error: "Aucune version." };

  if (!aiConfigured()) {
    return { ok: true, agentKey, agentName: "", configured: false, abstained: true, findings: 0, message: `${courtIaNonConfiguree(cleModeleRequise())} — agent non exécuté, aucune simulation.` };
  }

  const summary = await runAgentOnVersion(version.id, agentKey);
  revalidatePath(`/regulatory/enregistrement/analyse/${dossierId}`);
  return summary;
}
