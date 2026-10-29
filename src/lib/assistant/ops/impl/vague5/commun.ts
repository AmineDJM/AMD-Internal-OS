/**
 * OPS VAGUE 5a — outils partagés par plusieurs familles : la personne retrouvée par son nom et
 * la décision (approuver / refuser) lue dans une saisie libre.
 */
import { prisma } from "./erp";
import { resolveOne } from "../../helpers";
import { fold } from "../../impl-regulatory";

export const resolvePerson = (raw: string, label = "la personne") =>
  resolveOne(raw, label,
    (q) => prisma.user.findMany({ where: { name: { contains: q, mode: "insensitive" }, isActive: true }, select: { id: true, name: true }, take: 6 }),
    (u) => u.name);

export const decisionOf = (raw: string): "APPROVE" | "REJECT" | null => {
  const k = fold(raw);
  if (/refus|rejet|reject/.test(k)) return "REJECT";
  if (/approuv|accord|valid|approve|accept/.test(k)) return "APPROVE";
  return null;
};
