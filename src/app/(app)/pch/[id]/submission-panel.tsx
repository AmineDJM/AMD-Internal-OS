"use client";

import * as React from "react";
import { useAction } from "@/components/shared/use-action";
import { ChevronDown, ChevronRight, Loader2, Lock, Plus, Send } from "lucide-react";
import {
  addChecklistItem, createSubmission, submitSubmission, toggleChecklistItem, updateSubmission,
} from "@/lib/actions/pch-market-actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/utils";
import type { Market360 } from "@/lib/queries/market-360";

/**
 * LA SOUMISSION, VERSIONNÉE — Draft V1 → Review → Final → DÉPOSÉE (verrouillée).
 *
 * La version déposée est identifiable sans ambiguïté (cadenas + date) et PROTÉGÉE : le refus
 * de modification vient du serveur, l'écran ne fait que le donner à voir. La checklist est un
 * registre — chaque coche est signée et horodatée côté serveur.
 */
export function SubmissionPanel({ tenderId, soumissions, canEdit }: {
  tenderId: string;
  soumissions: Market360["soumissions"];
  canEdit: boolean;
}) {
  const { busy, err, run } = useAction();
  // La version la plus récente s'ouvre d'elle-même ; l'historique se déplie.
  const [openId, setOpenId] = React.useState<string | null>(soumissions[0]?.id ?? null);


  const statutLabel: Record<string, { label: string; tone: "neutral" | "info" | "warning" | "success" }> = {
    DRAFT: { label: "Brouillon", tone: "neutral" },
    REVIEW: { label: "En relecture", tone: "info" },
    FINAL: { label: "Version finale", tone: "warning" },
    SUBMITTED: { label: "Déposée", tone: "success" },
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Soumission ({soumissions.length} version{soumissions.length > 1 ? "s" : ""})
        </h2>
        {canEdit && (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => run(() => {
            const fd = new FormData(); fd.set("tenderId", tenderId);
            return createSubmission(fd);
          })}>
            <Plus className="h-4 w-4" /> Nouvelle version
          </Button>
        )}
      </div>

      {soumissions.length === 0 && (
        <p className="surface p-4 text-sm text-muted-foreground">
          Aucune version de soumission. Créez la V1 pour dérouler la checklist du dépôt
          (dossier administratif, technique, AMM, GMP, prix, garantie…).
        </p>
      )}

      {soumissions.map((s) => {
        const ouvert = openId === s.id;
        const st = statutLabel[s.status] ?? statutLabel.DRAFT;
        const faits = s.checklist.filter((c) => c.done).length;
        return (
          <div key={s.id} className="surface">
            <button
              type="button"
              onClick={() => setOpenId(ouvert ? null : s.id)}
              className="flex w-full flex-wrap items-center gap-2 px-3 py-3 text-left sm:px-4"
              aria-expanded={ouvert}
            >
              {ouvert ? <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />}
              <span className="min-w-0 font-medium [overflow-wrap:anywhere]">V{s.version}{s.label ? ` — ${s.label}` : ""}</span>
              <Badge tone={st.tone} dot={false}>{st.label}</Badge>
              {s.lockedAt && (
                <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                  <Lock className="h-3.5 w-3.5" /> déposée le {s.submittedAt ? formatDate(s.submittedAt.toString()) : "—"}
                </span>
              )}
              <span className="ml-auto text-xs tabular-nums text-muted-foreground">{faits}/{s.checklist.length} pièces</span>
            </button>

            {ouvert && (
              <div className="space-y-3 border-t border-border px-3 py-3 sm:px-4">
                <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                  {s.checklist.map((item) => (
                    <li key={item.key}>
                      <label className={`flex items-start gap-2 py-1 text-sm sm:py-0 ${s.lockedAt || !canEdit ? "cursor-default" : "cursor-pointer"}`}>
                        <input
                          type="checkbox"
                          checked={item.done}
                          disabled={busy || Boolean(s.lockedAt) || !canEdit}
                          onChange={() => run(() => {
                            const fd = new FormData(); fd.set("id", s.id); fd.set("itemKey", item.key);
                            return toggleChecklistItem(fd);
                          })}
                          className="mt-0.5 h-4 w-4 rounded border-input"
                        />
                        <span className={item.done ? "text-muted-foreground line-through" : ""}>
                          {item.label}
                          {item.done && item.doneAt && <span className="ml-1 text-xs text-muted-foreground no-underline">· {formatDate(item.doneAt)}</span>}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>

                {canEdit && !s.lockedAt && (
                  <div className="flex flex-wrap items-center gap-2">
                    <form
                      className="flex w-full min-w-0 items-center gap-2 sm:w-auto sm:flex-1"
                      action={(fd) => { fd.set("id", s.id); void run(() => addChecklistItem(fd)); }}
                    >
                      <Input name="label" placeholder="Ajouter une exigence propre à cet AO…" className="h-10 min-w-0 text-base sm:h-8 sm:text-sm" />
                      <Button type="submit" size="sm" variant="outline" disabled={busy}>Ajouter</Button>
                    </form>
                    <select
                      className="h-10 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-base sm:h-8 sm:flex-none sm:text-sm"
                      value={s.status}
                      disabled={busy}
                      aria-label="État de la version"
                      onChange={(e) => run(() => {
                        const fd = new FormData(); fd.set("id", s.id); fd.set("status", e.target.value);
                        return updateSubmission(fd);
                      })}
                    >
                      <option value="DRAFT">Brouillon</option>
                      <option value="REVIEW">En relecture</option>
                      <option value="FINAL">Version finale</option>
                    </select>
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        void run(() => { const fd = new FormData(); fd.set("id", s.id); return submitSubmission(fd); }, undefined, {
                          confirmer: `Déposer la V${s.version} ? La version sera VERROUILLÉE, la date de soumission posée sur le marché, et la photo des lignes figée.`,
                        });
                      }}
                    >
                      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Déposer &amp; verrouiller
                    </Button>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}

      {err && <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>}
    </div>
  );
}
