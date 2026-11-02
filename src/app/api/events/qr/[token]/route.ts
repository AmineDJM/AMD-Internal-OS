import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { qrPng } from "@/lib/qr";

export const dynamic = "force-dynamic";

/**
 * Image QR d'un participant (publique : le jeton est non devinable et le QR ne
 * fait qu'encoder l'URL de check-in, elle-même protégée). Permet d'afficher le
 * badge sur la page d'inscription et dans la liste des inscrits.
 */
export async function GET(req: NextRequest, props: { params: Promise<{ token: string }> }) {
  const params = await props.params;
  const reg = await prisma.eventRegistration.findUnique({
    where: { qrToken: params.token },
    select: { eventId: true },
  });
  if (!reg) return new NextResponse(null, { status: 404 });

  const url = `${req.nextUrl.origin}/events/${reg.eventId}/checkin?token=${params.token}`;
  const png = await qrPng(url);
  return new NextResponse(new Uint8Array(png), {
    headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=3600" },
  });
}
