import { requireModule } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/shared/page-header";
import { ModuleTabs } from "@/components/shared/module-tabs";
import { visibleTabs } from "@/lib/nav-tabs";
import { AGENDA_TABS } from "@/lib/labels";
import { NewMeetingButton } from "../meetings/new-meeting-button";
import {
  monthGrid, getCalendarEvents, getUpcomingEvents, algiersInputToUtc, algiersTodayYmd,
} from "@/lib/calendar";
import { CalendarView } from "./calendar-view";

export const dynamic = "force-dynamic";

export default async function CalendarPage(props: { searchParams: Promise<{ y?: string; m?: string }> }) {
  const searchParams = await props.searchParams;
  const user = await requireModule("WORKSPACE");

  const [ty, tm] = algiersTodayYmd().split("-").map(Number);
  const year = Number(searchParams.y) || ty;
  const month = (Number(searchParams.m) >= 1 && Number(searchParams.m) <= 12 ? Number(searchParams.m) : tm) - 1; // 0-based

  const grid = monthGrid(year, month);
  // Fenêtre UTC couvrant la grille affichée (jours d'Alger).
  const from = algiersInputToUtc(`${grid[0].ymd}T00:00`)!;
  const to = new Date(algiersInputToUtc(`${grid[grid.length - 1].ymd}T00:00`)!.getTime() + 86400000);

  const canMeet = userCan(user, "MESSAGING", "CREATE");
  const [events, upcoming, users, invitees] = await Promise.all([
    getCalendarEvents(user, from, to),
    getUpcomingEvents(user, 8),
    prisma.user.findMany({ where: { isActive: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    // PLANIFIER UNE RÉUNION DEPUIS L'AGENDA. Les réunions planifiées se projettent déjà dans la
    // grille : les créer ailleurs obligeait à changer d'écran pour poser un créneau qu'on est
    // justement en train de regarder.
    canMeet
      ? prisma.user.findMany({ where: { isActive: true, id: { not: user.id } }, select: { id: true, name: true, title: true }, orderBy: { name: "asc" } })
      : Promise.resolve([] as { id: string; name: string; title: string | null }[]),
  ]);

  const canCreate = userCan(user, "WORKSPACE", "CREATE");

  return (
    <div className="space-y-5">
      <PageHeader title="Agenda" description="Vos rendez-vous, réunions et informations importantes — au fuseau d'Alger. Créez des rendez-vous, invitez vos collègues, planifiez une réunion. L'assistant IA peut aussi le faire pour vous.">
        {canMeet && <NewMeetingButton users={invitees} />}
      </PageHeader>
      <ModuleTabs tabs={await visibleTabs(user, AGENDA_TABS)} />
      <CalendarView
        year={year}
        month={month}
        grid={grid}
        events={events}
        upcoming={upcoming}
        users={users}
        currentUserId={user.id}
        canCreate={canCreate}
      />
    </div>
  );
}
