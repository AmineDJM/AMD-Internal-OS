import { requireModule } from "@/lib/session";
import { userCan, hasGlobalView } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { getRequestList } from "@/lib/queries/admin-requests";
import { faitsDesDemandes } from "@/lib/queries/demandes-tableau";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { toNumber } from "@/lib/utils";
import { NewRequestButton } from "./new-request";
import { statutAffiche } from "@/lib/secretariat/traitement";
import { chezQuiDeLaDemande, montantDeLaDemande } from "@/lib/secretariat/bureau";
import { SuppliesManager } from "./supplies-manager";
import { type ExpenseAckItem } from "./expense-ack";
import { RequestsTable, type RequestRow } from "./requests-table";
import { RaccourcisBureau } from "./raccourcis";

/**
 * LE BUREAU DU SECRÉTARIAT — le tableau général (maquette validée, 10/2026).
 *
 * « Une ligne = une demande, avec où elle en est et chez qui. » En tête, « Catalogue fournitures » et
 * « + Nouvelle demande » ; puis des TUILES qui comptent ET filtrent (à traiter, en cours, en
 * validation, en paiement, en retard, terminées sur 30 jours) ; les raccourcis vers les écrans
 * annexes qui attendent quelque chose (notes de frais à réceptionner, courses en cours, corbeille) ;
 * enfin le tableau : référence, demande, demandeur, créée, échéance, chez qui, UN montant
 * (`montantDeLaDemande`, sa précédence documentée), pièces, statut. La ligne entière ouvre la fiche.
 */
export default async function DemandesPage({ searchParams }: { searchParams: { status?: string; type?: string } }) {
  const user = await requireModule("ADMIN_REQUESTS");
  const isManager = hasGlobalView(user.role) || userCan(user, "ADMIN_REQUESTS", "UPDATE");

  const [list, users, departments, activeArticles, supplyCatalog, expensePendingAck, coursesEnCours] = await Promise.all([
    getRequestList(user, { status: searchParams.status, type: searchParams.type }),
    prisma.user.findMany({ where: { isActive: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.department.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.officeSupplyArticle.findMany({ where: { active: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    isManager
      ? prisma.officeSupplyArticle.findMany({ select: { id: true, name: true, category: true, unit: true, reference: true, estimatedPrice: true, supplierHint: true, active: true, notes: true }, orderBy: [{ active: "desc" }, { name: "asc" }] })
      : Promise.resolve([] as { id: string; name: string; category: string | null; unit: string | null; reference: string | null; estimatedPrice: unknown; supplierHint: string | null; active: boolean; notes: string | null }[]),
    // Notes de frais dont les originaux n'ont pas encore été réceptionnés par le secrétariat.
    isManager
      ? prisma.hrDocumentRequest.findMany({
          where: { type: "EXPENSE_REPORT", originalsAckAt: null, status: { not: "REJECTED" } },
          include: { employee: { select: { fullName: true } } },
          orderBy: { createdAt: "asc" },
          take: 50,
        })
      : Promise.resolve([]),
    isManager ? prisma.driverMission.count({ where: { status: { notIn: ["DONE", "CANCELLED"] } } }) : Promise.resolve(0),
  ]);

  const ackItems: ExpenseAckItem[] = expensePendingAck.map((r) => ({
    id: r.id, employeeName: r.employee.fullName, expenseMonth: r.expenseMonth, createdAt: r.createdAt.toISOString(),
  }));
  const catalogRows = supplyCatalog.map((a) => ({ ...a, estimatedPrice: a.estimatedPrice != null ? toNumber(a.estimatedPrice) : null }));
  const faits = await faitsDesDemandes(list.rows.map((r) => ({ id: r.id, fields: r.fields })));

  const rows: RequestRow[] = list.rows.map((r) => {
    // Une étape retirée (en attente d'un tiers, d'un document, bloquée à la main) se lit « En cours ».
    const status = statutAffiche(r.status, r.blockedReason);
    const f = faits.get(r.id);
    const chez = chezQuiDeLaDemande({
      statut: status, responsable: r.assignedTo?.name ?? null, demandeur: r.requester?.name ?? null,
      validateurEnAttente: r.approvals[0]?.validator?.name ?? r.validator?.name ?? null,
      bc: f?.bc ?? null, devisARetenir: f?.devisARetenir ?? false,
    });
    const montant = f ? montantDeLaDemande(f.faits) : null;
    return {
      id: r.id,
      reference: r.reference,
      title: r.title,
      type: r.type,
      priority: r.priority,
      status,
      createdAt: r.createdAt.toISOString(),
      deadline: r.deadline ? r.deadline.toISOString() : null,
      completedAt: r.completedAt ? r.completedAt.toISOString() : null,
      requester: r.requester?.name ?? null,
      department: r.department?.name ?? null,
      chez,
      montant: montant?.montant ?? null,
      montantEtape: montant?.etape ?? null,
      pieces: f?.nbPieces ?? 0,
      batch: Boolean(r.batchId),
    };
  });

  return (
    <div className="space-y-4">
      <PageHeader
        title="Bureau du secrétariat"
        description="Les demandes transverses : déplacements, courriers, signatures, achats, devis, paiements, invités. Une ligne = une demande, avec où elle en est et chez qui."
      >
        {isManager && <SuppliesManager articles={catalogRows} />}
        <NewRequestButton users={users} departments={departments} articles={activeArticles} />
      </PageHeader>

      {isManager && <RaccourcisBureau notesDeFrais={ackItems} coursesEnCours={coursesEnCours} />}

      {rows.length === 0 ? (
        <EmptyState icon="ClipboardList" title="Aucune demande" description="Créez une nouvelle demande administrative." />
      ) : (
        <RequestsTable maintenant={Date.now()} rows={rows} totaux={{ ouvertes: list.ouvertes, terminees: list.terminees, terminesMontrees: list.terminesMontrees, coupe: list.coupe }} />
      )}
    </div>
  );
}
