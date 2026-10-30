import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { peutUtiliserAssistantIA } from "@/lib/rbac";
import { AssistantWorkspace } from "@/modules/assistant-ia/ecrans/assistant-workspace";

export const metadata: Metadata = {
  title: "Adventum Brain — Assistant IA",
  description: "Assistant interne d'Adventum Pharma.",
};

export const dynamic = "force-dynamic";

/**
 * L'ASSISTANT — nouvelle interface, moteur de production.
 *
 * L'interface est celle de `assistant-beta/` ; les réponses viennent du moteur Mastra + MiMo
 * (`lib/agent`, via `beta/actions.ts`). L'accès est le module `ASSISTANT_IA` : le Super Admin
 * l'a, et l'ouvre personne par personne. Ouvert, l'assistant travaille avec les droits de la
 * personne. Pour qui ne l'a pas, la page n'existe pas.
 */
export default async function AssistantPage() {
  const user = await requireUser();
  if (!peutUtiliserAssistantIA(user)) notFound();

  return (
    <div className="app-viewport-flush -mx-3 -mt-3 -mb-3 flex flex-col overflow-hidden sm:-mx-4 sm:-mt-6 sm:-mb-6 lg:-mx-8 lg:-mb-8">
      <AssistantWorkspace userName={user.name} userRole={user.role} />
    </div>
  );
}
