"use client";

import * as React from "react";
import { CheckCircle2, Plus, Receipt, XCircle } from "lucide-react";
import type { CareMode } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { formatCurrency } from "@/lib/utils";
import { QUOTE_STATUS_LABELS, SERVICE_KIND_LABELS } from "@/lib/care";
import { montantLisible, type BeneficiaryRow, type Perimetre, type QuoteRow } from "@/lib/care-fiches";
import { createCareQuote } from "@/lib/actions/care-actions";
import { QuoteForm } from "@/components/care/care-panel";

/**
 * LES DEVIS D'UNE PRISE EN CHARGE — l'écran de l'assistante de direction à qui on les a demandés (audit Assistante de
 * direction, 10/2026). Ce qui attend un devis, les devis déjà saisis, et le formulaire d'un devis reçu — le MÊME que sur
 * la fiche (`QuoteForm`). Rien d'autre de la demande n'est ici : retenir ou trancher un devis reste à la fiche.
 */
export function DevisSollicitesPanel({ scope, requestId, mode, taux, beneficiaries, quotes }: {
  scope: Perimetre;
  requestId: string;
  mode: CareMode;
  taux: number | null;
  beneficiaries: BeneficiaryRow[];
  quotes: QuoteRow[];
}) {
  const { enCours, rafraichir } = useRafraichir();
  const [busy, setBusy] = React.useState(false);
  const [ouvert, setOuvert] = React.useState(true);
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);
  const aChiffrer = beneficiaries
    .filter((b) => b.status === "APPROVED")
    .flatMap((b) => b.cells.filter((c) => c.kind === "SERVICE" && c.status === "REQUESTED").map((c) => ({ id: c.id, label: c.label, who: b.name })));

  const envoyer = async (f: FormData) => {
    if (busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await createCareQuote(undefined, f);
      setMsg({ ok: r.ok, text: r.ok ? (r.message ?? "Devis enregistré.") : (r.error ?? "Échec.") });
      if (r.ok) { setOuvert(false); rafraichir(); }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      {msg && (
        <p className={`flex items-start gap-2 rounded-xl px-3 py-2 text-sm ${msg.ok ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive"}`}>
          {msg.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0" />} {msg.text}
        </p>
      )}

      <section className="space-y-2 rounded-xl border border-border bg-card p-4">
        <h3 className="text-sm font-semibold">À chiffrer ({aChiffrer.length})</h3>
        {aChiffrer.length === 0
          ? <p className="text-xs text-muted-foreground">Plus rien n&apos;attend de devis sur cette demande.</p>
          : (
            <ul className="divide-y divide-border text-sm">
              {aChiffrer.map((c) => (
                <li key={c.id} className="py-1.5 [overflow-wrap:anywhere]">{c.label} <span className="text-xs text-muted-foreground">— {c.who}</span></li>
              ))}
            </ul>
          )}
      </section>

      <section className="space-y-3 rounded-xl border border-border bg-card p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Receipt className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold">Devis reçus</h3>
          {!ouvert && (
            <Button size="sm" variant="outline" className="ml-auto" disabled={busy || enCours} onClick={() => setOuvert(true)}>
              <Plus className="h-4 w-4" /> Enregistrer un devis reçu
            </Button>
          )}
        </div>
        {ouvert && (
          <QuoteForm
            scope={scope} requestId={requestId} mode={mode} taux={taux} beneficiaries={beneficiaries} preselection={[]}
            busy={busy} onCancel={() => setOuvert(false)} onSubmit={(f) => void envoyer(f)}
          />
        )}
        {quotes.length === 0 ? (
          <p className="text-xs text-muted-foreground">Aucun devis pour l&apos;instant.</p>
        ) : (
          <ul className="divide-y divide-border">
            {quotes.map((q) => (
              <li key={q.id} className="space-y-1 py-2.5 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  {q.documentId
                    ? <a href={`/api/documents/${q.documentId}`} target="_blank" rel="noreferrer" className="min-w-0 font-medium text-primary underline underline-offset-2 [overflow-wrap:anywhere]">{q.supplier}</a>
                    : <span className="min-w-0 font-medium [overflow-wrap:anywhere]">{q.supplier}</span>}
                  {q.reference && <span className="min-w-0 font-mono text-[0.6875rem] text-muted-foreground [overflow-wrap:anywhere]">{q.reference}</span>}
                  {q.serviceKind && <Badge tone="neutral" dot={false}>{SERVICE_KIND_LABELS[q.serviceKind]}</Badge>}
                  <span className="tabular-nums">{q.amount != null && q.currency === "USD" ? `${montantLisible(q.amount, "USD")} = ${formatCurrency(q.amountDzd)}` : formatCurrency(q.amountDzd)}</span>
                  <Badge tone={q.status === "ACCEPTED" ? "success" : q.status === "REJECTED" ? "danger" : "warning"} dot={false}>{QUOTE_STATUS_LABELS[q.status]}</Badge>
                </div>
                <p className="text-xs text-muted-foreground">Couvre : {q.cellLabels.length ? [...new Set(q.cellLabels)].join(", ") : "—"}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
