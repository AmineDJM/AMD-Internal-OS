import type { ReactNode } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowRight } from "lucide-react";
import { cn, formatCurrency } from "@/lib/utils";

/**
 * L'alerte « X DZD de dépenses non rangées » d'une vue d'ensemble de budget. Le lien mène à la liste « À imputer » — qui ne
 * vit que dans Budgets (`lienAImputerBudgets`) ; sans lien (la personne n'entre pas dans Budgets), elle informe seulement.
 */
export function AlerteAImputer({ href, total, action, className, children }: {
  href: string | null;
  total: number;
  action: string;
  className?: string;
  children: ReactNode;
}) {
  const classes = cn("flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-warning/40 bg-warning/5 px-3 py-2.5 text-sm sm:px-4", href && "transition hover:bg-warning/10", className);
  const corps = (
    <>
      <AlertTriangle className="h-4 w-4 shrink-0 text-warning" />
      <span className="min-w-0 flex-1 basis-[14rem]">
        <strong className="tabular-nums">{formatCurrency(total)}</strong> {children}
      </span>
      {href && <span className="inline-flex shrink-0 items-center gap-1 font-medium text-primary">{action} <ArrowRight className="h-3.5 w-3.5" /></span>}
    </>
  );
  return href ? <Link href={href} className={classes}>{corps}</Link> : <div className={classes}>{corps}</div>;
}
