import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { getCareDossier } from "../../infra/requetes/prise-en-charge";
import { peutSaisirLesDevis } from "../../infra/prise-en-charge/devis-acces";
import { PageHeader } from "@/components/shared/page-header";
import { DevisSollicitesPanel } from "./devis-sollicites-panel";
import { RetourPriseEnCharge } from "./retour-prise-en-charge";

/**
 * LA PAGE « DEVIS » D'UNE PRISE EN CHARGE (audit Assistante de direction, 10/2026) — par où l'assistante de direction,
 * à qui l'on a demandé les devis sans qu'elle ait le module des prises en charge, les saisit. C'est là que mènent la
 * notification « Devis à obtenir » et son sujet. Même porte que l'action (`peutSaisirLesDevis`).
 */
export async function PageDevisPriseEnCharge({ scope, id }: { scope: "NATIONAL" | "INTERNATIONAL"; id: string }) {
  const user = await requireUser();
  const req = scope === "NATIONAL"
    ? await prisma.congressNational.findUnique({ where: { id }, select: { id: true, name: true } })
    : await prisma.congressInternational.findUnique({ where: { id }, select: { id: true, name: true } });
  if (!req) notFound();
  if (!(await peutSaisirLesDevis(user, scope, id))) notFound();

  const care = await getCareDossier(scope, id);

  return (
    <div className="space-y-5">
      <RetourPriseEnCharge user={user} scope={scope} id={id} />
      <PageHeader title={`Devis — ${req.name}`} description="Ce qui attend un devis, et chaque devis reçu : fournisseur, montant, ce qu'il couvre et son PDF." />
      <DevisSollicitesPanel
        scope={scope} requestId={id} mode={care.reglages.mode} taux={care.reglages.taux}
        beneficiaries={care.beneficiaries} quotes={care.quotes}
      />
    </div>
  );
}
