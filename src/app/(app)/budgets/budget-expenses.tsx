"use client";

import * as React from "react";
import Link from "next/link";
import { Pencil, Trash2, Inbox, CheckCheck, Paperclip, ExternalLink, Building2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Select } from "@/components/ui/input";
import { formatCurrency, formatDate } from "@/lib/utils";
import { attributeTransaction, changerSocieteEcriture, deleteBudgetExpense } from "@/lib/actions/budget-envelope-actions";
import { PartagerButton } from "@/components/shared/partager-button";
import type { BudgetOverview, AttributedTx } from "@/lib/queries/budget";
import { useRun, AddExpenseRow, ExpenseEditSheet } from "./budget-forms";
import { BarreSuppressionAImputer } from "./suppression-a-imputer";

/**
 * BUDGETS — écran « DÉPENSES ». C'est ici qu'on TRAVAILLE, et nulle part ailleurs.
 *
 * Une seule chose à faire en arrivant : ranger ce qui n'est pas rangé. Les dépenses non
 * imputées viennent donc EN PREMIER — elles faussent tous les chiffres tant qu'elles
 * traînent — et le reste (l'historique de ce qui est déjà imputé) vient après.
 */
export function BudgetExpenses({ overview, canAttribute, canDelete, societes = [], canEditLines = canAttribute, marques }: {
  overview: BudgetOverview;
  /** Une étiquette par dépense à imputer (Budget Operations : « Force de vente » sur ce qu'un commercial a demandé). */
  marques?: Record<string, string>;
  canAttribute: boolean;
  /** Saisir / corriger les lignes purement budgétaires. Faux dans Budgets sur une enveloppe tenue par Budget Marketing. */
  canEditLines?: boolean;
  /** Les sociétés que la personne engage — pour rattacher une dépense à la bonne (Direction, 06/10). */
  societes?: { id: string; nom: string }[];
  /** Le Super Admin supprime une ou plusieurs écritures « à imputer » (§118.176) — le serveur revérifie. */
  canDelete: boolean;
}) {
  const { run } = useRun();
  const [editExpense, setEditExpense] = React.useState<AttributedTx | null>(null);
  const [selection, setSelection] = React.useState<Set<string>>(new Set());
  // LES PIÈCES D'UNE DÉPENSE, dépliées à la demande (Direction, 06/10 : « j'ai besoin des documents pour comprendre »).
  const [ouverte, setOuverte] = React.useState<string | null>(null);
  const deplacer = (transactionId: string, companyId: string) => {
    if (!companyId) return;
    const fd = new FormData();
    fd.set("transactionId", transactionId);
    fd.set("companyId", companyId);
    run(() => changerSocieteEcriture(fd));
  };
  const cats = overview.categories;
  const aImputer = overview.unattributed.transactions;
  const basculer = (id: string) => setSelection((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });
  const toutes = aImputer.length > 0 && aImputer.every((t) => selection.has(t.id));

  const assign = (transactionId: string, categoryId: string) => {
    const fd = new FormData();
    fd.set("transactionId", transactionId);
    if (categoryId) fd.set("budgetCategoryId", categoryId);
    run(() => attributeTransaction(fd));
  };

  return (
    <div className="space-y-5">
      {/* 1. À RANGER — la seule tâche de cet écran. */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Inbox className="h-4 w-4 text-warning" />
          <h2 className="text-sm font-semibold">À imputer</h2>
          {overview.unattributed.total > 0 && <Badge tone="warning" dot={false}>{formatCurrency(overview.unattributed.total)}</Badge>}
          {canDelete && aImputer.length > 0 && (
            <label className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
              <input
                type="checkbox" checked={toutes}
                onChange={() => setSelection(toutes ? new Set() : new Set(aImputer.map((t) => t.id)))}
                className="h-4 w-4 rounded border-input"
              />
              Tout sélectionner
            </label>
          )}
        </div>
        {canDelete && (
          <BarreSuppressionAImputer
            selection={selection}
            ecritures={aImputer.map((t) => ({ id: t.id, reference: t.reference, label: t.label, amount: t.amount, status: t.status }))}
            onVider={() => setSelection(new Set())}
          />
        )}
        {overview.unattributed.transactions.length === 0 ? (
          <p className="surface flex items-center gap-2 p-4 text-sm text-muted-foreground">
            <CheckCheck className="h-4 w-4 text-success" /> Tout est rangé — chaque dépense de la période est rattachée à une catégorie.
          </p>
        ) : (
          <ul className="surface divide-y divide-border">
            {aImputer.map((tx) => (
              <li key={tx.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5 text-sm">
                {canDelete && (
                  <input
                    type="checkbox" checked={selection.has(tx.id)} onChange={() => basculer(tx.id)}
                    aria-label={`Sélectionner ${tx.reference}`}
                    className="h-4 w-4 shrink-0 rounded border-input"
                  />
                )}
                <div className="min-w-0 flex-1 basis-[12rem]">
                  <p className="truncate font-medium">{tx.label}</p>
                  <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                    {tx.reference} · {formatDate(tx.date)}{tx.counterparty ? ` · ${tx.counterparty}` : ""}
                    {" · "}<span className={tx.societe ? "" : "text-warning"}>{tx.societe ?? "sans société"}</span>
                  </p>
                  <p className="text-xs text-muted-foreground">{tx.paiement}</p>
                </div>
                {marques?.[tx.id] && <Badge tone="info" dot={false}>{marques[tx.id]}</Badge>}
                <span className="shrink-0 whitespace-nowrap font-semibold tabular-nums">{formatCurrency(tx.amount)}</span>
                <button
                  type="button" onClick={() => setOuverte(ouverte === tx.id ? null : tx.id)} aria-expanded={ouverte === tx.id}
                  className="inline-flex min-h-9 shrink-0 items-center gap-1 rounded-md border border-border px-2.5 py-1 text-xs hover:bg-secondary sm:min-h-0 sm:px-2"
                >
                  <Paperclip className="h-3.5 w-3.5" /> Pièces ({tx.pieces.length + tx.liens.length})
                </button>
                {/* DEMANDER PAR MESSAGE si elle est toujours d'actualité, et si elle a été payée (Direction, 06/10). */}
                <PartagerButton
                  iconOnly refType="FINANCE_TRANSACTION" refId={tx.id} refLabel={`${tx.reference} — ${tx.label} (${formatCurrency(tx.amount)})`}
                  href="/budgets/depenses" noteInitiale={`Bonjour, cette dépense (${tx.reference} — ${tx.label}, ${formatCurrency(tx.amount)}${tx.counterparty ? `, ${tx.counterparty}` : ""}) est-elle toujours d'actualité ? A-t-elle été payée ?`}
                />
                {canAttribute ? (
                  <Select defaultValue="" onChange={(e) => assign(tx.id, e.target.value)} className="h-10 w-full sm:h-9 sm:w-48 sm:text-xs" aria-label={`Imputer ${tx.label}`}>
                    <option value="">Imputer à…</option>
                    {cats.map((c) => <option key={c.id} value={c.id}>{c.parentId ? `↳ ${c.name}` : c.name}</option>)}
                  </Select>
                ) : <Badge tone="neutral" dot={false}>Non imputé</Badge>}
                {ouverte === tx.id && (
                  <div className="basis-full space-y-2 rounded-lg bg-secondary/30 p-2.5 text-xs">
                    {tx.liens.length === 0 && tx.pieces.length === 0 && (
                      <p className="text-muted-foreground">Aucune pièce ni facture n&apos;est reliée à cette écriture : elle a été saisie directement en trésorerie.</p>
                    )}
                    {tx.liens.length > 0 && (
                      <div className="flex flex-wrap gap-x-3 gap-y-1">
                        {tx.liens.map((l) => (
                          <Link key={l.href + l.libelle} href={l.href} className="inline-flex items-center gap-1 font-medium text-primary hover:underline">
                            {l.libelle} <ExternalLink className="h-3 w-3" />
                          </Link>
                        ))}
                      </div>
                    )}
                    {tx.pieces.length > 0 && (
                      <ul className="space-y-0.5">
                        {tx.pieces.map((d) => (
                          <li key={d.id}>
                            <a href={d.href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
                              <Paperclip className="h-3 w-3" /> {d.nom}
                            </a>
                          </li>
                        ))}
                      </ul>
                    )}
                    {/* CETTE DÉPENSE CONCERNE UNE AUTRE SOCIÉTÉ : la déplacer. */}
                    {canAttribute && societes.length > 0 && (
                      <label className="flex w-full flex-wrap items-center gap-2">
                        <Building2 className="h-3.5 w-3.5 text-muted-foreground" />
                        <span>Société de la dépense :</span>
                        <Select defaultValue={tx.companyId ?? ""} onChange={(e) => deplacer(tx.id, e.target.value)} className="h-10 w-full sm:h-8 sm:w-56 sm:text-xs" aria-label={`Société de ${tx.label}`}>
                          {!tx.companyId && <option value="">— Aucune —</option>}
                          {societes.map((s) => <option key={s.id} value={s.id}>{s.nom}</option>)}
                        </Select>
                      </label>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 2. Saisir une dépense purement budgétaire (sans impact trésorerie). */}
      {canEditLines && cats.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">Ajouter une dépense</h2>
          <AddExpenseRow categories={cats} />
        </section>
      )}

      {/* 3. L'historique de ce qui est déjà imputé. */}
      {overview.attributed.transactions.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold">
            Déjà imputé <span className="font-normal text-muted-foreground">({overview.attributed.count})</span>
          </h2>
          <ul className="surface divide-y divide-border">
            {overview.attributed.transactions.map((tx) => (
              <li key={`${tx.kind}-${tx.id}`} className="flex flex-wrap items-center gap-3 px-3 py-2.5 text-sm">
                <div className="min-w-0 flex-1 basis-[12rem]">
                  <p className="truncate font-medium">{tx.label}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {tx.categoryName} · {tx.reference} · {formatDate(tx.date)}{tx.counterparty ? ` · ${tx.counterparty}` : ""}
                  </p>
                </div>
                {tx.kind === "BUDGET" && <Badge tone="neutral" dot={false}>Budgétaire</Badge>}
                {tx.kind === "GENERAL_MEANS" && <Badge tone="info" dot={false}>Moyens généraux</Badge>}
                {tx.kind === "PAIE" && <Badge tone="info" dot={false}>Paie</Badge>}
                {tx.kind === "MISSION" && <Badge tone="info" dot={false}>Mission</Badge>}
                {tx.kind === "HISTORIQUE" && <Badge tone="purple" dot={false}>Historique 2026</Badge>}
                <span className="shrink-0 whitespace-nowrap font-semibold tabular-nums">{formatCurrency(tx.amount)}</span>
                {tx.kind === "GENERAL_MEANS" || tx.kind === "PAIE" || tx.kind === "MISSION" || tx.kind === "HISTORIQUE" ? (
                  // Un achat des moyens généraux se corrige LÀ-BAS, avec son justificatif. Le
                  // modifier depuis le budget donnerait deux endroits pour changer un même
                  // montant — donc, tôt ou tard, deux montants différents. Le lien n'est offert que
                  // si la dépense est au SERVICE : l'écran ne montre plus que lui (§118.170), et un
                  // « Voir la dépense » qui mène là où elle n'est pas fait chercher ce qui n'y est pas.
                  tx.lien ? (
                    <Link href={tx.lien} className="shrink-0 text-xs font-medium text-primary hover:underline">
                      Voir la dépense
                    </Link>
                  ) : null
                ) : !canAttribute ? null : tx.kind === "FINANCE" ? (
                  // Dépense de trésorerie : ré-imputable ici, mais elle se supprime dans les Finances.
                  <Select defaultValue={tx.categoryId} onChange={(e) => assign(tx.id, e.target.value)} className="h-10 w-full sm:h-9 sm:w-48 sm:text-xs" aria-label={`Ré-imputer ${tx.label}`}>
                    <option value="">— Retirer l&apos;imputation —</option>
                    {cats.map((c) => <option key={c.id} value={c.id}>{c.parentId ? `↳ ${c.name}` : c.name}</option>)}
                  </Select>
                ) : !canEditLines ? null : (
                  <div className="flex items-center gap-0.5">
                    <button
                      title="Modifier cette ligne budgétaire" onClick={() => setEditExpense(tx)}
                      className="rounded p-2 text-muted-foreground hover:bg-secondary hover:text-foreground sm:p-1.5"
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                    <button
                      title="Supprimer cette ligne budgétaire"
                      onClick={() => {
                        if (window.confirm(`Supprimer la dépense « ${tx.label} » ? La consommation de la catégorie sera réajustée.`)) {
                          const fd = new FormData(); fd.set("id", tx.id); run(() => deleteBudgetExpense(fd));
                        }
                      }}
                      className="rounded p-2 text-muted-foreground hover:bg-destructive/10 hover:text-destructive sm:p-1.5"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {editExpense && <ExpenseEditSheet tx={editExpense} categories={cats} onClose={() => setEditExpense(null)} />}
    </div>
  );
}
