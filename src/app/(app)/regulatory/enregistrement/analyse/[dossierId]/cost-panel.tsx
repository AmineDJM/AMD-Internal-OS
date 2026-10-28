"use client";

import * as React from "react";
import { Loader2, CheckCircle2, XCircle, Hourglass } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";
import { setDossierBudget, submitDeferredReview, submitImmediateReview } from "@/lib/regulatory/intelligence/cost/cost-actions";

/**
 * Réglage du plafond de dépense IA du dossier.
 *
 * Le plafond n'est pas décoratif : au-delà, les analyses économiques **s'arrêtent et le disent**
 * plutôt que de laisser filer la facture. Champ vide = on revient au plafond global.
 */
export function BudgetForm({ dossierId, current }: { dossierId: string; current: number | null }) {
  const { rafraichir } = useRafraichir();
  const [value, setValue] = React.useState(current != null ? String(current) : "");
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);
  const lock = React.useRef(false);

  const save = () => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setMsg(null);
    const fd = new FormData();
    fd.set("dossierId", dossierId);
    fd.set("budgetUsd", value);
    void (async () => {
      try {
        const r = await setDossierBudget(fd);
        setMsg({ ok: r.ok, text: r.ok ? (r.message ?? "Enregistré.") : (r.error ?? "Le plafond n'a pas été enregistré.") });
        if (r.ok) rafraichir();
      } catch {
        setMsg({ ok: false, text: actionFailureMessage("THROWN") });
      } finally {
        setBusy(false);
        lock.current = false;
      }
    })();
  };

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="ai-budget" className="text-xs text-muted-foreground">Plafond du dossier ($)</label>
        <input
          id="ai-budget" type="number" inputMode="decimal" min="0" step="0.5" value={value}
          onChange={(e) => setValue(e.target.value)} placeholder="plafond global"
          className="w-32 rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm tabular-nums outline-none focus:border-primary/60"
        />
        <Button size="sm" variant="outline" onClick={save} disabled={busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Enregistrer
        </Button>
      </div>
      <p className="text-[0.6875rem] text-muted-foreground">
        Champ vide = plafond global. Au-delà du plafond, les analyses s&apos;arrêtent et le signalent.
      </p>
      {msg && (
        <p className={`flex items-center gap-1.5 text-xs ${msg.ok ? "text-success" : "text-destructive"}`}>
          {msg.ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />} {msg.text}
        </p>
      )}
    </div>
  );
}

/**
 * ANALYSE DIFFÉRÉE — moitié prix, résultats sous 24 h.
 *
 * Le bouton ne remplace pas l'analyse immédiate, il la complète : sur un dossier qu'on examine
 * maintenant, attendre n'a aucun sens ; sur une réanalyse complète lancée le soir, l'économie est
 * réelle. L'écran dit donc les deux termes du choix — le prix ET le délai — plutôt que de trancher
 * à la place de l'utilisateur.
 */
export function DeferredReviewButton({ dossierId, pending }: { dossierId: string; pending: { requestCount: number; submittedAt: string } | null }) {
  const { rafraichir } = useRafraichir();
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);
  const lock = React.useRef(false);

  const launch = () => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setMsg(null);
    const fd = new FormData();
    fd.set("dossierId", dossierId);
    void (async () => {
      try {
        const r = await submitDeferredReview(fd);
        setMsg({ ok: r.ok, text: r.ok ? (r.message ?? "Lot déposé.") : (r.error ?? "Le lot n'a pas été déposé.") });
        if (r.ok) rafraichir();
      } catch {
        setMsg({ ok: false, text: actionFailureMessage("THROWN") });
      } finally {
        setBusy(false);
        lock.current = false;
      }
    })();
  };

  if (pending) {
    return (
      <div className="rounded-xl border border-border px-3 py-2">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
          <Hourglass className="h-4 w-4 text-primary" />
          <span className="font-medium">Analyse différée en cours</span>
          <span className="text-xs text-muted-foreground">{pending.requestCount} part(s), déposée le {new Date(pending.submittedAt).toLocaleString("fr-FR")}</span>
        </p>
        <p className="mt-0.5 text-[0.6875rem] text-muted-foreground">
          Les constats remplaceront la revue IA actuelle dès réception (sous 24 h). Vous serez prévenu.
        </p>
      </div>
    );
  }

  // LE CHOIX APPARTIENT À L'UTILISATEUR : lui seul sait si la Direction attend le dossier demain
  // matin. Les deux voies produisent EXACTEMENT les mêmes constats — seuls le prix et le délai
  // changent, et l'écran le dit.
  const launchNow = () => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setMsg(null);
    const fd = new FormData();
    fd.set("dossierId", dossierId);
    void (async () => {
      try {
        const r = await submitImmediateReview(fd);
        setMsg({ ok: r.ok, text: r.ok ? "Analyse immédiate lancée — résultats dans l'heure." : (r.error ?? "L'analyse immédiate n'a pas été lancée.") });
        if (r.ok) rafraichir();
      } catch {
        setMsg({ ok: false, text: actionFailureMessage("THROWN") });
      } finally {
        setBusy(false);
        lock.current = false;
      }
    })();
  };

  return (
    <div className="space-y-1.5 border-t border-border pt-3">
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={launch} disabled={busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Hourglass className="h-4 w-4" />} Réanalyser à moitié prix (sous 24 h)
        </Button>
        <Button size="sm" variant="ghost" onClick={launchNow} disabled={busy} title="Même analyse, résultats dans l'heure, plein tarif">
          Résultats maintenant (plein tarif)
        </Button>
      </div>
      <p className="text-[0.6875rem] text-muted-foreground">
        Même lecture, même exigence, même consigne — seule la facturation change. À réserver aux réanalyses
        complètes : pour un dossier qu&apos;on examine maintenant, gardez l&apos;analyse immédiate.
      </p>
      {msg && (
        <p className={`flex items-start gap-1.5 text-xs ${msg.ok ? "text-success" : "text-destructive"}`}>
          {msg.ok ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />} {msg.text}
        </p>
      )}
    </div>
  );
}
