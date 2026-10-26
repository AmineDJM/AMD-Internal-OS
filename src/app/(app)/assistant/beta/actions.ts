"use server";

import { requireUser } from "@/lib/session";
import { peutVoirAdam } from "@/platform/in-process/visibilite-adam";
import { prisma } from "@/lib/prisma";
import { executerActionConfirmee } from "@/lib/agent/ecritures";

export interface ReponseBetaAction {
  ok: boolean;
  messageId: string;
  role: "assistant";
  content: string;
  outilsAppeles: string[];
  intent?: {
    id: string;
    kind: string;
    title: string;
    summary?: string;
    fields?: { label: string; value: string }[];
    status?: "PROPOSED" | "CONFIRMED" | "EXECUTING" | "EXECUTED" | "CANCELLED";
    resultLink?: string;
    resultMessage?: string;
  } | null;
  error?: string;
}

/**
 * Charge les métriques live de l'ERP pour la barre KPI en verre.
 */
export async function chargerKpiBeta() {
  const user = await requireUser();
  // L'ASSISTANT EST RÉSERVÉ AU SUPER ADMIN (§118.153) : la page l'était, ses actions non — une action
  // serveur s'appelle par son identifiant, sans passer par la page (audit 2026-10-24, R3).
  if (!peutVoirAdam(user)) return { ok: false as const, error: "L'assistant n'est pas ouvert à votre compte." };
  const [nbUsers, nbDossiers, nbProduits, nbTaches] = await Promise.all([
    prisma.user.count(),
    prisma.regulatoryDossier.count(),
    prisma.product.count(),
    prisma.task.count(),
  ]);

  return {
    ok: true,
    data: {
      nbUsers,
      nbDossiers,
      nbProduits,
      nbTaches,
      userName: user.name,
      userRole: user.role,
    },
  };
}

/**
 * Valide et exécute une intention d'action sous confirmation humaine.
 */
export async function confirmerActionBeta(intentId: string) {
  const user = await requireUser();
  if (!peutVoirAdam(user)) return { ok: false, error: "L'assistant n'est pas ouvert à votre compte." };
  return executerActionConfirmee(intentId, user);
}

/**
 * L'INTERFACE BÊTA NE RÉPOND PLUS ELLE-MÊME (audit 2026-10-24, R3 — même correctif que la décision 0006, R1).
 *
 * Elle appelait un fournisseur en direct (hors passerelle `models/gateway.ts` : ni coût, ni interrupteur,
 * ni garde de sortie), sans outils, avec des « réponses rapides » écrites à la main et un repli qui
 * renvoyait la question à son auteur. La refonte se poursuit sur sa branche ; ici, l'Assistant IA est le
 * moteur de production (`/chief-of-staff`, où mène `/assistant`).
 */
export async function envoyerMessageBeta(
  userPrompt: string,
  _moduleFilter?: string,
  _historique: { role: string; content: string }[] = []
): Promise<ReponseBetaAction> {
  const user = await requireUser();
  if (!peutVoirAdam(user)) return { ok: false, messageId: `err-${Date.now()}`, role: "assistant", content: "", outilsAppeles: [], error: "L'assistant n'est pas ouvert à votre compte." };
  if (!(userPrompt ?? "").trim()) return { ok: false, messageId: `err-${Date.now()}`, role: "assistant", content: "", outilsAppeles: [], error: "Message vide." };
  return {
    ok: true,
    messageId: `msg-${Date.now()}`,
    role: "assistant",
    content: "Cette interface est en cours de refonte. L'Assistant IA complet — outils de l'ERP, documents, voix — est ouvert dans « Assistant IA » du menu.",
    outilsAppeles: [],
  };
}
