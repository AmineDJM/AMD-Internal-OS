import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { clientIp, parseDevice } from "@/lib/device";
import { recordAudit } from "@/lib/audit";
import { notifyRoles } from "@/lib/notify";
import { sansBloquer } from "@/lib/journal";

const NO_CONTENT = new NextResponse(null, { status: 204 });

/**
 * Alerte de **tentative de capture d'écran** (compliance / fuite de données) : trace
 * QUI a tenté QUOI et OÙ (journal d'audit, module « Sécurité ») et **notifie les Super
 * Admins**. Débounce par utilisateur (30 s) pour éviter le spam. NB : le navigateur ne
 * peut pas EMPÊCHER une capture (le flou côté client est dissuasif) — mais on la journalise.
 */
const lastAlertByUser = new Map<string, number>();

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) return NO_CONTENT;

  let body: { path?: string; method?: string } = {};
  try { body = JSON.parse((await req.text()) || "{}"); } catch { return NO_CONTENT; }

  const userId = session.user.id;
  const now = Date.now();
  if (now - (lastAlertByUser.get(userId) ?? 0) < 30_000) return NO_CONTENT; // anti-spam serveur
  lastAlertByUser.set(userId, now);

  const path = String(body.path ?? "").slice(0, 200) || "?";
  const method = String(body.method ?? "capture").slice(0, 40);
  const who = session.user.name || session.user.email || userId;
  const ip = clientIp(req.headers);
  const { device, os, browser } = parseDevice(req.headers.get("user-agent"));

  await recordAudit({
    actorId: userId,
    action: "EXPORT", // exfiltration potentielle (capture d'écran)
    module: "Sécurité",
    summary: `⚠ Tentative de capture d'écran — ${who} (${method}) sur ${path} · ${device}/${os}/${browser}`,
    ipAddress: ip,
  });
  await notifyRoles(["SUPER_ADMIN"], {
    type: "GENERIC",
    title: "⚠ Tentative de capture d'écran",
    body: `${who} — ${path} (${method})`,
    link: "/admin",
  }).catch(sansBloquer("screenshot-attempt-route.POST.notifyRoles"));

  return NO_CONTENT;
}
