import { NextRequest, NextResponse } from "next/server";
import { entetesAntiExecution } from "@/lib/http/types-actifs";
import { getCurrentUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { getBlob } from "@/lib/drive-storage";
import { canViewMeeting } from "@/lib/meetings";

export const dynamic = "force-dynamic";

/** Sert une pièce jointe d'un message de réunion — réservé à l'organisateur et aux participants. */
export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const user = await getCurrentUser();
  if (!user) return new NextResponse(null, { status: 403 });

  const att = await prisma.meetingMessageAttachment.findUnique({
    where: { id: params.id },
    select: {
      blobId: true, name: true, mime: true,
      message: { select: { meeting: { select: { organizerId: true, participants: { select: { userId: true } } } } } },
    },
  });
  if (!att) return new NextResponse(null, { status: 404 });

  if (!canViewMeeting(user, att.message.meeting)) return new NextResponse(null, { status: 403 });

  const bytes = await getBlob(att.blobId);
  if (!bytes) return new NextResponse(null, { status: 404 });
  const dl = req.nextUrl.searchParams.get("dl") === "1";
  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "Content-Type": att.mime || "application/octet-stream",
      // Un type actif (HTML, SVG, XML) s'affiche sans jamais s'exécuter dans l'ERP (`lib/http/types-actifs.ts`).
      ...entetesAntiExecution(att.mime || "application/octet-stream"),
      "Content-Disposition": `${dl ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(att.name)}`,
      "Content-Length": String(bytes.length),
      "Cache-Control": "private, no-store",
    },
  });
}
