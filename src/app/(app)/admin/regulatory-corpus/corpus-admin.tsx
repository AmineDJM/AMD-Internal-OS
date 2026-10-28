"use client";

import * as React from "react";
import { Loader2, Plus, Search, BookPlus, CheckCircle2, Archive } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Retour } from "@/components/ui/retour";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";
import { createCorpusSourceVersion, setCorpusVersionStatus, seedAnppCorpus, searchCorpusAction } from "@/lib/regulatory/intelligence/corpus/actions";

interface Version { id: string; version: string; status: string; approvedAt: string | Date | null; _count: { sections: number } }
interface Source { id: string; authority: string; jurisdiction: string; code: string; title: string; versions: Version[] }
interface Citation { sectionId: string; authority: string; code: string; version: string; path: string; heading: string | null; snippet: string; rank: number }

export function CorpusAdmin({ sources, hasAnpp }: { sources: Source[]; hasAnpp: boolean }) {
  const { rafraichir } = useRafraichir();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [importing, setImporting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [q, setQ] = React.useState("");
  const [citations, setCitations] = React.useState<Citation[] | null>(null);

  async function run(key: string, fn: () => Promise<{ ok: boolean; error?: string }>) {
    setBusy(key); setError(null);
    try {
      const r = await fn();
      if (r.ok) rafraichir(); else setError(r.error ?? "Le corpus n'a pas été modifié.");
    } catch {
      setError(actionFailureMessage("THROWN"));
    } finally {
      setBusy(null);
    }
  }

  async function doImport(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setBusy("import"); setError(null);
    try {
      const r = await createCorpusSourceVersion(fd);
      if (r.ok) { setImporting(false); rafraichir(); } else setError(r.error ?? "La source n'a pas été importée.");
    } catch {
      setError(actionFailureMessage("THROWN"));
    } finally {
      setBusy(null);
    }
  }

  async function search() {
    setBusy("search");
    const fd = new FormData(); fd.set("q", q);
    try {
      const r = await searchCorpusAction(fd);
      setCitations(r.citations);
    } catch {
      setError(actionFailureMessage("THROWN"));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {!hasAnpp && (
          <Button type="button" size="sm" disabled={busy !== null} onClick={() => run("seed", seedAnppCorpus)}>
            {busy === "seed" ? <Loader2 className="h-4 w-4 animate-spin" /> : <BookPlus className="h-4 w-4" />} Amorcer le référentiel ANPP
          </Button>
        )}
        <Button type="button" size="sm" variant="outline" onClick={() => setImporting((v) => !v)}><Plus className="h-4 w-4" /> Importer une source</Button>
      </div>
      <Retour ton="erreur">{error}</Retour>

      {importing && (
        <form onSubmit={doImport} className="space-y-2 rounded-xl border border-border bg-card p-4">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Input name="authority" placeholder="Autorité (ANPP, EMA, ICH…)" defaultValue="ANPP" />
            <Input name="jurisdiction" placeholder="Juridiction (DZ, EU, ICH…)" defaultValue="DZ" />
            <Input name="code" placeholder="Code (ex. Arrêté 2021-05-10) *" required />
            <Input name="version" placeholder="Version (ex. 1.0)" defaultValue="1.0" />
          </div>
          <Input name="title" placeholder="Titre *" required />
          <Input name="sourceUrl" placeholder="URL officielle (optionnel)" />
          <Textarea name="text" rows={8} required placeholder="Texte intégral (découpé automatiquement en articles/sections)…" />
          <div className="flex justify-end gap-2">
            <Button type="button" size="sm" variant="outline" onClick={() => setImporting(false)}>Annuler</Button>
            <Button type="submit" size="sm" disabled={busy === "import"}>{busy === "import" ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Importer (brouillon)</Button>
          </div>
        </form>
      )}

      {/* Recherche RAG de test */}
      <div className="rounded-xl border border-border p-3">
        <div className="flex gap-2">
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Tester le RAG : rechercher dans le corpus actif…" onKeyDown={(e) => e.key === "Enter" && search()} />
          <Button type="button" size="sm" onClick={search} disabled={busy === "search"} aria-label="Rechercher dans le corpus" className="h-10 shrink-0 sm:h-8">{busy === "search" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}</Button>
        </div>
        {citations && (
          <div className="mt-2 space-y-1.5">
            {citations.length === 0 ? <p className="text-xs text-muted-foreground">Aucune correspondance dans le corpus actif.</p> :
              citations.map((c) => (
                <div key={c.sectionId} className="rounded-md border border-border/60 px-2.5 py-1.5 text-xs">
                  <p className="font-medium [overflow-wrap:anywhere]">{c.authority} · {c.code} v{c.version} · {c.path}{c.heading ? ` — ${c.heading}` : ""}</p>
                  <p className="text-muted-foreground" dangerouslySetInnerHTML={{ __html: c.snippet }} />
                </div>
              ))}
          </div>
        )}
      </div>

      {/* Sources */}
      <div className="space-y-2">
        {sources.map((s) => (
          <div key={s.id} className="rounded-xl border border-border p-3">
            <p className="text-sm font-medium">{s.authority} · {s.jurisdiction} · {s.code}</p>
            <p className="text-xs text-muted-foreground">{s.title}</p>
            <div className="mt-1.5 space-y-1">
              {s.versions.map((v) => (
                <div key={v.id} className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="font-medium">v{v.version}</span>
                  <span className={`rounded px-1.5 py-0.5 ${v.status === "ACTIVE" ? "bg-success/10 text-success" : v.status === "RETIRED" ? "bg-muted text-muted-foreground" : "bg-amber-500/10 text-amber-600"}`}>{v.status}</span>
                  <span className="text-muted-foreground">{v._count.sections} sections</span>
                  {v.status !== "ACTIVE" && (
                    <button type="button" disabled={busy !== null} onClick={() => run(`act-${v.id}`, () => { const fd = new FormData(); fd.set("sourceVersionId", v.id); fd.set("status", "ACTIVE"); return setCorpusVersionStatus(fd); })} className="inline-flex items-center gap-1 rounded border border-success/40 px-2 py-1.5 sm:px-1.5 sm:py-0.5 text-success"><CheckCircle2 className="h-3 w-3" /> Activer</button>
                  )}
                  {v.status !== "RETIRED" && (
                    <button type="button" disabled={busy !== null} onClick={() => run(`ret-${v.id}`, () => { const fd = new FormData(); fd.set("sourceVersionId", v.id); fd.set("status", "RETIRED"); return setCorpusVersionStatus(fd); })} className="inline-flex items-center gap-1 rounded border border-border px-2 py-1.5 sm:px-1.5 sm:py-0.5 text-muted-foreground"><Archive className="h-3 w-3" /> Retirer</button>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
        {sources.length === 0 && <p className="text-sm text-muted-foreground">Aucune source. Amorcez le référentiel ANPP ou importez un texte.</p>}
      </div>
    </div>
  );
}
