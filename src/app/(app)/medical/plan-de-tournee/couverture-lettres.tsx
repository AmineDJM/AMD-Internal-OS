import { cn } from "@/lib/utils";
import { InfoBulle } from "@/components/ui/info-bulle";
import { couvertureParLettre } from "@/lib/sfe/couverture-lettres";
import type { Lettre } from "@/lib/segmentation/regles";
import { LettreBadge } from "@/app/(app)/segmentation/lettre-badge";

/**
 * « COUVERTURE DU PANEL PAR LETTRE » — en tête du plan (maquette du délégué, 24/11/2026). Rendu serveur, sans geste :
 * il dit, pour chaque lettre, ce que le plan prévoit face à ce que la fréquence de la segmentation demande par cycle.
 */
export function CouvertureLettres({ praticiens, paires }: {
  praticiens: readonly { id: string; lettre: Lettre | null; requis: number }[];
  paires: readonly string[];
}) {
  const lignes = couvertureParLettre(praticiens, paires);
  if (lignes.length === 0) return null;
  const prevues = lignes.reduce((s, l) => s + l.prevues, 0);
  const requises = lignes.reduce((s, l) => s + l.requises, 0);
  return (
    <section aria-labelledby="t-couv" className="surface space-y-3 p-3 sm:p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="t-couv" className="flex items-center gap-1 text-base font-semibold">
          Couverture du panel par lettre
          <InfoBulle label="D'où vient le requis" align="left">
            Le requis est la fréquence fixée par lettre dans la Segmentation, par cycle, pour chaque praticien de votre panel.
          </InfoBulle>
        </h2>
        <span className="text-xs text-muted-foreground">{prevues} visites prévues · {requises} requises par cycle</span>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {lignes.map((l) => (
          <div key={l.lettre} className="min-w-0 space-y-1.5 rounded-lg border border-border p-2.5">
            <p className="flex items-center gap-2">
              <LettreBadge lettre={l.lettre} className="h-5 min-w-[22px]" />
              <span className="text-sm font-semibold tabular-nums">{l.prevues} / {l.requises}</span>
            </p>
            <div className="h-2 w-full overflow-hidden rounded-full bg-secondary" aria-hidden>
              <div className={cn("h-full rounded-full", l.manque === 0 ? "bg-success" : l.pct >= 60 ? "bg-primary" : "bg-warning")} style={{ width: `${l.pct}%` }} />
            </div>
            <p className={cn("text-xs font-medium", l.manque === 0 ? "text-success" : "text-warning")}>{l.manque === 0 ? "couvert" : `il manque ${l.manque}`}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
