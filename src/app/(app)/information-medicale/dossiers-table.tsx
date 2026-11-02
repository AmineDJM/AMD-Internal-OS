"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input, Select } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn, formatCurrency, plier } from "@/lib/utils";

/** Une ligne du registre, déjà lue côté serveur — la pastille, le produit, le délai. */
export interface LigneDossier {
  id: string;
  reference: string;
  label: string;
  nature: string;
  detail: string | null;
  circuit: "EVENT" | "PROMO";
  produit: { nom: string; id: string | null; autres: number } | null;
  montant: number | null;
  pastille: string;
  ton: "neutral" | "info" | "success" | "warning" | "danger" | "purple";
  jours: number | null;
  delai: "normal" | "attention" | "retard";
  valide: boolean;
}

const DELAI_CLASSE: Record<LigneDossier["delai"], string> = {
  normal: "",
  attention: "font-medium text-warning",
  retard: "font-semibold text-destructive",
};

export function DossiersTable({ lignes }: { lignes: LigneDossier[] }) {
  const router = useRouter();
  const [q, setQ] = React.useState("");
  const [circuit, setCircuit] = React.useState<"" | "EVENT" | "PROMO">("");
  const [archives, setArchives] = React.useState(false);

  const nbValides = lignes.filter((l) => l.valide).length;
  const visibles = React.useMemo(() => {
    const cle = plier(q.trim());
    return lignes.filter((l) => {
      if (!archives && l.valide) return false;
      if (circuit && l.circuit !== circuit) return false;
      if (!cle) return true;
      return plier(`${l.reference} ${l.label} ${l.produit?.nom ?? ""} ${l.nature}`).includes(cle);
    });
  }, [lignes, q, circuit, archives]);

  return (
    <Card>
      <div className="flex flex-col gap-2 border-b border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-sm font-semibold">Dossiers</h2>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-0 flex-1 sm:w-56 sm:flex-none">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              type="search" value={q} onChange={(e) => setQ(e.target.value)}
              placeholder="Réf., événement, produit…" aria-label="Rechercher" className="h-9 pl-8"
            />
          </div>
          <Select value={circuit} onChange={(e) => setCircuit(e.target.value as typeof circuit)} aria-label="Circuit" className="h-9 w-auto">
            <option value="">Tous les circuits</option>
            <option value="EVENT">Événements &amp; prises en charge</option>
            <option value="PROMO">Matériel promotionnel</option>
          </Select>
          {nbValides > 0 && (
            <button
              type="button" onClick={() => setArchives((v) => !v)} aria-pressed={archives}
              className={cn(
                "h-9 rounded-lg border px-3 text-sm transition-colors",
                archives ? "border-primary/40 bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-secondary",
              )}
            >
              Validés · {nbValides}
            </button>
          )}
        </div>
      </div>

      {visibles.length === 0 ? (
        <p className="px-4 py-6 text-sm text-muted-foreground">
          {lignes.length === 0 ? "Aucun dossier." : "Aucun dossier ne correspond."}
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="sticky left-0 z-10 bg-card">Dossier</TableHead>
              <TableHead>Produit</TableHead>
              <TableHead className="text-right">Montant</TableHead>
              <TableHead>Où en est-il</TableHead>
              <TableHead className="text-right">Depuis</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visibles.map((l) => (
              <TableRow
                key={l.id}
                className={cn("group cursor-pointer", l.valide && "text-muted-foreground")}
                onClick={(e) => {
                  if ((e.target as HTMLElement).closest("a")) return;
                  router.push(`/information-medicale/${l.id}`);
                }}
              >
                <TableCell className="sticky left-0 z-10 min-w-[11rem] max-w-[14rem] bg-card group-hover:bg-secondary sm:max-w-[26rem]">
                  <Link href={`/information-medicale/${l.id}`} className="block min-w-0">
                    <span className="block truncate font-medium text-foreground">
                      <span className="font-mono text-xs text-muted-foreground">{l.reference}</span> · {l.label}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {l.nature}{l.detail ? ` · ${l.detail}` : ""}
                    </span>
                  </Link>
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {!l.produit ? (
                    <span className="text-muted-foreground">—</span>
                  ) : l.produit.id ? (
                    <Link href={`/produits/${l.produit.id}`} className="text-primary hover:underline">{l.produit.nom}</Link>
                  ) : (
                    <span>{l.produit.nom}</span>
                  )}
                  {l.produit && l.produit.autres > 0 && <span className="text-xs text-muted-foreground"> +{l.produit.autres}</span>}
                </TableCell>
                <TableCell className="whitespace-nowrap text-right tabular-nums">
                  {l.montant != null ? formatCurrency(l.montant) : <span className="text-muted-foreground">—</span>}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  <Badge tone={l.ton}>{l.pastille}</Badge>
                </TableCell>
                <TableCell className={cn("whitespace-nowrap text-right tabular-nums", DELAI_CLASSE[l.delai])}>
                  {l.jours == null || l.valide ? <span className="text-muted-foreground">—</span> : `${l.jours} j`}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Card>
  );
}
