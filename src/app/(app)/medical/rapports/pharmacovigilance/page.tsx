import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft, ShieldAlert } from "lucide-react";
import { requireUser } from "@/lib/session";
import { signaleDesCasPv, voitTousLesCasPv } from "@/lib/pharmacovigilance/acces";
import { compteursCasPv, listerCasPv } from "@/lib/pharmacovigilance/donnees";
import { STATUTS_PV, STATUT_PV, estStatutPv } from "@/lib/pharmacovigilance/regles";
import { CHEMIN_PV_KAM, CHEMIN_RAPPORTS_TERRAIN, lienSignalerPv } from "@/lib/chemins/rapports-terrain";
import { PageHeader } from "@/components/shared/page-header";
import { BackLink } from "@/components/shared/back-link";
import { EmptyState } from "@/components/shared/empty-state";
import { ModuleTabs } from "@/components/shared/module-tabs";
import { visibleTabs } from "@/lib/nav-tabs";
import { MEDICAL_TABS } from "@/lib/labels";
import { cn } from "@/lib/utils";
import { ListeCasPv } from "@/app/(app)/regulatory/pharmacovigilance/liste-cas";

export const dynamic = "force-dynamic";

/**
 * « MES SIGNALEMENTS » — les cas de pharmacovigilance que le KAM a signalés (Direction, 06/10), sous Promotion médicale ›
 * Rapports : il suit leur statut et répond aux demandes de Regulatory sans quitter son module.
 */
export default async function MesSignalementsPvPage(props: { searchParams?: Promise<{ etat?: string }> }) {
  const searchParams = await props.searchParams;
  const user = await requireUser();
  const voitTout = voitTousLesCasPv(user);
  if (!signaleDesCasPv(user) && !voitTout) redirect(CHEMIN_RAPPORTS_TERRAIN);
  // LE FILTRE PAR ÉTAT (interface du délégué, 24/11/2026) : les compteurs deviennent les filtres — un clic, la liste suit.
  const etat = estStatutPv(searchParams?.etat) ? searchParams.etat : null;
  const [cas, compteurs, tabs] = await Promise.all([
    listerCasPv(user, { seulementLesMiens: true, statut: etat }),
    compteursCasPv(user, true),
    visibleTabs(user, MEDICAL_TABS),
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
      <ModuleTabs tabs={tabs} />

      {enquetes > 0 && (
        <p className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
          {enquetes} cas en enquête — chez vous : répondez dans l&apos;échange.
        </p>
      )}

      <nav aria-label="Filtrer par état" className="flex flex-wrap gap-1.5 text-sm">
        {[null, ...STATUTS_PV].map((s) => (
          <Link
            key={s ?? "tous"} href={s ? `${CHEMIN_PV_KAM}?etat=${s}` : CHEMIN_PV_KAM} aria-current={etat === s ? "page" : undefined}
            className={cn("inline-flex h-9 items-center rounded-full border px-3", etat === s ? "border-primary bg-primary/10 font-medium text-primary" : "border-input text-muted-foreground hover:bg-secondary")}
          >
            {s ? `${STATUT_PV[s].label} · ${compteurs[s]}` : "Tous"}
          </Link>
        ))}
      </nav>

      {cas.length === 0 && etat ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">Aucun signalement dans cet état.</p>
      ) : cas.length === 0 ? (
        <EmptyState icon="ShieldAlert" title="Aucun signalement" description="Un effet indésirable, un défaut de qualité, une erreur médicamenteuse rapportés lors d'une visite ? Signalez-le à Regulatory." />
      ) : (
        <ListeCasPv cas={cas} base={CHEMIN_PV_KAM} avecDeclarant={false} lecteur={{ userId: user.id, superAdmin: user.role === "SUPER_ADMIN" }} />
      )}
    </div>
  );
}
