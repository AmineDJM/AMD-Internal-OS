"use client";

import * as React from "react";
import { Play, Loader2, AlertCircle, ShieldCheck, ShieldAlert, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, Label, Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { runTestCenter, resumeTestCleanup } from "@/lib/actions/test-center-actions";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";
import { WRITE_MODES, PRODUCTION_SAFETY_PHRASE } from "@/lib/test-center/types";

const MODES = [
  { value: "SAFE_SYNTHETIC_TEST", label: "Test synthétique sûr (recommandé)", hint: "Identités synthétiques + smoke, audit approfondi (invariants, machines à états, oracles), migrations & roundtrip sauvegarde/restauration, auto-validation du testeur (mutation, fuzz, time-travel), nettoyage vérifié, certification scellée." },
  { value: "READ_ONLY_AUDIT", label: "Audit lecture seule", hint: "Aucune écriture : santé, invariants métier, machines à états, cohérence multi-oracles, migrations, auto-validation du testeur, certification." },
];

const ENV_LABEL: Record<string, string> = { production: "Production", staging: "Staging", development: "Développement" };

/** Panneau de lancement d'un run. En production, un mode d'écriture exige une confirmation + phrase. */
export function LaunchPanel({ environment }: { environment: string }) {
  const { rafraichir } = useRafraichir();
  const [mode, setMode] = React.useState("SAFE_SYNTHETIC_TEST");
  const [confirmed, setConfirmed] = React.useState(false);
  const [phrase, setPhrase] = React.useState("");
  const [pending, start] = React.useTransition();
  const [err, setErr] = React.useState<string | null>(null);
  const [okMsg, setOkMsg] = React.useState<string | null>(null);

  const isWrite = (WRITE_MODES as readonly string[]).includes(mode);
  const needsConfirm = environment === "production" && isWrite;
  const phraseOk = phrase.trim() === PRODUCTION_SAFETY_PHRASE;
  const canLaunch = !pending && (!needsConfirm || (confirmed && phraseOk));

  const launch = () =>
    start(async () => {
      setErr(null); setOkMsg(null);
      try {
        const r = await runTestCenter(needsConfirm ? { mode, productionConfirmed: confirmed, safetyPhrase: phrase.trim() } : { mode });
        if (!r.ok) { setErr(r.error ?? "Le run de test n'a pas été lancé."); return; }
        setOkMsg(`Run ${r.runId?.slice(0, 8)} terminé.`);
        setConfirmed(false); setPhrase("");
        rafraichir();
      } catch {
        setErr(actionFailureMessage("THROWN"));
      }
    });

  const current = MODES.find((m) => m.value === mode);
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base"><ShieldCheck className="h-4 w-4 text-primary" /> Lancer un run</CardTitle>
        <CardDescription>
          Réservé au Super Admin. Le nettoyage des données synthétiques est garanti et vérifié à la fin.
          {" "}Environnement : <span className="font-medium text-foreground/80">{ENV_LABEL[environment] ?? environment}</span>.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-1 gap-2 sm:max-w-md">
          <Label>Mode</Label>
          <Select value={mode} onChange={(e) => setMode(e.target.value)}>
            {MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </Select>
          {current && <p className="text-xs text-muted-foreground">{current.hint}</p>}
        </div>

        {needsConfirm && (
          <div className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
            <p className="flex items-center gap-2 text-sm font-medium text-amber-700"><ShieldAlert className="h-4 w-4" /> Exécution en production</p>
            <p className="text-xs text-muted-foreground">
              Ce mode crée des données synthétiques (comptes inactifs sur un domaine non routable), puis les nettoie et
              vérifie leur disparition. En production, une confirmation explicite est requise.
            </p>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="mt-0.5 h-4 w-4 rounded border-border" />
              <span>Je confirme l'exécution en production (aucune donnée préexistante ne sera touchée).</span>
            </label>
            <div className="grid grid-cols-1 gap-1.5">
              <Label className="text-xs">Phrase de sécurité — saisir exactement : <span className="font-mono text-foreground/80 [overflow-wrap:anywhere]">{PRODUCTION_SAFETY_PHRASE}</span></Label>
              <Input value={phrase} onChange={(e) => setPhrase(e.target.value)} placeholder={PRODUCTION_SAFETY_PHRASE} spellCheck={false} />
            </div>
          </div>
        )}

        {err && <div className="flex items-center gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"><AlertCircle className="h-4 w-4" /> {err}</div>}
        {okMsg && <div className="flex items-center gap-2 rounded-lg bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700"><ShieldCheck className="h-4 w-4" /> {okMsg}</div>}
        <Button onClick={launch} disabled={!canLaunch} size="sm">
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />} {pending ? "Exécution…" : "Lancer le run"}
        </Button>
        {needsConfirm && !canLaunch && !pending && <p className="text-[0.6875rem] text-amber-700">Cochez la confirmation et saisissez la phrase exacte pour activer le lancement.</p>}
        <p className="text-[0.6875rem] text-muted-foreground">Chaque run rend un verdict (Certifié / avec réserves / Bloqué / Non concluant) et scelle un paquet de preuves haché. Modes avancés (Staging complet, Chaos, Sécurité, Performance) : phases suivantes.</p>
      </CardContent>
    </Card>
  );
}

/** Bouton de reprise de nettoyage pour un run interrompu / incomplet. */
export function ResumeCleanupButton({ runId }: { runId: string }) {
  const { rafraichir } = useRafraichir();
  const [pending, start] = React.useTransition();
  const [msg, setMsg] = React.useState<string | null>(null);
  const resume = () =>
    start(async () => {
      try {
        const r = await resumeTestCleanup(runId);
        setMsg(r.ok ? "Nettoyage terminé." : (r.error ?? "Nettoyage incomplet."));
        rafraichir();
      } catch {
        setMsg(actionFailureMessage("THROWN"));
      }
    });
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="outline" onClick={resume} disabled={pending}>
        {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />} Reprendre le nettoyage
      </Button>
      {msg && <span className="text-xs text-muted-foreground">{msg}</span>}
    </div>
  );
}
