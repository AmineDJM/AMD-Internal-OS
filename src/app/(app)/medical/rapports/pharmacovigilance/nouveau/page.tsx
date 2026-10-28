import { redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireUser } from "@/lib/session";
import { scopeMedicalDoctors } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { signaleDesCasPv } from "@/lib/pharmacovigilance/acces";
import { etablissementsPourSignalement, produitsPourSignalement } from "@/lib/pharmacovigilance/donnees";
import { CHEMIN_PV_KAM } from "@/lib/chemins/rapports-terrain";
import { PageHeader } from "@/components/shared/page-header";
import { BackLink } from "@/components/shared/back-link";
import { InfoBulle } from "@/components/ui/info-bulle";
import { SignalerCasForm } from "./signaler-form";

export const dynamic = "force-dynamic";

/**
 * SIGNALER UN CAS DE PHARMACOVIGILANCE — ouvert depuis le planning du KAM (Promotion médicale, Direction 07/10) : le
 * bouton au-dessus du plan, ou la cellule d'un praticien. Venu d'une cellule (`?praticien=<id>`), le formulaire arrive
 * avec le médecin et son établissement — relus ICI, dans le périmètre de la personne : l'adresse ne porte qu'un
 * identifiant, jamais un nom qu'on pourrait forger. Le déclarant est la session (l'action l'écrit).
 */
export default async function SignalerCasPvPage(props: { searchParams?: Promise<{ praticien?: string }> }) {
  const searchParams = await props.searchParams;
  const user = await requireUser();
  if (!signaleDesCasPv(user)) redirect(CHEMIN_PV_KAM);
  const praticienId = typeof searchParams?.praticien === "string" ? searchParams.praticien : null;
  const [produits, etablissements, praticien] = await Promise.all([
    produitsPourSignalement(user.id),
    etablissementsPourSignalement(),
    praticienId
      ? prisma.medicalDoctor.findFirst({
          where: { AND: [{ id: praticienId }, scopeMedicalDoctors(user)] },
          select: { name: true, institutionId: true },
        })
      : Promise.resolve(null),
  ]);
  // L'établissement n'est prérempli que s'il figure dans la liste offerte : sinon le choix serait invisible.
  const institutionId = praticien?.institutionId && etablissements.some((e) => e.id === praticien.institutionId) ? praticien.institutionId : "";
  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <BackLink href={CHEMIN_PV_KAM}><ArrowLeft className="h-4 w-4" /> Mes signalements</BackLink>
      <PageHeader title="Signaler un cas de pharmacovigilance">
        <InfoBulle label="Ce qui se passe ensuite">
          Effet indésirable, défaut de qualité, erreur médicamenteuse : le produit, l&apos;établissement, la date et ce qui
          s&apos;est passé. Regulatory est prévenu aussitôt.
        </InfoBulle>
      </PageHeader>
      <SignalerCasForm
        produits={produits}
        etablissements={etablissements}
        aujourdhui={new Date().toISOString().slice(0, 10)}
        initial={{ doctorName: praticien?.name ?? "", institutionId }}
      />
    </div>
  );
}
