"use client";

import * as React from "react";
import Link from "next/link";
import { useKeyedAction } from "@/components/shared/use-action";
import { Search, ExternalLink, BellRing, Loader2, ChevronDown, ChevronRight, Clock, User } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/shared/status-badge";
import { EmptyState } from "@/components/shared/empty-state";
import { DocumentList } from "@/components/documents/document-list";
import { SuperAdminDeleteButton } from "@/components/shared/super-admin-delete";
import { VALIDATION_STEP_STATE, VALIDATION_MODE } from "@/lib/labels";
import { formatCurrency, formatDate, cn } from "@/lib/utils";
import { remindValidator } from "@/lib/actions/validation-actions";
import type { SupervisedValidationItem } from "@/lib/queries/validations";
import {
  urgencyOf, filterSupervised, supervisionCounters, daysSince,
  URGENCY_LABEL, URGENCY_TONE, type SupervisionFilter,
} from "@/lib/validation-supervision";

/**
 * SUPERVISION DES VALIDATIONS — la vue de la Direction, refaite autour de sa vraie question.
 *
 * L'écran affichait cent cartes de même taille, dans l'ordre de création, sans dire laquelle
 * attendait depuis trois semaines ni QUI la retenait. On lisait tout pour ne rien apprendre.
 *
 * Trois changements portent le reste :
 *   • **un tableau, pas des cartes** — vingt lignes tiennent à l'écran là où trois cartes
 *     tenaient, et la comparaison redevient possible ;
 *   • **« chez qui ça bloque » en colonne**, avec le temps d'attente — c'est la réponse
 *     cherchée, elle ne doit pas se déduire en ouvrant chaque demande ;
 *   • **une relance en un clic**, tracée : constater sans pouvoir agir n'est pas superviser.
 *
 * Les compteurs du haut sont des FILTRES : « 3 en retard » se clique et ne laisse que celles-là.
 */
export function SupervisionBoard({
  rows, isSuperAdmin,
}: { rows: SupervisedValidationItem[]; isSuperAdmin: boolean }) {
  const [filter, setFilter] = React.useState<SupervisionFilter>("ALL");
  const [query, setQuery] = React.useState("");
  const [open, setOpen] = React.useState<string | null>(null);
  // Le bouton « Relancer » d'une ligne n'a pas de place pour parler : un refus part en avis flottant.
  const { busy, run } = useKeyedAction({ signalerErreurs: true });
  const [sent, setSent] = React.useState<Set<string>>(new Set());

  // `now` figé au montage : recalculé à chaque rendu, un compteur pourrait changer de catégorie
  // pendant qu'on lit la liste.
  const now = React.useMemo(() => new Date(), []);
  const counters = React.useMemo(() => supervisionCounters(rows, now), [rows, now]);
  const shown = React.useMemo(() => filterSupervised(rows, now, filter, query), [rows, now, filter, query]);

  const relance = async (stepId: string) => {
    const fd = new FormData();
    fd.set("stepId", stepId);
    if (await run(stepId, () => remindValidator(fd))) {
      setSent((prev) => new Set(prev).add(stepId));
    }
  };

  const chip = (key: SupervisionFilter, label: string, count: number, tone: string) => (
    <button
      type="button"
      onClick={() => setFilter(filter === key ? "ALL" : key)}
      disabled={count === 0 && key !== "ALL"}
      className={cn(
        "rounded-xl border px-3 py-2 text-left transition-colors disabled:opacity-40",
        filter === key ? "border-primary bg-primary/10" : "border-border hover:bg-secondary",
      )}
    >
      <p className={cn("text-xl font-semibold tabular-nums", tone)}>{count}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </button>
  );

  if (rows.length === 0) {
    return (
      <EmptyState
        icon="ShieldCheck"
        title="Aucune demande en circulation"
        description="Les demandes de validation de toute la société apparaîtront ici, la plus urgente en premier."
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {chip("ALL", "En circulation", counters.total, "")}
        {chip("OVERDUE", "En retard", counters.overdue, counters.overdue > 0 ? "text-destructive" : "")}
        {chip("DUE_SOON", "Échéance proche", counters.dueSoon, counters.dueSoon > 0 ? "text-warning" : "")}
        {chip("STALLED", "Sans décision > 7 j", counters.stalled, counters.stalled > 0 ? "text-primary" : "")}
      </div>

      {counters.amountPending > 0 && (
        <p className="text-xs text-muted-foreground">
          Montant immobilisé par une signature en attente :{" "}
          <strong className="tabular-nums text-foreground">{formatCurrency(counters.amountPending)}</strong>
        </p>
      )}

      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Référence, objet, module, demandeur… ou le validateur qui bloque"
          type="search"
          className="w-full rounded-lg border border-input bg-background py-2 pl-8 pr-3 text-base outline-none focus:border-primary/60 sm:text-sm"
        />
      </div>

      {shown.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-4 text-sm text-muted-foreground">
          Aucune demande ne correspond{query ? ` à « ${query} »` : ""}.
        </p>
      ) : (
        <div className="surface overflow-hidden">
          <div className="divide-y divide-border">
            {shown.map((r) => {
              const u = urgencyOf(r, now);
              const waiting = daysSince(r.createdAt, now);
              const expanded = open === r.id;
              return (
                <div key={r.id}>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2.5 text-sm">
                    <button
                      type="button"
                      onClick={() => setOpen(expanded ? null : r.id)}
                      className="-m-2 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:text-foreground sm:m-0 sm:h-auto sm:w-auto"
                      aria-label={expanded ? "Replier" : "Déplier"}
                    >
                      {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                    </button>

                    <Badge tone={URGENCY_TONE[u]} dot={false}>{URGENCY_LABEL[u]}</Badge>

                    {/* Une base de 12 rem : au téléphone, l'objet passe sur sa propre ligne plutôt que d'être écrasé. */}
                    <div className="min-w-0 flex-1 basis-[12rem]">
                      <p className="truncate font-medium">{r.title}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        <span className="font-mono">{r.reference}</span> · {r.module} · demandé par {r.requester || "—"}
                      </p>
                    </div>

                    {/* CHEZ QUI ÇA BLOQUE — la colonne qui manquait. */}
                    <div className="min-w-[9rem] max-w-full">
                      {r.blockingValidator ? (
                        <p className="flex items-center gap-1 text-xs">
                          <User className="h-3 w-3 shrink-0 text-muted-foreground" />
                          <span className="truncate font-medium">{r.blockingValidator}</span>
                        </p>
                      ) : (
                        <p className="text-xs text-muted-foreground">—</p>
                      )}
                      <p className="flex items-center gap-1 text-[0.6875rem] text-muted-foreground">
                        <Clock className="h-3 w-3 shrink-0" />
                        {waiting <= 0 ? "aujourd'hui" : `${waiting} j d'attente`}
                        {r.deadline ? ` · échéance ${formatDate(r.deadline)}` : ""}
                      </p>
                    </div>

                    {r.amount !== null && (
                      <span className="shrink-0 text-sm font-semibold tabular-nums">{formatCurrency(r.amount)}</span>
                    )}

                    {r.blockingStepId && (
                      <button
                        type="button"
                        onClick={() => relance(r.blockingStepId!)}
                        disabled={busy === r.blockingStepId || sent.has(r.blockingStepId)}
                        className="inline-flex min-h-9 shrink-0 items-center gap-1 rounded-lg border border-input px-3 py-1 text-xs font-medium hover:bg-secondary disabled:opacity-50 sm:min-h-0 sm:px-2"
                        title={`Relancer ${r.blockingValidator ?? "le validateur"} (notification + push)`}
                      >
                        {busy === r.blockingStepId
                          ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          : <BellRing className="h-3.5 w-3.5" />}
                        {sent.has(r.blockingStepId) ? "Relancé" : "Relancer"}
                      </button>
                    )}
                  </div>

                  {expanded && (
                    <div className="space-y-2 border-t border-border/60 bg-secondary/20 px-3 py-3">
                      {r.description && <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">{r.description}</p>}
                      <p className="text-xs text-muted-foreground">Circuit : {VALIDATION_MODE[r.mode]}</p>
                      <div className="flex flex-wrap gap-2">
                        {r.steps.map((s) => (
                          <span key={s.order} className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-2 py-0.5 text-xs" title={s.reason || undefined}>
                            <span className="text-muted-foreground">{s.order}.</span>
                            <span>{s.validator}</span>
                            <StatusBadge map={VALIDATION_STEP_STATE} value={s.status} dot={false} />
                          </span>
                        ))}
                      </div>
                      {r.link && (
                        <Link href={r.link} className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline">
                          <ExternalLink className="h-3.5 w-3.5" /> Ouvrir la demande originale
                        </Link>
                      )}
                      {r.documents.length > 0 && <DocumentList documents={r.documents} />}
                      {isSuperAdmin && (
                        <SuperAdminDeleteButton kind="VALIDATION_REQUEST" id={r.id} name={`${r.reference} — ${r.title}`} enabled />
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
