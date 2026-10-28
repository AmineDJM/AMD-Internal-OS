"use client";

/**
 * LA CONVERSATION — la carte d'une action proposée : confirmer, ressaisir (action critique), annuler.
 */
import * as React from "react";
import Link from "next/link";
import { Sparkles, Loader2, CheckCircle2, AlertTriangle, ArrowRight, X, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ProposedAction } from "@/lib/assistant";
import { matchesConfirmText } from "@/lib/assistant/confirm";
import type { ActionState } from "./modele";

export function ActionCard({
  proposal, state, result, link, onConfirm, onCancel,
}: {
  proposal: ProposedAction;
  state: ActionState;
  result?: string;
  link?: string;
  onConfirm: (confirmTyped?: string) => void;
  onCancel: () => void;
}) {
  // CONFIRMATION FORTE (niveau CRITIQUE — salaires, suppressions, lots) : la carte fait
  // RESSAISIR la valeur exacte avant d'armer le bouton, et la valeur ressaisie PART AU
  // SERVEUR, qui la revérifie avec la même règle (matchesConfirmText) — l'UI n'est pas l'autorité.
  const critical = proposal.level === "CRITICAL" && Boolean(proposal.confirmText);
  const [typed, setTyped] = React.useState("");
  const armed = !critical || matchesConfirmText(typed, proposal.confirmText ?? "");
  // Un confirmText purement numérique est un MONTANT (affiché en DZD) ; sinon c'est un texte
  // à recopier tel quel (nom de dossier, « LOT 3 », « PLAN 4 », référence…).
  const cleanedAmount = (proposal.confirmText ?? "").replace(/[^0-9.,]/g, "").replace(",", ".");
  const confirmIsAmount = critical && /^[0-9\s\u00a0\u202f.,]+$/.test(proposal.confirmText ?? "") && cleanedAmount !== "" && Number.isFinite(Number(cleanedAmount));

  return (
    <div className={`overflow-hidden rounded-xl border shadow-sm ${critical ? "border-destructive/50 bg-gradient-to-br from-destructive/5 to-card" : proposal.level === "SENSITIVE" ? "border-warning/50 bg-gradient-to-br from-warning/5 to-card" : "border-primary/30 bg-gradient-to-br from-accent/40 to-card"}`}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border/60 px-3 py-2.5 sm:px-4">
        {critical ? <ShieldAlert className="h-4 w-4 shrink-0 text-destructive" /> : <Sparkles className="h-4 w-4 shrink-0 text-primary" />}
        <span className="min-w-0 text-sm font-semibold [overflow-wrap:anywhere]">{proposal.title}</span>
        {critical ? (
          <span className="ml-auto rounded-full bg-destructive/10 px-2 py-0.5 text-[0.6875rem] font-medium text-destructive">Critique</span>
        ) : proposal.level === "SENSITIVE" ? (
          <span className="ml-auto rounded-full bg-warning/10 px-2 py-0.5 text-[0.6875rem] font-medium text-warning">Sensible — à confirmer</span>
        ) : (
          <span className="ml-auto rounded-full bg-primary/10 px-2 py-0.5 text-[0.6875rem] font-medium text-primary">À confirmer</span>
        )}
      </div>

      {/* Au téléphone, l'intitulé passe au-dessus de la valeur : une colonne fixe de 7rem ne
          laissait plus à la valeur que le tiers de la carte. */}
      <dl className="divide-y divide-border/50">
        {proposal.fields.map((f) => (
          <div key={f.label} className="flex flex-col gap-0.5 px-3 py-2 text-sm sm:flex-row sm:gap-3 sm:px-4">
            <dt className="text-xs text-muted-foreground sm:w-28 sm:shrink-0 sm:text-sm">{f.label}</dt>
            <dd className="min-w-0 flex-1 whitespace-pre-wrap font-medium [overflow-wrap:anywhere]">{f.value}</dd>
          </div>
        ))}
      </dl>

      {proposal.warnings.length > 0 && state === "pending" && (
        <div className="space-y-1 border-t border-border/60 bg-warning/5 px-3 py-2 sm:px-4">
          {proposal.warnings.map((w, i) => (
            <p key={i} className="flex items-start gap-1.5 text-xs text-warning [overflow-wrap:anywhere]">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {w}
            </p>
          ))}
        </div>
      )}

      {critical && state === "pending" && (
        <div className="border-t border-border/60 bg-destructive/5 px-3 py-2.5 sm:px-4">
          <label className="text-xs font-medium text-destructive [overflow-wrap:anywhere]">
            {confirmIsAmount
              ? `Confirmation renforcée : ressaisissez le montant (${Number(cleanedAmount).toLocaleString("fr-FR")} DZD)`
              : `Confirmation renforcée : ressaisissez « ${proposal.confirmText} » pour confirmer`}
          </label>
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            inputMode={confirmIsAmount ? "numeric" : "text"}
            placeholder={proposal.confirmText}
            className={`mt-1 ${confirmIsAmount ? "w-full sm:w-48" : "w-full max-w-md"} rounded-lg border border-destructive/40 bg-background px-3 py-2 text-base outline-none sm:py-1.5 lg:text-sm focus:border-destructive focus:ring-2 focus:ring-destructive/20`}
          />
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-border/60 px-3 py-2.5 sm:px-4">
        {state === "pending" && (
          <>
            <Button size="sm" onClick={() => onConfirm(critical ? typed : undefined)} disabled={!armed} variant={critical ? "destructive" : "primary"}>
              <CheckCircle2 className="h-4 w-4" /> Confirmer
            </Button>
            <Button size="sm" variant="ghost" onClick={onCancel}><X className="h-4 w-4" /> Annuler</Button>
          </>
        )}
        {state === "running" && (
          <span className="flex items-center gap-1.5 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Exécution…</span>
        )}
        {state === "done" && (
          <span className="flex min-w-0 flex-wrap items-center gap-2 text-sm text-success [overflow-wrap:anywhere]">
            <CheckCircle2 className="h-4 w-4 shrink-0" /> {result ?? "Action effectuée."}
            {link && <Link href={link} className="inline-flex items-center gap-1 font-medium text-primary hover:underline">Ouvrir <ArrowRight className="h-3 w-3" /></Link>}
          </span>
        )}
        {state === "cancelled" && <span className="flex items-center gap-1.5 text-sm text-muted-foreground"><X className="h-4 w-4" /> Action annulée.</span>}
        {state === "error" && <span className="flex min-w-0 items-start gap-1.5 text-sm text-destructive [overflow-wrap:anywhere]"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {result ?? "Échec de l'action."}</span>}
      </div>
    </div>
  );
}
