"use client";

import * as React from "react";
import Link from "next/link";
import { Loader2, RefreshCw, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";
import { askBrain, regenererBriefing, type BrainAnswer } from "@/lib/actions/adventum-actions";
import { executeAssistantAction } from "@/lib/actions/assistant-actions";
import type { ProposedAction } from "@/lib/assistant";

/** Une puce de source : module ou document, cliquable quand elle a une adresse. */
export function Puce({ label, href }: { label: string; href: string | null }) {
  const cls = "ml-1 inline-flex max-w-[16rem] items-center truncate rounded-md border border-border bg-secondary/60 px-1.5 py-px align-baseline text-[0.6875rem] font-medium text-muted-foreground";
  return href ? <Link href={href} className={`${cls} hover:border-primary/40 hover:text-primary`}>{label}</Link> : <span className={cls}>{label}</span>;
}

export function BoutonRegenerer() {
  const { enCours, rafraichir } = useRafraichir();
  const [envoi, setEnvoi] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);
  return (
    <span className="inline-flex items-center gap-2">
      {msg && <span className="text-xs text-muted-foreground">{msg}</span>}
      <Button size="sm" variant="outline" disabled={envoi || enCours} onClick={async () => {
        setEnvoi(true); setMsg(null);
        try {
          const r = await regenererBriefing();
          if (r.ok) { setMsg(r.message ?? null); rafraichir(); } else setMsg(r.error ?? "Le briefing n'a pas été régénéré.");
        } catch {
          setMsg(actionFailureMessage("THROWN"));
        } finally {
          setEnvoi(false);
        }
      }}>
        {envoi || enCours ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}Régénérer
      </Button>
    </span>
  );
}

/** Une action proposée par l'assistant : un bouton qui passe par la confirmation canonique. */
function Proposition({ p }: { p: ProposedAction }) {
  const [etat, setEtat] = React.useState<"repos" | "confirmer" | "envoi" | "fait">("repos");
  const [err, setErr] = React.useState<string | null>(null);
  const [saisie, setSaisie] = React.useState("");
  const critique = p.level === "CRITICAL";
  if (etat === "fait") return <p className="flex items-center gap-1.5 text-sm text-success"><CheckCircle2 className="h-4 w-4" />{p.title} — fait.</p>;
  if (etat === "repos") return <Button size="sm" variant="outline" onClick={() => setEtat("confirmer")}>{p.title}</Button>;
  return (
    <div className="w-full space-y-2 rounded-lg border border-border p-3 text-sm">
      <p className="font-medium">{p.title}</p>
      {p.fields.length > 0 && <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">{p.fields.map((f, i) => <React.Fragment key={i}><dt className="text-muted-foreground">{f.label}</dt><dd>{f.value}</dd></React.Fragment>)}</dl>}
      {p.warnings.map((w, i) => <p key={i} className="text-xs text-warning">{w}</p>)}
      {critique && <Input value={saisie} onChange={(e) => setSaisie(e.target.value)} placeholder={`Ressaisir « ${p.confirmText ?? ""} »`} aria-label="Confirmation renforcée" />}
      {err && <p className="text-xs text-destructive">{err}</p>}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={() => setEtat("repos")}>Annuler</Button>
        <Button size="sm" disabled={etat === "envoi"} onClick={async () => {
          setEtat("envoi"); setErr(null);
          try {
            const r = await executeAssistantAction(p.payload, p.intentId, critique ? saisie : undefined);
            if (r.ok) setEtat("fait"); else { setErr(r.error ?? "L'action proposée n'a pas été exécutée."); setEtat("confirmer"); }
          } catch {
            setErr(actionFailureMessage("THROWN")); setEtat("confirmer");
          }
        }}>{etat === "envoi" && <Loader2 className="h-4 w-4 animate-spin" />}Confirmer</Button>
      </div>
    </div>
  );
}

export function Demander() {
  const [q, setQ] = React.useState("");
  const [envoi, setEnvoi] = React.useState(false);
  const [rep, setRep] = React.useState<BrainAnswer | null>(null);
  const demander = async () => {
    if (!q.trim() || envoi) return;
    setEnvoi(true); setRep(null);
    try {
      setRep(await askBrain(q));
    } finally {
      setEnvoi(false);
    }
  };
  return (
    <div className="surface space-y-3 rounded-xl p-4">
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void demander(); }}>
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Pourquoi les ventes de … baissent ce trimestre ?" aria-label="Question" className="min-w-0 flex-1" />
        <Button type="submit" disabled={envoi || !q.trim()} className="shrink-0">{envoi && <Loader2 className="h-4 w-4 animate-spin" />}Demander</Button>
      </form>
      {rep && (
        rep.ok || rep.reply ? (
          <div className="space-y-3">
            <p className="whitespace-pre-wrap text-sm leading-relaxed">{rep.reply}</p>
            {rep.sources.length > 0 && <p className="-ml-1 flex flex-wrap gap-y-1">{rep.sources.map((s, i) => <Puce key={i} label={s.label} href={s.href} />)}</p>}
            {rep.proposals.length > 0 && <div className="flex flex-wrap gap-2">{rep.proposals.map((p, i) => <Proposition key={p.intentId ?? i} p={p} />)}</div>}
          </div>
        ) : <p className="text-sm text-destructive">{rep.error ?? "Pas de réponse."}</p>
      )}
    </div>
  );
}
