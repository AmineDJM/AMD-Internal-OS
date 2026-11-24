import { redirect } from "next/navigation";
import { requireModule } from "@/lib/session";
import { peutAnnuaire } from "@/lib/rbac";
import { aiguillerVisite } from "@/lib/queries/aiguillage-visite";
import { loadMyFieldDay } from "@/lib/queries/my-field-day";
import { PageHeader } from "@/components/shared/page-header";
import { ModuleTabs } from "@/components/shared/module-tabs";
import { visibleTabs } from "@/lib/nav-tabs";
import { MEDICAL_TABS } from "@/lib/labels";
import type { Lettre } from "@/lib/segmentation/regles";
import { MesMedecins, type MedecinDuPanel } from "./mes-medecins";

export const dynamic = "force-dynamic";
export const metadata = { title: "Mes médecins — Visite médicale — AMD Internal OS" };

/**
 * « MES MÉDECINS » — le panel du délégué (interface du délégué, maquette VALIDÉE le 24/11/2026).
 *
 * Le panel tel que la tournée le lit (`loadMyFieldDay` : secteur ∪ rattachement, la lettre et le requis de la
 * segmentation, les visites du mois) — jamais un second calcul. Une ligne mène à la fiche du praticien (`/praticiens/<id>`),
 * celle de toute la plateforme. « + Ajouter un médecin » crée la fiche dans l'annuaire par le geste de l'annuaire
 * (`addDirectoryDoctor`) : le délégué en est le propriétaire, elle entre dans son panel — sans validation du superviseur
 * (DECISIONS, 24/11).
 */
export default async function MesMedecinsPage(props: { searchParams?: Promise<{ ajouter?: string; q?: string }> }) {
  const searchParams = await props.searchParams;
  const user = await requireModule("MEDICAL");
  const aiguillage = await aiguillerVisite(user);
  if (aiguillage.destination !== "JOURNEE") redirect(aiguillage.chemin);

  const maintenant = new Date();
  const [day, tabs] = await Promise.all([loadMyFieldDay(user.id, maintenant), visibleTabs(user, MEDICAL_TABS)]);
  const frequences = new Map(day.frequences.map((f) => [f.doctorId, f]));
  // EN RETARD = proposé par la tournée : la fréquence de sa lettre n'est pas tenue ce mois (`buildTournee`).
  const enRetard = new Map(day.tournee.map((t) => [t.doctorId, t.reason]));
  const medecins: MedecinDuPanel[] = day.panel.map((d) => {
    const f = frequences.get(d.id);
    return {
      id: d.id, nom: d.name, specialite: d.specialty, etablissement: d.institution, wilaya: d.wilaya,
      lettre: (f?.lettre ?? null) as Lettre | null, faites: f?.faites ?? 0, attendues: f?.attendues ?? 0,
      derniereVisite: d.derniereVisite?.toISOString() ?? null, retard: enRetard.get(d.id) ?? null,
    };
  });

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <PageHeader title="Mes médecins" />
      <ModuleTabs tabs={tabs} />
      <MesMedecins
        medecins={medecins}
        maintenant={maintenant.toISOString()}
        peutAjouter={peutAnnuaire(user, "MEDECINS", "CREATE")}
        ouvrirAjout={searchParams?.ajouter === "1"}
        rechercheInitiale={searchParams?.q ?? ""}
      />
    </div>
  );
}
