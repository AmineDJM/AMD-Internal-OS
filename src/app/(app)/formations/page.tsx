import { GraduationCap } from "lucide-react";
import { requireUser } from "@/lib/session";
import { userCan, hasGlobalView, isTopManagement } from "@/lib/rbac";
import { loadReportingLine } from "@/lib/departments";
import { managementChainOf } from "@/lib/hr/reporting-line";
import { canDecideChain, type ChainStage } from "@/lib/approval-chain";
import { auNomDeQui } from "@/lib/hr/stand-in-resolve";
import { prisma } from "@/lib/prisma";
import { clauseFormationsVisibles } from "@/lib/queries/visibilite-listes";
import { toNumber } from "@/lib/utils";
import { PageHeader } from "@/components/shared/page-header";
import { KpiCard } from "@/components/shared/kpi-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils";
import { countParticipants, type TrainingAttendance, type TrainingParticipantState } from "@/lib/training";
import { TrainingBoard, type TrainingRow } from "./training-board";
import { refusAnnulationFormation } from "@/lib/annulations/regles";

export const dynamic = "force-dynamic";
export const metadata = { title: "Formations — AMD Internal OS" };

/**
 * FORMATIONS — les demandes des salariés et les sessions organisées par les RH, au même endroit.
 *
 * Deux origines, un seul objet : une formation à financer et à suivre. Les séparer en deux
 * écrans aurait dédoublé le budget, les pièces et l'historique — et obligé la direction à
 * arbitrer dans deux files distinctes ce qui sort du même budget.
 */
export default async function FormationsPage(props: { searchParams: Promise<{ formation?: string }> }) {
  const searchParams = await props.searchParams;
  const user = await requireUser();
  const isHr = userCan(user, "TRAINING", "VALIDATE") || userCan(user, "TRAINING", "UPDATE");
  const isDg = hasGlobalView(user);
  const canOrganise = isHr || isDg;

  // UNE CLAUSE, lue aussi par la porte des pièces (`canAccessEntity` › TRAINING) : la page montrait
  // toutes les formations de la société à tout salarié (audit 360°, S4).
  const trainings = await prisma.training.findMany({
    where: await clauseFormationsVisibles(user),
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    take: 200,
    include: {
      requester: { select: { id: true, name: true } },
      department: { select: { name: true } },
      participants: {
        include: { user: { select: { id: true, name: true } } },
        orderBy: { createdAt: "asc" },
      },
    },
  });

  // QUI TRANCHE — LA MÊME RÈGLE QUE L'ACTION (`decideTraining`), lue ici sans requête par ligne
  // (audit 360°, I12). La page ne comptait comme N+1 que les personnes dont la fiche porte
  // `managerId = moi` : un responsable de DÉPARTEMENT — le N+1 réel de ceux qui n'ont pas de
  // responsable nommé — n'avait jamais le bouton que l'action lui aurait accordé. La chaîne se lit
  // sur l'organigramme réel (`managementChainOf`), et le sommet par `isTopManagement`, DG compris.
  const { employees, departments: organigramme } = await loadReportingLine();
  const employeDuCompte = new Map(employees.filter((e) => e.userId).map((e) => [e.userId as string, e.id]));
  const monEmploye = employeDuCompte.get(user.id) ?? null;
  // LES FICHES AU NOM DESQUELLES JE TRANCHE : la mienne, et celle de chaque absent que je remplace
  // (I18) — la même lecture que l'action (`deciderFor`), sans quoi le bouton manquerait à qui l'a.
  const auNom = await auNomDeQui(user.id);
  const mesFiches = new Set([...auNom.ids].map((id) => employeDuCompte.get(id)).filter((x): x is string => Boolean(x)));
  const auDessusDe = (requesterId: string | null): boolean => {
    if (!requesterId || mesFiches.size === 0) return false;
    const sujet = employeDuCompte.get(requesterId);
    return sujet ? managementChainOf(sujet, employees, organigramme).some((m) => mesFiches.has(m.employeeId)) : false;
  };
  const sommet = isTopManagement(user);

  const docs = trainings.length
    ? await prisma.document.findMany({
        where: { entityType: "TRAINING", entityId: { in: trainings.map((t) => t.id) } },
        select: { id: true, name: true, entityId: true },
      })
    : [];
  const docsByTraining = new Map<string, { id: string; name: string }[]>();
  for (const d of docs) {
    const arr = docsByTraining.get(d.entityId) ?? [];
    arr.push({ id: d.id, name: d.name });
    docsByTraining.set(d.entityId, arr);
  }

  const rows: TrainingRow[] = trainings.map((t) => {
    const participants = t.participants.map((p) => ({
      id: p.id,
      userId: p.userId,
      name: p.user?.name ?? "",
      attendance: p.attendance as TrainingAttendance,
      state: p.state as TrainingParticipantState,
    }));
    // « Peut trancher » est calculé ici, côté serveur : un bouton affiché par erreur est une
    // promesse que le serveur refusera.
    const isManager = (t.managerId != null && mesFiches.has(t.managerId)) || auDessusDe(t.requesterId);
    const canDecide = canDecideChain(
      { status: t.status === "PENDING" ? "PENDING" : "APPROVED", stage: t.stage as ChainStage, requesterUserId: t.requesterId },
      { id: user.id, isManager, isHr, isDg: sommet },
    ).ok;
    return {
      id: t.id,
      reference: t.reference,
      title: t.title,
      origin: t.origin as "EMPLOYEE" | "HR",
      status: t.status as TrainingRow["status"],
      stage: t.stage as TrainingRow["stage"],
      provider: t.provider,
      description: t.description,
      location: t.location,
      startDate: t.startDate ? t.startDate.toISOString() : null,
      endDate: t.endDate ? t.endDate.toISOString() : null,
      amount: toNumber(t.amount),
      amountGranted: t.amountGranted === null ? null : toNumber(t.amountGranted),
      requester: t.requester?.name ?? "",
      requesterId: t.requesterId,
      department: t.department?.name ?? null,
      participants,
      documents: docsByTraining.get(t.id) ?? [],
      canDecide,
      canCancel: t.requesterId === user.id && refusAnnulationFormation(t.status) === null,
      myParticipation: participants.find((p) => p.userId === user.id) ?? null,
    };
  });

  const pending = rows.filter((r) => r.status === "PENDING");
  const approved = rows.filter((r) => r.status === "APPROVED");
  const engaged = approved.reduce((a, r) => a + (r.amountGranted ?? r.amount), 0);
  const awaitingMe = rows.filter((r) => r.canDecide).length;
  const myInvites = rows.filter((r) => r.myParticipation?.state === "INVITED" && r.myParticipation.attendance === "VOLUNTARY").length;

  const people = canOrganise
    ? await prisma.user.findMany({ where: { isActive: true }, select: { id: true, name: true }, orderBy: { name: "asc" } })
    : [];
  const departments = canOrganise
    ? await prisma.department.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } })
    : [];

  return (
    <div className="space-y-5">
      <PageHeader
        title="Formations"
        description="Chacun peut demander une formation — elle monte responsable (N+1) → ressources humaines → direction. Les RH en organisent aussi, y invitent des participants (convoqués ou volontaires) et y attachent des postes (salle, traiteur…) validés un par un par la direction."
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiCard label="En validation" value={pending.length} icon="Hourglass" tone={pending.length > 0 ? "warning" : "default"} />
        <KpiCard label="À trancher par vous" value={awaitingMe} icon="ShieldCheck" tone={awaitingMe > 0 ? "warning" : "default"} />
        <KpiCard label="Accordées" value={approved.length} icon="GraduationCap" tone="success" hint={formatCurrency(engaged)} />
        <KpiCard label="Invitations à répondre" value={myInvites} icon="MailQuestion" tone={myInvites > 0 ? "info" : "default"} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <GraduationCap className="h-4 w-4 text-primary" /> Formations ({rows.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          <TrainingBoard
            rows={rows}
            canOrganise={canOrganise}
            isDg={isDg}
            people={people}
            departments={departments}
            counts={rows.map((r) => countParticipants(r.participants))}
            formationAOuvrir={searchParams.formation ?? null}
          />
        </CardContent>
      </Card>
    </div>
  );
}
