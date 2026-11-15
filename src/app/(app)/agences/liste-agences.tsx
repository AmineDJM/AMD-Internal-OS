import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { EmptyState } from "@/components/shared/empty-state";
import { LIBELLE_ETAPE_FILE, type LigneFileAgence } from "@/modules/ad-pro/api";

/**
 * UNE FILE DU PARCOURS AGENCE — d'abord ce qui est À VOUS, puis le reste, chaque ligne avec son étape en clair et un seul lien.
 * Utilisée par « Prospection d'agences » (assistante, Direction Marketing) et « Contrôles de conformité » (information médicale).
 */
export function ListeAgences({ lignes, vide, action }: { lignes: LigneFileAgence[]; vide: string; action: string }) {
  if (lignes.length === 0) return <EmptyState icon="CircleCheck" title={vide} />;
  const aMoi = lignes.filter((l) => l.aMoi);
  const autres = lignes.filter((l) => !l.aMoi);
  const bloc = (titre: string, ls: LigneFileAgence[], accent: boolean) => ls.length > 0 && (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold">{titre} <span className="font-normal text-muted-foreground">({ls.length})</span></h2>
      <ul className="space-y-2">
        {ls.map((l) => (
          <li key={l.itemId}>
            <Link href={l.lien} className={`flex flex-wrap items-center gap-3 rounded-xl border p-3 hover:bg-secondary/50 ${accent ? "border-primary/40 bg-primary/[0.03]" : "border-border bg-card"}`}>
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{l.label} <span className="font-normal text-muted-foreground">· {l.nature}</span></span>
                <span className="block text-xs text-muted-foreground">{l.ref}{l.assistante ? ` · ${l.assistante}` : ""} · depuis le {new Date(l.depuis).toLocaleDateString("fr-FR")}</span>
                {l.cahierDesCharges && <span className="mt-1 block text-xs [overflow-wrap:anywhere]">{l.cahierDesCharges.slice(0, 160)}</span>}
              </span>
              <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${accent ? "bg-primary text-primary-foreground" : "bg-secondary text-foreground"}`}>{LIBELLE_ETAPE_FILE[l.etape]}</span>
              {accent && <span className="inline-flex items-center gap-1 text-sm font-medium text-primary">{action} <ArrowRight className="h-4 w-4" /></span>}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
  return (
    <div className="space-y-5">
      {bloc("À vous", aMoi, true)}
      {bloc("En cours ailleurs", autres, false)}
    </div>
  );
}
