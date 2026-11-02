import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { peutUtiliserAssistantIA, peutVoirAdam } from "@/lib/rbac";
import { OngletsAdam } from "@/components/shared/onglets-adam";
import { AssistantWorkspace } from "@/modules/assistant-ia/ecrans/assistant-workspace";
import { adresseDeLaPersonne } from "@/modules/assistant-ia/api";

export const metadata: Metadata = {
  title: "Adam — AMD Internal OS",
  description: "Assistant interne d'Adventum Pharma.",
};

export const dynamic = "force-dynamic";

/**
 * ADAM — l'assistant de tous (Direction, 02/11/2026 ; module `ASSISTANT_IA`, clé inchangée) : nouvelle interface,
 * moteur de production.
 *
 * L'interface est celle de `assistant-beta/` ; les réponses viennent du moteur Mastra + MiMo
 * (`lib/agent`, via `beta/actions.ts`). L'accès est le module `ASSISTANT_IA` : le Super Admin
 * l'a, et l'ouvre personne par personne. Ouvert, l'assistant travaille avec les droits de la
 * personne. Pour qui ne l'a pas, la page n'existe pas.
 */
export default async function AssistantPage() {
  const user = await requireUser();
  if (!peutUtiliserAssistantIA(user)) notFound();
  // S1 (décision 0048) : l'accueil dans l'adresse que la personne a choisie (tutoiement / vouvoiement).
  const adresse = await adresseDeLaPersonne(user.id);

  return (
    <div className="app-viewport-flush -mx-3 -mt-3 -mb-3 flex flex-col overflow-hidden sm:-mx-4 sm:-mt-6 sm:-mb-6 lg:-mx-8 lg:-mb-8">
      {/* Le Super Admin SEUL a les onglets de l'ex-« My Chief of Staff » (Direction, 02/11/2026) ; un employé qui a
          Adam voit la conversation, sans barre. */}
      {peutVoirAdam(user) ? <OngletsAdam /> : null}
      <AssistantWorkspace userName={user.name} userRole={user.role} adresse={adresse} />
    </div>
  );
}
