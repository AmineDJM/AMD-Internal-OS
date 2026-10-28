"use client";

import * as React from "react";
import { AlertTriangle, ArrowRight, Loader2, Upload } from "lucide-react";
import { Sheet } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { validateMapping, type HeaderProposal, type TargetColumn } from "@/lib/medical/directory-mapping";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA CORRESPONDANCE DES COLONNES, À L'ÉCRAN — la dernière chance de dire non.
 *
 * ── CE QUE CET ÉCRAN REMPLACE ────────────────────────────────────────────────────────────
 *
 * Auparavant : on choisissait un fichier, il partait, et le message de fin annonçait
 * « colonne non reconnue : Colonne 3 ». Trop tard, et pour rien : le contenu était déjà perdu.
 *
 * Maintenant l'import se fait en deux temps. On LIT d'abord — sans rien écrire —, on montre ce
 * qu'on a compris colonne par colonne AVEC UN ÉCHANTILLON DE VALEURS, et on n'écrit qu'une fois
 * la correspondance acceptée.
 *
 * ── POURQUOI L'ORIGINE DE CHAQUE PROPOSITION EST AFFICHÉE ────────────────────────────────
 *
 * « Exact » et « deviné » ne se relisent pas avec la même attention. Présenter les deux du même
 * air ferait valider les secondes aussi vite que les premières — c'est-à-dire sans les lire. La
 * pastille dirige le regard là où il sert.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const ORIGINE: Record<string, { texte: string; classe: string }> = {
  exact: { texte: "exact", classe: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" },
  alias: { texte: "reconnu", classe: "bg-sky-500/10 text-sky-700 dark:text-sky-400" },
  approche: { texte: "approché", classe: "bg-amber-500/10 text-amber-700 dark:text-amber-400" },
  aucune: { texte: "à décider", classe: "bg-muted text-muted-foreground" },
};

export function ImportMappingSheet({
  fileName, directoryName, rowCount, proposals, targets, busy, onCancel, onConfirm,
}: {
  fileName: string;
  directoryName: string;
  rowCount: number;
  proposals: HeaderProposal[];
  targets: TargetColumn[];
  busy: boolean;
  onCancel: () => void;
  onConfirm: (mapping: (string | null)[]) => void;
}) {
  const [choix, setChoix] = React.useState<(string | null)[]>(() => proposals.map((p) => p.target));

  const problemes = React.useMemo(() => validateMapping(choix), [choix]);
  const retenues = choix.filter(Boolean).length;
  const ecartees = choix.length - retenues;

  // Une cible déjà prise ailleurs ne s'offre plus : c'est plus clair qu'un message d'erreur
  // après coup, et cela rend le conflit à peu près impossible à créer.
  const prises = new Set(choix.filter((c): c is string => Boolean(c)));

  return (
    <Sheet
      open onClose={onCancel} width="lg"
      title="Correspondance des colonnes"
      description={`${fileName} — ${rowCount} ligne(s) vers ${directoryName}. Rien n'est encore importé.`}
    >
      <div className="space-y-3">
        {/* Plus de bandeau d'aide (Direction, 07/10) : « Ne pas importer » dit de lui-même ce qu'il fait. */}
        <div className="rounded-xl border border-input">
          <Table>
            <TableHeader className="text-xs text-muted-foreground">
              <TableRow>
                <TableHead className="px-2.5 py-2 font-medium normal-case tracking-normal">Colonne du fichier</TableHead>
                <TableHead className="px-2.5 py-2 font-medium normal-case tracking-normal">Exemples</TableHead>
                <TableHead className="w-8" />
                <TableHead className="px-2.5 py-2 font-medium normal-case tracking-normal">Colonne de l&apos;annuaire</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {proposals.map((p, i) => {
                const o = ORIGINE[p.origin] ?? ORIGINE.aucune;
                return (
                  <TableRow key={p.index} className="align-top">
                    <TableCell className="px-2.5 py-2" data-sans-etiquette>
                      <div className="min-w-0">
                        <div className="font-medium [overflow-wrap:anywhere]">{p.header || <span className="text-muted-foreground">(sans titre)</span>}</div>
                        <span className={cn("mt-0.5 inline-block rounded px-1.5 py-0.5 text-[0.6875rem] font-medium", o.classe)}>
                          {o.texte}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="px-2.5 py-2 text-xs text-muted-foreground">
                      <div className="min-w-0 [overflow-wrap:anywhere]">
                        {p.sample.length ? p.sample.map((s, k) => <div key={k}>{s}</div>) : <span>—</span>}
                      </div>
                    </TableCell>
                    <TableCell className="px-1 py-2 text-muted-foreground" data-sans-etiquette><ArrowRight className="h-3.5 w-3.5" /></TableCell>
                    <TableCell className="px-2.5 py-2">
                      <select
                        value={choix[i] ?? ""}
                        onChange={(e) => {
                          const v = e.target.value || null;
                          setChoix((prev) => prev.map((c, k) => (k === i ? v : c)));
                        }}
                        aria-label={`Colonne de l'annuaire pour « ${p.header || "sans titre"} »`}
                        className="w-full min-w-0 rounded-lg border border-input bg-background px-2 py-2 text-base sm:py-1.5 sm:text-sm"
                      >
                        <option value="">Ne pas importer</option>
                        {targets.map((t) => (
                          <option key={t.id} value={t.id} disabled={prises.has(t.id) && choix[i] !== t.id}>
                            {t.label}
                          </option>
                        ))}
                      </select>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>

        {problemes.length > 0 && (
          <div className="space-y-1 rounded-lg border border-destructive/40 bg-destructive/5 p-2.5 text-xs text-destructive">
            {problemes.map((pb, i) => (
              <div key={i} className="flex items-start gap-1.5">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {pb.message}
              </div>
            ))}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-input pt-3">
          <span className="text-xs text-muted-foreground">
            {retenues} colonne(s) importée(s){ecartees > 0 ? ` · ${ecartees} écartée(s)` : ""}
          </span>
          <div className="flex w-full gap-2 sm:w-auto">
            <Button variant="outline" size="sm" onClick={onCancel} disabled={busy} className="flex-1 sm:flex-none">Annuler</Button>
            <Button
              size="sm"
              className="flex-1 sm:flex-none"
              disabled={busy || problemes.length > 0}
              onClick={() => onConfirm(choix)}
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
              Importer {rowCount} ligne(s)
            </Button>
          </div>
        </div>
      </div>
    </Sheet>
  );
}
