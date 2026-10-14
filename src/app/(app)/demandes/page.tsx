import { requireModule } from "@/lib/session";
import { userCan, hasGlobalView } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { getRequestList } from "@/lib/queries/admin-requests";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { toNumber } from "@/lib/utils";
import { NewRequestButton } from "./new-request";
import { statutAffiche } from "@/lib/secretariat/traitement";
import { SuppliesManager } from "./supplies-manager";
import { ExpenseAckList, type ExpenseAckItem } from "./expense-ack";
import { RequestsTable, type RequestRow } from "./requests-table";
import { OngletsBureau } from "@/components/reservation-fiche/onglets-bureau";
import { BureauAdPro } from "@/components/reservation-fiche/bureau-adpro";
import { compteurBureauAdPro, voitBureauAdPro } from "@/lib/queries/reservations-fiches";

/**
 * LE BUREAU DU SECRÉTARIAT — les demandes, et rien qu'elles.
 *
 * L'en-tête portait six boutons (Bureau de Donna, Validations, Courses, Missions, Corbeille…) et
 * une rangée d'onglets de statut : la page ressemblait à un standard téléphonique, et la liste —
 * la seule chose qu'on vient chercher — commençait sous deux étages de navigation. Les écrans
 * annexes restent servis à leurs adresses (`/demandes/courses`, `/demandes/driver`,
 * `/demandes/approvals`…) : on y arrive par les liens des demandes et les notifications, pas par
 * une barre de boutons permanente. Le tri se fait maintenant DANS les colonnes du tableau.
 */
export default async function DemandesPage({ searchParams }: { searchParams: { status?: string; type?: string; onglet?: string; fiche?: string } }) {
  const user = await requireModule("ADMIN_REQUESTS");
  const isManager = hasGlobalView(user.role) || userCan(user, "ADMIN_REQUESTS", "UPDATE");
  // LES ONGLETS « Général » / « Ad & Pro » (14/10) — l'onglet Ad & Pro est celui de l'assistante de direction.
  const compteurAdPro = voitBureauAdPro(user) ? await compteurBureauAdPro(user) : null;
  const onglet = compteurAdPro !== null && searchParams.onglet === "adpro" ? "adpro" : "general";

  const [list, users, departments, activeArticles, supplyCatalog, expensePendingAck] = await Promise.all([
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
  ]);

  const ackItems: ExpenseAckItem[] = expensePendingAck.map((r) => ({
    id: r.id, employeeName: r.employee.fullName, expenseMonth: r.expenseMonth, createdAt: r.createdAt.toISOString(),
  }));

  const catalogRows = supplyCatalog.map((a) => ({ ...a, estimatedPrice: a.estimatedPrice != null ? toNumber(a.estimatedPrice) : null }));

  const rows: RequestRow[] = list.rows.map((r) => ({
    id: r.id,
    reference: r.reference,
    title: r.title,
    type: r.type,
    priority: r.priority,
    // Une étape retirée (en attente d'un tiers, d'un document, bloquée à la main) se lit « En cours ».
    status: statutAffiche(r.status, r.blockedReason),
    deadline: r.deadline ? r.deadline.toISOString() : null,
    assignedTo: r.assignedTo?.name ?? null,
    batch: Boolean(r.batchId),
  }));

  return (
    <div className="space-y-5">
      <PageHeader title="Bureau du secrétariat" description="Centre de traitement des demandes transverses de l'entreprise. Filtrez directement dans les colonnes du tableau.">
        {isManager && <SuppliesManager articles={catalogRows} />}
        <NewRequestButton users={users} departments={departments} articles={activeArticles} />
      </PageHeader>

      {compteurAdPro !== null && <OngletsBureau actif={onglet} general={list.ouvertes} adpro={compteurAdPro} />}

      {onglet === "adpro" ? <BureauAdPro user={user} fiche={searchParams.fiche ?? null} /> : (<>
      {isManager && <ExpenseAckList items={ackItems} />}

      {rows.length === 0 ? (
        <EmptyState icon="ClipboardList" title="Aucune demande" description="Créez une nouvelle demande administrative." />
      ) : (
        <RequestsTable rows={rows} totaux={{ ouvertes: list.ouvertes, terminees: list.terminees, terminesMontrees: list.terminesMontrees, coupe: list.coupe }} />
      )}
      </>)}
    </div>
  );
}
