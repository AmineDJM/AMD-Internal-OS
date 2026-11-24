import Link from "next/link";
import { FileText } from "lucide-react";
import { formatCurrency } from "@/lib/utils";
import { LIBELLE_ETAPE_BC, type EtapeBC } from "@/lib/bons-de-commande/regle";
import type { PosteDeclare } from "@/modules/ad-pro/api";

const CONFORMITE: Record<string, { libelle: string; ton: string }> = {
  EN_CONTROLE: { libelle: "BAT en contrôle", ton: "text-warning" },
  CONFORME: { libelle: "BAT conforme", ton: "" },
  NON_CONFORME: { libelle: "BAT non conforme", ton: "text-destructive" },
};

/**
 * « POSTES DÉCLARÉS » (Direction, 23/11/2026) — ce que le dossier déclare à l'ANPP : chaque poste, son montant, l'agence ou
 * le bénéficiaire, son bon de commande et où il en est, la conformité de son BAT, ses pièces. Une pièce Legal (devis, BC,
 * facture) ne s'ouvre qu'à qui sa porte l'ouvre (`ouvrables`) ; sinon sa référence se lit, sans lien.
 */
export function PostesDeclares({ postes, ouvrables }: { postes: PosteDeclare[]; ouvrables: ReadonlySet<string> }) {
  if (postes.length === 0) return <p className="text-sm text-muted-foreground">Aucun poste soumis sur la demande.</p>;
  const total = postes.reduce((t, p) => t + (p.montant ?? 0), 0);
  return (
    <div className="space-y-2">
      <ul className="divide-y divide-border rounded-lg border border-border">
        {postes.map((p) => {
          const conf = p.conformite.requise ? CONFORMITE[p.conformite.statut ?? ""] ?? { libelle: "BAT à recevoir", ton: "text-muted-foreground" } : null;
          return (
            <li key={p.id} className="grid grid-cols-1 gap-2 p-3 text-sm sm:grid-cols-[minmax(0,1fr)_auto]">
              <div className="min-w-0 space-y-1">
                <p className="font-medium [overflow-wrap:anywhere]">
                  <Link href={p.lien} className="hover:underline">{p.label}</Link>
                  <span className="font-normal text-muted-foreground"> · {p.nature} · {p.statut}</span>
                </p>
                <p className="text-xs text-muted-foreground">
                  {p.payee ? `Agence / bénéficiaire : ${p.payee}` : "Agence / bénéficiaire : —"}
                  {" · "}
                  {p.bc ? `BC ${p.bc.reference ?? "sans référence"} — ${p.bc.etape ? LIBELLE_ETAPE_BC[p.bc.etape as EtapeBC] ?? p.bc.etape : "hors circuit"}` : "Sans bon de commande"}
                  {conf && <> · <span className={conf.ton}>{conf.libelle}</span>{p.conformite.note ? ` (« ${p.conformite.note} »)` : ""}</>}
                </p>
                {(p.pieces.length > 0 || p.fichiers.length > 0) && (
                  <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
                    {p.pieces.map((pc) => {
                      const premier = pc.fichiers[0];
                      const titre = `${pc.type}${pc.reference ? ` ${pc.reference}` : ""}`;
                      return (
                        <li key={`${pc.type}-${pc.legalId}`} className="inline-flex items-center gap-1">
                          <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                          {premier && ouvrables.has(pc.legalId)
                            ? <a href={`/api/documents/${premier.id}`} target="_blank" rel="noreferrer" className="text-primary hover:underline">{titre}</a>
                            : <span className="text-muted-foreground">{titre}</span>}
                        </li>
                      );
                    })}
                    {p.fichiers.map((f) => (
                      <li key={f.id} className="inline-flex min-w-0 items-center gap-1">
                        <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <a href={`/api/documents/${f.id}`} target="_blank" rel="noreferrer" className="truncate text-primary hover:underline">{f.nature} — {f.nom}</a>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <p className="font-medium tabular-nums sm:text-right">{p.montant != null ? formatCurrency(p.montant) : "—"}</p>
            </li>
          );
        })}
      </ul>
      <p className="text-right text-xs text-muted-foreground">Total des postes : <span className="font-medium tabular-nums text-foreground">{formatCurrency(total)}</span></p>
    </div>
  );
}
