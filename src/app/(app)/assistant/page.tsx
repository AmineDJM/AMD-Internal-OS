import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { peutVoirAdam } from "@/platform/in-process/visibilite-adam";
import { AssistantWorkspace } from "@/components/assistant-beta/assistant-workspace";

export const metadata: Metadata = {
  title: "Adventum Brain — Assistant IA",
  description: "Assistant interne d'Adventum Pharma.",
};

export const dynamic = "force-dynamic";

/**
 * L'ASSISTANT — nouvelle interface, moteur de production.
 *
 * L'interface est celle de `assistant-beta/` ; les réponses viennent du moteur éprouvé
 * (`runAssistant`, via `beta/actions.ts`) en attendant le moteur Mastra (R4). L'accès reste
 * celui de l'assistant de production : le Super Admin (§118.153). Pour tout autre compte, la
 * page n'existe pas.
 */
export default async function AssistantPage() {
  const user = await requireUser();
  if (!peutVoirAdam(user)) notFound();

  return (
    <div className="app-viewport-flush -mx-3 -mt-3 -mb-3 flex flex-col overflow-hidden sm:-mx-4 sm:-mt-6 sm:-mb-6 lg:-mx-8 lg:-mb-8">
      <AssistantWorkspace userName={user.name} userRole={user.role} />
    </div>
  );
}
