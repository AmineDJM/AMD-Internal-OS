import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireModule } from "@/lib/session";
import { PageHeader } from "@/components/shared/page-header";
import { BlocHistorique } from "@/modules/ad-pro/ecrans/bloc-historique";
import { prisma } from "@/lib/prisma";
import { entityHref } from "@/lib/entity-href";
import { LIBELLE_TYPE_DEMANDE, type TypeDemandeIntegree } from "@/lib/budget-marketing/integration-2026";

export const dynamic = "force-dynamic";

const TYPES = Object.keys(LIBELLE_TYPE_DEMANDE) as TypeDemandeIntegree[];

/**
 * LA FICHE D'INTÉGRATION D'UNE DEMANDE — le bloc « Historique 2026 » seul (postes payés, pièces attendues / manquantes,
 * dépôt). Elle sert d'abord aux FORMATIONS, qui n'ont pas de fiche à elles ; les autres natures y renvoient aussi vers
 * leur fiche. Une demande qu'aucun lot actif ne porte n'a pas de fiche ici.
 */
export default async function FicheIntegrationPage(props: { params: Promise<{ type: string; id: string }> }) {
  const params = await props.params;
  const user = await requireModule("BUDGET_MARKETING");
  const type = params.type as TypeDemandeIntegree;
  if (!TYPES.includes(type)) notFound();
  const row = await prisma.adProIntegrationDemande.findFirst({ where: { demandeType: type, demandeId: params.id, lot: { annuleLe: null } }, select: { libelle: true, lot: { select: { envelopeId: true } } } });
  if (!row) notFound();
  const fiche = type === "TRAINING" ? null : entityHref(type, params.id);
  return (
    <div className="space-y-5">
      <Link href={`/budget-marketing/integration?env=${encodeURIComponent(row.lot.envelopeId)}`} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> Intégration Ad &amp; Pro 2026
      </Link>
      <PageHeader title={row.libelle} description={LIBELLE_TYPE_DEMANDE[type]}>
        {fiche && <Link href={fiche} className="text-sm text-primary hover:underline">Ouvrir la fiche de la demande</Link>}
      </PageHeader>
      <BlocHistorique user={user} type={type} id={params.id} />
    </div>
  );
}
