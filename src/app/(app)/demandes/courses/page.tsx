import { redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireModule } from "@/lib/session";
import { userCan, hasGlobalView } from "@/lib/rbac";
import { getDriverMissions, getMissionAttachments } from "@/lib/queries/admin-requests";
import { PageHeader } from "@/components/shared/page-header";
import { CoursesBoard, type CourseDTO } from "./courses-board";
import { BackLink } from "@/components/shared/back-link";

/**
 * Espace « Courses » du bureau du secrétariat — EN LECTURE (Direction, 10/2026) : les missions
 * chauffeur ne se créent plus. Les courses déjà posées se suivent ici jusqu'à leur terme (le
 * chauffeur les mène depuis « Mes courses ») et peuvent encore être annulées.
 */
export default async function CoursesPage() {
  const user = await requireModule("ADMIN_REQUESTS");
  const canManage = hasGlobalView(user.role) || userCan(user, "ADMIN_REQUESTS", "UPDATE");
  if (!canManage) redirect("/demandes");

  const missions = await getDriverMissions(user);
  const attachments = await getMissionAttachments(missions.map((m) => m.id));

  const rows: CourseDTO[] = missions.map((m) => ({
    id: m.id,
    title: m.title,
    status: m.status,
    assignee: m.assignedTo?.name ?? null,
    deadline: m.deadline?.toISOString() ?? null,
    contactName: m.contactName,
    contactPhone: m.contactPhone,
    instructions: m.instructions,
    startLocation: m.startLocation,
    destination: m.destination,
    address: m.address,
    createdAt: m.createdAt.toISOString(),
    request: m.request ? { id: m.request.id, reference: m.request.reference } : null,
    stops: m.stops.map((s) => ({ id: s.id, location: s.location, task: s.task, done: s.done })),
    attachments: attachments.get(m.id) ?? [],
  }));

  return (
    <div className="space-y-5">
      <BackLink href="/demandes">
        <ArrowLeft className="h-4 w-4" /> Bureau du secrétariat
      </BackLink>
      <PageHeader title="Courses" description="Les courses déjà posées, jusqu'à leur terme." />
      <CoursesBoard courses={rows} />
    </div>
  );
}
