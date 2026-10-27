import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { touchPresence } from "@/lib/messaging";
import { getSync, getTotalUnread } from "@/lib/queries/messaging";
import { runScheduledJobs } from "@/lib/scheduled";

export const dynamic = "force-dynamic";

/**
 * Polling de la liste des conversations + badge de non-lus, et heartbeat de présence.
 *
 * `?portee=badge` : le BADGE de la barre supérieure (chaque onglet, toutes les 12 s) ne lit que le
 * total — une requête de comptage, sans la liste des conversations, leurs membres ni leurs aperçus
 * que seul le Messenger affiche (audit performance PERF-02). Même total que `getSync` : non-lus
 * hors conversations en sourdine.
 */
export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user || user.mustChangePassword) return NextResponse.json({ conversations: [], totalUnread: 0 }, { status: 200 });
  if (!userCan(user, "MESSAGING", "VIEW")) return NextResponse.json({ conversations: [], totalUnread: 0 }, { status: 200 });

  // Tâches périodiques (rappels de réunion…) — débouncées à 1×/min, sans cron externe.
  void runScheduledJobs();

  await touchPresence(user.id);
  if (req.nextUrl.searchParams.get("portee") === "badge") {
    return NextResponse.json({ totalUnread: await getTotalUnread(user.id) }, { headers: { "Cache-Control": "private, no-store" } });
  }
  const payload = await getSync(user.id);
  return NextResponse.json(payload, { headers: { "Cache-Control": "private, no-store" } });
}
