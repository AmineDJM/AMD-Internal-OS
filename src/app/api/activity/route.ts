import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { clientIp, parseDevice } from "@/lib/device";
import { sansBloquer } from "@/lib/journal";

const NO_CONTENT = new NextResponse(null, { status: 204 });

/** Receives page-view beacons: { path, durationMs }. Enriched with device/IP
 * and the geolocation already resolved on the user's session (no extra lookup). */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NO_CONTENT;

  let body: { path?: string; durationMs?: number; lat?: number; lng?: number; accuracy?: number; dev?: string } = {};
  try {
    body = JSON.parse((await req.text()) || "{}");
  } catch {
    return NO_CONTENT;
  }

  const path = String(body.path ?? "").slice(0, 200);
  if (!path || path.startsWith("/api")) return NO_CONTENT;
  const duration = Number(body.durationMs);
  const durationMs = Number.isFinite(duration) && duration > 0 ? Math.min(Math.round(duration), 86_400_000) : null;

  const ua = req.headers.get("user-agent");
  const ip = clientIp(req.headers);
  const { device, os, browser } = parseDevice(ua);
  const moduleKey = path.split("/").filter(Boolean)[0] ?? null;

  // Precise browser geolocation (consented) takes precedence over IP geolocation.
  const lat = Number(body.lat);
  const lng = Number(body.lng);
  const acc = Number(body.accuracy);
  const hasGeo = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  const devHint = body.dev ? String(body.dev).slice(0, 60) : null;

  let country: string | null = null;
  let city: string | null = null;
  if (session.user.sid) {
    const s = await prisma.userSession
      .findUnique({ where: { id: session.user.sid }, select: { country: true, city: true } })
      .catch(sansBloquer("activity-route.POST.userSession", null));
    country = s?.country ?? null;
    city = s?.city ?? null;
  }

  await prisma.activityLog
    .create({
      data: {
        userId: session.user.id, type: "PAGE_VIEW", path, module: moduleKey,
        durationMs, ipAddress: ip, country, city,
        latitude: hasGeo ? lat : null,
        longitude: hasGeo ? lng : null,
        accuracy: hasGeo && Number.isFinite(acc) ? acc : null,
        geoSource: hasGeo ? "gps" : country ? "ip" : null,
        device: devHint ? `${device} · ${devHint}` : device,
        os, browser, userAgent: ua,
      },
    })
    .catch(sansBloquer("activity-route.POST.activityLog"));

  return NO_CONTENT;
}
