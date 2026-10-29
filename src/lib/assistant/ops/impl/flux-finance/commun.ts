/**
 * OPS FLUX FINANCIERS — outils partagés par plusieurs familles : lecture d'un nombre saisi, ordre
 * de dépense et ligne budgétaire retrouvés par référence ou libellé.
 */
import { prisma } from "./erp";
import { toNumber } from "@/lib/utils";
import { dzd, resolveOne } from "../../helpers";

export const num = (input: Record<string, unknown>, key: string): number | null => {
  const v = input[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v.replace(/[\s  ]/g, "").replace(",", "."));
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

/** Un ordre de dépense par référence OD-… ou libellé (statuts bornés si fournis). */
export async function resolveOrder(raw: string, statuses?: string[]) {
  const q = raw.trim();
  if (!q) return { error: "Précisez la référence (OD-…) ou le libellé de l'ordre de dépense." } as const;
  const rows = await prisma.expenseOrder.findMany({
    where: {
      ...(statuses ? { status: { in: statuses as never } } : {}),
      OR: [
        { reference: { equals: q, mode: "insensitive" } },
        { label: { contains: q, mode: "insensitive" } },
        { beneficiary: { contains: q, mode: "insensitive" } },
      ],
    },
    select: {
      id: true, reference: true, label: true, amount: true, beneficiary: true, status: true,
      deferredUntil: true,
    },
    orderBy: { createdAt: "desc" },
    take: 6,
  });
  if (rows.length === 0) return { error: `Aucun ordre de dépense « ${q} »${statuses ? ` à l'état ${statuses.join("/")}` : ""}.` } as const;
  const exact = rows.filter((r) => r.reference.toLowerCase() === q.toLowerCase());
  if (exact.length === 1) return exact[0];
  if (rows.length === 1) return rows[0];
  return { error: `Plusieurs ordres correspondent à « ${q} » : ${rows.map((r) => `${r.reference} — ${r.label} (${dzd(toNumber(r.amount))})`).join(" ; ")} — donner la référence exacte.` } as const;
}

