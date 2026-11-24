import { redirect } from "next/navigation";
import { requireUser } from "@/lib/session";
import { userCan } from "@/lib/rbac";

export const dynamic = "force-dynamic";

/**
 * `/rh` N'EST PLUS UN ÉCRAN — c'est un aiguillage (Direction, 06/10 : « le menu Ressources humaines ne devrait plus être
 * cliquable, ce sont ses modules qui le sont »). Son ancien tableau de bord est réparti dans les sous-modules qu'il
 * résumait, chacun sous SON droit :
 *   • Employés (`/rh/equipe`) : effectif, actifs, contrats à échéance, masse salariale par entité, « Nouvel employé » ;
 *   • Demandes RH (`/rh/demandes`) : demandes à traiter, congés à trancher ;
 *   • Paie (`/rh/paie`) : les avances sur salaire.
 *
 * La route survit parce qu'elle vit dans des favoris, des notifications et des liens collés en conversation : elle mène au
 * premier sous-module ouvert à la personne.
 */
export default async function RhEntryPage() {
  const user = await requireUser();
  if (userCan(user, "EMPLOYEES", "VIEW")) redirect("/rh/equipe");
  if (userCan(user, "HR_REQUESTS", "VIEW")) redirect("/rh/demandes");
  if (userCan(user, "PAIE", "VIEW")) redirect("/rh/paie");
  if (userCan(user, "TRAINING", "VIEW")) redirect("/formations");
  redirect("/mon-dossier");
}
