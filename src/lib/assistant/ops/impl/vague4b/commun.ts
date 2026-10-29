/**
 * OPS VAGUE 4b — outils partagés par plusieurs familles : le format de date du jour et les
 * résolutions par nom de la personne et du praticien.
 */
import { prisma } from "./erp";
import { resolveOne } from "../../helpers";

export const day = (d: Date | null | undefined): string | null => (d ? d.toISOString().slice(0, 10) : null);

export const resolvePerson = (raw: string, label = "la personne") =>
  resolveOne(raw, label,
    (q) => prisma.user.findMany({ where: { name: { contains: q, mode: "insensitive" }, isActive: true }, select: { id: true, name: true }, take: 6 }),
    (u) => u.name);

export const resolveDoctor = (raw: string) =>
  resolveOne(raw, "le praticien (champ « doctor » — son nom)",
    (q) => prisma.medicalDoctor.findMany({
      where: { name: { contains: q, mode: "insensitive" } },
      select: { id: true, name: true, specialty: true, institution: true }, take: 6,
    }),
    (d) => `${d.name}${d.specialty ? ` (${d.specialty})` : ""}${d.institution ? ` — ${d.institution}` : ""}`);
