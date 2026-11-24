import { ADAM_TABS } from "@/lib/labels";
import { ModuleTabs } from "@/components/shared/module-tabs";

/**
 * LA BARRE D'ONGLETS DE L'ÉCRAN D'ADAM — à qui a le bureau (`ouvreLeBureauAdam`, Super Admin seul par défaut). L'écran qui
 * la rend décide de l'afficher, côté serveur : ce composant n'accorde rien, il dessine les portes. `conversation` = la
 * personne a aussi Adam (`/assistant`, module `ASSISTANT_IA`) ; sans lui, l'onglet mènerait à une page introuvable.
 */
export function OngletsAdam({ conversation = true }: { conversation?: boolean }) {
  return (
    <div className="shrink-0 border-b border-slate-200 bg-white px-3 sm:px-4" data-testid="onglets-adam">
      <ModuleTabs tabs={conversation ? ADAM_TABS : ADAM_TABS.filter((t) => t.module !== "ASSISTANT_IA")} />
    </div>
  );
}
