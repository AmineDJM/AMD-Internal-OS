import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireUser } from "@/lib/session";
import { hasGlobalView } from "@/lib/rbac";
import { canAccessEntity } from "@/lib/entity-access";
import { prisma } from "@/lib/prisma";
import { getCareDossier } from "@/lib/queries/care";
import { peutSaisirLesDevis } from "@/lib/care-devis-acces";
import { PageHeader } from "@/components/shared/page-header";
import { BackLink } from "@/components/shared/back-link";
import { DevisSollicitesPanel } from "@/components/care/devis-sollicites-panel";

/**
 * LA PAGE « DEVIS » D'UNE PRISE EN CHARGE (audit Assistante de direction, 10/2026) — par où l'assistante de direction,
 * à qui l'on a demandé les devis sans qu'elle ait le module des prises en charge, les saisit. C'est là que mènent la
 * notification « Devis à obtenir » et son sujet. Même porte que l'action (`peutSaisirLesDevis`).
 */
export async function PageDevisPriseEnCharge({ scope, id }: { scope: "NATIONAL" | "INTERNATIONAL"; id: string }) {
  const user = await requireUser();
  const module = scope === "NATIONAL" ? "CONGRESS_NATIONAL" : "CONGRESS_INTERNATIONAL";
  const req = scope === "NATIONAL"
    ? await prisma.congressNational.findUnique({ where: { id }, select: { id: true, name: true } })
    : await prisma.congressInternational.findUnique({ where: { id }, select: { id: true, name: true } });
  if (!req) notFound();
  if (!(await peutSaisirLesDevis(user, scope, id))) notFound();

  const care = await getCareDossier(scope, id);
  const ficheVisible = hasGlobalView(user) || (await canAccessEntity(user, module, id, "VIEW"));
  const retour = ficheVisible ? `${scope === "NATIONAL" ? "/congress-national" : "/congress-international"}/${id}` : "/dossiers";

  return (
    <div className="space-y-5">
      <BackLink href={retour}><ArrowLeft className="h-4 w-4" /> {ficheVisible ? "La demande" : "Mes sujets"}</BackLink>
      <PageHeader title={`Devis — ${req.name}`} description="Ce qui attend un devis, et chaque devis reçu : fournisseur, montant, ce qu'il couvre et son PDF." />
      <DevisSollicitesPanel
        scope={scope} requestId={id} mode={care.reglages.mode} taux={care.reglages.taux}
        beneficiaries={care.beneficiaries} quotes={care.quotes}
      />
    </div>
  );
}
