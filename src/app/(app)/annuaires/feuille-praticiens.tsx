import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { userCan, peutAnnuaire, annuaireOuvertParConsole, peutGererSpecialites, type SessionUser } from "@/lib/rbac";
import { chargerFeuillePraticiens, type FiltreGrade } from "@/lib/queries/annuaires";
import { AnnuaireGrid } from "@/app/(app)/medical/annuaire/annuaire-grid";
import { DirectoryBar } from "@/app/(app)/medical/annuaire/directory-bar";
import { EnTeteAnnuaires } from "./en-tete";
import { SANS_SPECIALITE } from "@/lib/annuaires/par-specialite";

/**
 * LA FEUILLE DES PRATICIENS, VUE DU MODULE « ANNUAIRES » — médecins ou pharmaciens.
 *
 * Même chargeur, mêmes composants, même portée que l'onglet Annuaire de la Visite médicale :
 * c'est une autre PORTE sur la même feuille, filtrée par grade. Un délégué y voit ses praticiens,
 * la direction tout ; un annuaire nommé fermé y reste fermé. La seule chose qui change est le
 * chemin des liens (`basePath`), pour que l'on reste dans le module d'où l'on vient.
 */
export async function FeuillePraticiensHub({
  user, grade, annuaire, specialite = null, archives = false,
}: {
  user: SessionUser;
  grade: Exclude<FiltreGrade, null>;
  annuaire: string | null;
  /** `?specialite=` — un annuaire par spécialité (médecins) : un identifiant ou `sans`. */
  specialite?: string | null;
  /** `?archives=1` — la vue des fiches archivées. */
  archives?: boolean;
}) {
  // LA PORTE est celle de l'ANNUAIRE (§118.147) : le module du référentiel (la Promotion
  // médicale), OU l'annuaire coché pour cette personne dans la console. L'onglet n'est rendu qu'à
  // qui passe l'une des deux, et son adresse tapée à la main refuse de la même façon.
  const cle = grade === "pharmaciens" ? "PHARMACIENS" : "MEDECINS";
  if (!peutAnnuaire(user, cle, "VIEW")) redirect("/dashboard?denied=MEDICAL");
  const canImport = peutAnnuaire(user, cle, "CREATE");
  const canEdit = peutAnnuaire(user, cle, "UPDATE");
  const canDelete = peutAnnuaire(user, cle, "DELETE");
  // LA STRUCTURE — annuaires nommés, leurs accès, leurs colonnes — reste la Visite médicale :
  // ouvrir la modification des FICHES n'ouvre pas le droit de réorganiser le référentiel.
  const canManageStructure = userCan(user, "MEDICAL", "UPDATE");

  // MÉDECINS : PLUS D'ANNUAIRES NOMMÉS NI D'« ANNUAIRE GÉNÉRAL » (Direction, 06/10 : « enlève tous les praticiens et
  // trucs généraux, garde la rubrique des spécialités ») — la feuille se range par SPÉCIALITÉ, et c'est tout.
  const medecins = grade === "medecins";
  const gerer = {
    creer: peutGererSpecialites(user, "CREATE"),
    modifier: peutGererSpecialites(user, "UPDATE"),
    supprimer: peutGererSpecialites(user, "DELETE"),
  };
  const feuille = await chargerFeuillePraticiens(user, {
    annuaire: medecins ? null : annuaire, grade, canManage: canManageStructure,
    // La GESTION des spécialités a une porte unique, Annuaires › Spécialités (Direction, 07/10) : la barre ne les liste que si elles ont des médecins.
    specialitesVides: false,
    entier: annuaireOuvertParConsole(user, cle, "VIEW"),
    // L'annuaire par spécialité ne concerne que les médecins ; l'archivage, les deux grades.
    specialite: grade === "medecins" ? specialite : null,
    archives,
  });
  if (!feuille) notFound();

  const basePath = grade === "pharmaciens" ? "/annuaires/pharmaciens" : "/annuaires/medecins";
  // L'ANNUAIRE D'UNE SPÉCIALITÉ (Direction, 06/10) : la spécialité est celle de l'annuaire — la colonne disparaît, et
  // une fiche ajoutée ici la reçoit. Elle reste affichée dans la vue de TOUTES les spécialités (et « Sans spécialité »).
  const specialiteDeLAnnuaire = medecins && feuille.specialiteOuverte && feuille.specialiteOuverte !== SANS_SPECIALITE
    ? feuille.annuairesSpecialite.find((s) => s.id === feuille.specialiteOuverte)?.name ?? null
    : null;
  const description = grade === "pharmaciens"
    ? "Les pharmaciens de l'annuaire — officines et pharmacies hospitalières — en feuille modifiable, avec les mêmes annuaires nommés que la Visite médicale."
    : "Les médecins de l'annuaire — hospitaliers et libéraux — en feuille modifiable, exportable, avec vue par spécialité.";

  return (
    <div className="space-y-5">
      <EnTeteAnnuaires user={user} description={description} />
      {!medecins && (
        <DirectoryBar
          directories={feuille.directories}
          current={annuaire}
          companies={feuille.companies}
          generalCount={feuille.generalCount}
          canManage={canManageStructure}
          people={feuille.people}
          basePath={basePath}
        />
      )}
      {/* LA BARRE « PAR SPÉCIALITÉ » EST RETIRÉE (Super Admin, 25/11/2026) : on filtre dans le tableau. Les archivés restent
          joignables, par un simple lien, seulement quand il y en a. */}
      {(feuille.archives || feuille.archivesCount > 0) && (
        <p className="text-xs">
          <Link href={lienArchives(basePath, medecins ? null : annuaire, !feuille.archives)} className="text-primary hover:underline">
            {feuille.archives ? "← Revenir aux actifs" : `Voir les archivés (${feuille.archivesCount})`}
          </Link>
        </p>
      )}
      <AnnuaireGrid
        archives={feuille.archives}
        rows={feuille.rows} etablissements={feuille.etablissements} couleurs={feuille.couleurs} customColumns={feuille.customColumns}
        canEdit={canEdit} canImport={canImport} canImportFile={userCan(user, "MEDICAL", "CREATE")} canDelete={canDelete} specialties={feuille.specialties}
        canManageColumns={canManageStructure}
        directoryId={feuille.openDirectoryId}
        directoryName={feuille.directoryName}
        titreParDefaut={grade === "pharmaciens" ? "PHARMACIEN" : undefined}
        colonnesMasquees={specialiteDeLAnnuaire ? ["specialty"] : []}
        specialiteImposee={specialiteDeLAnnuaire}
        exportHref={`/api/medical/annuaire/export?grade=${grade}`}
      />
    </div>
  );
}

/** Le lien vers les archivés (ou retour aux actifs), en gardant l'annuaire ouvert — l'état de la vue vit dans l'adresse. */
function lienArchives(basePath: string, annuaire: string | null | undefined, archives: boolean): string {
  const q = new URLSearchParams();
  if (annuaire) q.set("annuaire", annuaire);
  if (archives) q.set("archives", "1");
  const s = q.toString();
  return s ? `${basePath}?${s}` : basePath;
}
