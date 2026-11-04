"use client";

import * as React from "react";
import { Loader2, Search, FileText, AlertTriangle } from "lucide-react";
import { Input } from "@/components/ui/input";
import { natureLegale } from "@/lib/labels/juridique";
import { documentsLegalPourDemande } from "@/modules/finances/actions-pieces-paiement";
import type { DocumentLegalPropose } from "@/modules/finances/partage";

/**
 * « CHOISIR DANS LEGAL » (Direction, 04/11/2026) — la pièce d'une demande de paiement est souvent déjà au registre :
 * la facture reçue, le BC signé, le devis retenu. On la choisit au lieu de la redéposer. La liste est celle que la
 * personne voit dans Legal ; une facture déjà demandée, envoyée au règlement ou réglée est montrée, avec sa raison,
 * et ne se choisit pas.
 */
export function ChoisirDansLegal({ dejaChoisis, onChoisir }: {
  dejaChoisis: readonly string[];
  onChoisir: (doc: DocumentLegalPropose) => void;
}) {
  const [recherche, setRecherche] = React.useState("");
  const [docs, setDocs] = React.useState<DocumentLegalPropose[] | null>(null);
  const [charge, setCharge] = React.useState(false);

  React.useEffect(() => {
    let vivant = true;
    const t = setTimeout(async () => {
      setCharge(true);
      const fd = new FormData();
      if (recherche.trim()) fd.set("recherche", recherche.trim());
      try {
        const r = await documentsLegalPourDemande(fd);
        if (vivant) setDocs(r);
      } catch {
        if (vivant) setDocs([]);
      } finally {
        if (vivant) setCharge(false);
      }
    }, recherche ? 300 : 0);
    return () => { vivant = false; clearTimeout(t); };
  }, [recherche]);

  const dzd = (n: number) => `${n.toLocaleString("fr-FR", { maximumFractionDigits: 2 })} DZD`;

  return (
    <div className="space-y-2 rounded-lg border border-border bg-background p-2.5">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={recherche} onChange={(e) => setRecherche(e.target.value)} className="pl-8"
          placeholder="Chercher par fournisseur, référence ou titre" aria-label="Chercher dans Legal"
        />
      </div>
      {docs === null || (charge && docs.length === 0) ? (
        <p className="flex items-center gap-2 px-1 py-3 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Recherche dans Legal…</p>
      ) : docs.length === 0 ? (
        <p className="px-1 py-3 text-xs text-muted-foreground">
          Aucun document Legal à proposer{recherche ? " pour cette recherche" : ""} — factures, BC, devis et contrats munis d&apos;un fichier, que vous voyez dans Legal. Ajoutez la pièce depuis votre poste.
        </p>
      ) : (
        <ul className="max-h-72 space-y-1 overflow-y-auto">
          {docs.map((d) => {
            const choisi = dejaChoisis.includes(d.id);
            const bloque = Boolean(d.refus) || choisi;
            return (
              <li key={d.id}>
                <button
                  type="button" disabled={bloque} onClick={() => onChoisir(d)}
                  title={d.refus ?? (choisi ? "Déjà joint à cette demande." : undefined)}
                  className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-secondary/40 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{d.titre}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {[natureLegale(d.kind), d.partie, d.reference, d.montant != null ? dzd(d.montant) : null, d.date].filter(Boolean).join(" · ")}
                    </span>
                    {d.avertissement && (
                      <span className="mt-0.5 flex items-center gap-1 text-xs text-warning">
                        <AlertTriangle className="h-3 w-3" /> {d.avertissement}{d.refus ? " Elle ne peut pas être demandée à nouveau." : ""}
                      </span>
                    )}
                  </span>
                  {choisi && <span className="shrink-0 text-xs text-muted-foreground">Jointe</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
