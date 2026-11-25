import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { hasRole } from "@/lib/rbac";
import { LIBELLE_AGENCES, lienPosteAssistante } from "@/lib/chemins/ad-pro";
import { PageHeader } from "@/components/shared/page-header";
import { fileAgences } from "@/modules/ad-pro/api";
import { autresTachesAssistante } from "@/lib/queries/autres-taches-assistante";
import { ListeAgences } from "./liste-agences";
import { AutresTaches } from "./autres-taches";
import { AncrePosteVersSaPage } from "./ancre-poste";

export const dynamic = "force-dynamic";
export const metadata = { title: "Prospection d'agences — AMD Internal OS" };

/**
 * PROSPECTION D'AGENCES (Direction, 15/11/2026) — la file de l'assistante de direction : les postes qu'on lui a confiés,
 * avec ce qu'il faut y faire (déposer les devis, finaliser le BC). La Direction Marketing et le Super Admin y suivent tout le
 * parcours.
 *
 * SA PAGE AD & PRO (Direction, 23/11/2026) : ses postes d'abord — un geste par ligne —, puis ses autres tâches (BC à établir,
 * devis à obtenir, matériel promotionnel, billets et hôtels), puis les postes qui ne l'attendent pas, avec chez qui ils en sont.
 *
 * UN MODULE À PART (Super Admin, 25/11/2026) : la fusion dans le bureau du secrétariat (24/11/2026) est défaite. Le bureau ne
 * montre plus ni les postes agence ni les BC de poste ; ils ne vivent qu'ici, une seule fois. La porte est la clé de la console
 * `PROSPECTION_AGENCES` (`fileAgences`).
 */
export default async function AgencesPage() {
  const user = await requireUser();
  const lignes = await fileAgences(user);
  if (!lignes) notFound();
  const assistante = hasRole(user, "DIRECTION_ASSISTANT");
  const autres = assistante ? await autresTachesAssistante(user) : [];
  // Les postes qui s'ouvrent sur CETTE page : un ancien lien « …#poste-<id> » y mène.
  const siens = lignes.filter((l) => l.lien === lienPosteAssistante(l.itemId)).map((l) => l.itemId);
  return (
    <div className="space-y-5">
      <PageHeader
        title={LIBELLE_AGENCES}
        description={assistante
          ? "Votre page Ad & Pro : les postes qu'on vous a confiés — déposer les devis des agences, finaliser ou corriger le bon de commande — et vos autres tâches. Chaque ligne mène là où agir."
          : "Les postes Ad & Pro qui passent par une agence : devis à déposer, bon de commande à finaliser, et où en est chacun."}
      />
      <ListeAgences
        lignes={lignes} vide="Aucun poste en prospection pour l'instant." action="Ouvrir"
        aides={{ aMoi: "Un geste par poste : ouvrez-le pour le faire.", autres: "Rien à faire pour vous : chaque ligne dit chez qui en est le poste." }}
        entre={<AutresTaches groupes={autres} />}
      />
      {siens.length > 0 && <AncrePosteVersSaPage postes={siens} />}
    </div>
  );
}
