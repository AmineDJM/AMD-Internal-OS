/**
 * OPS VAGUE 6a — outils partagés par plusieurs familles : la personne retrouvée par son nom et les
 * rôles nommés (libellé FR → rôle) pour désigner un destinataire.
 */
import { prisma } from "./erp";
import { ROLE_LABELS } from "@/lib/labels";

export async function userByName(raw: string): Promise<{ id: string; name: string } | { error: string }> {
  const q = raw.trim();
  if (!q) return { error: "Précisez la personne (nom)." };
  const rows = await prisma.user.findMany({
    where: { name: { contains: q, mode: "insensitive" }, isActive: true },
    select: { id: true, name: true }, take: 6,
  });
  if (rows.length === 1) return rows[0];
  if (rows.length === 0) return { error: `Aucun utilisateur actif « ${q} ».` };
  return { error: `Plusieurs personnes correspondent : ${rows.map((u) => u.name).join(", ")} — préciser.` };
}

export const ROLE_PAIRS: [string, string][] = Object.entries(ROLE_LABELS as Record<string, string>);
