"use client";

import * as React from "react";
import { Download, Radar, Loader2, CheckCircle2, XCircle, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";
import { Badge } from "@/components/ui/badge";
import { ingestWave, ingestOneSource, runAnppWatch } from "@/lib/regulatory/intelligence/corpus/corpus-actions";

interface Src { code: string; title: string; authority: string }
type WatchFindings = NonNullable<Awaited<ReturnType<typeof runAnppWatch>>["findings"]>;
type IngestResults = NonNullable<Awaited<ReturnType<typeof ingestWave>>["results"]>;

/**
 * ALIMENTER LE CORPUS ET SURVEILLER L'ANPP.
 *
 * Deux boutons qui prennent du temps : le téléchargement espace volontairement les sources (ce
 * sont des services publics, on ne les martèle pas). L'écran le DIT avant, et rend compte
 * source par source après — une source injoignable est une information utile, pas un incident
 * à masquer derrière un « échec ».
 *
 * Verrou anti-double-clic en `useRef` synchrone : le `disabled` d'un bouton ne prend effet
 * qu'au rendu suivant, donc trop tard pour un double-clic rapide.
 */
export function CorpusPanel({ firstWave, missing, watchPages }: { firstWave: Src[]; missing: Src[]; watchPages: { code: string; title: string; url: string }[] }) {
  const { rafraichir } = useRafraichir();
  const [busy, setBusy] = React.useState<null | "first" | "all" | "watch" | "one">(null);
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);
  const [results, setResults] = React.useState<IngestResults | null>(null);
  const [watch, setWatch] = React.useState<WatchFindings | null>(null);
  const [pick, setPick] = React.useState(missing[0]?.code ?? "");
  const lock = React.useRef(false);

  const run = async (
    kind: "first" | "all" | "watch" | "one",
    fn: () => Promise<{ ok: boolean; error?: string; message?: string; results?: IngestResults; findings?: WatchFindings }>,
  ) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(kind);
    setMsg(null);
    setResults(null);
    setWatch(null);
    try {
      const r = await fn();
      setMsg({ ok: r.ok, text: r.ok ? (r.message ?? "Terminé.") : (r.error ?? "L'opération n'a pas abouti.") });
      if (r.results) setResults(r.results);
      if (r.findings) setWatch(r.findings);
      if (r.ok) rafraichir();
    } catch {
      setMsg({ ok: false, text: actionFailureMessage("THROWN") });
    } finally {
      setBusy(null);
      lock.current = false;
    }
  };

  const wave = (scope: "first" | "all") => {
    const fd = new FormData();
    fd.set("scope", scope);
    void run(scope, () => ingestWave(fd));
  };

  const one = () => {
    if (!pick) return;
    const fd = new FormData();
    fd.set("code", pick);
    void run("one", () => ingestOneSource(fd));
  };

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {/* ── Ingérer ── */}
      <section className="surface space-y-3 p-4">
        <div className="flex items-center gap-2">
          <Download className="h-4 w-4 text-primary" />
          <h2 className="text-sm font-semibold">Télécharger les textes</h2>
        </div>
        <p className="text-xs text-muted-foreground">
          Les sources sont téléchargées <strong>une par une, espacées</strong> — ce sont des services publics.
          Compter plusieurs minutes pour tout le catalogue. Une version déjà connue à l&apos;identique n&apos;est
          pas recréée ; chaque texte téléchargé est <strong>actif dès l&apos;import</strong>.
        </p>

        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => wave("first")} disabled={busy !== null}>
            {busy === "first" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            Première vague ({firstWave.length})
          </Button>
          <Button size="sm" variant="outline" onClick={() => wave("all")} disabled={busy !== null}>
            {busy === "all" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            Tout le catalogue ingérable
          </Button>
        </div>
        <p className="text-[0.6875rem] text-muted-foreground">
          La première vague suffit à analyser un dossier algérien : lignes directrices ANPP, ICH qualité, OMS.
        </p>

        {missing.length > 0 && (
          <div className="border-t border-border pt-3">
            <label className="text-xs font-medium" htmlFor="corpus-source">Ou une source précise</label>
            <div className="mt-1 flex flex-wrap gap-2">
              <select
                id="corpus-source" value={pick} onChange={(e) => setPick(e.target.value)}
                className="min-w-0 flex-1 rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary/60"
              >
                {missing.map((s) => <option key={s.code} value={s.code}>{s.authority} — {s.title}</option>)}
              </select>
              <Button size="sm" variant="outline" onClick={one} disabled={busy !== null || !pick}>
                {busy === "one" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />} Télécharger
              </Button>
            </div>
          </div>
        )}

        {msg && (
          <p className={`flex items-start gap-2 rounded-xl px-3 py-2 text-sm ${msg.ok ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive"}`}>
            {msg.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0" />}
            {msg.text}
          </p>
        )}

        {/* Le détail source par source : savoir CE QUI a échoué, pas seulement qu'il y a eu des échecs. */}
        {results && results.length > 0 && (
          <ul className="max-h-72 divide-y divide-border overflow-y-auto text-sm">
            {results.map((r) => (
              <li key={r.code} className="flex flex-wrap items-center gap-2 py-1.5">
                <Badge tone={r.ok ? (r.unchanged ? "neutral" : "success") : "danger"} dot={false}>
                  {r.ok ? (r.unchanged ? "inchangée" : "importée") : "échec"}
                </Badge>
                <span className="min-w-0 flex-1 truncate text-xs">{r.code}</span>
                <span className="shrink-0 text-[0.6875rem] text-muted-foreground">
                  {r.ok ? (r.unchanged ? "—" : `${r.sections ?? 0} section(s)`) : r.error}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ── Veiller ── */}
      <section className="surface space-y-3 p-4">
        <div className="flex items-center gap-2">
          <Radar className="h-4 w-4 text-primary" />
          <h2 className="text-sm font-semibold">Veille des publications ANPP</h2>
        </div>
        <p className="text-xs text-muted-foreground">
          L&apos;ANPP publie et met à jour <strong>sans préavis</strong>. Une ligne directrice qui change sans qu&apos;on
          le sache, c&apos;est une analyse qui devient fausse en silence — et des réserves qu&apos;on n&apos;aura pas vues
          venir. Le relevé compare l&apos;empreinte des pages et <strong>signale</strong> ; il ne réingère rien tout seul.
        </p>

        <Button size="sm" onClick={() => void run("watch", runAnppWatch)} disabled={busy !== null}>
          {busy === "watch" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Radar className="h-4 w-4" />} Relever maintenant
        </Button>

        <ul className="divide-y divide-border text-sm">
          {watchPages.map((p) => {
            const f = watch?.find((w) => w.code === p.code);
            return (
              <li key={p.code} className="space-y-1 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <a href={p.url} target="_blank" rel="noreferrer noopener" className="min-w-0 flex-1 truncate text-xs hover:underline">{p.title}</a>
                  {f && (
                    <Badge tone={!f.ok ? "danger" : f.changed ? "warning" : f.changed === undefined ? "info" : "success"} dot={false}>
                      {!f.ok ? "injoignable" : f.changed ? "a changé" : f.changed === undefined ? "1ᵉʳ relevé" : "inchangée"}
                    </Badge>
                  )}
                </div>
                {f?.error && <p className="text-[0.6875rem] text-destructive">{f.error}</p>}
                {f?.changed && (
                  <p className="flex items-start gap-1.5 text-[0.6875rem] text-warning">
                    <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
                    Page modifiée depuis le dernier relevé — vérifier ce qui a été publié avant la prochaine soumission.
                  </p>
                )}
                {f?.documentLinks && f.documentLinks.length > 0 && (
                  <details className="text-[0.6875rem] text-muted-foreground">
                    <summary className="cursor-pointer">{f.documentLinks.length} intitulé(s) repéré(s) sur la page</summary>
                    <ul className="mt-1 space-y-0.5 pl-3">
                      {f.documentLinks.slice(0, 25).map((d, i) => <li key={i}>• {d}</li>)}
                    </ul>
                  </details>
                )}
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
