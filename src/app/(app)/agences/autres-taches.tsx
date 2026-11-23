import Link from "next/link";
import { ArrowRight } from "lucide-react";
import type { GroupeAutresTaches } from "@/lib/queries/autres-taches-assistante";

/**
 * « VOS AUTRES TÂCHES » (23/11/2026) — ce que l'assistante de direction faisait ailleurs dans Ad & Pro, sur sa page : une
 * famille par bloc, compte à l'appui, la plus ancienne d'abord, et UN geste par ligne vers une page qu'elle ouvre.
 */
export function AutresTaches({ groupes }: { groupes: GroupeAutresTaches[] }) {
  if (groupes.length === 0) return null;
  const total = groupes.reduce((s, g) => s + g.lignes.length, 0);
  return (
    <section className="space-y-3" aria-label="Vos autres tâches">
      <div>
        <h2 className="text-sm font-semibold">Vos autres tâches <span className="font-normal text-muted-foreground">({total})</span></h2>
        <p className="text-xs text-muted-foreground">Hors prospection : bons de commande, devis, matériel promotionnel, billets et hôtels.</p>
      </div>
      {groupes.map((g) => (
        <div key={g.cle} className="space-y-1.5">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{g.titre} ({g.lignes.length})</h3>
          <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
            {g.lignes.map((l) => (
              <li key={l.cle}>
                <Link href={l.href} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-sm hover:bg-secondary/50">
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium [overflow-wrap:anywhere]">{l.titre}</span>
                    <span className="block text-xs text-muted-foreground">
                      {l.detail}{l.depuis ? ` · depuis le ${new Date(l.depuis).toLocaleDateString("fr-FR")}` : ""}
                    </span>
                  </span>
                  <span className="inline-flex items-center gap-1 font-medium text-primary">{l.geste} <ArrowRight className="h-4 w-4" /></span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
