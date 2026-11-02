import { prisma } from "./prisma";
import { sansBloquer } from "@/lib/journal";

export interface GeoInfo {
  country?: string;
  city?: string;
  region?: string;
}

function isPrivate(ip: string): boolean {
  return (
    ip.startsWith("127.") ||
    ip.startsWith("10.") ||
    ip.startsWith("192.168.") ||
    ip.startsWith("::1") ||
    ip === "::" ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
    ip.startsWith("169.254.")
  );
}

/** Best-effort IP geolocation via ipwho.is (HTTPS, free, no key). */
export async function geolocate(ip: string | null | undefined): Promise<GeoInfo> {
  if (!ip || isPrivate(ip)) return {};
  try {
    const res = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}`, {
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) return {};
    const j = (await res.json()) as {
      success?: boolean;
      country?: string;
      city?: string;
      region?: string;
    };
    if (j.success === false) return {};
    return { country: j.country, city: j.city, region: j.region };
  } catch {
    return {};
  }
}

/** Enrich a session row with geolocation in the background (fire-and-forget). */
export function enrichSessionGeo(sessionId: string, ip: string | null): void {
  void geolocate(ip).then((geo) => {
    if (geo.country || geo.city) {
      prisma.userSession
        .update({
          where: { id: sessionId },
          data: { country: geo.country, city: geo.city },
        })
        .catch(sansBloquer("geo.enrichSessionGeo.userSession"));
    }
  });
}
