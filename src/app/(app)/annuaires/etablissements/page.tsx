import { redirect } from "next/navigation";
import { requireModule } from "@/lib/session";
import { peutAnnuaire, userCan } from "@/lib/rbac";
import { INSTITUTION_TYPE, INSTITUTION_SECTOR } from "@/lib/labels";
import { chargerEtablissements } from "@/lib/queries/annuaires";
import { prisma } from "@/lib/prisma";
import { EtablissementsTable } from "./etablissements-table";
import { EnTeteAnnuaires } from "../en-tete";
import { EtablissementsParWilaya } from "./par-wilaya";
import { regrouperParWilaya } from "@/modules/lieux/partage";

export const dynamic = "force-dynamic";
export const metadata = { title: "Annuaires — Établissements — AMD Internal OS" };

/**
 * Onglet ÉTABLISSEMENTS du module « Annuaires » : le référentiel des hôpitaux, cliniques et
 * cabinets. C'est LE SEUL écran du référentiel depuis 09/2026 — l'onglet de la Promotion
 * médicale a été retiré à la demande de la Direction, et sa route redirige ici (§118.138).
 *
 * ── PORTÉE : LE RÉFÉRENTIEL N'EST PAS CLOISONNÉ, ET C'EST DÉJÀ TRANCHÉ ─────────────────────
 *
 * `MedicalInstitution` n'a AUCUNE fonction de portée dans `rbac.ts`, et les huit lecteurs du
 * dépôt l'interrogent sans clause (recherche globale, fabric d'entités, bénéficiaires de
 * congrès, `getMedicalData`). C'est un référentiel d'ÉTABLISSEMENTS, comme les spécialités : le
 * nom d'un CHU n'est pas une donnée confidentielle. En inventer une portée ICI donnerait une
 * neuvième vérité qui divergerait des huit autres (§118.5, §118.85).
 *
 * Ce qui EST cloisonné, ce sont les PRATICIENS : le compte affiché par établissement se calcule
 * donc dans la portée de la personne (`scopeMedicalDoctors`), dans le chargeur partagé.
 */
export default async function AnnuaireEtablissementsPage() {
  const user = await requireModule("DIRECTORIES");
  // LA PORTE est celle de l'ANNUAIRE (§118.147) : la Promotion médicale, OU l'annuaire des
  // établissements coché pour cette personne dans la console — sans lui ouvrir tout le module.
  if (!peutAnnuaire(user, "ETABLISSEMENTS", "VIEW")) redirect("/dashboard?denied=MEDICAL");
  // Qui ne voit AUCUN praticien par son module compte les rattachements en entier : sinon il lit
  // « 0 » partout, et supprimer un CHU ne l'avertirait de rien.
  const [feuille, specialites, parWilaya] = await Promise.all([
    chargerEtablissements(user, { compteEntier: !userCan(user, "MEDICAL", "VIEW") }),
    // Les spécialités connues, PROPOSÉES à la saisie d'un service — un référentiel, pas une porte.
    prisma.medicalSpecialty.findMany({ select: { name: true }, orderBy: { name: "asc" } }),
    // PAR WILAYA (refonte V2-D) : un regroupement sur la clé officielle, plus sur le texte saisi.
    prisma.medicalInstitution.groupBy({ by: ["wilayaCode"], where: { isActive: true }, _count: { _all: true } }),
  ]);
  return (
    <div className="space-y-5">
      <EnTeteAnnuaires
        user={user}
        description="CHU, EPH, EHS, cliniques, polycliniques, cabinets, et leurs services — le référentiel auquel se rattachent les praticiens. Les secteurs commerciaux ne se saisissent pas ici : chaque Business Unit les découpe dans sa configuration."
      />
      <EtablissementsParWilaya comptes={regrouperParWilaya(parWilaya.map((g) => ({ code: g.wilayaCode, n: g._count._all })))} />
      <EtablissementsTable
        rows={feuille.rows}
        couleurs={feuille.couleurs}
        types={Object.entries(INSTITUTION_TYPE).map(([value, label]) => ({ value, label }))}
        sectors={Object.entries(INSTITUTION_SECTOR).map(([value, d]) => ({ value, label: d.label }))}
        canCreate={peutAnnuaire(user, "ETABLISSEMENTS", "CREATE")}
        canEdit={peutAnnuaire(user, "ETABLISSEMENTS", "UPDATE")}
        canDelete={peutAnnuaire(user, "ETABLISSEMENTS", "DELETE")}
        suggestionsServices={specialites.map((s) => s.name)}
      />
    </div>
  );
}
