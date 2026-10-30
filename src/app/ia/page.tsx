import { redirect } from "next/navigation";
import { requireUser } from "@/lib/session";
import { peutUtiliserAssistantIA } from "@/lib/rbac";
import { AdventumIaApp } from "@/modules/assistant-ia/ecrans/app/adventum-ia-app";

export const dynamic = "force-dynamic";

/**
 * ADVENTUM IA — l'app de l'Assistant IA (décision 0027). Même porte que `/assistant` : le module `ASSISTANT_IA`,
 * ouvert personne par personne dans la console. Sans lui, l'app le dit (pas de page vide, pas de lien vers l'ERP).
 */
export default async function AdventumIaPage() {
  const user = await requireUser();
  if (user.mustChangePassword) redirect("/change-password");
  if (!peutUtiliserAssistantIA(user)) {
    return (
      <main className="grid min-h-dvh place-items-center bg-[#f5f8fc] p-6 text-center text-[#0f1b2d]">
        <div className="max-w-sm space-y-2">
          <h1 className="text-xl font-semibold">Adventum IA</h1>
          <p className="text-sm text-[#5b6b82]">L&apos;assistant ne vous est pas encore ouvert. Demandez à la Direction de l&apos;activer pour votre compte.</p>
        </div>
      </main>
    );
  }
  return <AdventumIaApp userName={user.name} />;
}
