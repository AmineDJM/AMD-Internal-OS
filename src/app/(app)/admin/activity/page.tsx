import { ArrowLeft } from "lucide-react";
import { requireModule } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/shared/page-header";
import { KpiCard } from "@/components/shared/kpi-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ActivityTable, type ActivityRow } from "./activity-table";
import { BackLink } from "@/components/shared/back-link";

function fmtDuration(ms: number | null): { label: string; value: number } {
  if (!ms) return { label: "—", value: 0 };
  const s = Math.round(ms / 1000);
  if (s < 60) return { label: `${s}s`, value: s };
  const m = Math.floor(s / 60);
  return { label: `${m}m ${s % 60}s`, value: s };
}

export default async function ActivityPage() {
  await requireModule("ADMIN");
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const [logs, pageViews, logins, todayUsers, totalTime] = await Promise.all([
    prisma.activityLog.findMany({ orderBy: { createdAt: "desc" }, take: 500, include: { user: { select: { name: true } } } }),
    prisma.activityLog.count({ where: { type: "PAGE_VIEW" } }),
    prisma.activityLog.count({ where: { type: "LOGIN" } }),
    prisma.activityLog.findMany({ where: { createdAt: { gte: startOfDay } }, select: { userId: true }, distinct: ["userId"] }),
    prisma.activityLog.aggregate({ _sum: { durationMs: true } }),
  ]);

  const rows: ActivityRow[] = logs.map((l) => {
    const d = fmtDuration(l.durationMs);
    const gps = l.latitude != null && l.longitude != null;
    const location = gps
      ? `GPS ${l.latitude!.toFixed(4)}, ${l.longitude!.toFixed(4)}${l.accuracy ? ` (±${Math.round(l.accuracy)} m)` : ""}`
      : [l.city, l.country].filter(Boolean).join(", ");
    return {
      id: l.id, user: l.user?.name ?? "—", type: l.type, path: l.path ?? "",
      device: l.device ?? "—", browser: l.browser ?? "—", os: l.os ?? "—",
      location, ip: l.ipAddress ?? "",
      lat: gps ? l.latitude! : null, lng: gps ? l.longitude! : null,
      duration: d.label, durationValue: d.value, createdAt: l.createdAt.toISOString(),
    };
  });

  const totalMinutes = Math.round((totalTime._sum.durationMs ?? 0) / 60000);

  return (
    <div className="space-y-5">
      <BackLink href="/admin">
        <ArrowLeft className="h-4 w-4" /> Retour à l’administration
      </BackLink>
      <PageHeader title="Activité & traçabilité" description="Connexions, pages visitées, temps passé, appareils et localisation." />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiCard label="Pages vues" value={pageViews} icon="MousePointerClick" tone="info" />
        <KpiCard label="Connexions" value={logins} icon="LogIn" tone="success" />
        <KpiCard label="Utilisateurs (aujourd’hui)" value={todayUsers.length} icon="Users" />
        <KpiCard label="Temps cumulé" value={`${totalMinutes} min`} icon="Timer" />
      </div>

      <Card>
        <CardHeader><CardTitle>Journal d’activité détaillé</CardTitle></CardHeader>
        <CardContent><ActivityTable rows={rows} /></CardContent>
      </Card>
    </div>
  );
}
