import { NextResponse, type NextRequest } from "next/server";
import { identiteDuSondage, peutVoirLaMessagerie } from "@/lib/session-legere";
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
 *
 * L'identité est celle des SONDAGES (`session-legere.ts`, PERF-06) : jeton + session révocable + Vue
 * exacte, sans la matrice complète des droits — 2 requêtes au lieu de 11 par appel.
 */
export async function GET(req: NextRequest) {
  const user = await identiteDuSondage();
  if (!user || user.mustChangePassword) return NextResponse.json({ conversations: [], totalUnread: 0 }, { status: 200 });
  if (!(await peutVoirLaMessagerie(user))) return NextResponse.json({ conversations: [], totalUnread: 0 }, { status: 200 });

  // Tâches périodiques (rappels de réunion…) — débouncées à 1×/min, sans cron externe.
  void runScheduledJobs();

  await touchPresence(user.id);
  if (req.nextUrl.searchParams.get("portee") === "badge") {
    return NextResponse.json({ totalUnread: await getTotalUnread(user.id) }, { headers: { "Cache-Control": "private, no-store" } });
  }
  const payload = await getSync(user.id);
  return NextResponse.json(payload, { headers: { "Cache-Control": "private, no-store" } });
}
