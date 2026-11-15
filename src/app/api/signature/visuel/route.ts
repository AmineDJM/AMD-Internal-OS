import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { lireVisuel, type NatureVisuel } from "@/lib/signature-en-ligne/visuels";

/**
 * L'APERÇU DE MA SIGNATURE OU DE MON CACHET (15/11/2026) — à son seul propriétaire : `?nature=SIGNATURE|CACHET`. Aucune
 * personne ne lit l'image d'une autre ; une session en « Vue exacte » non plus.
 */
export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user || user.impersonatedBy) return new NextResponse(null, { status: 404 });
  const nature = req.nextUrl.searchParams.get("nature") === "CACHET" ? "CACHET" : "SIGNATURE";
  const png = await lireVisuel(user.id, nature as NatureVisuel);
  if (!png) return new NextResponse(null, { status: 404 });
  return new NextResponse(new Uint8Array(png), { headers: { "Content-Type": "image/png", "Cache-Control": "private, no-store" } });
}
