import { notFound } from "next/navigation";
import { CHEMIN_RAPPORTS_TERRAIN } from "@/lib/chemins/rapports-terrain";
import { ArrowLeft } from "lucide-react";
import { requireModule } from "@/lib/session";
import { scopeMedicalDoctors } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { getFieldReportDetail, managesReports } from "@/lib/queries/field-reports";
import { PageHeader } from "@/components/shared/page-header";
import { SupprimerRapport } from "../supprimer-rapport";
import { ReportEditor } from "./report-editor";
import { SimpleReportEditor } from "./simple-report-editor";
import { BackLink } from "@/components/shared/back-link";
import { remisesDuRapport, stockPourVisite } from "@/lib/queries/promo-remises";

export const dynamic = "force-dynamic";

export default async function FieldReportPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  // La fiche d'un rapport est gardée par le MÊME module que la liste (« Rapports terrain »),
  // et non plus par « Promotion médicale » : sinon un profil ayant accès aux rapports mais pas
  // à la promotion médicale (ex. Direction des opérations) était renvoyé vers « Mon espace »
  // en ouvrant un rapport. L'accès fin (voir/éditer CE rapport) reste géré par getFieldReportDetail.
  const user = await requireModule("FIELD_REPORTS");
  const detail = await getFieldReportDetail(user, params.id);
  if (!detail) notFound();
  // Compte rendu (synthèse) simple pour tous : dicter/écrire + médecin(s), établissement,
  // spécialité, date, pièces jointes. Le gestionnaire peut aussi valider/rouvrir.
  const isManager = managesReports(user);

  const doctors = await prisma.medicalDoctor.findMany({
    where: scopeMedicalDoctors(user),
    select: { id: true, name: true },
    orderBy: { name: "asc" },
    take: 500,
  });

  // LE MATÉRIEL REMIS (§118.204) — le stock EN MAIN du KAM qui a fait la visite (pas de celui qui
  // ouvre la fiche), et ce que ce compte rendu a déjà remis. Un compte rendu rattaché à une visite de
  // l'emploi du temps n'en porte pas : la visite les porte, et son rapport les corrige.
  const lien = await prisma.fieldReport.findUnique({ where: { id: detail.id }, select: { delegateId: true, visitId: true } });
  const materiel = lien && !lien.visitId
    ? await Promise.all([stockPourVisite(lien.delegateId ?? user.id), remisesDuRapport(detail.id)])
        // Un compte rendu ne présente pas de supports numériques : ils se rattachent à une VISITE.
        .then(([stock, initial]) => ({ stock: { articles: stock.articles, numeriques: [] }, initial }))
    : null;

  return (
    <div className="space-y-5">
      <BackLink href={CHEMIN_RAPPORTS_TERRAIN}>
        <ArrowLeft className="h-4 w-4" /> Rapports
      </BackLink>
      <PageHeader
        title={isManager ? "Rapport de visite" : "Mon compte rendu de visite"}
        description={
          isManager
            ? (detail.delegateName ? `Délégué : ${detail.delegateName} · relecture et validation.` : "Relecture et validation.")
            : "Parlez (ou écrivez) votre compte rendu, puis envoyez."
        }
      >
        <SupprimerRapport
          id={detail.id}
          name={detail.delegateName ? `Rapport — ${detail.delegateName}` : "Rapport de visite"}
          enabled={detail.canDelete}
          versLaListe
          compact={false}
          libelle="Supprimer"
        />
      </PageHeader>
      {isManager
        ? <ReportEditor detail={detail} doctors={doctors} materiel={materiel} rattacheAUneVisite={Boolean(lien?.visitId)} />
        : <SimpleReportEditor detail={detail} doctors={doctors} materiel={materiel} rattacheAUneVisite={Boolean(lien?.visitId)} />}
    </div>
  );
}
