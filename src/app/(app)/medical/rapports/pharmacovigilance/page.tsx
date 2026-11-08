import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft, ShieldAlert } from "lucide-react";
import { requireUser } from "@/lib/session";
import { signaleDesCasPv, voitTousLesCasPv } from "@/lib/pharmacovigilance/acces";
import { compteursCasPv, listerCasPv } from "@/lib/pharmacovigilance/donnees";
import { STATUTS_PV, STATUT_PV } from "@/lib/pharmacovigilance/regles";
import { CHEMIN_PV_KAM, CHEMIN_RAPPORTS_TERRAIN, lienSignalerPv } from "@/lib/chemins/rapports-terrain";
import { PageHeader } from "@/components/shared/page-header";
import { BackLink } from "@/components/shared/back-link";
import { EmptyState } from "@/components/shared/empty-state";
import { ListeCasPv } from "@/app/(app)/regulatory/pharmacovigilance/liste-cas";

export const dynamic = "force-dynamic";

/**
 * « MES SIGNALEMENTS » — les cas de pharmacovigilance que le KAM a signalés (Direction, 06/10), sous Promotion médicale ›
 * Rapports : il suit leur statut et répond aux demandes de Regulatory sans quitter son module.
 */
export default async function MesSignalementsPvPage() {
  const user = await requireUser();
  const voitTout = voitTousLesCasPv(user);
  if (!signaleDesCasPv(user) && !voitTout) redirect(CHEMIN_RAPPORTS_TERRAIN);
  const [cas, compteurs] = await Promise.all([
    listerCasPv(user, { seulementLesMiens: true }),
    compteursCasPv(user, true),
  ]);
  const enquetes = compteurs.ENQUETE;

  return (
    <div className="space-y-5">
      <BackLink href={CHEMIN_RAPPORTS_TERRAIN}><ArrowLeft className="h-4 w-4" /> Rapports</BackLink>
      <PageHeader title="Mes signalements de pharmacovigilance">
        {signaleDesCasPv(user) && (
          <Link href={lienSignalerPv()} className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90">
            <ShieldAlert className="h-4 w-4" /> Signaler un cas
          </Link>
        )}
        {voitTout && <Link href="/regulatory/pharmacovigilance" className="text-sm text-primary hover:underline">Tous les cas (Regulatory)</Link>}
      </PageHeader>

      {enquetes > 0 && (
        <p className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
          {enquetes} cas en enquête — chez vous : répondez dans l&apos;échange.
        </p>
      )}

      <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
        {STATUTS_PV.map((s) => <span key={s} className="rounded-full bg-secondary px-2.5 py-1">{STATUT_PV[s].label} : {compteurs[s]}</span>)}
      </div>

      {cas.length === 0 ? (
        <EmptyState icon="ShieldAlert" title="Aucun signalement" description="Un effet indésirable, un défaut de qualité, une erreur médicamenteuse rapportés lors d'une visite ? Signalez-le à Regulatory." />
      ) : (
        <ListeCasPv cas={cas} base={CHEMIN_PV_KAM} avecDeclarant={false} lecteur={{ userId: user.id, superAdmin: user.role === "SUPER_ADMIN" }} />
      )}
    </div>
  );
}
