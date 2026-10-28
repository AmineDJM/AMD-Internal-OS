import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { PARTICIPANT_ROLE, REGISTRATION_STATUS } from "@/lib/labels";

export const dynamic = "force-dynamic";

const esc = (v: string | null | undefined) => `"${String(v ?? "").replace(/"/g, '""')}"`;

/** Export Excel/CSV de la liste des inscrits / présence. */
export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const user = await getCurrentUser();
  if (!user || !userCan(user, "EVENTS", "VIEW")) return new NextResponse(null, { status: 403 });

  const event = await prisma.event.findUnique({
    where: { id: params.id },
    select: { name: true, registrations: { orderBy: { lastName: "asc" } } },
  });
  if (!event) return new NextResponse(null, { status: 404 });

  const header = ["Nom", "Prénom", "Rôle", "Spécialité", "Établissement", "Ville", "Email", "Téléphone", "Statut", "Check-in"];
  const rows = event.registrations.map((r) =>
    [r.lastName, r.firstName, PARTICIPANT_ROLE[r.role] ?? r.role, r.specialty, r.institution, r.city, r.email, r.phone,
      REGISTRATION_STATUS[r.status]?.label ?? r.status, r.checkedInAt ? new Date(r.checkedInAt).toLocaleString("fr-FR") : ""]
      .map(esc).join(","),
  );
  const csv = "﻿" + [header.map(esc).join(","), ...rows].join("\r\n");

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`inscrits-${event.name}.csv`)}`,
      "Cache-Control": "private, no-store",
    },
  });
}
