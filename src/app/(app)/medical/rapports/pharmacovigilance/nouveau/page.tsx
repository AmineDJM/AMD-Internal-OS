import { redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireUser } from "@/lib/session";
import { hasGlobalView, scopeMedicalDoctors } from "@/lib/rbac";
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
 *
 * Venu du COMPTE RENDU d'une visite (`?visite=<id>` — le lien de la notification « votre compte rendu évoque peut-être
 * un effet indésirable »), le cas se RATTACHE à la visite : son médecin, sa date et la phrase que l'IA a relevée arrivent
 * préremplis. Seulement la visite de la personne : celle d'un autre ne préremplit rien (l'action la refuserait).
 */
export default async function SignalerCasPvPage(props: { searchParams?: Promise<{ praticien?: string; visite?: string; produit?: string; date?: string }> }) {
  const searchParams = await props.searchParams;
  const user = await requireUser();
  if (!signaleDesCasPv(user)) redirect(CHEMIN_PV_KAM);
  // LA VISITE À RATTACHER (compte rendu) : relue dans le périmètre de la personne.
  const visiteId = typeof searchParams?.visite === "string" ? searchParams.visite : null;
  const visite = visiteId
    ? await prisma.medicalVisit.findFirst({
        where: { id: visiteId, ...(hasGlobalView(user) ? {} : { delegateId: user.id }) },
        select: { id: true, date: true, doctorId: true, pvIaExtrait: true, doctor: { select: { name: true } } },
      })
    : null;
  const praticienId = typeof searchParams?.praticien === "string" ? searchParams.praticien : visite?.doctorId ?? null;
  const produitCanonique = typeof searchParams?.produit === "string" ? searchParams.produit : null;
  const aujourdhui = new Date().toISOString().slice(0, 10);
  // LE JOUR DE LA VISITE (11/2026) : une date lisible, jamais dans le futur — sinon le formulaire repart d'aujourd'hui.
  const dateLue = typeof searchParams?.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(searchParams.date) && searchParams.date <= aujourdhui
    ? searchParams.date : undefined;
  const date = dateLue ?? (visite ? visite.date.toISOString().slice(0, 10) : undefined);
  const [produits, etablissements, praticien, promus] = await Promise.all([
    produitsPourSignalement(user.id),
    etablissementsPourSignalement(),
    praticienId
      ? prisma.medicalDoctor.findFirst({
          where: { AND: [{ id: praticienId }, scopeMedicalDoctors(user)] },
          select: { name: true, institutionId: true },
        })
      : Promise.resolve(null),
    // LE PRODUIT COCHÉ DANS LA VISITE est un produit canonique ; le formulaire liste les produits PROMUS qui le portent.
    produitCanonique
      ? prisma.promoProduct.findMany({ where: { productId: produitCanonique, isActive: true }, select: { id: true } })
      : Promise.resolve([] as { id: string }[]),
  ]);
  // Prérempli seulement s'il figure dans la liste offerte (le premier « des miens » d'abord) : sinon le choix serait invisible.
  const offerts = new Set(promus.map((p) => p.id));
  const produitId = produits.find((p) => offerts.has(p.id))?.id;
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
      {visite && (
        <p className="rounded-lg border border-border bg-secondary/40 px-3 py-2 text-sm">
          Rattaché à votre visite du {visite.date.toLocaleDateString("fr-FR")}{visite.doctor?.name ? ` — ${visite.doctor.name}` : ""} :
          le cas apparaîtra sur son compte rendu.
        </p>
      )}
      <SignalerCasForm
        produits={produits}
        etablissements={etablissements}
        aujourdhui={aujourdhui}
        initial={{
          doctorName: praticien?.name ?? visite?.doctor?.name ?? "", institutionId,
          ...(produitId ? { produitId } : {}), ...(date ? { date } : {}),
          ...(visite ? { visitId: visite.id, description: visite.pvIaExtrait ?? "" } : {}),
        }}
      />
    </div>
  );
}
