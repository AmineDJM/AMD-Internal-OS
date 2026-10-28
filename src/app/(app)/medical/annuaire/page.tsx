import { notFound } from "next/navigation";
import { requireModule } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { PageHeader } from "@/components/shared/page-header";
import { ModuleTabs } from "@/components/shared/module-tabs";
import { visibleTabs } from "@/lib/nav-tabs";
import { MEDICAL_TABS } from "@/lib/labels";
import { chargerFeuillePraticiens } from "@/lib/queries/annuaires";
import { AnnuaireGrid } from "./annuaire-grid";
import { DirectoryBar } from "./directory-bar";

export const dynamic = "force-dynamic";

/**
 * ANNUAIRE — la feuille détaillée du module Promotion médicale.
 *
 * Tous ceux avec qui l'on travaille : médecins, pharmaciens, praticiens hospitaliers. En FEUILLE
 * MODIFIABLE — on ne consulte pas un annuaire, on le corrige : un clic sélectionne une cellule,
 * double-clic ou Entrée l'édite, les colonnes fermées (wilaya, grade, secteur, potentiel) se
 * choisissent dans un menu, et l'on peut basculer en vue par spécialité.
 *
 * La portée est celle du module : un délégué voit et corrige ses praticiens, la direction voit
 * tout. C'est `scopeMedicalDoctors` qui décide, la même fonction que partout ailleurs — et chaque
 * écriture est revérifiée au niveau de la ligne côté serveur.
 *
 * LA LECTURE VIT DANS `lib/queries/annuaires.ts`, partagée avec le module « Annuaires » du pôle
 * Administration : deux pages qui chargeraient la même feuille chacune de leur côté finiraient
 * par montrer deux annuaires (§118.5).
 */
export default async function AnnuairePage(props: { searchParams?: Promise<{ annuaire?: string }> }) {
  const searchParams = await props.searchParams;
  const user = await requireModule("MEDICAL");
  const canImport = userCan(user, "MEDICAL", "CREATE");
  const canEdit = userCan(user, "MEDICAL", "UPDATE");
  const canDelete = userCan(user, "MEDICAL", "DELETE");

  const feuille = await chargerFeuillePraticiens(user, { annuaire: searchParams?.annuaire ?? null, grade: null, canManage: canEdit });
  if (!feuille) notFound();

  return (
    <div className="space-y-5">
      <PageHeader title="Annuaire" />
      <ModuleTabs tabs={await visibleTabs(user, MEDICAL_TABS)} />
      <DirectoryBar
        directories={feuille.directories}
        current={searchParams?.annuaire ?? null}
        companies={feuille.companies}
        generalCount={feuille.generalCount}
        canManage={canEdit}
        people={feuille.people}
      />
      <AnnuaireGrid
        rows={feuille.rows} etablissements={feuille.etablissements} couleurs={feuille.couleurs} customColumns={feuille.customColumns}
        canEdit={canEdit} canImport={canImport} canImportFile={canImport} canDelete={canDelete} specialties={feuille.specialties}
        canManageColumns={canEdit}
        directoryId={feuille.openDirectoryId}
        directoryName={feuille.directoryName}
      />
    </div>
  );
}
