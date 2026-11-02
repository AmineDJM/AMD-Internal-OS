import { requireUser } from "@/lib/session";
import { ROLE_LABELS } from "@/lib/labels";
import { PageHeader } from "@/components/shared/page-header";
import { lireEcranRecettes } from "@/modules/recettes/api";
import { Designations, ListeRecettes } from "@/modules/recettes/ecrans/recettes";

export const dynamic = "force-dynamic";
export const metadata = { title: "Recettes — AMD Internal OS" };

/**
 * LES RECETTES (J10, décision 0028) — « comment on fait chez nous », tiré des circuits réels et validé par le
 * responsable du processus. Chacun ne voit que les recettes des circuits dont il voit l'écran.
 */
export default async function RecettesPage() {
  const user = await requireUser();
  const e = await lireEcranRecettes(user);
  const roles = Object.fromEntries(Object.entries(ROLE_LABELS));
  const compte = (s: string) => e.recettes.filter((r) => r.statut === s).length;
  return (
    <div className="space-y-4">
      <PageHeader
        title="Recettes"
        description={`Le savoir-faire de la maison, tiré des dossiers réels : ${compte("VALIDEE")} validée(s), ${compte("PROPOSEE")} proposée(s), ${compte("RETIREE")} retirée(s). L'Assistant IA ne se sert que des recettes validées.`}
      />
      <ListeRecettes recettes={e.recettes} roles={roles} />
      <Designations designations={e.designations} roles={roles} peutDesigner={e.peutDesigner} />
    </div>
  );
}
