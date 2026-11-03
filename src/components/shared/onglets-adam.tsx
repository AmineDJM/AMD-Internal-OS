import { ADAM_TABS } from "@/lib/labels";
import { ModuleTabs } from "@/components/shared/module-tabs";

/**
 * LA BARRE D'ONGLETS DE L'ÉCRAN D'ADAM — Super Admin seul (Direction, 02/11/2026). L'écran qui la rend décide de
 * l'afficher (`peutVoirAdam`, côté serveur) : ce composant n'accorde rien, il dessine les quatre portes.
 */
export function OngletsAdam() {
  return (
    <div className="shrink-0 border-b border-slate-200 bg-white px-3 sm:px-4" data-testid="onglets-adam">
      <ModuleTabs tabs={ADAM_TABS} />
    </div>
  );
}
