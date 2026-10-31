import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { peutUtiliserAssistantIA } from "@/lib/rbac";
import { listerGestesAssistant } from "@/modules/assistant-ia/actions-gestes";
import { GestesAssistant } from "@/modules/assistant-ia/ecrans/gestes-assistant";

export const metadata: Metadata = { title: "Ce que l'assistant a fait — Assistant IA" };
export const dynamic = "force-dynamic";

/**
 * « CE QUE L'ASSISTANT A FAIT » (lot J7, décision 0029) — l'historique des gestes de l'assistant au nom de la
 * personne, lu dans le journal des effets, avec « Annuler » (annulé / compensé / impossible + pourquoi).
 */
export default async function GestesAssistantPage() {
  const user = await requireUser();
  if (!peutUtiliserAssistantIA(user)) notFound();
  const r = await listerGestesAssistant(false);
  return <GestesAssistant initiaux={r.ok ? r.gestes : []} superAdmin={user.role === "SUPER_ADMIN"} />;
}
