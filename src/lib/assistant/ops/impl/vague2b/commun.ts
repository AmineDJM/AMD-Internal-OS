/**
 * OPS VAGUE 2b — outil partagé par plusieurs familles : la personne retrouvée par son nom
 * (utilisateurs actifs, ambiguïté listée).
 */
import { prisma } from "./erp";
import { resolveOne } from "../../helpers";

export const resolvePerson = (raw: string) =>
  resolveOne(raw, "la personne",
    (q) => prisma.user.findMany({ where: { name: { contains: q, mode: "insensitive" }, isActive: true }, select: { id: true, name: true }, take: 6 }),
    (u) => u.name);
