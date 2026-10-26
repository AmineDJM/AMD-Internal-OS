"use client";

import * as React from "react";
import { ChevronDown, ChevronRight, FileText, Search, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Input, Select } from "@/components/ui/input";
import { Sheet } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatCurrency, formatDate } from "@/lib/utils";
import { DEPT_BUDGET_LABEL } from "@/lib/department-budget";
import {
  AUCUN_FILTRE, SANS_NATURE, filtrerDepenses, filtreActif, grouperParMois, titreMois,
  type FiltrePaiement, type FiltresDepenses,
} from "@/lib/general-means/ecran";
import { ExpenseRowActions } from "./expense-row-actions";
import { EVENEMENT_FILTRE_NATURE, type FiltreNatureDetail } from "./par-nature-mois";
import type { BudgetTarget } from "@/lib/budget/target";
import type { CatalogArticle } from "./receipt-lines";
import type { GeneralMeansExpense } from "@/lib/queries/general-means";

/**
 * LES DÉPENSES, RANGÉES PAR MOIS (Direction, 09/10 : « moins de lignes, le détail à la demande »).
 *
 * Une seule liste, qui se filtre (paiement, nature, recherche) — jamais deux listes qui se recoupent. Seul le MOIS EN COURS
 * est ouvert ; les autres se déplient d'un clic, avec leur nombre de dépenses et leur total. Une ligne = une dépense, six
 * colonnes ; un clic sur la ligne ouvre un panneau avec tout le détail (articles, précisions, justificatifs) et les gestes
 * de correction — au même droit qu'avant : le serveur revérifie chaque modification.
 *
 * Quand un filtre est posé, tous les mois concernés s'ouvrent : on cherche, on ne feuillette pas.
 */

const PAIEMENTS: { valeur: FiltrePaiement; libelle: string }[] = [
  { valeur: "TOUS", libelle: "Tous paiements" },
  { valeur: "CAISSE", libelle: "Caisse d'avance" },
  { valeur: "HORS", libelle: "Hors caisse" },
];

export function ExpenseTable({
  expenses, canSpend, canAmendCash, articles, budgetTargets, cashUsable, maintenant,
}: {
  expenses: GeneralMeansExpense[];
  canSpend: boolean;
  /** Peut-on corriger une dépense payée en LIQUIDE ? (détenteur de la caisse, ou direction) */
  canAmendCash: boolean;
  articles: CatalogArticle[];
  budgetTargets: BudgetTarget[];
  cashUsable: boolean;
  /** L'instant où le serveur a rendu la page (ISO) : le même « mois en cours » des deux côtés, sans écart d'hydratation. */
  maintenant: string;
}) {
  const [filtres, setFiltres] = React.useState<FiltresDepenses>(AUCUN_FILTRE);
  const [bascules, setBascules] = React.useState<Record<string, boolean>>({});
  const [choisieId, setChoisieId] = React.useState<string | null>(null);

  // Les natures du filtre sont celles des ARTICLES : une dépense « café + ramettes » se retrouve sous les deux.
  const natures = React.useMemo(() => {
    const noms = new Set<string>();
    let sans = false;
    for (const e of expenses) {
      for (const p of e.parts.length > 0 ? e.parts : [{ nature: e.nature }]) { if (p.nature) noms.add(p.nature); else sans = true; }
    }
    return [...[...noms].sort((a, b) => a.localeCompare(b, "fr")), ...(sans ? [SANS_NATURE] : [])];
  }, [expenses]);

  // UN CLIC SUR UNE CATÉGORIE DE « PAR NATURE » filtre cette liste : la catégorie et le mois regardé.
  React.useEffect(() => {
    const ecoute = (ev: Event) => {
      const d = (ev as CustomEvent<FiltreNatureDetail>).detail;
      if (d) setFiltres((f) => ({ ...f, nature: d.nature, mois: d.mois }));
    };
    window.addEventListener(EVENEMENT_FILTRE_NATURE, ecoute);
    return () => window.removeEventListener(EVENEMENT_FILTRE_NATURE, ecoute);
  }, []);

  const lignes = React.useMemo(() => filtrerDepenses(expenses, filtres), [expenses, filtres]);
  const groupes = React.useMemo(() => grouperParMois(lignes, maintenant), [lignes, maintenant]);
  const actif = filtreActif(filtres);
  const total = lignes.reduce((a, e) => a + e.amount, 0);
  const choisie = choisieId ? expenses.find((e) => e.id === choisieId) ?? null : null;

  if (expenses.length === 0) {
    return <p className="p-4 text-sm text-muted-foreground">Aucune dépense imputée cette année.</p>;
  }

  const ouvert = (mois: string, parDefaut: boolean) => (actif ? true : bascules[mois] ?? parDefaut);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 px-4 pt-1">
        <label className="relative min-w-0 flex-1 basis-48 sm:max-w-xs">
          <span className="sr-only">Rechercher une dépense</span>
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={filtres.recherche} onChange={(e) => setFiltres((f) => ({ ...f, recherche: e.target.value }))}
            placeholder="Rechercher…" className="h-10 pl-8 text-base sm:h-9 sm:text-sm"
          />
        </label>
        <Select
          aria-label="Paiement" value={filtres.paiement} className="h-10 w-auto text-base sm:h-9 sm:text-sm"
          onChange={(e) => setFiltres((f) => ({ ...f, paiement: e.target.value as FiltrePaiement }))}
        >
          {PAIEMENTS.map((p) => <option key={p.valeur} value={p.valeur}>{p.libelle}</option>)}
        </Select>
        <Select
          aria-label="Nature" value={filtres.nature} className="h-10 w-auto text-base sm:h-9 sm:text-sm"
          onChange={(e) => setFiltres((f) => ({ ...f, nature: e.target.value }))}
        >
          <option value="">Toutes natures</option>
          {natures.map((n) => <option key={n} value={n}>{n}</option>)}
        </Select>
        {filtres.mois && (
          <button
            type="button" onClick={() => setFiltres((f) => ({ ...f, mois: "" }))}
            className="inline-flex min-h-9 items-center gap-1 rounded-full border border-border bg-secondary px-2.5 text-xs font-medium hover:bg-secondary/70 sm:min-h-0 sm:py-1"
            aria-label={`Retirer le filtre ${titreMois(filtres.mois)}`}
          >
            {titreMois(filtres.mois)} <X className="h-3.5 w-3.5" />
          </button>
        )}
        {/* LE TOTAL DE CE QUI EST AFFICHÉ : un filtre qui ne recalcule rien ne fait que cacher des lignes. */}
        <span className="ml-auto text-xs text-muted-foreground">
          {lignes.length} dépense{lignes.length > 1 ? "s" : ""} · <strong className="tabular-nums text-foreground">{formatCurrency(total)}</strong>
        </span>
      </div>

      {lignes.length === 0 ? (
        <p className="px-4 pb-4 text-sm text-muted-foreground">Aucune dépense ne correspond à ces filtres.</p>
      ) : (
        <Table className="min-w-[44rem]">
          <TableHeader className="border-y border-border bg-secondary/40">
            <TableRow>
              <TableHead scope="col" className="px-4">Dépense</TableHead>
              <TableHead scope="col">Nature</TableHead>
              <TableHead scope="col">Paiement</TableHead>
              <TableHead scope="col">Date</TableHead>
              <TableHead scope="col" className="text-right">Montant</TableHead>
              <TableHead scope="col">Pièce</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {groupes.flatMap((g) => {
              const est = ouvert(g.mois, g.ouvert);
              return [
                <TableRow key={`m-${g.mois}`} className="bg-secondary/40 font-medium hover:bg-secondary/70">
                  <TableCell colSpan={4} className="p-0">
                    <button
                      type="button" aria-expanded={est}
                      onClick={() => setBascules((b) => ({ ...b, [g.mois]: !est }))}
                      className="flex min-h-11 w-full items-center gap-1.5 px-4 text-left sm:min-h-9"
                    >
                      {est ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
                      {titreMois(g.mois)} <span className="font-normal text-muted-foreground">· {g.count} dépense{g.count > 1 ? "s" : ""}</span>
                    </button>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-right tabular-nums">{formatCurrency(g.total)}</TableCell>
                  <TableCell />
                </TableRow>,
                ...(est ? g.lignes.map((e) => (
                  <TableRow key={e.id} onClick={() => setChoisieId(e.id)} className="cursor-pointer">
                    <TableCell className="max-w-[18rem] px-4">
                      <button type="button" onClick={() => setChoisieId(e.id)} className="block max-w-full truncate text-left font-medium hover:underline" title={e.label}>
                        {e.label}
                      </button>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs">
                      {e.nature ?? <span className="text-muted-foreground">{SANS_NATURE}</span>}
                      {budgetTargets.length > 0 && e.toClassify && <> <Badge tone="warning" dot={false}>à classer</Badge></>}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{e.fromPettyCash ? "caisse" : "hors caisse"}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{formatDate(e.date, { day: "2-digit", month: "2-digit" })}</TableCell>
                    <TableCell className="whitespace-nowrap text-right font-semibold tabular-nums">{formatCurrency(e.amount)}</TableCell>
                    <TableCell className="whitespace-nowrap">
                      {e.documents.length === 0 ? (
                        <span className="text-xs font-medium text-warning">manque</span>
                      ) : (
                        <a
                          href={`/api/documents/${e.documents[0].id}?dl=1`} title={e.documents.map((d) => d.name).join(", ")}
                          aria-label={`Télécharger ${e.documents[0].name}`} onClick={(ev) => ev.stopPropagation()}
                          className="inline-flex min-h-9 items-center gap-1 rounded-md px-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground sm:min-h-0"
                        >
                          <FileText className="h-4 w-4" />{e.documents.length > 1 && <span className="text-xs tabular-nums">{e.documents.length}</span>}
                        </a>
                      )}
                    </TableCell>
                  </TableRow>
                )) : []),
              ];
            })}
          </TableBody>
        </Table>
      )}

      <Sheet
        open={choisie !== null} onClose={() => setChoisieId(null)}
        title={choisie?.label ?? "Dépense"} description={choisie ? formatDate(choisie.date) : undefined} width="lg"
      >
        {choisie && (
          <DetailDepense
            e={choisie}
            editable={canSpend && (!choisie.fromPettyCash || canAmendCash)}
            articles={articles} budgetTargets={budgetTargets} cashUsable={cashUsable}
          />
        )}
      </Sheet>
    </div>
  );
}

/** Tout le détail d'une dépense — ce que la ligne du tableau ne montre plus — et ses gestes de correction. */
function DetailDepense({ e, editable, articles, budgetTargets, cashUsable }: {
  e: GeneralMeansExpense;
  editable: boolean;
  articles: CatalogArticle[];
  budgetTargets: BudgetTarget[];
  cashUsable: boolean;
}) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-2xl font-semibold tabular-nums">{formatCurrency(e.amount)}</p>
        {e.fromPettyCash
          ? <Badge tone="info" dot={false}>payé sur la caisse d&apos;avance</Badge>
          : <Badge tone="neutral" dot={false}>payé hors caisse</Badge>}
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
        <div>
          <dt className="text-xs text-muted-foreground">Nature</dt>
          <dd>
            {e.nature ?? SANS_NATURE}
            {budgetTargets.length > 0 && e.toClassify && <> <Badge tone="warning" dot={false}>à classer</Badge></>}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Budget imputé</dt>
          <dd>{DEPT_BUDGET_LABEL[e.kind]}{e.budgetLabel && <span className="block text-xs text-muted-foreground">{e.budgetLabel}</span>}</dd>
        </div>
        {e.createdBy && (
          <div>
            <dt className="text-xs text-muted-foreground">Saisie par</dt>
            <dd>{e.createdBy}</dd>
          </div>
        )}
      </dl>

      {e.notes && (
        <div>
          <p className="text-xs text-muted-foreground">Précisions (fournisseur, facture)</p>
          <p className="text-sm [overflow-wrap:anywhere]">{e.notes}</p>
        </div>
      )}

      {e.lines.length > 0 && (
        <div>
          <p className="mb-1 text-xs text-muted-foreground">Articles</p>
          <ul className="divide-y divide-border rounded-lg border border-border text-sm">
            {e.lines.map((l) => (
              <li key={l.id} className="flex items-baseline justify-between gap-3 px-3 py-2">
                <span className="min-w-0 [overflow-wrap:anywhere]">{l.quantity > 1 ? `${l.quantity} × ` : ""}{l.label}</span>
                <span className="shrink-0 tabular-nums">{formatCurrency(l.amount)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <p className="mb-1 text-xs text-muted-foreground">Justificatifs</p>
        {e.documents.length === 0 ? (
          <Badge tone="danger" dot={false}>sans pièce</Badge>
        ) : (
          <ul className="space-y-1">
            {e.documents.map((d) => (
              <li key={d.id}>
                <a href={`/api/documents/${d.id}?dl=1`} className="inline-flex min-h-9 items-center gap-1.5 text-sm text-primary hover:underline sm:min-h-0">
                  <FileText className="h-4 w-4" /> <span className="[overflow-wrap:anywhere]">{d.name}</span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Corriger ou supprimer se fait ICI, là où l'on relit la dépense. Le serveur revérifie le droit : sur une dépense
          payée en liquide, seule la personne qui détient la caisse (ou la direction) y touche. */}
      {editable && (
        <div className="flex flex-wrap items-start gap-2 border-t border-border pt-3">
          <span className="py-2 text-xs text-muted-foreground sm:py-1.5">Corriger ou supprimer</span>
          <ExpenseRowActions
            expense={{
              id: e.id, label: e.label, amount: e.amount, kind: e.kind, notes: e.notes,
              fromPettyCash: e.fromPettyCash, budgetCategoryId: e.budgetCategoryId, lines: e.lines,
            }}
            articles={articles}
            budgetTargets={budgetTargets}
            cashUsable={cashUsable}
          />
        </div>
      )}
    </div>
  );
}
