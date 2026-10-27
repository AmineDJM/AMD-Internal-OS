import Link from "next/link";
import { requireModule } from "@/lib/session";
import { userCan, scopeAdProOther } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { platformScope, getMyCompanies, companyOptions } from "@/lib/company";
import { toNumber, formatCurrency, formatDate } from "@/lib/utils";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { StatusBadge } from "@/components/shared/status-badge";
import { ModuleTabs } from "@/components/shared/module-tabs";
import { CreateRecordButton } from "@/components/shared/create-record-button";
import { PartagerButton } from "@/components/shared/partager-button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AD_PRO_OTHER_STATUS, EVENTS_TABS } from "@/lib/labels";
import { adProOtherCreateFields } from "@/lib/ad-pro/create-fields";
import { createAdProOtherRequest } from "@/lib/actions/ad-pro-other-actions";

export const dynamic = "force-dynamic";

/**
 * « AUTRE » — la nature qui manquait.
 *
 * Sans elle, une dépense de promotion inhabituelle se déclarait « en sponsoring » faute de mieux,
 * et l'on perdait deux choses : la lisibilité du sponsoring, qui se remplissait d'objets qui n'en
 * étaient pas, et la trace de la dépense, rangée sous une étiquette fausse.
 *
 * L'écran est volontairement court. Une nature dont on ne connaît pas le contenu ne peut pas
 * avoir de circuit prédéfini : elle a un demandeur, une décision, et un motif.
 */
export default async function AdProOtherPage() {
  const user = await requireModule("AD_PRO_OTHER");
  const canCreate = userCan(user, "AD_PRO_OTHER", "CREATE");

  const [requests, companies, businessUnits] = await Promise.all([
    prisma.adProOtherRequest.findMany({
      // Le délégué ne voit que SES demandes (portée ASSIGNÉE, 27/10/2026) — la même porte que la fiche.
      where: { AND: [await platformScope(user.id), scopeAdProOther(user)] },
      orderBy: { createdAt: "desc" },
      include: { company: { select: { name: true } } },
    }),
    getMyCompanies(user.id),
      // LES GAMMES ACTIVES — c'est le budget Ad&Pro de l'une d'elles que la demande engage.
    prisma.businessUnit.findMany({
      where: { isActive: true }, select: { id: true, name: true },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    }),
]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Autres demandes"
        description="Les demandes de promotion qui n'entrent dans aucune autre nature. Un demandeur, une description, une décision."
      >
        {canCreate && (
          <CreateRecordButton
            autoOpenParam="new"
            label="Nouvelle demande"
            title="Demande Ad & Pro — autre"
            description="Décrivez la demande : c'est sur cette description que la décision se prendra, puisqu'aucun formulaire ne la décrit pour nous."
            width="md"
            action={createAdProOtherRequest}
            redirectBase="/ad-pro/autres"
            fields={adProOtherCreateFields({ companies: companyOptions(companies), businessUnits })}
          />
        )}
      </PageHeader>

      <ModuleTabs tabs={EVENTS_TABS.map((t) => ({ label: t.label, href: t.href, show: userCan(user, t.module, "VIEW") }))} />

      {requests.length === 0 ? (
        <EmptyState
          icon="CircleEllipsis"
          title="Aucune demande"
          description={canCreate ? "Utilisez cette nature pour ce qui n'entre dans aucune autre — plutôt que de le déclarer sous une étiquette fausse." : "Les demandes apparaîtront ici."}
        />
      ) : (
        <div className="surface p-1.5 sm:p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Référence</TableHead>
                <TableHead>Objet</TableHead>
                <TableHead>Pour qui</TableHead>
                <TableHead className="text-right">Montant</TableHead>
                <TableHead>Statut</TableHead>
                <TableHead>Créée le</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {requests.map((r) => (
                <TableRow key={r.id} className="cursor-pointer">
                  <TableCell className="font-mono text-xs">
                    <Link href={`/ad-pro/autres/${r.id}`} className="hover:underline">{r.reference}</Link>
                  </TableCell>
                  <TableCell className="font-medium">
                    <Link href={`/ad-pro/autres/${r.id}`} className="hover:underline [overflow-wrap:anywhere]">{r.title}</Link>
                    {r.company && <div className="mt-0.5 text-xs text-muted-foreground">{r.company.name}</div>}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{r.beneficiary || "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.amount != null ? formatCurrency(toNumber(r.amount)) : "—"}</TableCell>
                  <TableCell><StatusBadge map={AD_PRO_OTHER_STATUS} value={r.status} dot={false} /></TableCell>
                  <TableCell className="text-muted-foreground">
                    <span className="flex items-center justify-end gap-2 whitespace-nowrap sm:justify-start">
                      {formatDate(r.createdAt.toISOString())}
                      <PartagerButton
                        iconOnly variant="ghost"
                        refType="AD_PRO_OTHER" refId={r.id}
                        refLabel={`${r.reference} — ${r.title}`}
                        href={`/ad-pro/autres/${r.id}`}
                      />
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
