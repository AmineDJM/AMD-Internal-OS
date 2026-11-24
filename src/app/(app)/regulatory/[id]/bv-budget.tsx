import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { montantDzd } from "@/lib/utils";
import type { LigneEncadreBv } from "@/lib/budget-regulatory/bv-acceptes";

/**
 * LE BUDGET DU DOSSIER, SUR LA FICHE (Super Admin, 24/11/2026) — « branche le budget Regulatory directement au suivi
 * des dossiers ».
 *
 * Un encadré sobre : pour chaque BV, ce qui est demandé, ce qui est engagé (accepté, pas encore payé), ce qui est
 * consommé (payé), et l'enveloppe où il compte. Les chiffres viennent des mêmes lectures que la page Budget Regulatory
 * (`budget-bv-acceptes.ts`) : la fiche et le budget ne peuvent pas se contredire.
 */
export function BudgetBvCard({ lignes, lienBudget }: { lignes: LigneEncadreBv[]; lienBudget: boolean }) {
  const montant = (n: number | null) => (n === null ? "—" : montantDzd(n));
  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle>Budget</CardTitle>
        {lienBudget && (
          <Link href="/budget-regulatory/bv" className="text-xs text-primary hover:underline">Budget Regulatory →</Link>
        )}
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {lignes.map((l) => (
          <div key={l.nature} className="space-y-1 rounded-md border border-border px-3 py-2">
            <p className="font-medium">BV {l.nature} %</p>
            <dl className="grid grid-cols-3 gap-2 text-xs">
              <div className="min-w-0"><dt className="text-muted-foreground">Demandé</dt><dd className="font-medium [overflow-wrap:anywhere]">{montant(l.demande)}</dd></div>
              <div className="min-w-0"><dt className="text-muted-foreground">Engagé</dt><dd className="font-medium [overflow-wrap:anywhere]">{montant(l.engage)}</dd></div>
              <div className="min-w-0"><dt className="text-muted-foreground">Consommé</dt><dd className="font-medium [overflow-wrap:anywhere]">{montant(l.consomme)}</dd></div>
            </dl>
            <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
              {l.enveloppe
                ? <>Enveloppe : {l.enveloppe}</>
                : l.engage + l.consomme > 0
                  ? "Aucune enveloppe Regulatory ne couvre la date d'acceptation : ce BV n'est compté dans aucun budget."
                  : "Rien d'engagé pour l'instant."}
              {l.circuit === "ORDRE" && " · ancien circuit (ordre de dépense)"}
            </p>
            {l.prevision > 0 && (
              <p className="text-xs text-muted-foreground">Prévision : {montantDzd(l.prevision)} (3 × le BV 25 %), engagée au budget jusqu&apos;à l&apos;engagement du BV 75 % réel.</p>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
