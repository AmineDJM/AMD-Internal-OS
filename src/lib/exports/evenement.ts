import type { CurrentUser } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { PARTICIPANT_ROLE, REGISTRATION_STATUS } from "@/lib/labels";
import { estIdentifiant } from "./filtres";
import { exporte, MIME_CSV, refusExport, type ResultatExport } from "./types";

const esc = (v: string | null | undefined) => `"${String(v ?? "").replace(/"/g, '""')}"`;

/**
 * LA LISTE DES INSCRITS D'UN ÉVÉNEMENT (présence, check-in), en CSV — partagée par `/api/events/[id]/export` et
 * l'Assistant IA (lot K7, décision 0037), qui désigne l'événement par son nom (le plus récent qui correspond).
 */
export async function exporterInscritsEvenement(user: CurrentUser, designation: string): Promise<ResultatExport> {
  if (!userCan(user, "EVENTS", "VIEW")) return refusExport(403, "Non autorisé.");
  const t = designation.trim();
  const id = !t ? null : estIdentifiant(t) ? t : (await prisma.event.findFirst({
    where: { name: { contains: t, mode: "insensitive" } }, orderBy: [{ startDate: "desc" }, { createdAt: "desc" }], select: { id: true },
  }))?.id ?? null;
  const event = id ? await prisma.event.findUnique({ where: { id }, select: { name: true, registrations: { orderBy: { lastName: "asc" } } } }) : null;
  if (!event) return refusExport(404, "Événement introuvable.");

  const header = ["Nom", "Prénom", "Rôle", "Spécialité", "Établissement", "Ville", "Email", "Téléphone", "Statut", "Check-in"];
  const rows = event.registrations.map((r) =>
    [r.lastName, r.firstName, PARTICIPANT_ROLE[r.role] ?? r.role, r.specialty, r.institution, r.city, r.email, r.phone,
      REGISTRATION_STATUS[r.status]?.label ?? r.status, r.checkedInAt ? new Date(r.checkedInAt).toLocaleString("fr-FR") : ""]
      .map(esc).join(","),
  );
  const csv = "﻿" + [header.map(esc).join(","), ...rows].join("\r\n");
  await recordAudit({ actorId: user.id, action: "EXPORT", module: "Événements", summary: `Export des inscrits « ${event.name} » (${rows.length})` });
  return exporte(csv, `inscrits-${event.name}.csv`, MIME_CSV, `les ${rows.length} inscrit(s) de « ${event.name} »`);
}
