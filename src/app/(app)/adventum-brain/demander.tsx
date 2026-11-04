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
import { confirmerIntentionAssistantIA, ignorerIntentionAssistantIA } from "@/modules/assistant-ia/actions";
import type { ProposedAction } from "@/lib/assistant";
import type { CarteDEntree } from "@/modules/assistant-ia/api";

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

/** Le geste « Confirmer », commun aux deux cartes : l'exécution, puis « fait » — ou l'erreur dite, la carte reste ouverte. */
async function confirmerGeste(
  executer: () => Promise<{ ok: boolean; error?: string }>,
  setEtat: (e: "confirmer" | "envoi" | "fait") => void,
  setErr: (m: string | null) => void,
): Promise<void> {
  setEtat("envoi"); setErr(null);
  try {
    const r = await executer();
    if (r.ok) setEtat("fait"); else { setErr(r.error ?? "L'action proposée n'a pas été exécutée."); setEtat("confirmer"); }
  } catch {
    setErr(actionFailureMessage("THROWN")); setEtat("confirmer");
  }
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
        <Button size="sm" disabled={etat === "envoi"} onClick={() => confirmerGeste(() => executeAssistantAction(p.payload, p.intentId, critique ? saisie : undefined), setEtat, setErr)}>{etat === "envoi" && <Loader2 className="h-4 w-4 animate-spin" />}Confirmer</Button>
      </div>
    </div>
  );
}

/**
 * I6 (décision 0070) : une carte du MOTEUR UNIQUE — l'intention persistée du tour de Brain, confirmée (ou ignorée) par la
 * même action que la conversation (`confirmerIntentionAssistantIA`), jamais par l'ancienne confirmation.
 */
function CarteMoteur({ c }: { c: CarteDEntree }) {
  const [etat, setEtat] = React.useState<"repos" | "confirmer" | "envoi" | "fait" | "ignoree">("repos");
  const [err, setErr] = React.useState<string | null>(null);
  const [saisie, setSaisie] = React.useState("");
  if (etat === "fait") return <p className="flex items-center gap-1.5 text-sm text-success"><CheckCircle2 className="h-4 w-4" />{c.titre} — fait.</p>;
  if (etat === "ignoree") return <p className="text-sm text-muted-foreground">{c.titre} — ignorée.</p>;
  if (etat === "repos") return <Button size="sm" variant="outline" onClick={() => setEtat("confirmer")}>{c.titre}</Button>;
  return (
    <div className="w-full space-y-2 rounded-lg border border-border p-3 text-sm">
      <p className="font-medium">{c.titre}</p>
      {c.champs.length > 0 && <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">{c.champs.map((f, i) => <React.Fragment key={i}><dt className="text-muted-foreground">{f.label}</dt><dd>{f.value}</dd></React.Fragment>)}</dl>}
      {c.avertissements.map((w, i) => <p key={i} className="text-xs text-warning">{w}</p>)}
      {c.confirmText && <Input value={saisie} onChange={(e) => setSaisie(e.target.value)} placeholder={`Ressaisir « ${c.confirmText} »`} aria-label="Confirmation renforcée" />}
      {err && <p className="text-xs text-destructive">{err}</p>}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" disabled={etat === "envoi"} onClick={async () => {
          const r = await ignorerIntentionAssistantIA(c.id).catch(() => ({ ok: false, error: actionFailureMessage("THROWN") }));
          if (r.ok) setEtat("ignoree"); else setErr(r.error ?? "La carte n'a pas pu être ignorée.");
        }}>Ignorer</Button>
        <Button size="sm" disabled={etat === "envoi"} onClick={() => confirmerGeste(() => confirmerIntentionAssistantIA(c.id, c.confirmText ? saisie : undefined), setEtat, setErr)}>{etat === "envoi" && <Loader2 className="h-4 w-4 animate-spin" />}{c.libelleBouton ?? "Confirmer"}</Button>
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
            {(rep.cartes?.length ?? 0) > 0 && <div className="flex flex-wrap gap-2">{rep.cartes!.map((c) => <CarteMoteur key={c.id} c={c} />)}</div>}
          </div>
        ) : <p className="text-sm text-destructive">{rep.error ?? "Pas de réponse."}</p>
      )}
    </div>
  );
}
